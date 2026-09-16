import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createGame,
  setReady,
  playCard,
  toggleStarVote,
  toggleEndVote,
  acknowledgeMistake,
  dismissRun,
  settleGates,
  nextLevel,
  checkTimeout,
  setClockPaused,
  viewFor,
  levelsFor,
  SECONDS_PER_CARD,
} from '../server/game.js';

const IDS = ['a', 'b', 'c'];
const nameOf = (id) => id.toUpperCase();

/** A game with hands forced to known values, already in the playing phase. */
function staged(hands, ids = IDS) {
  const g = createGame(ids);
  ids.forEach((id) => setReady(g, id, ids));
  g.hands = structuredClone(hands);
  return g;
}

/** Everyone owns the mistake on the table, which is what lets play go on. */
function ownUp(g, ids = IDS) {
  ids.forEach((id) => acknowledgeMistake(g, id));
  settleGates(g, ids);
}

test('level counts follow player count', () => {
  assert.equal(levelsFor(2), 12);
  assert.equal(levelsFor(3), 10);
  assert.equal(levelsFor(4), 8);
});

test('a new game deals one card each and starts with one life per player', () => {
  const g = createGame(IDS);
  assert.equal(g.level, 1);
  assert.equal(g.lives, 3);
  assert.equal(g.shurikens, 1);
  assert.equal(g.phase, 'ready');
  const all = IDS.flatMap((id) => g.hands[id]);
  assert.equal(all.length, 3);
  assert.equal(new Set(all).size, 3, 'cards are distinct');
  assert.ok(all.every((c) => c >= 1 && c <= 100));
});

test('the level only starts once everyone is ready', () => {
  const g = createGame(IDS);
  setReady(g, 'a', IDS);
  setReady(g, 'b', IDS);
  assert.equal(g.phase, 'ready');
  setReady(g, 'c', IDS);
  assert.equal(g.phase, 'playing');
});

test('cards cannot be played before the level starts', () => {
  const g = createGame(IDS);
  const card = g.hands.a[0];
  assert.equal(playCard(g, 'a', card, nameOf).ok, false);
});

test('playing the lowest outstanding card is safe', () => {
  const g = staged({ a: [5, 40], b: [20], c: [70] });
  assert.equal(playCard(g, 'a', 5, nameOf).ok, true);
  assert.equal(g.lives, 3);
  assert.deepEqual(g.pile.map((p) => p.card), [5]);
  assert.deepEqual(g.hands.a, [40]);
});

test('only your lowest card is playable', () => {
  const g = staged({ a: [5, 40], b: [20], c: [70] });
  const res = playCard(g, 'a', 40, nameOf);
  assert.equal(res.ok, false);
  assert.match(res.error, /lowest/);
  assert.deepEqual(g.hands.a, [5, 40]);
});

test('a card you do not hold is rejected', () => {
  const g = staged({ a: [5], b: [20], c: [70] });
  assert.equal(playCard(g, 'a', 99, nameOf).ok, false);
});

test('playing too high costs exactly one life and burns every lower card', () => {
  const g = staged({ a: [50], b: [10, 20], c: [30] });
  playCard(g, 'a', 50, nameOf);
  assert.equal(g.lives, 2, 'one life lost, not one per burned card');
  assert.deepEqual(g.hands.b, []);
  assert.deepEqual(g.hands.c, []);
  assert.deepEqual(g.discarded, [10, 20, 30]);
  assert.deepEqual(g.pile.map((p) => p.card), [50]);
});

test('running out of lives ends the run, once the mistake is owned', () => {
  const g = staged({ a: [90], b: [1], c: [2] });
  g.lives = 1;
  playCard(g, 'a', 90, nameOf);
  assert.equal(g.lives, 0, 'the life goes straight away');
  assert.equal(g.phase, 'mistake', 'but the run is not over until they have seen why');
  ownUp(g);
  assert.equal(g.phase, 'lost');
  assert.equal(g.lostTo, 'lives');
});

test('a mistake that empties every hand still ends the level', () => {
  const g = staged({ a: [50], b: [10], c: [30] });
  playCard(g, 'a', 50, nameOf);
  assert.equal(g.lives, 2);
  assert.equal(g.phase, 'mistake');
  ownUp(g);
  assert.equal(g.phase, 'levelCleared');
});

