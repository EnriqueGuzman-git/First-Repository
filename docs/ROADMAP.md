# Engineering Roadmap & Known Limitations

This document is an honest, analysed backlog of the gaps between what the
protocol specification promises and what the server currently implements, plus
the infrastructure work that a multi-instance deployment would require. It is
deliberately specific: each item names the file, the observed behaviour, the
intended behaviour, and the reason it is sequenced where it is.

Items in **Tier 1** are correctness gaps in the realtime protocol. They are the
highest-value work because closing them removes divergence between `PROTOCOL.md`
and the running server. Several interact with client-side sequence-gap detection
and are best landed with the full unit/integration/E2E suite green, so they are
tracked here rather than rushed.

---

## Tier 1 — Protocol correctness

### ~~1. Recipient-scoped replay buffer~~ ✅ Fixed
- **Where:** `src/server/app/gameSession.ts` (`emit`, `getReplayEvents`).
- **Was:** A single `replayBuffer` collected every sequenced event regardless of
  delivery target. `MOVE_ACK` and `MOVE_BROADCAST` both landed in the same buffer.
- **Fixed:** Buffer entries now carry `{ event, target, anchorPlayerId }`.
  `getReplayEvents(fromSeq, requestingPlayerId)` filters by `broadcast` / `player`
  / `others` semantics. Integration tests updated accordingly.

### 2. `sessionSeq`: global counter vs. per-recipient ordering
- **Where:** `gameSession.ts` sequence allocation; `wsClient.ts` gap detection.
- **Decision needed:** Either (a) keep one global sequence and make the client
  tolerant of expected gaps for events it was never a recipient of, or (b) move
  to a per-recipient sequence so each client sees a strictly contiguous stream.
  Option (b) is cleaner for gap detection but changes the wire semantics and
  `PROTOCOL.md`. Capture the choice in an ADR before implementing.
- **Note:** The recipient-scoped buffer fix (item 1) chose option (a) — global
  sequence preserved, client gap-detection tolerates non-contiguous subsequences
  because the gaps correspond to events addressed to the other player.

### ~~3. RECONNECT should use REPLAY when the buffer covers the gap~~ ✅ Fixed
- **Where:** `src/server/app/commandHandler.ts` (`handleReconnect`).
- **Was:** Reconnect always answered with a full `STATE_SYNC` **SNAPSHOT**.
- **Fixed:** `handleReconnect` now calls `getReplayEvents(lastReceivedSeq + 1,
  playerId)` and sends `STATE_SYNC REPLAY` when the buffer covers the gap,
  falling back to SNAPSHOT only when the buffer is exhausted or empty.

### ~~4. Reload-reconnect is not auto-wired on the client~~ ✅ Fixed
- **Where:** `src/client/hooks/useWebSocket.ts`, `src/client/store/gameStore.ts`.
- **Was:** `AUTH_ACK` reducer never set `roomId`, so the auto-RECONNECT trigger
  always saw `null` after a page reload.
- **Fixed:** `AUTH_ACK` reducer now hydrates `roomId` and `mySymbol` from
  `existingRoom`, enabling transparent room rejoin on refresh.

### 5. `DUPLICATE_SESSION` is never enforced
- **Where:** `commandHandler.ts` player→connection registry (`Set`).
- **Now:** The same session token may open N simultaneous connections; the
  declared `DUPLICATE_SESSION` error is never emitted.
- **Intended:** Reject (or supersede) a second concurrent connection for a token
  per the spec, closing the newer/older connection deterministically.

### ~~6. `PLAYER_LEFT` / `DISCONNECT_TIMEOUT` on window expiry~~ ✅ Fixed
- **Where:** `gameSession.ts` reconnect-window timeout.
- **Was:** Window expiry abandoned the game but never emitted `PLAYER_LEFT` with
  reason `DISCONNECT_TIMEOUT`, and the slot was never freed.
- **Fixed:** `GameSession` now emits `PLAYER_LEFT` (broadcast) on expiry and
  calls an injected `OnPlayerLeftFn` callback that handles `removePlayer` and
  `sessions.setRoom(null)` at the command-handler layer.

---

## Tier 2 — Hardening (partially addressed)

- **HTTP abuse protection.** `POST /api/rooms` is now rate-limited and room ids
  are validated (done — see CHANGELOG). Remaining: consider limiting the read
  endpoints and protecting `/metrics` behind an internal-only guard.
- **Server exception boundary.** `INTERNAL_ERROR` with `traceId` is now produced
  on unexpected handler throws (done). Remaining: add an integration test that
  forces a handler throw and asserts the `INTERNAL_ERROR` shape.
- **Structured error emission.** Wire up the remaining declared-but-unused codes
  (`ROOM_EXPIRED`, `RECONNECT_WINDOW_EXPIRED`, `UNAUTHORIZED`) at the points the
  spec describes.

---

## Tier 3 — Deployment scale (out of current scope by design)

These are called out in the README's "Production Considerations" and are
infrastructure rather than application concerns:

- External durable store for rooms/sessions/history (currently in-memory + JSON).
- Shared coordination (Redis) for multi-instance rooms and WebSocket fan-out.
- Distributed rate limiting (the current limiter is per-process).
- Centralised structured logging / tracing (propagate the `traceId` end-to-end).
- Horizontal scaling and load-balancer WebSocket/session affinity.

---

## How to pick up the remaining Tier 1 item

1. Reproduce the current behaviour with a failing unit or integration test.
2. For item 2 (sessionSeq model): record the design decision in an ADR and update
   `PROTOCOL.md` before changing wire semantics.
3. Implement, keeping the game engine transport-free.
4. Green the full suite: `npm run lint && npm run typecheck && npm test && npm run test:e2e`.
