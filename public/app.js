/* The Mind — client. Renders whatever the server says; the server owns the rules. */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  const SVG_NS = 'http://www.w3.org/2000/svg';
  /** One glyph from the sprite in index.html. */
  const icon = (name, cls) => {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', cls ? `i ${cls}` : 'i');
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS(SVG_NS, 'use');
    use.setAttribute('href', `#i-${name}`);
    svg.append(use);
    return svg;
  };

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* private mode */ } },
  };

  let ws = null;
  let state = null;       // latest server state
  let reconnectAt = 500;  // backoff, ms
  let intent = null;      // pending {type:'create'|'join', ...} to send once open
  let heroValue = null;   // card on the hero now, so we only animate real changes
  let lastLives = null;
  let lastLogId = null;   // null means "haven't seen a log yet" — distinct from a real id
  let entering = false;   // a create/join is in flight, so the buttons stay locked

  /**
   * A snapshot of the last render. Lists are rebuilt wholesale on every state,
   * which would otherwise replay every entrance animation on every message —
   * so each animation is gated on something here actually having changed.
   */
  const prev = {
    hand: [],
    topCard: null,
    ready: [],
    done: [],
    lobbyIds: [],
    seatCards: new Map(),
    lives: null,
    shurikens: null,
  };

  /* ── Connection ─────────────────────────────────────── */

  function connect(onOpen) {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      if (ws.readyState === WebSocket.OPEN && onOpen) onOpen();
      return;
    }
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${location.host}`);

    ws.onopen = () => {
      reconnectAt = 500;
      if (onOpen) onOpen();
      else if (intent) send(intent);
    };

    ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      handle(msg);
    };

    ws.onclose = () => {
      ws = null;
      // Only auto-rejoin if we were actually in a room.
      if (!store.get('code')) return;
      intent = { type: 'join', code: store.get('code'), name: store.get('name'), playerId: store.get('playerId') };
      setTimeout(() => connect(), reconnectAt);
      reconnectAt = Math.min(reconnectAt * 2, 8000);
    };
  }

  function send(msg) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    else { intent = msg; connect(); }
  }

  function handle(msg) {
    if (msg.type === 'joined') {
      intent = null;
      setEntering(false);
      store.set('code', msg.code);
      store.set('playerId', msg.playerId);
      return;
    }
    if (msg.type === 'removed') {
      goHome(msg.message || 'The host removed you from the room.');
      return;
    }
    // Something the room needs said that no state can carry — a run ended by
    // somebody walking out, say.
    if (msg.type === 'notice') {
      toast(msg.message);
      return;
    }
    if (msg.type === 'error') {
      setEntering(false);
      toast(msg.message);
      // A stale saved room shouldn't trap us on a reconnect loop.
      if (/No room called|already in progress|is full|removed you/i.test(msg.message)) {
        store.del('code'); store.del('playerId');
        intent = null;
        show('home');
      }
      return;
    }
    if (msg.type === 'state') render(msg);
  }

  /* ── Screens & toast ────────────────────────────────── */

  const screens = { home: $('screen-home'), lobby: $('screen-lobby'), game: $('screen-game') };
  let screenName = 'home';
  function show(name) {
    // A screen change means the room moved on under you — whatever the leave
    // sheet was asking about is no longer the question.
    if (name !== screenName) closeLeave();
    screenName = name;
    for (const [k, node] of Object.entries(screens)) node.hidden = k !== name;
    syncExit();
  }

  /**
   * The exit button is the game screen's only way out, since every gate covers
   * the HUD. It stays off any screen with its own Leave control, and off any
   * sheet where a ✕ in the corner would read as that sheet's close button.
   */
  function syncExit() {
    $('btn-exit').hidden =
      screenName !== 'game' || !$('overlay-rules').hidden || !$('overlay-leave').hidden;
  }

  let toastTimer;
  function toast(text) {
    const node = $('toast');
    node.textContent = text;
    node.hidden = false;
    void node.offsetWidth; // restart the entrance on a repeat toast
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { node.hidden = true; }, 3200);
  }

  /** A mistake washes the whole screen once, then cleans itself up. */
  function dangerFlash() {
    const flash = el('div', 'danger-flash');
    flash.addEventListener('animationend', () => flash.remove());
    document.body.append(flash);
  }

  let enteringTimer;
  /**
   * Lock the home-screen buttons while a create/join is in flight. Without this
   * an impatient second tap asks the server for a second seat, and you end up
   * in the lobby twice.
   */
  function setEntering(on) {
    entering = on;
    clearTimeout(enteringTimer);
    $('btn-create').disabled = on;
    $('btn-join').disabled = on;
    $('btn-create').textContent = on ? 'Creating…' : 'Create a room';
    $('btn-join').textContent = on ? 'Joining…' : 'Join';
    // Never leave the buttons stuck if the server never answers.
    if (on) enteringTimer = setTimeout(() => setEntering(false), 8000);
  }

  /**
   * Leaving is the one thing here with no undo — mid-run it ends the run for
   * everybody — so it is always asked first, in the words that apply.
   */
  function askToLeave() {
    const g = state?.game;
    const midRun = g && g.phase !== 'won' && g.phase !== 'lost';
    $('leave-body').textContent = midRun
      ? 'Nobody else can play your hand, so the run ends here for everyone and the room drops back to the lobby.'
      : 'Your seat is freed and you go back to the start. The others carry on without you.';
    $('overlay-leave').hidden = false;
    syncExit();
  }

  function closeLeave() {
    $('overlay-leave').hidden = true;
    syncExit();
  }

  /** Drop the room we were in and go back to the start, optionally saying why. */
  function goHome(message) {
    closeLeave();
    // Say so on the way out: a socket that merely closes reads as a phone that
    // dropped, and mid-game that holds the seat open instead of freeing it.
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'leave' }));
    store.del('code');
    store.del('playerId');
    intent = null;
    state = null;
    stopTimer();
    setEntering(false);
    const socket = ws;
    ws = null;
    socket?.close();
    show('home');
    if (message) toast(message);
  }

  const buzz = (ms) => { try { navigator.vibrate?.(ms); } catch { /* unsupported */ } };
  const initials = (name) => (name || '?').trim().slice(0, 2).toUpperCase();
  const nameIn = (g, id) => g.seats.find((s) => s.id === id)?.name ?? 'Someone';
  /** "Sam", or "Sam and Pat" — whoever a gate is still waiting on. */
  const andList = (names) =>
    names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0] ?? 'the others';

  /* ── Render ─────────────────────────────────────────── */

  function render(next) {
    state = next;
    if (!state.game) { stopTimer(); renderLobby(); show('lobby'); return; }
    renderGame();
    show('game');
  }

  function renderLobby() {
    $('room-code-value').textContent = state.code;

    const list = $('lobby-players');
    const ids = state.lobby.map((p) => p.id);
    list.replaceChildren();
    for (const p of state.lobby) {
      const li = el('li');
      // Only a player who wasn't here on the last render slides in.
      if (prev.lobbyIds.length && !prev.lobbyIds.includes(p.id)) li.classList.add('arriving');
      li.append(el('span', 'avatar', initials(p.name)), el('span', 'player-name', p.name));
      if (p.isHost) li.append(el('span', 'tag', 'Host'));
      if (p.id === state.you.id) li.append(el('span', 'tag', 'You'));
      if (state.you.isHost && p.id !== state.you.id) {
        const remove = el('button', 'remove-btn');
        remove.type = 'button';
        remove.title = `Remove ${p.name}`;
        remove.setAttribute('aria-label', `Remove ${p.name}`);
        remove.append(icon('x'));
        remove.addEventListener('click', () => send({ type: 'removePlayer', playerId: p.id }));
        li.append(remove);
      }
      list.append(li);
    }
    prev.lobbyIds = ids;

    $('timed-toggle').hidden = !state.you.isHost;

    const enough = state.lobby.length >= state.minPlayers;
    const start = $('btn-start');
    start.hidden = !state.you.isHost;
    start.disabled = !enough;

    renderLobbyStatus(enough);
  }

  /** Run setup as a small readout, so the numbers line up instead of running
   *  together in one dot-separated sentence. */
  function renderLobbyStatus(enough) {
    const node = $('lobby-status');
    node.replaceChildren();

    if (!enough) {
      node.textContent = `Waiting for players. ${state.minPlayers} minimum, up to ${state.maxPlayers}.`;
      return;
    }
    if (!state.you.isHost) {
      node.textContent = 'Waiting for the host to start…';
      return;
    }

    const n = state.lobby.length;
    const stats = [
      [n, n === 1 ? 'player' : 'players'],
      [state.plannedLevels, 'levels'],
      [n, n === 1 ? 'life' : 'lives'],
      [1, 'shuriken'],
    ];
    for (const [value, label] of stats) {
      const stat = el('span', 'stat');
      stat.append(el('span', 'stat-value', value), el('span', 'stat-label', label));
      node.append(stat);
    }
  }

  function renderGame() {
    const g = state.game;

    $('hud-level').textContent = g.level;
    $('hud-maxlevel').textContent = `/${g.maxLevel}`;
    renderTokens($('hud-lives'), g.lives, g.maxLives, 'life', 'heart', prev.lives);
    renderTokens($('hud-shurikens'), g.shurikens, 4, 'star', 'star', prev.shurikens);
    prev.lives = g.lives;
    prev.shurikens = g.shurikens;

    renderTimer(g);
    renderSeats(g);
    renderPile(g);
    renderHero(g);
    renderFeed(g);
    renderHand(g);
    renderOverlays(g);

    lastLives = g.lives;
  }

  /**
   * Count down from the moment the state arrived rather than from any clock
   * value the server sends, so a wrong phone clock cannot skew the display.
   * The server alone decides when the time is actually up.
   */
  let timerEndsAt = null;
  let timerInterval = null;
  let urgentBelow = 0;

  function renderTimer(g) {
    const running = g.timed && g.msRemaining != null;
    $('hud-timer').hidden = !running;
    if (!running) { stopTimer(); return; }
    timerEndsAt = performance.now() + g.msRemaining;
    // A quarter of this level's own budget, so the alarm reads the same on a
    // 40 second level as on a four minute one. The server sends the budget;
    // the client never works out what a level is worth.
    urgentBelow = g.msBudget / 4;

    // Someone is offline: their cards are unplayable, so the server holds the
    // clock. Show it stopped rather than counting down against nobody.
    if (g.clockPaused) { stopTimer(); paintTimer(g.msRemaining, true); return; }
    tickTimer();
    timerInterval ??= setInterval(tickTimer, 250);
  }

  function tickTimer() {
    paintTimer(Math.max(0, timerEndsAt - performance.now()), false);
  }

  function paintTimer(left, paused) {
    const secs = Math.ceil(left / 1000);
    const node = $('hud-timer');
    $('hud-timer-value').textContent = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
    node.classList.toggle('paused', paused);
    node.classList.toggle('urgent', !paused && left <= urgentBelow);
  }

  function stopTimer() {
    clearInterval(timerInterval);
    timerInterval = null;
  }

  /**
   * One glyph per resource, spent ones dimmed. The token that just changed
   * animates, so losing a life reads as the heart draining rather than a
   * number quietly going down.
   */
  function renderTokens(node, count, max, cls, glyph, before) {
    node.replaceChildren();
    const shown = Math.max(count, Math.min(max, count + 1));
    for (let i = 0; i < shown; i++) {
      const spent = i >= count;
      const token = icon(glyph, `token ${cls}${spent ? ' spent' : ''}`);
      if (before != null && before !== count) {
        if (spent && i < before) token.classList.add('draining');
        else if (!spent && i >= before) token.classList.add('gained');
      }
      node.append(token);
    }
  }

  function renderSeats(g) {
    const node = $('seats');
    node.replaceChildren();
    const counts = new Map();

    for (const s of g.seats) {
      counts.set(s.id, s.cards);
      const li = el('li');
      if (s.id === state.you.id) li.classList.add('is-you');
      if (!s.connected) li.classList.add('is-out');
      if (g.phase === 'ready' && s.ready) li.classList.add('is-ready');
      if (g.phase === 'playing' && s.votedStar) li.classList.add('is-voting');
      li.append(el('div', 'seat-name', s.id === state.you.id ? 'You' : s.name));

      const meta = el('div', 'seat-meta');
      if (!s.connected) {
        meta.append(el('span', null, 'offline'));
      } else if (s.votedStar && g.phase === 'playing') {
        meta.append(icon('star'), el('span', null, 'voted'));
      } else {
        const count = el('span', 'seat-count', s.cards);
        // Someone played: their count ticks rather than silently swapping.
        if (prev.seatCards.has(s.id) && prev.seatCards.get(s.id) !== s.cards) {
          count.classList.add('changed');
        }
        meta.append(count, el('span', null, s.cards === 1 ? 'card' : 'cards'));
      }
      li.append(meta);
      node.append(li);
    }
    prev.seatCards = counts;
  }

  function renderPile(g) {
    // One ascending timeline of everything resolved this level, so you can see
    // both what landed and what got burned.
    const resolved = [
      ...g.pile.map((c) => ({ card: c, burned: false })),
      ...g.discarded.map((c) => ({ card: c, burned: true })),
    ].sort((a, b) => a.card - b.card);

    const landed = g.topCard != null && g.topCard !== prev.topCard;
    const trail = $('pile-trail');
    trail.replaceChildren();
    if (resolved.length === 0) {
      trail.append(el('span', 'empty', 'Nothing played yet'));
    } else {
      for (const r of resolved) {
        const latest = !r.burned && r.card === g.topCard;
        const chip = el('span', `chip${r.burned ? ' burned' : ''}${latest ? ' latest' : ''}`, r.card);
        // Only a genuinely new top card drops in; a re-render of the same
        // pile leaves the chips still.
        if (latest && landed) chip.classList.add('land');
        trail.append(chip);
      }
      trail.scrollLeft = trail.scrollWidth;
    }
    prev.topCard = g.topCard ?? null;
    $('pile-count').textContent = `${g.cardsRemaining} left`;
  }

  function renderHero(g) {
    const hero = $('hero');
    const lowest = g.hand.length ? g.hand[0] : null;
    const live = lowest != null && g.phase === 'playing';

    hero.classList.toggle('is-live', live);
    hero.classList.toggle('is-idle', !live);
    hero.disabled = !live;

    if (lowest != null) {
      $('hero-num').textContent = lowest;
      $('hero-hint').textContent = live ? 'Tap to play' : 'Waiting';
      hero.dataset.card = lowest; // drives the corner indices
    } else {
      delete hero.dataset.card;
      $('hero-num').textContent = g.phase === 'ready' ? 'Get ready' : "You're out";
      $('hero-hint').textContent = g.phase === 'ready' ? '' : 'Help the others land theirs';
    }

    // Animate a genuinely new card sliding in, not a re-render of the same one.
    if (lowest != null && lowest !== heroValue) {
      hero.classList.remove('enter');
      void hero.offsetWidth; // restart the animation
      hero.classList.add('enter');
    }
    heroValue = lowest;

    if (lastLives != null && g.lives < lastLives) {
      hero.classList.remove('wrong');
      void hero.offsetWidth;
      hero.classList.add('wrong');
      dangerFlash();
      buzz([40, 60, 40]);
    }
  }

  /** Fly the played card up toward the pile strip, on tap, before the server replies. */
  function throwGhost(card) {
    const ghost = el('div', 'ghost', card);
    ghost.addEventListener('animationend', () => ghost.remove());
    $('ghosts').append(ghost);
  }

  function playLowest() {
    const g = state?.game;
    if (!g || g.phase !== 'playing' || !g.hand.length) return;
    const card = g.hand[0];
    // Optimistic: animate on tap so it feels instant, then let the server's
    // next state decide what actually happened.
    throwGhost(card);
    heroValue = null; // make the next card animate in
    buzz(12);
    send({ type: 'play', card });
  }

  function renderFeed(g) {
    const last = g.log[g.log.length - 1];
    const node = $('feed');
    node.className = 'feed';
    if (!last) { node.replaceChildren(); return; }
    if (last.kind === 'mistake') node.classList.add('mistake');
    else if (last.kind === 'shuriken') node.classList.add('shuriken');
    else if (last.kind === 'cleared') node.classList.add('good');
    // Wrapped so a new line fades in; re-rendering the same line leaves it be.
    const fresh = last.id !== lastLogId;
    if (fresh || !node.firstChild) node.replaceChildren(el('span', null, last.text));
    else node.firstChild.textContent = last.text;
    // A fresh page load (not just a WS reconnect within the same session) starts
    // lastLogId back at null, and the state it lands on can already carry an old
    // entry as its last — don't buzz for something that happened before we looked.
    if (lastLogId !== null && fresh && last.kind === 'shuriken') buzz(30);
    lastLogId = last.id;
  }

  function renderHand(g) {
    const node = $('hand');
    node.replaceChildren();

    if (g.hand.length === 0) {
      node.append(el('div', 'hand-empty', 'No cards left. Help the others land theirs.'));
    } else {
      // The slider shows your hand at a glance; the hero card is what you press.
      // Cards you were not already holding are dealt in, staggered — which in
      // practice means the start of a level, since a hand only ever shrinks.
      let dealt = 0;
      g.hand.forEach((card, i) => {
        const cardEl = el('div', `card${i === 0 ? ' next' : ''}`, card);
        if (!prev.hand.includes(card)) {
          cardEl.classList.add('dealt');
          cardEl.style.setProperty('--i', dealt++);
        }
        node.append(cardEl);
      });
      node.scrollLeft = 0;
    }
    prev.hand = [...g.hand];

    $('hand-label').textContent = g.hand.length ? `Your hand · ${g.hand.length}` : 'Your hand';

    const star = $('btn-star');
    const votesNeeded = g.seats.filter((s) => s.connected).length;
    star.disabled = g.phase !== 'playing' || g.shurikens === 0;
    star.classList.toggle('voted', g.starVotes.includes(state.you.id));
    // The control fills as votes land, so progress toward unanimity is visible.
    star.style.setProperty('--vote', votesNeeded ? g.starVotes.length / votesNeeded : 0);
    $('star-label').textContent = g.shurikens === 0
      ? 'No shurikens'
      : g.starVotes.length > 0
        ? `Shuriken ${g.starVotes.length}/${votesNeeded}`
        : 'Throw shuriken';
  }

  function renderOverlays(g) {
    renderReadyGate(g);
    renderMistakeGate(g);
    renderResult(g);
  }

  /** A row of player chips, lit for whoever has already acted. Returns the
   *  lit ids, so the next render only pops the ones that just came on. */
  function renderChipRow(node, seats, acted, before) {
    node.replaceChildren(...seats.filter((s) => s.connected).map((s) => {
      const on = acted.includes(s.id);
      const chip = el('span', `chip${on ? ' on' : ''}`, s.id === state.you.id ? 'You' : s.name);
      if (on && !before.includes(s.id)) chip.classList.add('just');
      return chip;
    }));
    return [...acted];
  }

  function renderReadyGate(g) {
    const overlay = $('overlay-ready');
    overlay.hidden = g.phase !== 'ready';
    if (g.phase !== 'ready') { prev.ready = []; return; }

    $('ready-level').textContent = g.level;
    prev.ready = renderChipRow($('ready-list'), g.seats, g.ready, prev.ready);
    const btn = $('btn-ready');
    const iAmReady = g.ready.includes(state.you.id);
    btn.disabled = iAmReady;
    btn.textContent = iAmReady ? 'Waiting for the others…' : "I'm ready";
  }

  /**
   * Somebody played out of turn: the table stops here. The player who jumped
   * and the player who was sitting on the lowest card each get told, in their
   * own words, and play only resumes once both have owned it. Everyone else
   * watches — nobody can touch a card behind this.
   */
  function renderMistakeGate(g) {
    const overlay = $('overlay-mistake');
    overlay.hidden = g.phase !== 'mistake';
    if (g.phase !== 'mistake') return;

    const m = g.mistake;
    const you = state.you.id;
    const mine = you === m.culprit || you === m.victim;

    const iconBox = $('mistake-icon');
    iconBox.className = `result-icon${mine ? ' bad' : ''}`;
    iconBox.replaceChildren(icon('x'));

    // Their own line if they are in it, otherwise plainly what happened.
    $('mistake-title').textContent = m.message ?? 'Out of order';
    $('mistake-cards').replaceChildren(
      mistakeCard(m.card, 'played', 'bad'),
      mistakeCard(m.lowest, 'should have gone first', 'live'),
    );
    $('mistake-body').textContent = `${
      you === m.culprit
        ? `You played ${m.card} while ${nameIn(g, m.victim)} was still holding ${m.lowest}.`
        : you === m.victim
          ? `${nameIn(g, m.culprit)} played ${m.card} while you were still holding ${m.lowest}.`
          : `${nameIn(g, m.culprit)} played ${m.card} while ${nameIn(g, m.victim)} was still holding ${m.lowest}.`
    } It cost a life.`;

    const btn = $('btn-mistake');
    const yours = m.waitingOn.includes(you);
    btn.disabled = !yours;
    btn.textContent = yours
      ? 'My bad'
      : `Waiting for ${andList(m.waitingOn.map((id) => nameIn(g, id)))}…`;
    btn.onclick = () => send({ type: 'ackMistake' });
  }

  /** One of the two cards the mistake was between, with what it was. */
  function mistakeCard(value, label, cls) {
    const box = el('span', `mcard ${cls}`);
    box.append(el('b', null, value), el('em', null, label));
    return box;
  }

  function renderResult(g) {
    const result = $('overlay-result');
    const done = g.phase === 'levelCleared' || g.phase === 'won' || g.phase === 'lost';
    result.hidden = !done;
    $('result-list').hidden = g.phase !== 'lost';
    if (g.phase !== 'lost') prev.done = [];
    if (!done) return;

    const iconBox = $('result-icon');
    const btn = $('btn-result');
    iconBox.className = 'result-icon';
    btn.disabled = false; // an earlier run can have left it waiting on somebody

    if (g.phase === 'levelCleared') {
      const lost = g.livesLostThisLevel;
      const clean = lost === 0;
      iconBox.classList.add(clean ? 'good' : 'bad');
      iconBox.replaceChildren(icon(clean ? 'check' : 'heart'));
      $('result-title').textContent = clean
        ? `Level ${g.level} cleared`
        : `Level ${g.level} survived`;
      const reward = g.lastReward === 'life'
        ? ' You earned an extra life.'
        : g.lastReward === 'shuriken'
          ? ' You earned a shuriken.'
          : '';
      $('result-body').textContent = (clean
        ? 'Not a card out of place.'
        : `That cost ${lost} life${lost === 1 ? '' : 's'}.`) + reward;
      btn.textContent = `Start level ${g.level + 1}`;
      btn.onclick = () => send({ type: 'nextLevel' });
    } else if (g.phase === 'won') {
      iconBox.classList.add('win');
      iconBox.replaceChildren(icon('trophy'));
      $('result-title').textContent = 'You beat The Mind';
      $('result-body').textContent = `All ${g.maxLevel} levels cleared. That was genuinely telepathic.`;
      btn.textContent = state.you.isHost ? 'Play again' : 'Waiting for the host…';
      btn.disabled = !state.you.isHost;
      btn.onclick = () => send({ type: 'playAgain' });
    } else {
      // Lost. Nobody is moved off the final board until everybody has said so:
      // the run is over either way, and it is the table's to sit with.
      iconBox.classList.add('bad');
      iconBox.replaceChildren(icon('x'));
      const outOfTime = g.lostTo === 'time';
      $('result-title').textContent = outOfTime ? 'Out of time' : 'Out of lives';
      $('result-body').textContent = `${outOfTime
        ? `The clock ran out on level ${g.level} of ${g.maxLevel}.`
        : `You made it to level ${g.level} of ${g.maxLevel}.`
      } Sit with it as long as you like — the room goes back together.`;
      prev.done = renderChipRow($('result-list'), g.seats, g.done, prev.done);
      const iAmDone = g.done.includes(state.you.id);
      btn.disabled = iAmDone;
      btn.textContent = iAmDone ? 'Waiting for the others…' : 'Back to the lobby';
      btn.onclick = () => send({ type: 'backToLobby' });
    }
  }

  /* ── Wiring ─────────────────────────────────────────── */

  const nameInput = $('input-name');
  const codeInput = $('input-code');
  nameInput.value = store.get('name') || '';

  function currentName() {
    const name = nameInput.value.trim().slice(0, 14);
    if (!name) { toast('Enter your name first.'); nameInput.focus(); return null; }
    store.set('name', name);
    return name;
  }

  $('btn-create').addEventListener('click', () => {
    if (entering) return;
    const name = currentName();
    if (!name) return;
    setEntering(true);
    send({ type: 'create', name });
  });

  function doJoin() {
    if (entering) return;
    const name = currentName();
    if (!name) return;
    const code = codeInput.value.trim().toUpperCase();
    if (code.length !== 4) { toast('Room codes are 4 characters.'); codeInput.focus(); return; }
    setEntering(true);
    // If this is the room we were already in, claim the seat we already have
    // rather than asking for a new one.
    const savedId = store.get('code') === code ? store.get('playerId') : null;
    send(savedId ? { type: 'join', code, name, playerId: savedId } : { type: 'join', code, name });
  }
  $('btn-join').addEventListener('click', doJoin);
  codeInput.addEventListener('input', () => {
    codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  });
  codeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doJoin(); });
  nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') nameInput.blur(); });

  let copiedTimer;
  $('room-code').addEventListener('click', async () => {
    const node = $('room-code');
    try {
      await navigator.clipboard.writeText(state?.code ?? '');
      node.classList.add('copied');
      clearTimeout(copiedTimer);
      copiedTimer = setTimeout(() => node.classList.remove('copied'), 1600);
      toast('Room code copied.');
    } catch {
      toast('Copy it manually: ' + (state?.code ?? ''));
    }
  });

  $('hero').addEventListener('click', playLowest);
  $('btn-start').addEventListener('click', () => send({ type: 'start', timed: $('input-timed').checked }));
  $('btn-ready').addEventListener('click', () => send({ type: 'ready' }));
  $('btn-star').addEventListener('click', () => send({ type: 'star' }));

  $('btn-leave-lobby').addEventListener('click', askToLeave);
  $('btn-exit').addEventListener('click', askToLeave);
  $('btn-leave-cancel').addEventListener('click', closeLeave);
  $('btn-leave-confirm').addEventListener('click', () => goHome());

  const rules = $('overlay-rules');
  const openRules = () => { rules.hidden = false; syncExit(); };
  $('btn-rules-home').addEventListener('click', openRules);
  $('btn-rules-game').addEventListener('click', openRules);
  $('btn-rules-close').addEventListener('click', () => { rules.hidden = true; syncExit(); });

  // A room code in the URL (?room=ABCD) lets you share a join link.
  const fromUrl = new URLSearchParams(location.search).get('room');
  if (fromUrl) codeInput.value = fromUrl.toUpperCase().slice(0, 4);

  // Rejoin a room we were already in — survives a refresh or a backgrounded tab.
  const savedCode = store.get('code');
  const savedId = store.get('playerId');
  if (savedCode && savedId) {
    intent = { type: 'join', code: savedCode, name: store.get('name'), playerId: savedId };
    connect();
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && store.get('code') && !ws) connect();
  });
})();