test('a mistake logs the culprit and every player it burned a card from', () => {
  const g = staged({ a: [50], b: [10, 20], c: [30] });
  playCard(g, 'a', 50, nameOf);
  const entry = g.log.find((e) => e.kind === 'mistake');
  assert.ok(entry);
  assert.equal(entry.culprit, 'a');
  assert.deepEqual([...entry.victims].sort(), ['b', 'c']);
  assert.deepEqual(entry.burned, [10, 20, 30]);
});

/* ── The mistake gate ───────────────────────────────────── */

test('a mistake names the player who jumped and the one sitting on the lowest card', () => {
  const g = staged({ a: [50], b: [30], c: [10, 20] });
  playCard(g, 'a', 50, nameOf);
  assert.equal(g.phase, 'mistake');
  assert.equal(g.mistake.culprit, 'a');
  assert.equal(g.mistake.victim, 'c', 'the lowest card was C\u2019s, not every burned player');
  assert.equal(g.mistake.card, 50);
  assert.equal(g.mistake.lowest, 10);
  assert.equal(typeof g.mistake.culpritMessage, 'string');
  assert.ok(g.mistake.culpritMessage.length > 0);
  assert.equal(typeof g.mistake.victimMessage, 'string');
  assert.ok(g.mistake.victimMessage.length > 0);
});

test('nothing can be played or thrown until the mistake is owned', () => {
  const g = staged({ a: [50, 60], b: [10], c: [70] });
  playCard(g, 'a', 50, nameOf);

  const blocked = playCard(g, 'c', 70, nameOf);
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /mistake/i);
  assert.equal(toggleStarVote(g, 'c', IDS, nameOf).ok, false);
  assert.deepEqual(g.hands.c, [70], 'the card stays in their hand');

  ownUp(g);
  assert.equal(g.phase, 'playing');
  assert.equal(playCard(g, 'a', 60, nameOf).ok, true);
});

test('only the two players it was between can own a mistake, and both must', () => {
  const g = staged({ a: [50, 60], b: [10], c: [70] });
  playCard(g, 'a', 50, nameOf);

  acknowledgeMistake(g, 'c'); // a bystander cannot wave it through
  settleGates(g, IDS);
  assert.equal(g.phase, 'mistake');
  assert.deepEqual(g.mistake.acks, []);

  acknowledgeMistake(g, 'a');
  acknowledgeMistake(g, 'a'); // twice is once
  settleGates(g, IDS);
  assert.deepEqual(g.mistake.acks, ['a']);
  assert.equal(g.phase, 'mistake', 'one of the two is not enough');

  acknowledgeMistake(g, 'b');
  settleGates(g, IDS);
  assert.equal(g.phase, 'playing');
  assert.equal(g.mistake, null);
});

test('a player who is gone is not waited on', () => {
  const g = staged({ a: [50, 60], b: [10], c: [70] });
  playCard(g, 'a', 50, nameOf);
  acknowledgeMistake(g, 'a');
  // B's phone died holding the card that should have gone first.
  settleGates(g, ['a', 'c']);
  assert.equal(g.phase, 'playing', 'the table is not frozen behind an empty seat');
});

test('the ready gate does not hang on a phone that died before tapping ready', () => {
  const g = createGame(IDS);
  setReady(g, 'a', IDS);
  setReady(g, 'b', IDS);
  assert.equal(g.phase, 'ready', 'C has not said ready');

  // C's phone dies without ever tapping. Nobody is going to tap it for them,
  // and A and B have no ready button left to press.
  settleGates(g, ['a', 'b']);
  assert.equal(g.phase, 'playing', 'the table that is here gets on with it');
});

test('the ready gate still waits on everyone who is actually here', () => {
  const g = createGame(IDS);
  setReady(g, 'a', IDS);
  settleGates(g, ['a', 'b']);
  assert.equal(g.phase, 'ready', 'B is here and has not said ready');
  settleGates(g, []);
  assert.equal(g.phase, 'ready', 'an empty room starts nothing');
});

test('the next level is dealt without a mistake hanging over it', () => {
  const g = staged({ a: [50], b: [10], c: [30] });
  playCard(g, 'a', 50, nameOf);
  ownUp(g);
  nextLevel(g);
  assert.equal(g.phase, 'ready');
  assert.equal(g.mistake, null);
});

/* ── Stepping away from a lost run ──────────────────────── */

