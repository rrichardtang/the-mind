import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import {
  createGame,
  setReady,
  playCard,
  toggleStarVote,
  nextLevel,
  viewFor,
  levelsFor,
  MIN_PLAYERS,
  MAX_PLAYERS,
} from './game.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PORT = process.env.PORT || 3000;
const ROOM_TTL_MS = 6 * 60 * 60 * 1000; // rooms are dropped 6h after last activity

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // Cheap liveness probe for hosts that poll one (Railway's healthcheckPath).
  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size, uptime: Math.round(process.uptime()) }));
    return;
  }

  let filePath = path.join(PUBLIC_DIR, decodeURIComponent(url.pathname));
  // Keep requests inside public/, and treat unknown paths as the app shell.
  if (!filePath.startsWith(PUBLIC_DIR)) filePath = PUBLIC_DIR;
  if (!path.extname(filePath) || !fs.existsSync(filePath)) filePath = path.join(PUBLIC_DIR, 'index.html');

  fs.readFile(filePath, (err, body) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(body);
  });
});

const wss = new WebSocketServer({ server });

/** code -> { code, hostId, players: Map, game, updatedAt } */
const rooms = new Map();

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no look-alike glyphs
function newRoomCode() {
  let code;
  do {
    code = Array.from({ length: 4 }, () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]).join('');
  } while (rooms.has(code));
  return code;
}

const cleanName = (name) => String(name ?? '').trim().slice(0, 14) || 'Player';
const activeIds = (room) => [...room.players.values()].filter((p) => p.connected).map((p) => p.id);
const send = (ws, msg) => {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
};
const fail = (ws, message) => send(ws, { type: 'error', message });

function roomState(room, playerId) {
  const player = room.players.get(playerId);
  return {
    type: 'state',
    code: room.code,
    you: { id: playerId, name: player?.name, isHost: room.hostId === playerId },
    minPlayers: MIN_PLAYERS,
    maxPlayers: MAX_PLAYERS,
    lobby: [...room.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      connected: p.connected,
      isHost: p.id === room.hostId,
    })),
    plannedLevels: levelsFor(room.players.size),
    game: room.game ? viewFor(room.game, playerId, room.players) : null,
  };
}

function broadcast(room) {
  room.updatedAt = Date.now();
  for (const p of room.players.values()) {
    if (p.connected) send(p.ws, roomState(room, p.id));
  }
}

const nameOfIn = (room) => (id) => room.players.get(id)?.name ?? 'Player';

function handleCreate(ws, ctx, msg) {
  const room = { code: newRoomCode(), hostId: null, players: new Map(), game: null, updatedAt: Date.now() };
  rooms.set(room.code, room);
  joinRoom(ws, ctx, room, cleanName(msg.name), crypto.randomUUID());
}

function handleJoin(ws, ctx, msg) {
  const code = String(msg.code ?? '').trim().toUpperCase();
  const room = rooms.get(code);
  if (!room) return fail(ws, `No room called ${code || '—'}.`);

  // Reconnect path: a known playerId reclaims its seat, hand and all.
  const existing = msg.playerId && room.players.get(msg.playerId);
  if (existing) {
    if (existing.connected && existing.ws !== ws) existing.ws?.close(4000, 'Reconnected elsewhere');
    return joinRoom(ws, ctx, room, existing.name, existing.id);
  }

  if (room.game) return fail(ws, 'That game is already in progress.');
  if (room.players.size >= MAX_PLAYERS) return fail(ws, `That room is full (${MAX_PLAYERS} players).`);
  joinRoom(ws, ctx, room, cleanName(msg.name), crypto.randomUUID());
}

function joinRoom(ws, ctx, room, name, playerId) {
  const player = room.players.get(playerId) ?? { id: playerId, name };
  player.name = name;
  player.connected = true;
  player.ws = ws;
  room.players.set(playerId, player);
  if (!room.hostId || !room.players.has(room.hostId)) room.hostId = playerId;

  ctx.room = room;
  ctx.playerId = playerId;
  send(ws, { type: 'joined', code: room.code, playerId });
  broadcast(room);
}

function requireGame(ws, ctx) {
  const room = ctx.room;
  if (!room) {
    fail(ws, 'You are not in a room.');
    return null;
  }
  if (!room.game) {
    fail(ws, 'No game in progress.');
    return null;
  }
  return room;
}

