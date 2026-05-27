const http = require('http');
const crypto = require('crypto');

const PORT = process.env.PORT ? Number(process.env.PORT) : 8787;

// In-memory rooms. (If server restarts, rooms are lost.)
// room = {
//   code, hostId, status: 'lobby'|'in_progress'|'finished',
//   quizConfig, questions, players: [{id,name,isHost,isAI,score,color}],
//   createdAt
// }
const rooms = new Map();

function genCode() {
  // 4 chars, easy to share
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 4; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function now() {
  return Date.now();
}

function safeJsonParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

// Minimal WebSocket server (no npm deps). Supports text frames only.
const clients = new Set(); // { id, roomCode, socket }

function wsSend(socket, msgObj) {
  if (!socket || socket.destroyed) return;
  const payload = Buffer.from(JSON.stringify(msgObj), 'utf8');
  socket.write(makeWsTextFrame(payload));
}

function broadcastRoom(roomCode, msgObj) {
  for (const c of clients) {
    if (c.roomCode === roomCode) wsSend(c.socket, msgObj);
  }
}

function roomSnapshot(room) {
  return {
    code: room.code,
    status: room.status,
    hostId: room.hostId,
    quizConfig: room.quizConfig,
    questions: room.questions,
    players: room.players
  };
}

function upsertPlayer(room, player) {
  const idx = room.players.findIndex(p => p.id === player.id);
  if (idx === -1) room.players.push(player);
  else room.players[idx] = { ...room.players[idx], ...player };
}

function removePlayer(room, playerId) {
  const idx = room.players.findIndex(p => p.id === playerId);
  if (idx !== -1) room.players.splice(idx, 1);
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('QuizForge AI multiplayer backend is running.\n');
});

