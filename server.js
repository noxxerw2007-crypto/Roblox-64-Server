const http = require('http');
const { randomUUID } = require('crypto');
const { WebSocket, WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 10000;
const HOST = '0.0.0.0';
const MAX_PLAYERS_PER_ROOM = 30;
const MAX_MESSAGE_BYTES = 16 * 1024;
const MAX_MESSAGES_PER_WINDOW = 40;
const RATE_WINDOW_MS = 10_000;
const HEARTBEAT_MS = 25_000;

const rooms = new Map();

const server = http.createServer((req, res) => {
  if (req.url === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      service: 'roblox-64-server',
      websocket: '/ws',
      uptimeSeconds: Math.floor(process.uptime())
    }));
    return;
  }

  if (req.url === '/' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      name: 'Roblox 64 Multiplayer Server',
      status: 'online',
      health: '/health',
      websocket: '/ws',
      protocolVersion: 1
    }));
    return;
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not_found' }));
});

const wss = new WebSocketServer({
  server,
  path: '/ws',
  maxPayload: MAX_MESSAGE_BYTES
});

function send(ws, message) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

function roomKey(gameId, roomId) {
  return gameId + ':' + roomId;
}

function getRoom(gameId, roomId) {
  const key = roomKey(gameId, roomId);
  let room = rooms.get(key);

  if (!room) {
    room = { key, gameId, roomId, players: new Map() };
    rooms.set(key, room);
  }

  return room;
}

function broadcast(room, message, except = null) {
  for (const player of room.players.values()) {
    if (player.ws !== except) send(player.ws, message);
  }
}

function cleanRoom(room) {
  if (room && room.players.size === 0) rooms.delete(room.key);
}

function validSlug(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const cleaned = value.trim().toLowerCase();
  if (!/^[a-z0-9_-]{1,32}$/.test(cleaned)) return null;
  return cleaned;
}

function safeState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

  const result = {};
  const entries = Object.entries(value).slice(0, 24);

  for (const [key, item] of entries) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,31}$/.test(key)) continue;

    if (typeof item === 'number' && Number.isFinite(item)) {
      result[key] = Math.max(-1_000_000, Math.min(1_000_000, item));
    } else if (typeof item === 'string') {
      result[key] = item.slice(0, 64);
    } else if (typeof item === 'boolean' || item === null) {
      result[key] = item;
    }
  }

  return result;
}

function leaveRoom(ws) {
  const room = ws.room;
  if (!room) return;

  const playerId = ws.playerId;
  room.players.delete(playerId);
  ws.room = null;
  ws.playerId = null;

  broadcast(room, { type: 'player:left', playerId });
  cleanRoom(room);
}

