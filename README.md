# The Mind

A mobile web version of [The Mind](https://boardgamegeek.com/boardgame/244992/mind) for playing
with friends on your phones — real-time, room-code multiplayer, with lives and shurikens.

Everyone opens the same URL, one person creates a room, the rest join with a 4-character code.
Hands are dealt and validated on the server, so nobody can see anyone else's cards.

## Running it

```bash
npm install
npm start          # http://localhost:3000
```

Then open the URL on every phone. On the same wifi, use your machine's LAN address
(e.g. `http://192.168.1.20:3000`) so your friends' phones can reach it.

`npm run dev` restarts on file changes. `PORT=8080 npm start` changes the port.

## Playing

Level N deals every player N cards from a 1–100 deck. Together you have to play them all into
one pile in **ascending order — without communicating**. No talking, no gestures, no counting.

- Play a card while someone still holds a lower one and you **lose a life**; every lower card is
  discarded face up.
- A **shuriken ✦** takes unanimous agreement. Everyone then discards their lowest card face up.
- Clearing certain levels earns a bonus life or shuriken.
- Lives hit zero and the run ends. Clear the last level and you've beaten The Mind.

Your hand is always sorted ascending. Your **lowest card fills most of the screen** — tap it to
play it, and it flies up into the pile as the next card rises to take its place. The strip along
the bottom is the rest of your hand at a glance, and the row above the big card is everything
already resolved this level: played cards plain, burned cards struck through.

Only your lowest card is ever playable. Holding a lower card back is always a mistake against
yourself, so this costs you nothing and saves you from fat-fingering a card out of order.

| Players | Levels | Starting lives | Starting shurikens |
| ------- | ------ | -------------- | ------------------ |
| 2       | 12     | 2              | 1                  |
| 3       | 10     | 3              | 1                  |
| 4       | 8      | 4              | 1                  |
| 5–6     | 8      | 5–6            | 1                  |

2–4 players is the official table. 5–6 is an unofficial extension so bigger groups can play.

### House rules

The physical game prints each level's reward on its level card. This build grants a **shuriken
after levels 2, 5 and 8** and a **life after levels 3, 6 and 9**, capped at 5 lives and 4
shurikens. If your copy's level cards differ, edit the `REWARDS` table at the top of
[`server/game.js`](server/game.js) — it's the only place those are defined.

## Notes

- **Dropped connection.** Your seat and hand are held open; reopening the page rejoins the same
  room automatically. Mid-game a disconnected player keeps their seat, so the game can carry on
  when someone's phone locks.
- **Rooms** are in-memory and disappear when the server restarts, plus 6 hours after the last
  player leaves. Nothing is persisted, and there are no accounts.
- **Add to Home Screen** on iOS or Android for a full-screen, app-like game.

## Layout

```
server/game.js    rules engine — pure logic, no I/O
server/index.js   static hosting, rooms, WebSocket protocol
public/           the client (no build step, no framework)
test/             engine unit tests + end-to-end WebSocket tests
```

The rules live entirely on the server. Clients render whatever state they're sent and are told
only their own hand — every other player is just a card count.

```bash
npm test
```
