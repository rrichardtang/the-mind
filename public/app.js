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
  let lastTopCard = null;
  let lastLives = null;
  let lastLogId = 0;

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
      store.set('code', msg.code);
      store.set('playerId', msg.playerId);
      return;
    }
    if (msg.type === 'error') {
      toast(msg.message);
      // A stale saved room shouldn't trap us on a reconnect loop.
      if (/No room called|already in progress|is full/i.test(msg.message)) {
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

  const buzz = (ms) => { try { navigator.vibrate?.(ms); } catch { /* unsupported */ } };
  const initials = (name) => (name || '?').trim().slice(0, 2).toUpperCase();

  /* ── Render ─────────────────────────────────────────── */

  function render(next) {
    state = next;
    if (!state.game) { renderLobby(); show('lobby'); return; }
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
      list.append(li);
    }

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

    renderSeats(g);
    renderPile(g);
    renderFeed(g);
    renderHand(g);
    renderOverlays(g);

    lastTopCard = g.topCard;
    lastLives = g.lives;
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
    const card = $('pile-card');
    const slot = card.parentElement;

    card.textContent = g.topCard ?? '—';
    card.classList.toggle('empty', g.topCard == null);
    if (g.topCard != null && g.topCard !== lastTopCard) {
      card.classList.remove('pop');
      void card.offsetWidth; // restart the animation
      card.classList.add('pop');
    }
    if (lastLives != null && g.lives < lastLives) {
      slot.classList.remove('shake');
      void slot.offsetWidth;
      slot.classList.add('shake');
      buzz([40, 60, 40]);
    }
    // The pile is re-rendered on every state, so a level change must not
    // inherit the previous level's mistake styling.
    if (g.pile.length === 0 && g.discarded.length === 0) slot.classList.remove('shake');

    $('pile-note').textContent = g.phase === 'ready'
      ? 'Waiting for everyone to focus'
      : `${g.cardsRemaining} card${g.cardsRemaining === 1 ? '' : 's'} still in hands`;

    const discard = $('discard');
    discard.hidden = g.discarded.length === 0;
    discard.replaceChildren(...g.discarded.map((c) => el('span', 'chip', c)));
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
      // Only the lowest card is playable: holding it back is always a mistake
      // against yourself, so this just prevents fat-finger disasters.
      g.hand.forEach((card, i) => {
        const playable = i === 0 && g.phase === 'playing';
        const btn = el('button', `card ${playable ? 'playable' : 'locked'}`, card);
        btn.disabled = !playable;
        if (playable) {
          btn.addEventListener('click', () => { buzz(12); send({ type: 'play', card }); });
        }
        node.append(btn);
      });
    }

    $('hand-label').textContent = g.hand.length
      ? `Your hand · ${g.hand.length}`
      : 'Your hand · empty';

    const star = $('btn-star');
    const youVoted = g.starVotes.includes(state.you.id);
    const votesNeeded = g.seats.filter((s) => s.connected).length;
    star.disabled = g.phase !== 'playing' || g.shurikens === 0;
    star.classList.toggle('voted', youVoted);
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
      $('result-title').textContent = 'Out of lives';
      $('result-body').textContent = `You made it to level ${g.level} of ${g.maxLevel}.`;
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
    const name = currentName();
    if (name) send({ type: 'create', name });
  });

  function doJoin() {
    const name = currentName();
    if (!name) return;
    const code = codeInput.value.trim().toUpperCase();
    if (code.length !== 4) { toast('Room codes are 4 characters.'); codeInput.focus(); return; }
    send({ type: 'join', code, name });
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

  $('btn-start').addEventListener('click', () => send({ type: 'start' }));
  $('btn-ready').addEventListener('click', () => send({ type: 'ready' }));
  $('btn-star').addEventListener('click', () => send({ type: 'star' }));

  $('btn-leave-lobby').addEventListener('click', () => {
    store.del('code'); store.del('playerId');
    intent = null;
    state = null;
    ws?.close();
    ws = null;
    show('home');
  });

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
