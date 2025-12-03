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
  const body = {
    contents: [
      {
        role: 'user',
        parts: [
          { text: promptText }
        ]
      }
    ],
    // Optional generation config; keep minimal for now
    generationConfig: {
      // response modalities, length hints, temperature, etc. (optional)
      // For example: "maxOutputTokens": 512
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

// serve index
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT} (port ${PORT})`);
});
