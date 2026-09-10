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
  checkTimeout,
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

/** code -> { code, hostId, players: Map, removed: Set, game, timerId, updatedAt } */
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

/**
 * One timer per room, re-armed from the level's own deadline on every state
 * change. Nobody has to touch anything for a level to time out, so a real
 * setTimeout is the only thing that can end it.
 */
function syncTimer(room) {
  clearTimeout(room.timerId);
  room.timerId = null;
  const game = room.game;
  if (!game?.timed || game.deadlineAt == null) return;
  room.timerId = setTimeout(() => {
    checkTimeout(game, Date.now());
    broadcast(room);
  }, Math.max(0, game.deadlineAt - Date.now()));
}

/** Drop a room for good, timer and all, so nothing fires against a dead room. */
function deleteRoom(room) {
  clearTimeout(room.timerId);
  rooms.delete(room.code);
}

function broadcast(room) {
  room.updatedAt = Date.now();
  syncTimer(room);
  for (const p of room.players.values()) {
    if (p.connected) send(p.ws, roomState(room, p.id));
  }
}

const nameOfIn = (room) => (id) => room.players.get(id)?.name ?? 'Player';

/**
 * Tear the game down and return the room to a lobby. Seats are only held open
 * for the sake of a game in progress, so the ones nobody is sitting in go too.
 */
function endGame(room) {
  room.game = null;
  syncTimer(room); // not every caller broadcasts afterwards, so disarm here too
  for (const p of room.players.values()) if (!p.connected) room.players.delete(p.id);
  if (!room.players.has(room.hostId)) room.hostId = room.players.keys().next().value ?? null;
}

function handleCreate(ws, ctx, msg) {
  leaveCurrentRoom(ws, ctx);
  const room = {
    code: newRoomCode(),
    hostId: null,
    players: new Map(),
    removed: new Set(), // playerIds the host evicted, so they cannot auto-rejoin
    game: null,
    timerId: null,
    updatedAt: Date.now(),
  };
  rooms.set(room.code, room);
  joinRoom(ws, ctx, room, cleanName(msg.name), crypto.randomUUID());
}