test('a lost run waits for every player before the room moves on', () => {
  const g = staged({ a: [90], b: [1], c: [2] });
  g.lives = 1;
  playCard(g, 'a', 90, nameOf);
  ownUp(g);
  assert.equal(g.phase, 'lost');

  assert.equal(settleGates(g, IDS), false, 'nobody has said they are done');
  dismissRun(g, 'a');
  dismissRun(g, 'a');
  assert.deepEqual(g.done, ['a']);
  assert.equal(settleGates(g, IDS), false);

  dismissRun(g, 'b');
  assert.equal(settleGates(g, IDS), false, 'C is still looking at it');
  dismissRun(g, 'c');
  assert.equal(settleGates(g, IDS), true);
});

test('a lost run is only ever dismissed by players who are still here', () => {
  const g = staged({ a: [90], b: [1], c: [2] });
  g.lives = 1;
  playCard(g, 'a', 90, nameOf);
  ownUp(g);

  dismissRun(g, 'a');
  assert.equal(settleGates(g, ['a', 'b']), false);
  assert.equal(settleGates(g, ['a']), true, 'the others walked off; A is the whole table');
  assert.equal(settleGates(g, []), false, 'an empty room ends nothing on its own');
});

test('a run still being played is never dismissed', () => {
  const g = staged({ a: [5], b: [20], c: [70] });
  dismissRun(g, 'a');
  assert.deepEqual(g.done, []);
  assert.equal(settleGates(g, IDS), false);
});

/* ── Ending a run stalled on somebody who is away ───────── */

test('a run stalled on a missing player is ended by everyone still here', () => {
  const g = staged({ a: [5], b: [20], c: [70] });
  const here = ['a', 'c']; // B's phone is gone, and nobody else can play B's 20

  assert.equal(toggleEndVote(g, 'a', here).ok, true);
  assert.deepEqual(g.endVotes, ['a']);
  assert.equal(settleGates(g, here), false, 'C has not agreed');

  assert.equal(toggleEndVote(g, 'c', here).ok, true);
  assert.equal(settleGates(g, here), true, 'the table agreed, so the room clears the run away');
});

test('a run everybody is present for cannot be voted away', () => {
  const g = staged({ a: [5], b: [20], c: [70] });
  const result = toggleEndVote(g, 'a', IDS);
  assert.equal(result.ok, false);
  assert.match(result.error, /Everyone is here/);
  assert.deepEqual(g.endVotes, []);
});

test('a vote to end is dropped the moment the missing player comes back', () => {
  const g = staged({ a: [5], b: [20], c: [70] });
  toggleEndVote(g, 'a', ['a', 'c']);
  toggleEndVote(g, 'c', ['a', 'c']);

  // B reconnects in the same breath: the stall is over, so the vote is too.
  assert.equal(settleGates(g, IDS), false, 'a recovered run is never ended by an old vote');
  assert.deepEqual(g.endVotes, []);
  assert.equal(g.phase, 'playing');
});

test('a vote to end can be taken back', () => {
  const g = staged({ a: [5], b: [20], c: [70] });
  const here = ['a', 'c'];
  toggleEndVote(g, 'a', here);
  toggleEndVote(g, 'a', here);
  assert.deepEqual(g.endVotes, []);
  assert.equal(settleGates(g, here), false);
});

test('a finished run is left alone by the vote that ends a stalled one', () => {
  const g = staged({ a: [90], b: [1], c: [2] });
  g.lives = 1;
  playCard(g, 'a', 90, nameOf);
  ownUp(g);
  assert.equal(g.phase, 'lost');

  const result = toggleEndVote(g, 'a', ['a', 'c']);
  assert.equal(result.ok, false);
  assert.match(result.error, /already over/);
  assert.deepEqual(g.endVotes, [], 'a lost run is stepped away from, not voted away');
});

test('the view carries the vote so every client can see it building', () => {
  const g = staged({ a: [5], b: [20], c: [70] });
  toggleEndVote(g, 'a', ['a', 'c']);
  const players = new Map(IDS.map((id) => [id, { name: nameOf(id), connected: id !== 'b' }]));
  assert.deepEqual(viewFor(g, 'c', players).endVotes, ['a']);
});

test('a shuriken needs unanimous votes and discards each lowest card', () => {
  const g = staged({ a: [5, 40], b: [20], c: [70] });
  toggleStarVote(g, 'a', IDS, nameOf);
  toggleStarVote(g, 'b', IDS, nameOf);
  assert.equal(g.shurikens, 1, 'not thrown before everyone agrees');
  toggleStarVote(g, 'c', IDS, nameOf);
  assert.equal(g.shurikens, 0);
  assert.deepEqual(g.discarded, [5, 20, 70]);
  assert.deepEqual(g.hands.a, [40]);
  assert.deepEqual(g.starVotes, []);
});