server.on('upgrade', (req, socket) => {
  try {
    const key = req.headers['sec-websocket-key'];
    if (!key) { socket.destroy(); return; }
    const accept = crypto
      .createHash('sha1')
      .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64');

    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n` +
      '\r\n'
    );

    const client = { id: `c_${Math.random().toString(36).slice(2)}_${Date.now()}`, roomCode: null, socket };
    clients.add(client);

    wsSend(socket, { type: 'hello', clientId: client.id, serverTime: now() });

    socket.on('data', (buf) => {
      const frames = parseWsFrames(buf);
      for (const text of frames) {
        const msg = safeJsonParse(text);
        if (!msg || typeof msg.type !== 'string') {
          wsSend(socket, { type: 'error', message: 'Invalid message' });
          continue;
        }

        if (msg.type === 'create_room') {
          const name = String(msg.name || '').trim().slice(0, 40) || 'Host';
          const quizConfig = msg.quizConfig || {};
          const questions = Array.isArray(msg.questions) ? msg.questions : [];
          const players = Array.isArray(msg.players) ? msg.players : null;

          let code = genCode();
          let tries = 0;
          while (rooms.has(code) && tries++ < 20) code = genCode();
          if (rooms.has(code)) {
            wsSend(socket, { type: 'error', message: 'Failed to create room' });
            continue;
          }

          const room = { code, hostId: client.id, status: 'lobby', quizConfig, questions, players: [], createdAt: now() };
          if (players && players.length) {
            room.players = players.map(p => ({
              id: String(p.id || '').trim() || `p_${Math.random().toString(36).slice(2)}`,
              name: String(p.name || '').slice(0, 40) || 'Player',
              isHost: !!p.isHost,
              isAI: !!p.isAI,
              score: Number(p.score || 0),
              color: String(p.color || '')
            }));
            upsertPlayer(room, { id: client.id, name, isHost: true, isAI: false, score: 0, color: room.players[0]?.color || '#7c6dfa' });
          } else {
            room.players = [{ id: client.id, name, isHost: true, isAI: false, score: 0, color: '#7c6dfa' }];
          }

          rooms.set(code, room);
          client.roomCode = code;

          wsSend(socket, { type: 'room_created', room: roomSnapshot(room) });
          broadcastRoom(code, { type: 'room_update', room: roomSnapshot(room) });
          continue;
        }

        if (msg.type === 'join_room') {
          const code = String(msg.code || '').trim().toUpperCase();
          const name = String(msg.name || '').trim().slice(0, 40) || 'Player';
          const room = rooms.get(code);
          if (!room) { wsSend(socket, { type: 'join_denied', message: 'Room not found' }); continue; }

          client.roomCode = code;
          upsertPlayer(room, { id: client.id, name, isHost: false, isAI: false, score: 0, color: '#fa6d9a' });
          wsSend(socket, { type: 'join_accepted', room: roomSnapshot(room) });
          broadcastRoom(code, { type: 'room_update', room: roomSnapshot(room) });
          continue;
        }

        if (msg.type === 'host_update') {
          const code = client.roomCode;
          if (!code) { wsSend(socket, { type: 'error', message: 'Not in a room' }); continue; }
          const room = rooms.get(code);
          if (!room) { wsSend(socket, { type: 'error', message: 'Room not found' }); continue; }
          if (room.hostId !== client.id) { wsSend(socket, { type: 'error', message: 'Host only' }); continue; }

          if (msg.quizConfig) room.quizConfig = msg.quizConfig;
          if (Array.isArray(msg.questions)) room.questions = msg.questions;
          if (Array.isArray(msg.players)) {
            room.players = msg.players.map(p => ({
              id: String(p.id || '').trim() || `p_${Math.random().toString(36).slice(2)}`,
              name: String(p.name || '').slice(0, 40) || 'Player',
              isHost: !!p.isHost,
              isAI: !!p.isAI,
              score: Number(p.score || 0),
              color: String(p.color || '')
            }));
            const host = room.players.find(p => p.id === room.hostId);
            if (host) host.isHost = true;
          }

          broadcastRoom(code, { type: 'room_update', room: roomSnapshot(room) });
          continue;
        }

        if (msg.type === 'start_quiz') {
          const code = client.roomCode;
          if (!code) { wsSend(socket, { type: 'error', message: 'Not in a room' }); continue; }
          const room = rooms.get(code);
          if (!room) { wsSend(socket, { type: 'error', message: 'Room not found' }); continue; }
          if (room.hostId !== client.id) { wsSend(socket, { type: 'error', message: 'Host only' }); continue; }
          room.status = 'in_progress';
          broadcastRoom(code, { type: 'quiz_started', room: roomSnapshot(room) });
          continue;
        }

        if (msg.type === 'score_update') {
          const code = client.roomCode;
          if (!code) continue;
          const room = rooms.get(code);
          if (!room) continue;
          const score = Number(msg.score || 0);
          upsertPlayer(room, { id: client.id, score });
          broadcastRoom(code, { type: 'room_update', room: roomSnapshot(room) });
          continue;
        }

        wsSend(socket, { type: 'error', message: 'Unknown message type' });
      }
    });

    socket.on('close', () => {
      clients.delete(client);
      const code = client.roomCode;
      if (!code) return;
      const room = rooms.get(code);
      if (!room) return;
      const wasHost = room.hostId === client.id;
      removePlayer(room, client.id);
      if (wasHost) {
        broadcastRoom(code, { type: 'room_closed', message: 'Host left. Room closed.' });
        rooms.delete(code);
        return;
      }
      broadcastRoom(code, { type: 'room_update', room: roomSnapshot(room) });
    });
  } catch (e) {
    socket.destroy();
  }
});

function makeWsTextFrame(payloadBuf) {
  const len = payloadBuf.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x81;
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payloadBuf]);
}

function parseWsFrames(buf) {
  const out = [];
  let offset = 0;
  while (offset + 2 <= buf.length) {
    const b0 = buf[offset];
    const b1 = buf[offset + 1];
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    offset += 2;

    if (len === 126) {
      if (offset + 2 > buf.length) break;
      len = buf.readUInt16BE(offset);
      offset += 2;
    } else if (len === 127) {
      if (offset + 8 > buf.length) break;
      const big = buf.readBigUInt64BE(offset);
      offset += 8;
      len = Number(big);
    }

    let maskKey = null;
    if (masked) {
      if (offset + 4 > buf.length) break;
      maskKey = buf.slice(offset, offset + 4);
      offset += 4;
    }

    if (offset + len > buf.length) break;
    let payload = buf.slice(offset, offset + len);
    offset += len;

    if (masked && maskKey) {
      const unmasked = Buffer.alloc(payload.length);
      for (let i = 0; i < payload.length; i++) unmasked[i] = payload[i] ^ maskKey[i % 4];
      payload = unmasked;
    }

    if (!fin) continue;
    if (opcode === 0x8) break;
    if (opcode !== 0x1) continue;
    out.push(payload.toString('utf8'));
  }
  return out;
}

server.listen(PORT, () => {
  console.log(`QuizForge backend listening on http://localhost:${PORT}`);
});

