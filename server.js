'use strict';

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { Pool } = require('pg');

const PORT = Number(process.env.PORT || 8787);
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID || '';
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET || '';
const SESSION_SECRET = process.env.SESSION_SECRET || '';
const DATABASE_URL = process.env.DATABASE_URL || '';
const IS_PROD = process.env.NODE_ENV === 'production';
const FRONTEND = path.join(__dirname, 'index.html');

if (IS_PROD && (!SESSION_SECRET || SESSION_SECRET.length < 32)) {
  console.warn('WARNING: SESSION_SECRET should be a random value of at least 32 characters.');
}

const pool = DATABASE_URL ? new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 30000
}) : null;

async function initDb() {
  if (!pool) {
    console.warn('DATABASE_URL is not set. GitHub accounts are disabled; multiplayer still works.');
    return;
  }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      github_id TEXT UNIQUE NOT NULL,
      login TEXT NOT NULL,
      name TEXT,
      avatar_url TEXT,
      profile_url TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions(expires_at);
  `);
}

const rooms = new Map();
const clients = new Set();

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 4; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}
function now() { return Date.now(); }
function safeJsonParse(s) { try { return JSON.parse(s); } catch { return null; } }
function randomToken(bytes = 32) { return crypto.randomBytes(bytes).toString('base64url'); }
function sha256(s) { return crypto.createHash('sha256').update(s).digest('hex'); }
function hmac(s) { return crypto.createHmac('sha256', SESSION_SECRET || 'dev-only-secret').update(s).digest('hex'); }
function cookie(name, value, opts = {}) {
  let s = `${name}=${encodeURIComponent(value)}`;
  if (opts.maxAge !== undefined) s += `; Max-Age=${opts.maxAge}`;
  s += `; Path=${opts.path || '/'}`;
  if (opts.httpOnly !== false) s += '; HttpOnly';
  if (opts.secure ?? IS_PROD) s += '; Secure';
  s += `; SameSite=${opts.sameSite || 'Lax'}`;
  return s;
}
function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function send(res, status, body, type = 'application/json; charset=utf-8', extra = {}) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...extra });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}
function redirect(res, location, extraHeaders = {}) {
  res.writeHead(302, { Location: location, ...extraHeaders });
  res.end();
}
async function readBody(req, max = 1024 * 1024) {
  return await new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', chunk => {
      data += chunk;
      if (data.length > max) reject(new Error('Request too large'));
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}
function jsonBody(req) {
  return readBody(req).then(s => safeJsonParse(s) || {});
}
function githubRequest(url, options = {}, body = null) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: options.method || 'GET',
      headers: {
        Accept: 'application/json',
        'User-Agent': 'QuizForge-AI',
        ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } : {})
      }
    }, r => {
      let data = '';
      r.setEncoding('utf8');
      r.on('data', c => data += c);
      r.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(data); } catch { parsed = data; }
        if (r.statusCode >= 200 && r.statusCode < 300) resolve(parsed);
        else reject(new Error(`GitHub HTTP ${r.statusCode}`));
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function createSession(userId) {
  if (!pool) return null;
  const token = randomToken(32);
  const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  await pool.query('DELETE FROM sessions WHERE expires_at < NOW()');
  await pool.query('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,$3)', [sha256(token), userId, expires]);
  return token;
}
async function currentUser(req) {
  if (!pool) return null;
  const token = parseCookies(req).qf_session;
  if (!token) return null;
  const { rows } = await pool.query(`
    SELECT u.id,u.github_id,u.login,u.name,u.avatar_url,u.profile_url
    FROM sessions s JOIN users u ON u.id=s.user_id
    WHERE s.token_hash=$1 AND s.expires_at>NOW()
  `, [sha256(token)]);
  if (!rows[0]) return null;
  return rows[0];
}

async function githubLogin(req, res) {
  if (!GITHUB_CLIENT_ID || !GITHUB_CLIENT_SECRET) return send(res, 503, { error: 'GitHub OAuth is not configured.' });
  const state = randomToken(24);
  const signature = hmac(state);
  const stateCookie = `${state}.${signature}`;
  const callback = `${PUBLIC_URL}/auth/github/callback`;
  const url = new URL('https://github.com/login/oauth/authorize');
  url.searchParams.set('client_id', GITHUB_CLIENT_ID);
  url.searchParams.set('redirect_uri', callback);
  url.searchParams.set('scope', 'read:user user:email');
  url.searchParams.set('state', state);
  redirect(res, url.toString(), {
    'Set-Cookie': cookie('qf_oauth_state', stateCookie, { maxAge: 600 })
  });
}

async function githubCallback(req, res, url) {
  const supplied = url.searchParams.get('state') || '';
  const saved = parseCookies(req).qf_oauth_state || '';
  const [savedState, savedSig] = saved.split('.');
  if (!supplied || !savedState || supplied !== savedState || !crypto.timingSafeEqual(Buffer.from(savedSig || ''), Buffer.from(hmac(savedState)))) {
    return send(res, 400, { error: 'Invalid OAuth state.' });
  }
  const code = url.searchParams.get('code');
  if (!code) return send(res, 400, { error: 'GitHub did not return an authorization code.' });
  if (!pool) return send(res, 503, { error: 'Database is not configured.' });

  try {
    const tokenBody = new URLSearchParams({
      client_id: GITHUB_CLIENT_ID,
      client_secret: GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: `${PUBLIC_URL}/auth/github/callback`
    }).toString();
    const tokenData = await githubRequest('https://github.com/login/oauth/access_token', { method: 'POST' }, tokenBody);
    if (!tokenData.access_token) throw new Error('GitHub token exchange failed');

    const user = await githubRequest('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });
    const githubId = String(user.id);
    const result = await pool.query(`
      INSERT INTO users(github_id,login,name,avatar_url,profile_url)
      VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(github_id) DO UPDATE SET
        login=EXCLUDED.login,name=EXCLUDED.name,avatar_url=EXCLUDED.avatar_url,
        profile_url=EXCLUDED.profile_url,updated_at=NOW()
      RETURNING id
    `, [githubId, user.login || 'github-user', user.name || user.login || 'GitHub user', user.avatar_url || null, user.html_url || null]);

    const session = await createSession(result.rows[0].id);
    redirect(res, '/', {
      'Set-Cookie': [
        cookie('qf_session', session, { maxAge: 30 * 24 * 60 * 60 }),
        cookie('qf_oauth_state', '', { maxAge: 0 })
      ]
    });
  } catch (err) {
    console.error('GitHub OAuth error:', err);
    send(res, 500, { error: 'GitHub sign-in failed.' });
  }
}

async function handleHttp(req, res) {
  const url = new URL(req.url, PUBLIC_URL);
  try {
    if (req.method === 'GET' && url.pathname === '/') {
      if (!fs.existsSync(FRONTEND)) return send(res, 404, 'index.html not found', 'text/plain; charset=utf-8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      fs.createReadStream(FRONTEND).pipe(res);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true, service: 'quizforge-multiplayer' });
    if (req.method === 'GET' && url.pathname === '/auth/github') return githubLogin(req, res);
    if (req.method === 'GET' && url.pathname === '/auth/github/callback') return githubCallback(req, res, url);
    if (req.method === 'GET' && url.pathname === '/api/me') {
      const user = await currentUser(req);
      return send(res, 200, { user: user ? { id: user.id, login: user.login, name: user.name, avatar_url: user.avatar_url, profile_url: user.profile_url } : null });
    }
    if (req.method === 'POST' && url.pathname === '/auth/logout') {
      const token = parseCookies(req).qf_session;
      if (pool && token) await pool.query('DELETE FROM sessions WHERE token_hash=$1', [sha256(token)]);
      return send(res, 200, { ok: true }, 'application/json; charset=utf-8', { 'Set-Cookie': cookie('qf_session', '', { maxAge: 0 }) });
    }
    send(res, 404, { error: 'Not found' });
  } catch (err) {
    console.error('HTTP error:', err);
    send(res, 500, { error: 'Internal server error' });
  }
}

function wsSend(socket, msgObj) {
  if (!socket || socket.destroyed) return;
  const payload = Buffer.from(JSON.stringify(msgObj), 'utf8');
  socket.write(makeWsTextFrame(payload));
}
function broadcastRoom(roomCode, msgObj) {
  for (const c of clients) if (c.roomCode === roomCode) wsSend(c.socket, msgObj);
}
function roomSnapshot(room) {
  return { code: room.code, status: room.status, hostId: room.hostId, quizConfig: room.quizConfig, questions: room.questions, players: room.players };
}
function upsertPlayer(room, player) {
  const idx = room.players.findIndex(p => p.id === player.id);
  if (idx === -1) room.players.push(player); else room.players[idx] = { ...room.players[idx], ...player };
}
function removePlayer(room, playerId) {
  const idx = room.players.findIndex(p => p.id === playerId);
  if (idx !== -1) room.players.splice(idx, 1);
}

const server = http.createServer(handleHttp);

server.on('upgrade', (req, socket) => {
  try {
    const key = req.headers['sec-websocket-key'];
    if (!key) return socket.destroy();
    const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const client = { id: `c_${randomToken(10)}`, roomCode: null, socket };
    clients.add(client);
    wsSend(socket, { type: 'hello', clientId: client.id, serverTime: now() });

    socket.on('data', buf => {
      for (const text of parseWsFrames(buf)) {
        const msg = safeJsonParse(text);
        if (!msg || typeof msg.type !== 'string') { wsSend(socket, { type: 'error', message: 'Invalid message' }); continue; }
        if (msg.type === 'create_room') {
          const name = String(msg.name || '').trim().slice(0, 40) || 'Host';
          const quizConfig = msg.quizConfig || {};
          const questions = Array.isArray(msg.questions) ? msg.questions : [];
          const players = Array.isArray(msg.players) ? msg.players : null;
          let code = genCode(), tries = 0;
          while (rooms.has(code) && tries++ < 20) code = genCode();
          if (rooms.has(code)) { wsSend(socket, { type: 'error', message: 'Failed to create room' }); continue; }
          const room = { code, hostId: client.id, status: 'lobby', quizConfig, questions, players: [], createdAt: now() };
          if (players && players.length) {
            room.players = players.map(p => ({ id: String(p.id || '').trim() || `p_${randomToken(6)}`, name: String(p.name || '').slice(0, 40) || 'Player', isHost: !!p.isHost, isAI: !!p.isAI, score: Number(p.score || 0), color: String(p.color || '') }));
            upsertPlayer(room, { id: client.id, name, isHost: true, isAI: false, score: 0, color: room.players[0]?.color || '#7c6dfa' });
          } else room.players = [{ id: client.id, name, isHost: true, isAI: false, score: 0, color: '#7c6dfa' }];
          rooms.set(code, room); client.roomCode = code;
          wsSend(socket, { type: 'room_created', room: roomSnapshot(room) }); broadcastRoom(code, { type: 'room_update', room: roomSnapshot(room) }); continue;
        }
        if (msg.type === 'join_room') {
          const code = String(msg.code || '').trim().toUpperCase(), name = String(msg.name || '').trim().slice(0, 40) || 'Player', room = rooms.get(code);
          if (!room) { wsSend(socket, { type: 'join_denied', message: 'Room not found' }); continue; }
          client.roomCode = code; upsertPlayer(room, { id: client.id, name, isHost: false, isAI: false, score: 0, color: '#fa6d9a' });
          wsSend(socket, { type: 'join_accepted', room: roomSnapshot(room) }); broadcastRoom(code, { type: 'room_update', room: roomSnapshot(room) }); continue;
        }
        if (msg.type === 'host_update') {
          const code = client.roomCode, room = code && rooms.get(code);
          if (!room) { wsSend(socket, { type: 'error', message: 'Room not found' }); continue; }
          if (room.hostId !== client.id) { wsSend(socket, { type: 'error', message: 'Host only' }); continue; }
          if (msg.quizConfig) room.quizConfig = msg.quizConfig;
          if (Array.isArray(msg.questions)) room.questions = msg.questions;
          if (Array.isArray(msg.players)) room.players = msg.players.map(p => ({ id: String(p.id || '').trim() || `p_${randomToken(6)}`, name: String(p.name || '').slice(0, 40) || 'Player', isHost: !!p.isHost, isAI: !!p.isAI, score: Number(p.score || 0), color: String(p.color || '') }));
          const host = room.players.find(p => p.id === room.hostId); if (host) host.isHost = true;
          broadcastRoom(code, { type: 'room_update', room: roomSnapshot(room) }); continue;
        }
        if (msg.type === 'start_quiz') {
          const code = client.roomCode, room = code && rooms.get(code);
          if (!room) { wsSend(socket, { type: 'error', message: 'Room not found' }); continue; }
          if (room.hostId !== client.id) { wsSend(socket, { type: 'error', message: 'Host only' }); continue; }
          room.status = 'in_progress'; broadcastRoom(code, { type: 'quiz_started', room: roomSnapshot(room) }); continue;
        }
        if (msg.type === 'score_update') {
          const code = client.roomCode, room = code && rooms.get(code); if (!room) continue;
          upsertPlayer(room, { id: client.id, score: Number(msg.score || 0) }); broadcastRoom(code, { type: 'room_update', room: roomSnapshot(room) }); continue;
        }
        wsSend(socket, { type: 'error', message: 'Unknown message type' });
      }
    });
    socket.on('close', () => {
      clients.delete(client); const code = client.roomCode; if (!code) return;
      const room = rooms.get(code); if (!room) return;
      const wasHost = room.hostId === client.id; removePlayer(room, client.id);
      if (wasHost) { broadcastRoom(code, { type: 'room_closed', message: 'Host left. Room closed.' }); rooms.delete(code); return; }
      broadcastRoom(code, { type: 'room_update', room: roomSnapshot(room) });
    });
  } catch { socket.destroy(); }
});

function makeWsTextFrame(payloadBuf) {
  const len = payloadBuf.length;
  let header;
  if (len < 126) { header = Buffer.alloc(2); header[0] = 0x81; header[1] = len; }
  else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([header, payloadBuf]);
}
function parseWsFrames(buf) {
  const out = []; let offset = 0;
  while (offset + 2 <= buf.length) {
    const b0 = buf[offset], b1 = buf[offset + 1], fin = (b0 & 0x80) !== 0, opcode = b0 & 0x0f, masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f; offset += 2;
    if (len === 126) { if (offset + 2 > buf.length) break; len = buf.readUInt16BE(offset); offset += 2; }
    else if (len === 127) { if (offset + 8 > buf.length) break; len = Number(buf.readBigUInt64BE(offset)); offset += 8; }
    let maskKey = null;
    if (masked) { if (offset + 4 > buf.length) break; maskKey = buf.slice(offset, offset + 4); offset += 4; }
    if (offset + len > buf.length) break;
    let payload = buf.slice(offset, offset + len); offset += len;
    if (masked && maskKey) { const unmasked = Buffer.alloc(payload.length); for (let i = 0; i < payload.length; i++) unmasked[i] = payload[i] ^ maskKey[i % 4]; payload = unmasked; }
    if (!fin) continue; if (opcode === 0x8) break; if (opcode !== 0x1) continue; out.push(payload.toString('utf8'));
  }
  return out;
}

initDb().then(() => server.listen(PORT, () => console.log(`QuizForge server listening on ${PUBLIC_URL}`))).catch(err => {
  console.error('Database initialization failed:', err);
  process.exit(1);
});

process.on('SIGTERM', async () => { if (pool) await pool.end().catch(() => {}); process.exit(0); });
