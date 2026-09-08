import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { WebSocket } from 'ws';

const PORT = 3971;
const URL = `ws://127.0.0.1:${PORT}`;

let server;

test.before(async () => {
  server = spawn(process.execPath, ['server/index.js'], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  // Poll the port rather than scraping stdout, so the banner's wording is free
  // to change without hanging the suite.
  server.stdout.resume();
  for (let i = 0; i < 100; i++) {
    try {
      await fetch(`http://127.0.0.1:${PORT}/`);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error('server did not start');
});

test.after(() => server?.kill());

/** A test client that queues messages so tests can await them by predicate. */
class Client {
  constructor() {
    this.queue = [];
    this.waiters = [];
    this.ws = new WebSocket(URL);
    this.ws.on('message', (raw) => {
      const msg = JSON.parse(raw);
      const i = this.waiters.findIndex((w) => w.match(msg));
      if (i >= 0) this.waiters.splice(i, 1)[0].resolve(msg);
      else this.queue.push(msg);
    });
  }
  static async open() {
    const c = new Client();
    await once(c.ws, 'open');
    return c;
  }
  send(msg) { this.ws.send(JSON.stringify(msg)); }
  next(match) {
    const i = this.queue.findIndex(match);
    if (i >= 0) return Promise.resolve(this.queue.splice(i, 1)[0]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for a message')), 4000);
      this.waiters.push({ match, resolve: (m) => { clearTimeout(timer); resolve(m); } });
    });
  }
  state(match = () => true) {
    return this.next((m) => m.type === 'state' && match(m));
  }
  close() { this.ws.close(); }
}

test('two players create, join, start, and see only their own hand', async () => {
  const host = await Client.open();
  const guest = await Client.open();

  host.send({ type: 'create', name: 'Richard' });
  const joined = await host.next((m) => m.type === 'joined');
  assert.match(joined.code, /^[A-Z0-9]{4}$/);

  await host.state();
  guest.send({ type: 'join', code: joined.code, name: 'Sam' });
  await guest.next((m) => m.type === 'joined');

  const lobby = await host.state((m) => m.lobby.length === 2);
  assert.deepEqual(lobby.lobby.map((p) => p.name), ['Richard', 'Sam']);
  assert.equal(lobby.you.isHost, true);
  assert.equal(lobby.plannedLevels, 12);

  host.send({ type: 'start' });
  const hs = await host.state((m) => m.game);
  const gs = await guest.state((m) => m.game);

  assert.equal(hs.game.phase, 'ready');
  assert.equal(hs.game.lives, 2);
  assert.equal(hs.game.shurikens, 1);
  assert.equal(hs.game.hand.length, 1);
  assert.equal(gs.game.hand.length, 1);
  assert.notDeepEqual(hs.game.hand, gs.game.hand);
  assert.equal(gs.you.isHost, false);

  // Neither player's payload may expose the other's card. A substring check on
  // the JSON would false-match digits inside `lives`/`level`, so look at the
  // only fields that ever carry card values, plus the shape of `seats`.
  const cardsVisibleTo = (v) => [...v.hand, ...v.pile, ...v.discarded, v.topCard].filter((c) => c != null);
  assert.deepEqual(cardsVisibleTo(hs.game), hs.game.hand, 'host sees only their own card');
  assert.equal(cardsVisibleTo(hs.game).includes(gs.game.hand[0]), false, 'guest card must not leak');
  assert.equal(cardsVisibleTo(gs.game).includes(hs.game.hand[0]), false, 'host card must not leak');
  assert.equal('hands' in hs.game, false, 'the raw hands map is never sent');
  assert.deepEqual(Object.keys(hs.game.seats[0]).sort(), ['cards', 'connected', 'id', 'name', 'ready', 'votedStar']);

  host.close();
  guest.close();
});

test('a level plays out and both clients agree on the result', async () => {
  const host = await Client.open();
  const guest = await Client.open();

  host.send({ type: 'create', name: 'Richard' });
  const { code } = await host.next((m) => m.type === 'joined');
  guest.send({ type: 'join', code, name: 'Sam' });
  await guest.next((m) => m.type === 'joined');
  await host.state((m) => m.lobby.length === 2);

  host.send({ type: 'start' });
  let hs = await host.state((m) => m.game);
  let gs = await guest.state((m) => m.game);

  host.send({ type: 'ready' });
  guest.send({ type: 'ready' });
  hs = await host.state((m) => m.game?.phase === 'playing');
  gs = await guest.state((m) => m.game?.phase === 'playing');

  // Play the genuinely lower card first, so this is a clean level.
  const hostLow = hs.game.hand[0] < gs.game.hand[0];
  const first = hostLow ? host : guest;
  const second = hostLow ? guest : host;
  const firstCard = hostLow ? hs.game.hand[0] : gs.game.hand[0];
  const secondCard = hostLow ? gs.game.hand[0] : hs.game.hand[0];

  first.send({ type: 'play', card: firstCard });
  await second.state((m) => m.game?.topCard === firstCard);
  second.send({ type: 'play', card: secondCard });

  const done = await host.state((m) => m.game?.phase === 'levelCleared');
  assert.equal(done.game.lives, 2, 'no lives lost on a clean level');
  const guestDone = await guest.state((m) => m.game?.phase === 'levelCleared');
  assert.equal(guestDone.game.level, 1);

  host.send({ type: 'nextLevel' });
  const next = await host.state((m) => m.game?.level === 2);
  assert.equal(next.game.phase, 'ready');
  assert.equal(next.game.hand.length, 2);

  host.close();
  guest.close();
});

test('a mistake costs a life on every client', async () => {
  const host = await Client.open();
  const guest = await Client.open();
  host.send({ type: 'create', name: 'Richard' });
  const { code } = await host.next((m) => m.type === 'joined');
  guest.send({ type: 'join', code, name: 'Sam' });
  await guest.next((m) => m.type === 'joined');
  await host.state((m) => m.lobby.length === 2);
  host.send({ type: 'start' });
  const hs = await host.state((m) => m.game);
  const gs = await guest.state((m) => m.game);
  host.send({ type: 'ready' });
  guest.send({ type: 'ready' });
  await host.state((m) => m.game?.phase === 'playing');
  await guest.state((m) => m.game?.phase === 'playing');

  // Deliberately play the higher card first.
  const hostHigh = hs.game.hand[0] > gs.game.hand[0];
  const wrong = hostHigh ? host : guest;
  const wrongCard = hostHigh ? hs.game.hand[0] : gs.game.hand[0];
  wrong.send({ type: 'play', card: wrongCard });

  const after = await guest.state((m) => m.game?.lives === 1);
  assert.equal(after.game.lives, 1);
  assert.ok(after.game.log.some((l) => l.kind === 'mistake'));

  host.close();
  guest.close();
});

test('a shuriken needs both players to agree', async () => {
  const host = await Client.open();
  const guest = await Client.open();
  host.send({ type: 'create', name: 'Richard' });
  const { code } = await host.next((m) => m.type === 'joined');
  guest.send({ type: 'join', code, name: 'Sam' });
  await guest.next((m) => m.type === 'joined');
  await host.state((m) => m.lobby.length === 2);
  host.send({ type: 'start' });
  await host.state((m) => m.game);
  await guest.state((m) => m.game);
  host.send({ type: 'ready' });
  guest.send({ type: 'ready' });
  await host.state((m) => m.game?.phase === 'playing');
  await guest.state((m) => m.game?.phase === 'playing');

  host.send({ type: 'star' });
  const oneVote = await guest.state((m) => m.game?.starVotes.length === 1);
  assert.equal(oneVote.game.shurikens, 1, 'one vote is not enough');

  guest.send({ type: 'star' });
  const thrown = await host.state((m) => m.game?.shurikens === 0);
  assert.ok(thrown.game.log.some((l) => l.kind === 'shuriken'));

  host.close();
  guest.close();
});

test('a dropped player keeps their seat and hand when they rejoin', async () => {
  const host = await Client.open();
  const guest = await Client.open();
  host.send({ type: 'create', name: 'Richard' });
  const { code } = await host.next((m) => m.type === 'joined');
  guest.send({ type: 'join', code, name: 'Sam' });
  const guestJoin = await guest.next((m) => m.type === 'joined');
  await host.state((m) => m.lobby.length === 2);
  host.send({ type: 'start' });
  await host.state((m) => m.game);
  const before = await guest.state((m) => m.game);

  guest.close();
  await host.state((m) => m.game?.seats.some((s) => !s.connected));

  const rejoined = await Client.open();
  rejoined.send({ type: 'join', code, name: 'Sam', playerId: guestJoin.playerId });
  const after = await rejoined.state((m) => m.game);
  assert.deepEqual(after.game.hand, before.game.hand, 'same hand after reconnecting');
  assert.equal(after.you.id, guestJoin.playerId);
  assert.ok(after.game.seats.every((s) => s.connected));

  host.close();
  rejoined.close();
});

test('bad rooms, non-host starts, and undersized games are rejected', async () => {
  const c = await Client.open();
  c.send({ type: 'join', code: 'ZZZZ', name: 'Nobody' });
  assert.match((await c.next((m) => m.type === 'error')).message, /No room called ZZZZ/);

  c.send({ type: 'create', name: 'Solo' });
  await c.next((m) => m.type === 'joined');
  c.send({ type: 'start' });
  assert.match((await c.next((m) => m.type === 'error')).message, /at least 2 players/);

  const guest = await Client.open();
  const state = await c.state();
  guest.send({ type: 'join', code: state.code, name: 'Two' });
  await guest.next((m) => m.type === 'joined');
  guest.send({ type: 'start' });
  assert.match((await guest.next((m) => m.type === 'error')).message, /Only the host/);

  c.close();
  guest.close();
});

test('a game in progress cannot be joined by a newcomer', async () => {
  const host = await Client.open();
  const guest = await Client.open();
  host.send({ type: 'create', name: 'Richard' });
  const { code } = await host.next((m) => m.type === 'joined');
  guest.send({ type: 'join', code, name: 'Sam' });
  await guest.next((m) => m.type === 'joined');
  await host.state((m) => m.lobby.length === 2);
  host.send({ type: 'start' });
  await host.state((m) => m.game);

  const late = await Client.open();
  late.send({ type: 'join', code, name: 'Late' });
  assert.match((await late.next((m) => m.type === 'error')).message, /already in progress/);

  host.close(); guest.close(); late.close();
});

test('the app shell is served over http', async () => {
  const res = await fetch(`http://127.0.0.1:${PORT}/`);
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /<title>The Mind<\/title>/);

  const css = await fetch(`http://127.0.0.1:${PORT}/styles.css`);
  assert.equal(css.headers.get('content-type'), 'text/css; charset=utf-8');
});