test('a shuriken vote can be taken back', () => {
  const g = staged({ a: [5], b: [20], c: [70] });
  toggleStarVote(g, 'a', IDS, nameOf);
  toggleStarVote(g, 'a', IDS, nameOf);
  assert.deepEqual(g.starVotes, []);
  assert.equal(g.shurikens, 1);
});

test('a shuriken skips empty hands and can clear the level', () => {
  const g = staged({ a: [], b: [20], c: [70] });
  IDS.forEach((id) => toggleStarVote(g, id, IDS, nameOf));
  assert.deepEqual(g.discarded, [20, 70]);
  assert.equal(g.phase, 'levelCleared');
});

test('shurikens cannot be thrown when there are none left', () => {
  const g = staged({ a: [5], b: [20], c: [70] });
  g.shurikens = 0;
  assert.equal(toggleStarVote(g, 'a', IDS, nameOf).ok, false);
});

test('playing a card clears any pending shuriken votes', () => {
  const g = staged({ a: [5, 40], b: [20], c: [70] });
  toggleStarVote(g, 'a', IDS, nameOf);
  playCard(g, 'a', 5, nameOf);
  assert.deepEqual(g.starVotes, []);
});

test('clearing a level deals the next one and re-arms the ready gate', () => {
  const g = staged({ a: [5], b: [20], c: [70] });
  playCard(g, 'a', 5, nameOf);
  playCard(g, 'b', 20, nameOf);
  playCard(g, 'c', 70, nameOf);
  assert.equal(g.phase, 'levelCleared');

  nextLevel(g);
  assert.equal(g.level, 2);
  assert.equal(g.phase, 'ready');
  assert.deepEqual(g.ready, []);
  assert.equal(g.pile.length, 0);
  assert.equal(g.discarded.length, 0);
  IDS.forEach((id) => assert.equal(g.hands[id].length, 2));
});

test('clearing level 2 awards a shuriken and level 3 a life', () => {
  const g = staged({ a: [5], b: [20], c: [70] });
  g.level = 2;
  g.shurikens = 1;
  playCard(g, 'a', 5, nameOf);
  playCard(g, 'b', 20, nameOf);
  playCard(g, 'c', 70, nameOf);
  assert.equal(g.shurikens, 2);
  assert.equal(g.lastReward, 'shuriken');

  const h = staged({ a: [5], b: [20], c: [70] });
  h.level = 3;
  h.lives = 1;
  playCard(h, 'a', 5, nameOf);
  playCard(h, 'b', 20, nameOf);
  playCard(h, 'c', 70, nameOf);
  assert.equal(h.lives, 2);
  assert.equal(h.lastReward, 'life');
});

test('rewards respect the caps', () => {
  const g = staged({ a: [5], b: [20], c: [70] });
  g.level = 3;
  g.lives = 5;
  playCard(g, 'a', 5, nameOf);
  playCard(g, 'b', 20, nameOf);
  playCard(g, 'c', 70, nameOf);
  assert.equal(g.lives, 5);
  assert.equal(g.lastReward, null);
});

test('clearing the final level wins the run', () => {
  const g = staged({ a: [5], b: [20], c: [70] });
  g.level = g.maxLevel;
  playCard(g, 'a', 5, nameOf);
  playCard(g, 'b', 20, nameOf);
  playCard(g, 'c', 70, nameOf);
  assert.equal(g.phase, 'won');
  assert.equal(nextLevel(g), undefined);
  assert.equal(g.level, g.maxLevel, 'nextLevel is a no-op after a win');
});

test('a player view hides other hands but reveals their sizes', () => {
  const g = staged({ a: [5, 40], b: [20], c: [70] });
  const players = new Map(IDS.map((id) => [id, { id, name: nameOf(id), connected: true }]));
  const view = viewFor(g, 'a', players);
  assert.deepEqual(view.hand, [5, 40]);
  assert.equal(JSON.stringify(view).includes('20'), false, 'B’s card 20 must not leak');
  assert.deepEqual(view.seats.map((s) => s.cards), [2, 1, 1]);
  assert.equal(view.cardsRemaining, 4);
});

