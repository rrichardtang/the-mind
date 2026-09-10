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
  let lastLogId = 0;
  let entering = false;   // a create/join is in flight, so the buttons stay locked

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
  function show(name) {
    for (const [k, node] of Object.entries(screens)) node.hidden = k !== name;
  }

  let toastTimer;
  function toast(text) {
    const node = $('toast');
    node.textContent = text;
    node.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { node.hidden = true; }, 3200);
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

  /** Drop the room we were in and go back to the start, optionally saying why. */
  function goHome(message) {
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

  /* ── Render ─────────────────────────────────────────── */

  function render(next) {
    state = next;
    if (!state.game) { stopTimer(); renderLobby(); show('lobby'); return; }
    renderGame();
    show('game');
  }

  function renderLobby() {
    $('room-code').textContent = state.code;

    const list = $('lobby-players');
    list.replaceChildren();
    for (const p of state.lobby) {
      const li = el('li');
      li.append(el('span', 'avatar', initials(p.name)), el('span', 'player-name', p.name));
      if (p.isHost) li.append(el('span', 'tag', 'Host'));
      if (p.id === state.you.id) li.append(el('span', 'tag', 'You'));
      if (state.you.isHost && p.id !== state.you.id) {
        const remove = el('button', 'remove-btn', '✕');
        remove.type = 'button';
        remove.title = `Remove ${p.name}`;
        remove.setAttribute('aria-label', `Remove ${p.name}`);
        remove.addEventListener('click', () => send({ type: 'removePlayer', playerId: p.id }));
        li.append(remove);
      }
      list.append(li);
    }

    $('timed-toggle').hidden = !state.you.isHost;

    const enough = state.lobby.length >= state.minPlayers;
    const start = $('btn-start');
    start.hidden = !state.you.isHost;
    start.disabled = !enough;

    $('lobby-status').textContent = !enough
      ? `Waiting for players — ${state.minPlayers} minimum, up to ${state.maxPlayers}.`
      : state.you.isHost
        ? `${state.lobby.length} players · ${state.plannedLevels} levels · ${state.lobby.length} lives · 1 shuriken`
        : 'Waiting for the host to start…';
  }

  function renderGame() {
    const g = state.game;

    $('hud-level').textContent = g.level;
    $('hud-maxlevel').textContent = `/ ${g.maxLevel}`;
    renderTokens($('hud-lives'), g.lives, g.maxLives, 'life', '♥');
    renderTokens($('hud-shurikens'), g.shurikens, 4, 'star', '✦');

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

  function renderTimer(g) {
    const running = g.timed && g.msRemaining != null;
    $('hud-timer').hidden = !running;
    if (!running) { stopTimer(); return; }
    timerEndsAt = performance.now() + g.msRemaining;
    tickTimer();
    timerInterval ??= setInterval(tickTimer, 250);
  }

  function tickTimer() {
    const left = Math.max(0, timerEndsAt - performance.now());
    const secs = Math.ceil(left / 1000);
    const node = $('hud-timer');
    node.textContent = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
    node.classList.toggle('urgent', left <= 30000);
  }

  function stopTimer() {
    clearInterval(timerInterval);
    timerInterval = null;
  }

  function renderTokens(node, count, max, cls, glyph) {
    node.replaceChildren();
    const shown = Math.max(count, Math.min(max, count + 1));
    for (let i = 0; i < shown; i++) {
      node.append(el('span', `token ${cls}${i < count ? '' : ' spent'}`, glyph));
    }
  }

  function renderSeats(g) {
    const node = $('seats');
    node.replaceChildren();
    for (const s of g.seats) {
      const li = el('li');
      if (s.id === state.you.id) li.classList.add('is-you');
      if (!s.connected) li.classList.add('is-out');
      if (g.phase === 'ready' && s.ready) li.classList.add('is-ready');
      if (g.phase === 'playing' && s.votedStar) li.classList.add('is-voting');
      li.append(el('div', 'seat-name', s.id === state.you.id ? 'You' : s.name));
      const meta = !s.connected ? 'offline' : s.votedStar && g.phase === 'playing' ? '✦ voted'
        : `${s.cards} card${s.cards === 1 ? '' : 's'}`;
      li.append(el('div', 'seat-meta', meta));
      node.append(li);
    }
  }

  function renderPile(g) {
    // One ascending timeline of everything resolved this level, so you can see
    // both what landed and what got burned.
    const resolved = [
      ...g.pile.map((c) => ({ card: c, burned: false })),
      ...g.discarded.map((c) => ({ card: c, burned: true })),
    ].sort((a, b) => a.card - b.card);

    const trail = $('pile-trail');
    trail.replaceChildren();
    if (resolved.length === 0) {
      trail.append(el('span', 'empty', 'Nothing played yet'));
    } else {
      for (const r of resolved) {
        const latest = !r.burned && r.card === g.topCard;
        trail.append(el('span', `chip${r.burned ? ' burned' : ''}${latest ? ' latest' : ''}`, r.card));
      }
      trail.scrollLeft = trail.scrollWidth;
    }
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
    } else {
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
    if (!last) { node.textContent = ''; return; }
    if (last.kind === 'mistake') node.classList.add('mistake');
    else if (last.kind === 'shuriken') node.classList.add('shuriken');
    else if (last.kind === 'cleared') node.classList.add('good');
    node.textContent = last.text;
    if (last.id !== lastLogId && last.kind === 'shuriken') buzz(30);
    lastLogId = last.id;
  }

  function renderHand(g) {
    const node = $('hand');
    node.replaceChildren();

    if (g.hand.length === 0) {
      node.append(el('div', 'hand-empty', 'No cards left — help the others land theirs.'));
    } else {
      // The slider shows your hand at a glance; the hero card is what you press.
      g.hand.forEach((card, i) => node.append(el('div', `card${i === 0 ? ' next' : ''}`, card)));
      node.scrollLeft = 0;
    }

    $('hand-label').textContent = g.hand.length ? `Your hand · ${g.hand.length}` : 'Your hand · empty';

    const star = $('btn-star');
    const votesNeeded = g.seats.filter((s) => s.connected).length;
    star.disabled = g.phase !== 'playing' || g.shurikens === 0;
    star.classList.toggle('voted', g.starVotes.includes(state.you.id));
    $('star-label').textContent = g.shurikens === 0
      ? 'No shurikens'
      : g.starVotes.length > 0
        ? `Shuriken ${g.starVotes.length}/${votesNeeded}`
        : 'Throw shuriken';
  }

  function renderOverlays(g) {
    const readyOverlay = $('overlay-ready');
    readyOverlay.hidden = g.phase !== 'ready';
    if (g.phase === 'ready') {
      $('ready-level').textContent = g.level;
      const list = $('ready-list');
      list.replaceChildren(...g.seats.filter((s) => s.connected).map((s) => {
        const chip = el('span', `chip${s.ready ? ' on' : ''}`, s.id === state.you.id ? 'You' : s.name);
        return chip;
      }));
      const btn = $('btn-ready');
      const iAmReady = g.ready.includes(state.you.id);
      btn.disabled = iAmReady;
      btn.textContent = iAmReady ? 'Waiting for the others…' : "I'm ready";
    }

    const result = $('overlay-result');
    const done = g.phase === 'levelCleared' || g.phase === 'won' || g.phase === 'lost';
    result.hidden = !done;
    if (!done) return;

    const icon = $('result-icon');
    const btn = $('btn-result');
    icon.className = 'result-icon';

    if (g.phase === 'levelCleared') {
      const lost = g.livesLostThisLevel;
      const clean = lost === 0;
      icon.classList.add(clean ? 'good' : 'bad');
      icon.textContent = clean ? '✓' : '♥';
      $('result-title').textContent = clean
        ? `Level ${g.level} cleared`
        : `Level ${g.level} survived`;
      const reward = g.lastReward === 'life'
        ? ' You earned an extra life ♥'
        : g.lastReward === 'shuriken'
          ? ' You earned a shuriken ✦'
          : '';
      $('result-body').textContent = (clean
        ? 'Not a card out of place.'
        : `That cost ${lost} life${lost === 1 ? '' : 's'}.`) + reward;
      btn.textContent = `Start level ${g.level + 1}`;
      btn.onclick = () => send({ type: 'nextLevel' });
    } else if (g.phase === 'won') {
      icon.classList.add('win');
      icon.textContent = '★';
      $('result-title').textContent = 'You beat The Mind';
      $('result-body').textContent = `All ${g.maxLevel} levels cleared. That was genuinely telepathic.`;
      btn.textContent = state.you.isHost ? 'Play again' : 'Waiting for the host…';
      btn.disabled = !state.you.isHost;
      btn.onclick = () => send({ type: 'playAgain' });
    } else {
      icon.classList.add('bad');
      icon.textContent = '✕';
      const outOfTime = g.lostTo === 'time';
      $('result-title').textContent = outOfTime ? 'Out of time' : 'Out of lives';
      $('result-body').textContent = outOfTime
        ? `The clock ran out on level ${g.level} of ${g.maxLevel}.`
        : `You made it to level ${g.level} of ${g.maxLevel}.`;
      btn.textContent = state.you.isHost ? 'Play again' : 'Waiting for the host…';
      btn.disabled = !state.you.isHost;
      btn.onclick = () => send({ type: 'playAgain' });
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

  $('room-code').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(state?.code ?? '');
      toast('Room code copied.');
    } catch {
      toast('Copy it manually: ' + (state?.code ?? ''));
    }
  });

  $('hero').addEventListener('click', playLowest);
  $('btn-start').addEventListener('click', () => send({ type: 'start', timed: $('input-timed').checked }));
  $('btn-ready').addEventListener('click', () => send({ type: 'ready' }));
  $('btn-star').addEventListener('click', () => send({ type: 'star' }));

  $('btn-leave-lobby').addEventListener('click', () => goHome());

  const rules = $('overlay-rules');
  $('btn-rules-home').addEventListener('click', () => { rules.hidden = false; });
  $('btn-rules-game').addEventListener('click', () => { rules.hidden = false; });
  $('btn-rules-close').addEventListener('click', () => { rules.hidden = true; });

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
