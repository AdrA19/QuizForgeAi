# QuizForge AI

Turn any document into an interactive quiz — solo or multiplayer, with an AI study assistant built in.

**Live site:** [adra19.github.io/QuizForgeAi](https://adra19.github.io/QuizForgeAi)

---

## What it does

- Upload PDFs, Word docs, PowerPoints, plain text, or Markdown files
- AI generates quiz questions from your content (MCQ, multi-answer, type-in)
- Play solo or host a real-time multiplayer game with a room code
- AI bots can fill empty lobby slots (scores simulated, no API calls)
- Built-in AI chat assistant with group and chat organisation
- Session persists across refreshes — resume mid-quiz after closing the tab

---

## Setup

### 1. Get an API key

QuizForge works with any OpenAI-compatible provider:

| Provider | Model suggestion | Notes |
|---|---|---|
| [Groq](https://console.groq.com) | `llama-3.1-8b-instant` | Free tier, fast, recommended |
| [OpenAI](https://platform.openai.com) | `gpt-4o-mini` | Paid, best quality |
| [DeepSeek](https://platform.deepseek.com) | `deepseek-chat` | Cheap, good quality |
| Any OpenAI-compatible endpoint | — | Set Custom in the modal |

### 2. Add the key in the app

Click **⚙ API Key** in the top right → choose your provider → paste your key → Save.

Your key stays in your browser only — never sent to any server except your chosen provider.

### 3. Upload and generate

Click **Create a Quiz** → upload your files → configure questions, timer, difficulty → choose Solo or Multiplayer → Generate.

---

## Multiplayer

### How it works

Multiplayer uses a real WebSocket backend (`server.js`) deployed separately. The GitHub Pages site connects to it automatically.

**Backend URL:** `wss://quizforge-multiplayer.onrender.com`

### Host a game

1. Choose **Multiplayer** mode when generating a quiz
2. Share the 4-letter room code with friends
3. Click **Start Quiz for Everyone** when ready

### Join a game

Click **Join with Code** on the home screen → enter the room code and your name.

### Deploy your own backend (optional)

If you fork this repo and want your own backend:

1. Push `server.js`, `package.json`, and `render.yaml` to your repo
2. Go to [render.com](https://render.com) → New → Blueprint → connect your repo
3. After deploy, copy your service URL (e.g. `https://your-service.onrender.com`)
4. In `index.html`, update:
   ```js
   const MP_SERVER_PROD = 'wss://your-service.onrender.com';
   ```
5. Commit and push

The backend requires no npm packages — runs with `node server.js` out of the box.

---

## Rate limits (Groq)

Groq free tier allows ~6,000 tokens per minute. One quiz generation can use most of that budget. If generation stops:

- Wait 60 seconds and try again
- Reduce question count (5–7 is safe on free tier)
- Lower **Max Tokens** in the API settings (2000 is default, try 1500)
- Reduce document size — only the first 4,000 characters are sent

---

## File structure

```
index.html       — entire frontend (single file app)
server.js        — WebSocket multiplayer backend (Node.js, no dependencies)
package.json     — backend package config
render.yaml      — Render deployment config
README.md        — this file
```

---

## Features

| Feature | Details |
|---|---|
| Question types | MCQ, multi-answer, type-in |
| Difficulty | Easy / Medium / Hard |
| Timer | Per-question countdown or no-timer mode |
| Session persistence | Survives page refresh |
| Leave quiz early | Goes straight to results with current score |
| AI Chat | Grouped chats with auto-naming, manual group naming |
| System prompts | Customisable, with presets and saved prompts |
| Leaderboard | Real-time scoring with AI bot simulation |
| Mobile support | Responsive UI, sidebar auto-collapses on mobile |

---

## Local development

```bash
# Run the multiplayer backend locally
node server.js
# Listens on ws://localhost:8787

# Open index.html in your browser
# (file:// protocol auto-detects local dev and uses ws://localhost:8787)
```

No build step required. Everything runs from the single HTML file.

---

## Tech stack

- Vanilla JS, HTML, CSS — no framework
- [PDF.js](https://mozilla.github.io/pdf.js/) for PDF extraction
- [Mammoth.js](https://github.com/mwilliamson/mammoth.js) for DOCX extraction
- Native WebSocket API (frontend) + Node.js `http` module (backend)
- Hosted on GitHub Pages (frontend) + Render (backend)