test('the mistake reaches each player in their own words, and hides nobody', () => {
  const g = staged({ a: [50], b: [30], c: [10, 20] });
  playCard(g, 'a', 50, nameOf);
  const players = new Map(IDS.map((id) => [id, { id, name: nameOf(id), connected: true }]));

  const culprit = viewFor(g, 'a', players).mistake;
  assert.equal(culprit.message, g.mistake.culpritMessage);
  assert.deepEqual(culprit.waitingOn, ['a', 'c']);
  assert.equal(culprit.lowest, 10);
  assert.equal(culprit.victim, 'c');

  assert.equal(viewFor(g, 'c', players).mistake.message, g.mistake.victimMessage);
  assert.equal(viewFor(g, 'b', players).mistake.message, null, 'a bystander gets no line of their own');

  // Nobody waits on a player who is no longer there.
  acknowledgeMistake(g, 'a');
  players.set('c', { id: 'c', name: 'C', connected: false });
  assert.deepEqual(viewFor(g, 'b', players).mistake.waitingOn, []);
});

test('a two player game runs 12 levels with 2 lives', () => {
  const g = createGame(['a', 'b']);
  assert.equal(g.maxLevel, 12);
  assert.equal(g.lives, 2);
});

test('lives lost are tracked per level and reset on the next deal', () => {
  const g = staged({ a: [50], b: [10], c: [30] });
  assert.equal(g.livesLostThisLevel, 0);
  playCard(g, 'a', 50, nameOf);
  assert.equal(g.livesLostThisLevel, 1, 'a botched level is distinguishable from a clean one');
  ownUp(g);
  nextLevel(g);
  assert.equal(g.livesLostThisLevel, 0);
});

test('a clean level reports no lives lost', () => {
  const g = staged({ a: [5], b: [20], c: [70] });
  playCard(g, 'a', 5, nameOf);
  playCard(g, 'b', 20, nameOf);
  playCard(g, 'c', 70, nameOf);
  assert.equal(g.phase, 'levelCleared');
  assert.equal(g.livesLostThisLevel, 0);
});

/* ── Timed runs ─────────────────────────────────────────── */

const timedGame = () => createGame(IDS, { timed: true });

test('the clock only starts when the level does', () => {
  const g = timedGame();
  const now = 1_700_000_000_000;
  setReady(g, 'a', IDS, now);
  assert.equal(g.deadlineAt, null, 'the ready gate is untimed');
  setReady(g, 'b', IDS, now);
  setReady(g, 'c', IDS, now);
  assert.equal(g.deadlineAt, now + SECONDS_PER_CARD * 1000 * IDS.length * g.level, '20s per card dealt');
});

test('an untimed run never gets a deadline', () => {
  const g = createGame(IDS);
  IDS.forEach((id) => setReady(g, id, IDS));
  assert.equal(g.timed, false);
  assert.equal(g.deadlineAt, null);
  checkTimeout(g, Date.now() + 10 * 60 * 60 * 1000);
  assert.equal(g.phase, 'playing');
});

test('clearing a level stops the clock, and the next level restarts it', () => {
  const g = timedGame();
  IDS.forEach((id) => setReady(g, id, IDS));
  g.hands = { a: [5], b: [20], c: [70] };
  playCard(g, 'a', 5, nameOf);
  playCard(g, 'b', 20, nameOf);
  playCard(g, 'c', 70, nameOf);
  assert.equal(g.phase, 'levelCleared');
  assert.equal(g.deadlineAt, null);

  nextLevel(g);
  assert.equal(g.deadlineAt, null);
  IDS.forEach((id) => setReady(g, id, IDS));
  assert.ok(g.deadlineAt > Date.now());
});

test('the clock running out loses the whole run', () => {
  const g = timedGame();
  IDS.forEach((id) => setReady(g, id, IDS));
  const deadline = g.deadlineAt;

  checkTimeout(g, deadline - 1);
  assert.equal(g.phase, 'playing', 'a second early is still in time');

  checkTimeout(g, deadline);
  assert.equal(g.phase, 'lost');
  assert.equal(g.lostTo, 'time');
  assert.equal(g.deadlineAt, null);

  const log = g.log.length;
  checkTimeout(g, deadline + 60000);
  assert.equal(g.log.length, log, 'checkTimeout is safe to call again');
});