function joinRoom(ws, message) {
  const gameId = validSlug(message.gameId, null);
  const roomId = validSlug(message.roomId, 'public');

  if (!gameId || !roomId) {
    send(ws, { type: 'error', code: 'invalid_room', message: 'Use simple game and room IDs (letters, numbers, _ or -).' });
    return;
  }

  const existing = rooms.get(roomKey(gameId, roomId));
  if (existing && existing.players.size >= MAX_PLAYERS_PER_ROOM) {
    send(ws, { type: 'error', code: 'room_full', message: 'This room is full.' });
    return;
  }

  leaveRoom(ws);

  const room = getRoom(gameId, roomId);
  if (room.players.size >= MAX_PLAYERS_PER_ROOM) {
    send(ws, { type: 'error', code: 'room_full', message: 'This room is full.' });
    cleanRoom(room);
    return;
  }

  const playerId = randomUUID();
  const displayName = typeof message.displayName === 'string'
    ? message.displayName.trim().replace(/[<>\u0000-\u001f]/g, '').slice(0, 20) || 'Player'
    : 'Player';

  const player = {
    playerId,
    displayName,
    state: {},
    ws
  };

  room.players.set(playerId, player);
  ws.room = room;
  ws.playerId = playerId;

  send(ws, {
    type: 'joined',
    playerId,
    gameId,
    roomId,
    maxPlayers: MAX_PLAYERS_PER_ROOM,
    players: Array.from(room.players.values(), p => ({
      playerId: p.playerId,
      displayName: p.displayName,
      state: p.state
    }))
  });

  broadcast(room, {
    type: 'player:joined',
    player: { playerId, displayName, state: {} }
  }, ws);
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.room = null;
  ws.playerId = null;
  ws.rateWindowStart = Date.now();
  ws.rateCount = 0;

  send(ws, { type: 'hello', protocolVersion: 1, message: 'Send a join message to enter a game room.' });

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (raw) => {
    const now = Date.now();

    if (now - ws.rateWindowStart >= RATE_WINDOW_MS) {
      ws.rateWindowStart = now;
      ws.rateCount = 0;
    }

    ws.rateCount += 1;
    if (ws.rateCount > MAX_MESSAGES_PER_WINDOW) {
      send(ws, { type: 'error', code: 'rate_limited', message: 'Slow down and try again.' });
      ws.close(1008, 'Rate limit exceeded');
      return;
    }

    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      send(ws, { type: 'error', code: 'bad_json', message: 'Messages must be valid JSON.' });
      return;
    }

    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      send(ws, { type: 'error', code: 'bad_message', message: 'Message must be a JSON object.' });
      return;
    }

    if (message.type === 'join') {
      joinRoom(ws, message);
      return;
    }

    const room = ws.room;
    if (!room) {
      send(ws, { type: 'error', code: 'not_in_room', message: 'Join a room first.' });
      return;
    }

    const player = room.players.get(ws.playerId);
    if (!player) return;

    if (message.type === 'player:update') {
      const state = safeState(message.state);
      if (!state) {
        send(ws, { type: 'error', code: 'invalid_state', message: 'Player state must be a JSON object.' });
        return;
      }

      player.state = state;
      broadcast(room, {
        type: 'player:updated',
        playerId: player.playerId,
        state
      }, ws);
      return;
    }

    if (message.type === 'game:event') {
      const eventName = typeof message.event === 'string' ? message.event : '';
      if (!/^[a-zA-Z][a-zA-Z0-9_.:-]{0,47}$/.test(eventName)) {
        send(ws, { type: 'error', code: 'invalid_event', message: 'Invalid event name.' });
        return;
      }

      const data = safeState(message.data || {});
      if (!data) {
        send(ws, { type: 'error', code: 'invalid_event_data', message: 'Event data must be a JSON object.' });
        return;
      }

      broadcast(room, {
        type: 'game:event',
        playerId: player.playerId,
        event: eventName,
        data
      }, ws);
      return;
    }

    if (message.type === 'chat:send') {
      const text = typeof message.text === 'string' ? message.text.trim().slice(0, 300) : '';
      if (!text) return;

      broadcast(room, {
        type: 'chat:message',
        playerId: player.playerId,
        displayName: player.displayName,
        text
      });
      return;
    }

    if (message.type === 'ping') {
      send(ws, { type: 'pong', time: Date.now() });
      return;
    }

    send(ws, { type: 'error', code: 'unknown_type', message: 'Unknown message type.' });
  });

  ws.on('close', () => leaveRoom(ws));
  ws.on('error', (error) => {
    console.error('WebSocket error:', error.message);
    leaveRoom(ws);
  });
});

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }

    ws.isAlive = false;
    ws.ping();
  }
}, HEARTBEAT_MS);

server.listen(PORT, HOST, () => {
  console.log('Roblox 64 server listening on ' + HOST + ':' + PORT);
  console.log('WebSocket endpoint: /ws');
});

function shutdown() {
  clearInterval(heartbeat);
  for (const ws of wss.clients) ws.close(1001, 'Server shutting down');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 8_000).unref();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