function handleMessage(ws, ctx, msg) {
  switch (msg.type) {
    case 'create':
      return handleCreate(ws, ctx, msg);
    case 'join':
      return handleJoin(ws, ctx, msg);

    case 'start': {
      const room = ctx.room;
      if (!room) return fail(ws, 'You are not in a room.');
      if (room.hostId !== ctx.playerId) return fail(ws, 'Only the host can start the game.');
      if (room.game) return fail(ws, 'The game has already started.');
      if (room.players.size < MIN_PLAYERS) return fail(ws, `You need at least ${MIN_PLAYERS} players.`);
      room.game = createGame([...room.players.keys()]);
      return broadcast(room);
    }

    case 'ready': {
      const room = requireGame(ws, ctx);
      if (!room) return;
      setReady(room.game, ctx.playerId, activeIds(room));
      return broadcast(room);
    }

    case 'play': {
      const room = requireGame(ws, ctx);
      if (!room) return;
      const result = playCard(room.game, ctx.playerId, Number(msg.card), nameOfIn(room));
      if (!result.ok) return fail(ws, result.error);
      return broadcast(room);
    }

    case 'star': {
      const room = requireGame(ws, ctx);
      if (!room) return;
      const result = toggleStarVote(room.game, ctx.playerId, activeIds(room), nameOfIn(room));
      if (!result.ok) return fail(ws, result.error);
      return broadcast(room);
    }

    case 'nextLevel': {
      const room = requireGame(ws, ctx);
      if (!room) return;
      nextLevel(room.game);
      return broadcast(room);
    }

    case 'playAgain': {
      const room = ctx.room;
      if (!room) return fail(ws, 'You are not in a room.');
      if (room.hostId !== ctx.playerId) return fail(ws, 'Only the host can start a new run.');
      room.game = null;
      return broadcast(room);
    }

    case 'ping':
      return send(ws, { type: 'pong' });

    default:
      return fail(ws, `Unknown action: ${msg.type}`);
  }
}

wss.on('connection', (ws) => {
  const ctx = { room: null, playerId: null };
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return fail(ws, 'Malformed message.');
    }
    try {
      handleMessage(ws, ctx, msg);
    } catch (err) {
      console.error('handler error', err);
      fail(ws, 'Something went wrong handling that.');
    }
  });

  ws.on('close', () => {
    const { room, playerId } = ctx;
    if (!room || !playerId) return;
    const player = room.players.get(playerId);
    if (!player || player.ws !== ws) return; // superseded by a reconnect
    player.connected = false;
    player.ws = null;
    // Before the game starts a disconnect gives up the seat; mid-game the seat
    // is held open so a dropped phone can rejoin with the same hand.
    if (!room.game) {
      room.players.delete(playerId);
      if (room.hostId === playerId) room.hostId = room.players.keys().next().value ?? null;
    }
    if (room.players.size === 0) rooms.delete(room.code);
    else broadcast(room);
  });
});

// Drop dead sockets so disconnects register promptly on mobile.
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

const sweep = setInterval(() => {
  const cutoff = Date.now() - ROOM_TTL_MS;
  for (const [code, room] of rooms) {
    if (room.updatedAt < cutoff && activeIds(room).length === 0) rooms.delete(code);
  }
}, 10 * 60 * 1000);

server.on('close', () => {
  clearInterval(heartbeat);
  clearInterval(sweep);
});

// ws re-emits the http server's errors on the WebSocketServer, so both need a
// listener or a busy port becomes an unhandled 'error' event and a stack trace.
function onStartupError(err) {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  Port ${PORT} is already in use — The Mind may already be running.`);
    console.error(`  Stop it, or start on another port:  PORT=3001 npm start\n`);
    process.exit(1);
  }
  throw err;
}
server.on('error', onStartupError);
wss.on('error', onStartupError);

server.listen(PORT, () => {
  // Phones can't use localhost, so print the LAN addresses they should open.
  const lan = Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);

  console.log(`\n  The Mind is running.\n`);
  console.log(`  This device:   http://localhost:${PORT}`);
  for (const address of lan) console.log(`  Phones:        http://${address}:${PORT}`);
  if (!lan.length) console.log('  No LAN address found — other devices may not be able to reach this.');
  console.log(`\n  Everyone opens the same URL, on the same wifi. Ctrl+C to stop.\n`);
});