test('running out of lives is distinguishable from running out of time', () => {
  const g = timedGame();
  IDS.forEach((id) => setReady(g, id, IDS));
  g.hands = { a: [90], b: [1], c: [2] };
  g.lives = 1;
  playCard(g, 'a', 90, nameOf);
  ownUp(g);
  assert.equal(g.phase, 'lost');
  assert.equal(g.lostTo, 'lives');
  assert.equal(g.deadlineAt, null);
});

test('a won run cannot then time out', () => {
  const g = timedGame();
  IDS.forEach((id) => setReady(g, id, IDS));
  g.level = g.maxLevel;
  g.hands = { a: [5], b: [20], c: [70] };
  playCard(g, 'a', 5, nameOf);
  playCard(g, 'b', 20, nameOf);
  playCard(g, 'c', 70, nameOf);
  assert.equal(g.phase, 'won');
  checkTimeout(g, Date.now() + 10 * 60 * 60 * 1000);
  assert.equal(g.phase, 'won');
  assert.equal(g.lostTo, null);
});

test('a disconnected player stops the clock, and reconnecting starts it again', () => {
  const g = timedGame();
  const start = 1_700_000_000_000;
  IDS.forEach((id) => setReady(g, id, IDS, start));
  const budget = g.deadlineAt - start;

  setClockPaused(g, true, start + 10000);
  assert.equal(g.deadlineAt, null, 'a paused clock has no deadline to expire');
  assert.equal(g.msLeft, budget - 10000);

  // However long the outage lasts, none of it comes off the clock.
  checkTimeout(g, start + budget + 60000);
  assert.equal(g.phase, 'playing');

  setClockPaused(g, false, start + budget + 60000);
  assert.equal(g.msLeft, null);
  assert.equal(g.deadlineAt, start + 2 * budget + 50000, 'resumes with the time it had');

  checkTimeout(g, g.deadlineAt);
  assert.equal(g.lostTo, 'time');
});

test('dropping out during the ready gate holds the next clock too', () => {
  const g = timedGame();
  const start = 1_700_000_000_000;
  setClockPaused(g, true, start);
  IDS.filter((id) => id !== 'c').forEach((id) => setReady(g, id, ['a', 'b'], start));

  assert.equal(g.phase, 'playing', 'the players still there can start the level');
  assert.equal(g.deadlineAt, null);
  assert.equal(g.msLeft, SECONDS_PER_CARD * 1000 * IDS.length * g.level, 'the full budget, held');

  setClockPaused(g, false, start + 5000);
  assert.equal(g.deadlineAt, start + 5000 + g.msPerCard * IDS.length);
});

test('pausing an untimed run does nothing at all', () => {
  const g = createGame(IDS);
  IDS.forEach((id) => setReady(g, id, IDS));
  setClockPaused(g, true, Date.now());
  assert.equal(g.paused, false);
  assert.equal(g.msLeft, null);
});

test('the view sends time remaining, never the raw deadline', () => {
  const g = timedGame();
  IDS.forEach((id) => setReady(g, id, IDS));
  const players = new Map(IDS.map((id) => [id, { id, name: nameOf(id), connected: true }]));

  const view = viewFor(g, 'a', players, g.deadlineAt - 5000);
  assert.equal(view.timed, true);
  assert.equal(view.msRemaining, 5000);
  assert.equal('deadlineAt' in view, false);

  assert.equal(viewFor(g, 'a', players, g.deadlineAt + 5000).msRemaining, 0, 'clamped at zero');
  assert.equal(view.msBudget, SECONDS_PER_CARD * 1000 * IDS.length * g.level);

  const untimed = viewFor(createGame(IDS), 'a', players);
  assert.equal(untimed.msRemaining, null);
  assert.equal(untimed.msBudget, null);
});

test('a paused view freezes the remaining time and says so', () => {
  const g = timedGame();
  IDS.forEach((id) => setReady(g, id, IDS));
  const players = new Map(IDS.map((id) => [id, { id, name: nameOf(id), connected: true }]));
  setClockPaused(g, true, g.deadlineAt - 12000);

  const view = viewFor(g, 'a', players, Date.now() + 60000);
  assert.equal(view.clockPaused, true);
  assert.equal(view.msRemaining, 12000, 'frozen, however long the wall clock runs on');
});

test('a shortened clock is what the tests run against', () => {
  const g = createGame(IDS, { timed: true, secondsPerCard: 0.2 });
  IDS.forEach((id) => setReady(g, id, IDS));
  assert.equal(g.deadlineAt - Date.now() <= 600, true, '0.2s per card, 3 cards');
});
