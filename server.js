// server.js
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const fetch = require('node-fetch');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!GEMINI_API_KEY) {
  console.warn('Warning: GEMINI_API_KEY environment variable is not set. Set it in .env before running.');
}

app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// Helper: call Gemini REST generateContent endpoint
async function callGemini(promptText) {
  // choose a model; you can change to gemini-2.5-flash or whichever model you have access to
  const model = 'gemini-2.5-flash';

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;

  // Build a simple "contents" request with a single user part
  // allow callers to specify generation config via environment defaults
  const defaultMax = process.env.GEMINI_MAX_OUTPUT_TOKENS ? parseInt(process.env.GEMINI_MAX_OUTPUT_TOKENS, 10) : 512;
  const body = {
    contents: [
      {
        role: 'user',
        parts: [
          { text: promptText }
        ]
      }
    ],
    // Optional generation config; set sensible defaults and allow overriding
    generationConfig: {
      maxOutputTokens: defaultMax,
      temperature: 0.2,
      // You can add other options here: topK, topP, repetitionPenalty, etc.
    }
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // Gemini Developer REST expects the API key in this header
      'x-goog-api-key': GEMINI_API_KEY
    },
    body: JSON.stringify(body),
    // Note: you may need to set timeouts or retries in production
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Gemini API error ${res.status}: ${errorText}`);
  }

  const data = await res.json();

  // Typical response format: data.candidates[].content.parts[].text
  // We'll try to extract the first candidate text safely.
  try {
    const candidate = data?.candidates?.[0];
    const partText = candidate?.content?.parts?.[0]?.text;
    if (partText) return partText;
  } catch (err) {
    // fall through to generic stringify
  }

  // fallback: return a stringified version of the response if the above path doesn't exist
  return JSON.stringify(data);
}

// Stream-aware explain endpoint: streams the explanation as text chunks to the client
app.post('/api/explain/stream', async (req, res) => {
  try {
    const { code, mode = 'summary', language = 'auto' } = req.body || {};
    if (!code) return res.status(400).json({ error: 'No code provided' });

    if (!GEMINI_API_KEY) return res.status(400).json({ error: 'GEMINI_API_KEY is not set in server environment' });

    // Prepare prompt
    const prompt = `You are a helpful code explainer. The user requested mode=${mode} and language=${language}. Provide a clear ${mode} of the code below.\n\nCode:\n${code}`;

    // Set headers for streaming text response
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // Call Gemini (non-streaming) to get full text, then stream it in chunks to the client.
    // NOTE: If Gemini streaming is available for your account, replace this with a true streaming call.
    let explanation;
    try {
      explanation = await callGemini(prompt);
    } catch (err) {
      console.error('Gemini explain failed:', err);
      res.status(502).write('Error: Gemini API failed\n');
      return res.end();
    }

    // Split the explanation into reasonable chunks (by sentence or 240 chars)
    const maxChunk = 240;
    const chunks = [];
    if (!explanation) explanation = '';
    // try to split by sentences first
    const sentences = explanation.split(/(?<=[.?!])\s+/);
    let buf = '';
    for (const s of sentences) {
      if ((buf + ' ' + s).length > maxChunk) {
        if (buf) { chunks.push(buf.trim()); buf = s; }
        else { chunks.push(s.trim()); buf = ''; }
      } else {
        buf = buf ? (buf + ' ' + s) : s;
      }
    }
    if (buf) chunks.push(buf.trim());

    // Stream chunks to client
    for (const c of chunks) {
      // Each chunk is sent as a line; client will append as it arrives
      res.write(c + '\n');
      // slight delay could be added for demo: await new Promise(r => setTimeout(r, 30));
    }

    // end stream
    res.end();
  } catch (err) {
    console.error(err);
    res.status(500).end('Server error');
  }
});

// Keep a lightweight rule-based fallback for fitness-specific prompts (optional)
// We will prefer Gemini if API key present; otherwise fallback to local rules.
function localFallback(message) {
  const msg = (message || '').toLowerCase();
  if (/\b(workout|exercise|plan|routine)\b/.test(msg)) {
    return `Sample full-body routine (local fallback):\n- Squats 3x10\n- Push-ups 3x8-12\n- Rows 3x8-12\n- Plank 3x30s\nDo this 3x/week. (This is the local fallback - enable Gemini API for richer replies.)`;
  }
  if (/\b(diet|calorie|protein|meal)\b/.test(msg)) {
    return `Local diet tip: prioritize protein (1.6-2.2 g/kg), eat whole foods, and reduce processed sugars.`;
  }
  if (/\b(hi|hello|hey)\b/.test(msg)) {
    return `Hey — I'm FitBuddy. Ask me for workout plans, diet tips, or motivation.`;
  }
  return `I didn't understand. Try asking \"Give me a 30 minute full-body home workout\" or \"How many calories should I eat to lose weight?\"`;
}

