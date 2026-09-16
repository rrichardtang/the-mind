// Core rules engine for The Mind. Pure logic — no networking, no I/O.
//
// Rules implemented (Wolfgang Warsch / NSV):
//   * Deck is 1-100, all distinct. On level N every player is dealt N cards.
//   * Cards must be played into one shared ascending pile, without communicating.
//   * Playing a card while a lower card is still in someone's hand costs 1 life,
//     and every card lower than the one played is discarded. The table then
//     stops until the two players it happened between have owned it (see the
//     'mistake' phase below) — a house rule, not the printed one.
//   * A shuriken may be thrown by unanimous agreement: everyone discards their
//     lowest card face up.
//   * Lives at 0 -> the run is lost. Finishing the last level -> the run is won.

export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 6;
export const MAX_LIVES = 5;
export const MAX_SHURIKENS = 4;
const DECK_SIZE = 100;

// Number of levels per player count. 2-4 players is the official table; 5-6 is
// an unofficial extension so bigger groups can still play.
const LEVELS_BY_PLAYERS = { 2: 12, 3: 10, 4: 8, 5: 8, 6: 8 };

// Rewards granted *after* clearing the given level. The physical level cards
// print these symbols; this table is the common 2/5/8 shuriken, 3/6/9 life
// layout. Edit here to match the cards in your own copy of the game.
const REWARDS = { 2: 'shuriken', 3: 'life', 5: 'shuriken', 6: 'life', 8: 'shuriken', 9: 'life' };

// Optional per-level clock: this many seconds for every card dealt this level,
// so the pressure scales with the hands on the table. Edit here to retune it.
export const SECONDS_PER_CARD = 20;

// Playful trash-talk shown to whoever caused a mistake, and to whoever was
// sitting on the lowest card when it happened. Edit here to retune the
// voice/rotation.
const CULPRIT_MESSAGES = [
  'Not so fast, buster.',
  'Slow your roll, champ.',
  "What's the hurry?",
  'Cutting is bad etiquette.',
  'Somebody was feeling lucky.',
  'Easy there, speed racer.',
];
const VICTIM_MESSAGES = [
  'Hurry up, gramps.',
  'No guts, no glory.',
  'Should have played it sooner.',
  'Too slow!',
  'Asleep at the wheel?',
  "That one's on you too.",
];

const pick = (pool) => pool[Math.floor(Math.random() * pool.length)];

export function levelsFor(playerCount) {
  return LEVELS_BY_PLAYERS[playerCount] ?? 8;
}