function handleJoin(ws, ctx, msg) {
  const code = String(msg.code ?? '').trim().toUpperCase();
  const room = rooms.get(code);
  if (!room) return fail(ws, `No room called ${code || '—'}.`);
  if (msg.playerId && room.removed.has(msg.playerId)) return fail(ws, 'The host removed you from that room.');

  // A finished run is finished: the room drops back to the lobby as soon as
  // anyone joins, so nobody walks into the old game's lives and shurikens.
  if (room.game && (room.game.phase === 'won' || room.game.phase === 'lost')) endGame(room);

  // An impatient second tap on Join is the same person, not a new one. If this
  // socket already holds a seat here, hand that seat straight back instead of
  // dealing out another player.
  const held = ctx.room === room ? room.players.get(ctx.playerId) : null;
  if (held && held.ws === ws) return joinRoom(ws, ctx, room, held.name, held.id);

  // Reconnect path: a known playerId reclaims its seat, hand and all.
  const existing = msg.playerId && room.players.get(msg.playerId);
  if (existing) {
    if (existing.connected && existing.ws !== ws) existing.ws?.close(4000, 'Reconnected elsewhere');
    leaveCurrentRoom(ws, ctx);
    return joinRoom(ws, ctx, room, existing.name, existing.id);
  }

  if (room.game) return fail(ws, 'That game is already in progress.');
  if (room.players.size >= MAX_PLAYERS) return fail(ws, `That room is full (${MAX_PLAYERS} players).`);
  // One socket only ever owns one seat, so a join from elsewhere gives up the old one.
  leaveCurrentRoom(ws, ctx);
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

/**
 * Give up a seat. Before the game starts the seat is freed outright; mid-game it
 * is held open so a dropped phone can come back to the same hand.
 */
function dropSeat(room, playerId) {
  const player = room.players.get(playerId);
  if (!player) return;
  player.connected = false;
  player.ws = null;
  if (!room.game) {
    room.players.delete(playerId);
    if (room.hostId === playerId) room.hostId = room.players.keys().next().value ?? null;
  }
  if (room.players.size === 0) deleteRoom(room);
  else broadcast(room);
}

/** Release whatever seat this socket is holding, if it is still the owner. */
function leaveCurrentRoom(ws, ctx) {
  const { room, playerId } = ctx;
  ctx.room = null;
  ctx.playerId = null;
  if (!room || !playerId) return;
  if (room.players.get(playerId)?.ws !== ws) return; // superseded by a reconnect
  dropSeat(room, playerId);
}

/** Host eviction: the seat goes for good, and the player is told why. */
function evictPlayer(room, player) {
  const ws = player.ws;
  room.players.delete(player.id);
  room.removed.add(player.id);
  player.connected = false;
  player.ws = null;
  if (ws) {
    send(ws, { type: 'removed', message: 'The host removed you from the room.' });
    ws.close(4001, 'Removed by host');
  }
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
      room.game = createGame([...room.players.keys()], { timed: msg.timed === true });
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

    case 'removePlayer': {
      const room = ctx.room;
      if (!room) return fail(ws, 'You are not in a room.');
      if (room.hostId !== ctx.playerId) return fail(ws, 'Only the host can remove players.');
      if (room.game) return fail(ws, 'You can only remove players before the game starts.');
      const target = room.players.get(String(msg.playerId ?? ''));
      if (!target) return fail(ws, 'That player is no longer in the room.');
      if (target.id === ctx.playerId) return fail(ws, "You can't remove yourself — leave the room instead.");
      evictPlayer(room, target);
      return broadcast(room);
    }

    case 'playAgain': {
      const room = ctx.room;
      if (!room) return fail(ws, 'You are not in a room.');
      if (room.hostId !== ctx.playerId) return fail(ws, 'Only the host can start a new run.');
      endGame(room);
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
    if (room.players.get(playerId)?.ws !== ws) return; // superseded by a reconnect
    dropSeat(room, playerId);
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
    if (room.updatedAt < cutoff && activeIds(room).length === 0) deleteRoom(room);
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

/**
 * Where to tell people to point their phones. On a host the machine's own
 * address is an internal container IP that nobody can reach, so LAN advice
 * there is worse than useless — say what's actually true instead.
 */
function startupBanner() {
  const lines = ['', '  The Mind is running.', ''];

  // Railway, Render and Fly each publish the service's real hostname.
  const publicHost =
    process.env.RAILWAY_PUBLIC_DOMAIN ||
    process.env.RENDER_EXTERNAL_HOSTNAME ||
    (process.env.FLY_APP_NAME && `${process.env.FLY_APP_NAME}.fly.dev`);
  const hosted =
    publicHost ||
    process.env.RAILWAY_ENVIRONMENT ||
    process.env.RENDER ||
    process.env.FLY_APP_NAME;

  if (publicHost) {
    lines.push(`  Everyone opens:  https://${publicHost}`, '', '  Listening on port ' + PORT + '.');
  } else if (hosted) {
    lines.push(
      `  Listening on port ${PORT}.`,
      '',
      '  No public domain yet — generate one in your host\'s networking',
      '  settings, then open that URL on every phone.',
    );
  } else {
    // Local: phones can't use localhost, so print the LAN addresses.
    const lan = Object.values(os.networkInterfaces())
      .flat()
      .filter((i) => i && i.family === 'IPv4' && !i.internal)
      .map((i) => i.address);

    lines.push(`  This device:   http://localhost:${PORT}`);
    for (const address of lan) lines.push(`  Phones:        http://${address}:${PORT}`);
    if (!lan.length) lines.push('  No LAN address found — other devices may not be able to reach this.');
    lines.push('', '  Everyone opens the same URL, on the same wifi. Ctrl+C to stop.');
  }

  return lines.concat('').join('\n');
}

server.listen(PORT, () => console.log(startupBanner()));
