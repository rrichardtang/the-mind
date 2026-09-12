// Core rules engine for The Mind. Pure logic — no networking, no I/O.
//
// Rules implemented (Wolfgang Warsch / NSV):
//   * Deck is 1-100, all distinct. On level N every player is dealt N cards.
//   * Cards must be played into one shared ascending pile, without communicating.
//   * Playing a card while a lower card is still in someone's hand costs 1 life,
//     and every card lower than the one played is discarded.
//   * A shuriken may be thrown by unanimous agreement: everyone discards their
//     lowest card face up.
//   * Lives at 0 -> the run is lost. Finishing the last level -> the run is won.
//
// House rule (not in the printed rules): a played card is followed by a
// cooldown before the next one is accepted, so the pile can't be solved by
// mashing "play" the instant it's legal. See PLAY_COOLDOWN_MS.

export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 6;
// A game starts with one life per player (see createGame below), so the cap
// on gaining more can never sit below a full table's starting count.
export const MAX_LIVES = MAX_PLAYERS;
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

// Minimum gap between any two accepted card plays, whoever they're from.
// Edit here to retune it.
export const PLAY_COOLDOWN_MS = 1000;

// Playful trash-talk shown to whoever caused a mistake, and to whoever was
// holding one of the burned cards. Edit here to retune the voice/rotation.
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
    phase: 'ready', // ready | playing | levelCleared | won | lost
    timed,
    msPerCard: secondsPerCard * 1000,
    lastPlayAt: null, // epoch ms of the last accepted play; gates the next one
    // A level's clock is either running (deadlineAt, epoch ms) or paused
    // (msLeft), never both: armClock is the only thing that sets either.
    deadlineAt: null,
    msLeft: null,
    paused: false, // true while a seated player is disconnected
    lostTo: null, // 'lives' | 'time', once the run is lost
    ready: [],
    starVotes: [],
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
  game.lastPlayAt = null;
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

/** Mark a player ready for the current level. Everyone ready -> level begins. */
export function setReady(game, playerId, activeIds, now = Date.now()) {
  if (game.phase !== 'ready') return;
  if (!game.ready.includes(playerId)) game.ready.push(playerId);
  const allReady = activeIds.every((id) => game.ready.includes(id));
  if (allReady && activeIds.length > 0) {
    game.phase = 'playing';
    // The clock only starts once play does — the ready gate is untimed.
    if (game.timed) armClock(game, levelBudget(game), now);
    log(game, 'level', `Level ${game.level}. Concentrate.`);
  }
}

/**
 * Play a card. Only a player's lowest card is ever playable, since holding a
 * lower card back is always a mistake against yourself.
 */
export function playCard(game, playerId, card, nameOf, now = Date.now()) {
  if (game.phase !== 'playing') return { ok: false, error: 'The level has not started yet.' };
  if (game.lastPlayAt != null && now - game.lastPlayAt < PLAY_COOLDOWN_MS) {
    return { ok: false, error: 'Wait a beat before the next card.' };
  }
  const hand = game.hands[playerId] ?? [];
  if (!hand.includes(card)) return { ok: false, error: 'That card is not in your hand.' };
  if (card !== hand[0]) return { ok: false, error: 'You can only play your lowest card.' };

  game.lastPlayAt = now;
  const lowest = lowestOutstanding(game);
  hand.shift();
  game.pile.push({ card, playerId });
  game.starVotes = [];

  if (card === lowest) {
    log(game, 'play', `${nameOf(playerId)} played ${card}.`, { card });
  } else {
    // Mistake: every card below the one played is burned, and it costs a life.
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
    game.lives -= 1;
    game.livesLostThisLevel += 1;
    log(game, 'mistake', `${nameOf(playerId)} played ${card}. ${burned.join(', ')} were still out. Lost a life.`, {
      card,
      burned,
      culprit: playerId,
      victims: [...victims],
      culpritMessage: pick(CULPRIT_MESSAGES),
      victimMessage: pick(VICTIM_MESSAGES),
    });
    if (game.lives <= 0) {
      game.lives = 0;
      loseRun(game, 'lives', 'Out of lives. The run is over.');
      return { ok: true };
    }
  }

  checkLevelEnd(game);
  return { ok: true };
}

/** Vote to throw a shuriken. Unanimous among connected players -> it lands. */
export function toggleStarVote(game, playerId, activeIds, nameOf) {
  if (game.phase !== 'playing') return { ok: false, error: 'The level has not started yet.' };
  if (game.shurikens <= 0) return { ok: false, error: 'No shurikens left.' };

  const i = game.starVotes.indexOf(playerId);
  if (i >= 0) game.starVotes.splice(i, 1);
  else game.starVotes.push(playerId);

  if (activeIds.length > 0 && activeIds.every((id) => game.starVotes.includes(id))) {
    throwStar(game, nameOf);
  }
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