function shuffledDeck() {
  const deck = Array.from({ length: DECK_SIZE }, (_, i) => i + 1);
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

/** Start a fresh run. `playerIds` fixes the seating for the whole game. */
export function createGame(playerIds, { timed = false, secondsPerCard = SECONDS_PER_CARD } = {}) {
  const game = {
    playerIds: [...playerIds],
    maxLevel: levelsFor(playerIds.length),
    level: 1,
    lives: playerIds.length, // one life per player, per the rulebook
    shurikens: 1,
    hands: {},
    pile: [], // cards successfully played, ascending
    discarded: [], // cards lost to mistakes or shurikens
    phase: 'ready', // ready | playing | mistake | levelCleared | won | lost
    timed,
    msPerCard: secondsPerCard * 1000,
    // A level's clock is either running (deadlineAt, epoch ms) or paused
    // (msLeft), never both: armClock is the only thing that sets either.
    deadlineAt: null,
    msLeft: null,
    paused: false, // true while a seated player is disconnected
    lostTo: null, // 'lives' | 'time', once the run is lost
    ready: [],
    starVotes: [],
    // Who has agreed to end a run stalled on somebody who is not here. Only
    // ever populated while the table is stalled; settleGates owns clearing it.
    endVotes: [],
    // Set exactly while the phase is 'mistake', and never otherwise: the two
    // players a mistake happened between, and which of them has owned it.
    mistake: null,
    done: [], // who has finished looking at a lost run
    lastReward: null,
    livesLostThisLevel: 0,
    log: [],
  };
  dealLevel(game);
  return game;
}

function dealLevel(game) {
  const deck = shuffledDeck();
  game.hands = {};
  for (const id of game.playerIds) {
    game.hands[id] = deck.splice(0, game.level).sort((a, b) => a - b);
  }
  game.pile = [];
  game.discarded = [];
  game.ready = [];
  game.starVotes = [];
  game.livesLostThisLevel = 0;
  game.phase = 'ready';
  clearClock(game);
}

const levelBudget = (game) => game.msPerCard * game.playerIds.length * game.level;

function clearClock(game) {
  game.deadlineAt = null;
  game.msLeft = null;
}

/** Put `ms` on the clock, running or held, depending on the pause state. */
function armClock(game, ms, now) {
  game.deadlineAt = game.paused ? null : now + ms;
  game.msLeft = game.paused ? ms : null;
}

const msRemaining = (game, now) =>
  game.msLeft ?? (game.deadlineAt == null ? null : Math.max(0, game.deadlineAt - now));

/**
 * Freeze or resume the level's clock. A disconnected player's cards cannot be
 * played by anyone, so a timed level would be unclearable through no fault of
 * the table — the clock waits for them instead.
 */
export function setClockPaused(game, paused, now = Date.now()) {
  if (!game.timed || game.paused === paused) return;
  const left = msRemaining(game, now);
  game.paused = paused;
  if (left != null) armClock(game, left, now);
}

function loseRun(game, lostTo, text) {
  game.phase = 'lost';
  game.lostTo = lostTo;
  clearClock(game);
  log(game, 'lost', text);
}

function log(game, kind, text, extra = {}) {
  game.log.push({ id: game.log.length + 1, kind, text, ...extra });
  if (game.log.length > 60) game.log.splice(0, game.log.length - 60);
}

const cardsLeft = (game) => game.playerIds.flatMap((id) => game.hands[id] ?? []);
const lowestOutstanding = (game) => Math.min(...cardsLeft(game));

/**
 * Whether the run is waiting on somebody who is not here. Nobody else can play
 * their cards, so the level cannot be finished until they are back — which is
 * the only situation in which ending the run early is offered at all.
 */
const stalled = (game, activeIds) => game.playerIds.some((id) => !activeIds.includes(id));

/**
 * Whether everybody still here has put their name to something. Every gate in
 * the game is this shape — ready, shuriken, ending a stalled run, stepping away
 * from a lost one — and none of them ever waits on a player who is gone. An
 * empty room agrees to nothing.
 */
const unanimous = (activeIds, votes) => activeIds.length > 0 && activeIds.every((id) => votes.includes(id));

/** Cast or take back a vote. Taking one back is what you do when the table changes. */
function toggleVote(votes, playerId) {
  const i = votes.indexOf(playerId);
  if (i >= 0) votes.splice(i, 1);
  else votes.push(playerId);
}

/**
 * Begin the level once everyone still here has said ready. Driven both by the
 * last player tapping ready and by settleGates, because the table can also
 * become all-ready by somebody leaving it.
 */
function startIfReady(game, activeIds, now) {
  if (game.phase !== 'ready' || !unanimous(activeIds, game.ready)) return;
  game.phase = 'playing';
  // The clock only starts once play does — the ready gate is untimed.
  if (game.timed) armClock(game, levelBudget(game), now);
  log(game, 'level', `Level ${game.level}. Concentrate.`);
}

/** Mark a player ready for the current level. Everyone ready -> level begins. */
export function setReady(game, playerId, activeIds, now = Date.now()) {
  if (game.phase !== 'ready') return;
  if (!game.ready.includes(playerId)) game.ready.push(playerId);
  startIfReady(game, activeIds, now);
}

/**
 * Play a card. Only a player's lowest card is ever playable, since holding a
 * lower card back is always a mistake against yourself.
 */
export function playCard(game, playerId, card, nameOf) {
  if (game.phase === 'mistake') return { ok: false, error: 'Own that mistake first.' };
  if (game.phase !== 'playing') return { ok: false, error: 'The level has not started yet.' };
  const hand = game.hands[playerId] ?? [];
  if (!hand.includes(card)) return { ok: false, error: 'That card is not in your hand.' };
  if (card !== hand[0]) return { ok: false, error: 'You can only play your lowest card.' };

  const lowest = lowestOutstanding(game);
  hand.shift();
  game.pile.push({ card, playerId });
  game.starVotes = [];

  if (card === lowest) {
    log(game, 'play', `${nameOf(playerId)} played ${card}.`, { card });
  } else {
    // Mistake: every card below the one played is burned, and it costs a life.
    // Whoever holds the lowest one is the player who should have gone first —
    // read off before the burn empties their hand.
    const holder = game.playerIds.find((id) => (game.hands[id] ?? []).includes(lowest));
    const burned = [];
    const victims = new Set();
    for (const id of game.playerIds) {
      const kept = [];
      for (const c of game.hands[id]) {
        if (c < card) { burned.push(c); victims.add(id); } else kept.push(c);
      }
      game.hands[id] = kept;
    }
    burned.sort((a, b) => a - b);
    game.discarded.push(...burned);
    game.lives = Math.max(0, game.lives - 1);
    game.livesLostThisLevel += 1;
    log(game, 'mistake', `${nameOf(playerId)} played ${card}. ${burned.join(', ')} were still out. Lost a life.`, {
      card,
      burned,
      culprit: playerId,
      victims: [...victims],
    });
    // Everything the mistake costs beyond the life — the level ending, the run
    // being lost — waits behind resolveMistake, so neither player can be moved
    // off the callout before they have seen it.
    game.phase = 'mistake';
    game.mistake = {
      card,
      lowest,
      culprit: playerId,
      victim: holder,
      acks: [],
      culpritMessage: pick(CULPRIT_MESSAGES),
      victimMessage: pick(VICTIM_MESSAGES),
    };
    return { ok: true };
  }

  checkLevelEnd(game);
  return { ok: true };
}

/** Own up to the mistake on the table. Only the two players it was between can. */
export function acknowledgeMistake(game, playerId) {
  if (game.phase !== 'mistake') return;
  const { culprit, victim, acks } = game.mistake;
  if ((playerId === culprit || playerId === victim) && !acks.includes(playerId)) acks.push(playerId);
}

/** Step away from a lost run. The room waits for everyone before it moves on. */
export function dismissRun(game, playerId) {
  if (game.phase !== 'lost') return;
  if (!game.done.includes(playerId)) game.done.push(playerId);
}

/**
 * Resolve whatever the table is waiting on, given who is still connected.
 * Every gate only ever waits on players who are actually here: a phone that
 * dies behind one must not freeze the room for everybody else.
 *
 * Returns true once the room should clear the game away — either everyone has
 * stepped away from a lost run, or everyone still here has agreed to end one
 * that cannot be finished.
 */
export function settleGates(game, activeIds, now = Date.now()) {
  // The vote to end belongs to the stall that prompted it. The moment everyone
  // is back it goes, so a vote taken during an outage can never end a run that
  // recovered from it.
  if (!stalled(game, activeIds)) game.endVotes = [];
  if (unanimous(activeIds, game.endVotes)) return true;

  // A phone that dies before tapping ready must not hold the level back for
  // everyone who did: the gate re-settles whenever the table changes, the same
  // way the mistake gate below does.
  startIfReady(game, activeIds, now);

  if (game.phase === 'mistake') {
    const { culprit, victim, acks } = game.mistake;
    const owed = [culprit, victim].filter((id) => activeIds.includes(id) && !acks.includes(id));
    if (owed.length === 0) resolveMistake(game);
    return false;
  }
  return game.phase === 'lost' && unanimous(activeIds, game.done);
}

/** Both players have owned the mistake: let its consequences land. */
function resolveMistake(game) {
  game.mistake = null;
  game.phase = 'playing';
  if (game.lives === 0) return loseRun(game, 'lives', 'Out of lives. The run is over.');
  checkLevelEnd(game);
}

/**
 * Vote to end a run the table cannot finish, because a player is away and their
 * cards are unplayable by anyone else. It takes everyone who is still here, so
 * a run is never ended over somebody's head — and a vote can be taken back,
 * which is what you do when the missing phone comes back to life.
 */
export function toggleEndVote(game, playerId, activeIds) {
  if (game.phase === 'won' || game.phase === 'lost') return { ok: false, error: 'The run is already over.' };
  if (!stalled(game, activeIds)) return { ok: false, error: 'Everyone is here — the run can carry on.' };

  toggleVote(game.endVotes, playerId);
  return { ok: true };
}

/** Vote to throw a shuriken. Unanimous among connected players -> it lands. */
export function toggleStarVote(game, playerId, activeIds, nameOf) {
  if (game.phase === 'mistake') return { ok: false, error: 'Own that mistake first.' };
  if (game.phase !== 'playing') return { ok: false, error: 'The level has not started yet.' };
  if (game.shurikens <= 0) return { ok: false, error: 'No shurikens left.' };

  toggleVote(game.starVotes, playerId);
  if (unanimous(activeIds, game.starVotes)) throwStar(game, nameOf);
  return { ok: true };
}

function throwStar(game, nameOf) {
  game.shurikens -= 1;
  game.starVotes = [];
  const revealed = [];
  for (const id of game.playerIds) {
    const hand = game.hands[id];
    if (!hand.length) continue;
    const card = hand.shift();
    game.discarded.push(card);
    revealed.push({ playerId: id, name: nameOf(id), card });
  }
  game.discarded.sort((a, b) => a - b);
  const summary = revealed.map((r) => `${r.name} ${r.card}`).join(', ');
  log(game, 'shuriken', `Shuriken thrown. Discarded ${summary || 'nothing'}.`, { revealed });
  checkLevelEnd(game);
}

function checkLevelEnd(game) {
  if (cardsLeft(game).length > 0) return;

  clearClock(game);

  if (game.level >= game.maxLevel) {
    game.phase = 'won';
    log(game, 'won', `Level ${game.level} cleared. You beat The Mind.`);
    return;
  }

  const reward = REWARDS[game.level] ?? null;
  game.lastReward = null;
  if (reward === 'life' && game.lives < MAX_LIVES) {
    game.lives += 1;
    game.lastReward = 'life';
  } else if (reward === 'shuriken' && game.shurikens < MAX_SHURIKENS) {
    game.shurikens += 1;
    game.lastReward = 'shuriken';
  }
  game.phase = 'levelCleared';
  const suffix = game.lastReward === 'life' ? ' Gained a life.' : game.lastReward === 'shuriken' ? ' Gained a shuriken.' : '';
  log(game, 'cleared', `Level ${game.level} cleared.${suffix}`);
}

/**
 * End the run if the level's clock has run out. Safe to call at any time: it
 * only ever fires on a timed level that is still being played.
 */
export function checkTimeout(game, now) {
  // A paused clock has no deadline, so it can never expire here.
  if (!game.timed || game.phase !== 'playing' || game.deadlineAt == null || now < game.deadlineAt) return;
  loseRun(game, 'time', 'The clock ran out. The run is over.');
}

/** Advance to the next level and deal fresh hands. */
export function nextLevel(game) {
  if (game.phase !== 'levelCleared') return;
  game.level += 1;
  game.lastReward = null;
  dealLevel(game);
}

/**
 * The mistake gate as one player sees it: what happened, whose acknowledgement
 * is still outstanding, and — for the two it was between — a line of their own.
 */
function mistakeView(game, playerId, players) {
  const m = game.mistake;
  if (!m) return null;
  return {
    card: m.card,
    lowest: m.lowest,
    culprit: m.culprit,
    victim: m.victim,
    // Only players who are still here are waited on, so the label reads true.
    waitingOn: [m.culprit, m.victim].filter((id) => !m.acks.includes(id) && players.get(id)?.connected),
    message: playerId === m.culprit ? m.culpritMessage : playerId === m.victim ? m.victimMessage : null,
  };
}

/**
 * View of the game for one player: their own hand in full, everyone else's as
 * a count only. This is the whole reason the rules live on the server.
 */
export function viewFor(game, playerId, players, now = Date.now()) {
  return {
    level: game.level,
    maxLevel: game.maxLevel,
    lives: game.lives,
    maxLives: MAX_LIVES,
    shurikens: game.shurikens,
    phase: game.phase,
    timed: game.timed,
    // Remaining time, not the deadline: the client counts down from when the
    // state lands, so a skewed phone clock can never desync the display.
    msRemaining: msRemaining(game, now),
    // The level's full budget, so the client can shade the clock as a fraction
    // of it rather than re-deriving the rule.
    msBudget: game.timed ? levelBudget(game) : null,
    clockPaused: game.paused,
    lostTo: game.lostTo,
    hand: game.hands[playerId] ?? [],
    pile: game.pile.map((p) => p.card),
    topCard: game.pile.length ? game.pile[game.pile.length - 1].card : null,
    discarded: game.discarded,
    cardsRemaining: cardsLeft(game).length,
    lastReward: game.lastReward,
    livesLostThisLevel: game.livesLostThisLevel,
    ready: game.ready,
    starVotes: game.starVotes,
    endVotes: game.endVotes,
    mistake: mistakeView(game, playerId, players),
    done: game.done,
    log: game.log.slice(-12),
    seats: game.playerIds.map((id) => ({
      id,
      name: players.get(id)?.name ?? 'Player',
      connected: players.get(id)?.connected ?? false,
      cards: (game.hands[id] ?? []).length,
      ready: game.ready.includes(id),
      votedStar: game.starVotes.includes(id),
    })),
  };
}