app.post('/api/chat', async (req, res) => {
  try {
    const { message } = req.body || {};
    if (!message) return res.status(400).json({ error: 'No message provided' });

    // If no API key, use fallback
    if (!GEMINI_API_KEY) {
      const reply = localFallback(message);
      return res.json({ reply, source: 'local-fallback' });
    }

    // Build a prompt to guide Gemini (you can expand system instructions)
    const prompt = `You are FitBuddy, a concise friendly fitness coach. Answer the user's question clearly and with practical steps. If user asks for a workout, include sets/reps/time. Keep it brief.\n\nUser: ${message}`;

    let replyText;
    try {
      replyText = await callGemini(prompt);
    } catch (err) {
      console.error('Gemini API call failed:', err);
      // fallback to local rule-based if Gemini fails
      const fallback = localFallback(message);
      return res.json({ reply: fallback, source: 'fallback', error: String(err) });
    }

    return res.json({ reply: replyText, source: 'gemini' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/explain
// Expects JSON: { code: string, model?: string, mode?: 'summary'|'line'|'refactor'|'doc', language?: string }
app.post('/api/explain', async (req, res) => {
  try {
    const { code, model = 'gpt-4-mini', mode = 'summary', language = 'auto' } = req.body || {};
    if (!code) return res.status(400).json({ error: 'No code provided' });

    // Always use Gemini for explanations. Require GEMINI_API_KEY to be configured.
    if (!GEMINI_API_KEY) {
      return res.status(400).json({ error: 'Server is configured to use Gemini for explanations but GEMINI_API_KEY is not set. Please add GEMINI_API_KEY to your .env.' });
    }

    const prompt = `You are a helpful code explainer. The user requested mode=${mode} and language=${language}. Provide a clear ${mode} of the code below.\n\nCode:\n${code}`;
    try {
      const explanation = await callGemini(prompt);
      return res.json({ explanation, source: 'gemini' });
    } catch (err) {
      console.error('Gemini explain failed:', err);
      return res.status(502).json({ error: 'Gemini API error', detail: String(err) });
    }

    // Local heuristic fallback explanation (unreachable because we require Gemini above)
    function naiveExplain(codeStr, mode) {
      const lines = codeStr.split(/\r?\n/).map(l => l.replace(/\t/g, '  '));
      if (mode === 'summary') {
        // build a tiny summary by looking for keywords
        const joined = codeStr.toLowerCase();
        if (/print\(/.test(joined)) return 'This snippet prints output to the console.';
        if (/def\s+\w+\(/.test(joined)) return 'This snippet defines one or more functions.';
        if (/class\s+\w+/.test(joined)) return 'This snippet defines a class.';
        if (/import\s+/.test(joined)) return 'This snippet imports external modules.';
        return 'Small code snippet — general purpose. Try "Line-by-line" mode for more detail.';
      }

      if (mode === 'doc') {
        // Produce a simple docstring-style description
        return 'Description:\n' + (lines.slice(0, 6).map((l, i) => `L${i+1}: ${l.trim()}`).join('\n')) + '\n\n(Use a real LLM for fuller documentation.)';
      }

      if (mode === 'refactor') {
        return 'Refactor suggestion:\n- Consider smaller functions, clearer variable names, and adding comments.\n- Run a linter or formatter (e.g., Prettier/Black) to normalize style.';
      }

      // default: line-by-line
      const out = [];
      for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        const t = raw.trim();
        if (!t) continue;
        let explanation = '';
        if (/^\s*#/.test(raw) || /^\/\//.test(raw)) explanation = 'Comment: ' + t.replace(/^#|^\/\//, '').trim();
        else if (/^\s*console\.log\(/.test(t) || /^\s*print\(/.test(t)) explanation = 'Prints a value to the console.';
        else if (/^\s*return\b/.test(t)) explanation = 'Returns a value from the current function.';
        else if (/^\s*def\s+\w+\s*\(/.test(t) || /^\s*function\s+\w+/.test(t)) explanation = 'Defines a function.';
        else if (/^\s*class\s+\w+/.test(t)) explanation = 'Defines a class/type.';
        else if (/^\s*for\s+/.test(t) || /^\s*while\s+/.test(t)) explanation = 'Loop: iterates over items or condition.';
        else if (/^\s*if\s+/.test(t) || /^\s*else\b/.test(t)) explanation = 'Conditional branch.';
        else if (/^\s*import\b/.test(t) || /^\s*from\b/.test(t)) explanation = 'Imports external module(s).' ;
        else explanation = 'Executes: ' + t;

        out.push(`Line ${i+1}: ${t}\n  → ${explanation}`);
      }
      return out.join('\n\n');
    }

    const explanation = naiveExplain(code, mode);
    return res.json({ explanation, source: 'local-fallback' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// serve index
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT} (port ${PORT})`);
});
