# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project aims
to follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed
- **Reload-reconnect restored (ROADMAP #4).** The `AUTH_ACK` reducer in
  `gameStore.ts` now hydrates `roomId` and `mySymbol` from `existingRoom`. The
  auto-RECONNECT trigger in `useWebSocket.ts` reads `roomId` from the store, so
  after a page reload the client now transparently rejoins its room as the server
  intended.
- **Recipient-scoped replay buffer (ROADMAP #1).** `GameSession.replayBuffer`
  entries now carry `{ event, target, anchorPlayerId }` metadata. The new
  `getReplayEvents(fromSeq, requestingPlayerId)` filters by delivery semantics:
  `broadcast` → all; `player P` → only P; `others P` → everyone except P. This
  prevents `MOVE_ACK` (mover-only) from appearing in an opponent's replay, and
  vice-versa for `MOVE_BROADCAST`.
- **RECONNECT uses REPLAY when buffer covers the gap (ROADMAP #3).** 
  `handleReconnect` now tries a recipient-scoped `STATE_SYNC REPLAY` first,
  falling back to `SNAPSHOT` only when the buffer has been trimmed past the
  client's last known sequence number. `handleSyncRequest` also passes
  `playerId` to `getReplayEvents` for consistent scoping.
- **`PLAYER_LEFT` emitted on reconnect window expiry (ROADMAP #6).** When a
  player's 5-minute reconnect window expires, `GameSession` now emits
  `PLAYER_LEFT` with `reason: 'DISCONNECT_TIMEOUT'` before freeing the slot.
  Slot cleanup (`rooms.removePlayer`, `sessions.setRoom(null)`) is handled via
  an injected `OnPlayerLeftFn` callback so `GameSession` remains decoupled from
  `RoomStore` and `SessionStore`.
- **`prefer-const` lint errors in `rateLimiter.test.ts`.** Two `let clock`
  declarations that are never reassigned within their test cases changed to
  `const`.

### Added
- **Server exception boundary.** The WebSocket message router now wraps command
  routing and delivery in a try/catch that converts any unexpected handler throw
  into the protocol's `INTERNAL_ERROR` event with a generated `traceId`, instead
  of letting the exception escape the socket `message` callback.
- **HTTP rate limiting.** `POST /api/rooms` is protected by a fixed-window
  limiter (20 creations / minute / client), returning `429` with a `Retry-After`
  header. The limiter is a small, injectable-clock, unit-tested utility
  (`src/server/http/rateLimiter.ts`).
- **Graceful-shutdown notice.** On `SIGINT`/`SIGTERM` the server now broadcasts a
  `SERVER_SHUTTING_DOWN` error to all connected clients before closing sockets,
  via a new `ConnectionManager.broadcastAll`.
- **Repository engineering scaffolding:** GitHub Actions CI (lint · typecheck ·
  test+coverage · build, plus Playwright E2E and a Docker image build),
  multi-stage `Dockerfile`, `docker-compose.yml`, `LICENSE` (MIT),
  `CONTRIBUTING.md`, `.env.example`, `.editorconfig`, and `.nvmrc`.
- **`SessionStore.getTokenByPlayerId`.** New lookup method used by the
  `OnPlayerLeftFn` callback to clear room associations on reconnect window
  expiry.

### Changed
- **HTTP room-id validation.** `GET /api/rooms/:id` and `.../history` now reject
  malformed ids with `400 INVALID_ROOM_ID` using the shared `isRoomId` guard,
  instead of casting the raw path segment straight to `RoomId`.
- **Comment pass.** Reduced explanatory comments across the codebase to a
  senior standard — kept invariants, protocol/spec references, and non-obvious
  "why" rationale; removed section-divider art and comments that restated code.
- **Integration tests for `SYNC_REQUEST` updated** to reflect correct
  recipient-scoped behavior: P1's replay no longer contains `MOVE_BROADCAST`
  (which was addressed to P2), and a pre-game sync correctly falls back to
  `SNAPSHOT` when there are no events to replay.

### Removed
- Dead code with no call sites: `logger.withTrace`,
  `idGenerator.generateMessageId` / `generateCommandId`,
  `ConnectionManager.getConnectionIdForPlayer`, `roomStore.getSlot` /
  `RoomStore.deleteRoom`, `SessionStore.getSessionByPlayerId` (and its now-unused
  reverse index), `GameSession.activeGameId`, `createEmptyHistoryRepository`,
  the never-dispatched `MOVE_ACK_LATENCY` client action, `commandBuilder.buildAuth`
  / `buildPing`, `optimisticEngine.detectWinningLine`, `wsClient` `getState` /
  `getRoomId` and the unused `getWsClient` / `destroyWsClient` singleton, and a
  vacuous placeholder unit test.
- Committed `test-results/` Playwright artifacts (directory was already in
  `.gitignore`; removed the files that had been committed before the ignore rule
  was in place).
- Stale "no license selected" boilerplate from `README.md` (the project has been
  MIT-licensed since the initial commit).

### Known limitations
- See [`docs/ROADMAP.md`](./docs/ROADMAP.md) for the remaining protocol gaps:
  `DUPLICATE_SESSION` enforcement (ROADMAP #5) and the `sessionStorage` vs.
  `localStorage` spec divergence are still deferred.
