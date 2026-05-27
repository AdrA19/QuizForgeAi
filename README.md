# QuizForge AI — Multiplayer backend (for GitHub Pages)

Your site on **GitHub Pages** (`https://adra19.github.io/QuizForgeAi/`) can only serve **static HTML**.  
Multiplayer needs a small **WebSocket server** hosted separately.

## Architecture

| Part | Where it lives |
|------|----------------|
| `QuizForge Ai.html` | GitHub Pages (static) |
| `server.js` | Render / Railway / Fly (Node, WebSocket) |

Everyone’s browser connects to the **same** `wss://` URL. The server keeps room state (players, AI bots, questions, start signal).

---

## 1) Deploy backend (Render — free)

1. Push this repo to GitHub (include `server.js`, `package.json`, `render.yaml`).
2. Go to [render.com](https://render.com) → **New** → **Blueprint** (or **Web Service**).
3. Connect your repo. Render will run: `node server.js`
4. After deploy, copy your service URL, e.g. `https://quizforge-multiplayer.onrender.com`
5. Your WebSocket URL is: **`wss://quizforge-multiplayer.onrender.com`** (same host, `wss` scheme).

> Free tier may sleep when idle; first connection can take ~30s.

---

## 2) Point the HTML at your backend (no extra user UI)

In `QuizForge Ai.html`, set:

```javascript
const MP_SERVER_PROD = 'wss://YOUR-SERVICE.onrender.com';
```

Commit and push to GitHub Pages.

---

## 3) Local testing

Terminal:

```bash
node server.js
```

Open the HTML locally → multiplayer uses `ws://localhost:8787` automatically.

---

## Notes

- Rooms are **in-memory**; restarting the server clears lobbies.
- GitHub Pages cannot run `server.js`; you must deploy it elsewhere.
- Use **`wss://`** on the live HTTPS site (GitHub Pages). `ws://` is blocked by browsers on HTTPS pages.
