# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project aims
to follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed
- **`vitest.config.ts` Windows path bug.** The alias for `@ttt/shared/protocol`
  used `new URL(...).pathname` which produces an invalid `/C:/...` path on
  Windows. Replaced with `fileURLToPath(new URL(...))` which returns a correct
  platform-native path on all operating systems.
- **`messageRouter.ts` `'others'` delivery target.** The `deliver()` method was
  sending events to the *anchor* player instead of *excluding* them. Fixed to
  iterate `playerConnectionRegistry` and skip the anchor playerId.
- **`gameSession.ts` replay buffer coverage check.** `getReplayEvents` was
  checking the global oldest buffer entry to detect trim/exhaustion, but the
  oldest entry may belong to the other player. Now checks the oldest entry
  *scoped to the requesting player* for a correct per-player gap detection.
- **`gameSession.ts` unused `firstTurnOverride` parameter removed.** No caller
  ever passed this argument; the turn is now always sourced directly from
  `createRematch().newState.firstTurn`.
- **`useWebSocket.ts` `Array(9).fill('')` replaced with `EMPTY_BOARD`.** All
  three occurrences of the double-cast board fallback replaced with the shared
  `EMPTY_BOARD` constant for clarity and type safety.
- **`useWebSocket.ts` stale REPLAY comment corrected.** The comment said events
  "arrive as individual events" which was incorrect — in REPLAY mode they are
  bundled in `event.events` and dispatched by the for-loop immediately above.
- **`GameStatus.tsx` ABANDONED text fixed.** When the local player abandoned the
  game, the message incorrectly read "Opponent abandoned the game". Now reads
  "You abandoned the game" when `result.winner !== mySymbol`.
- **`wsClient.ts` misleading close-code comment fixed.** Code `4003` (never sent
  by the server) replaced with `4006` (actual ping-timeout close code the server
  sends on idle connections). Comment updated accordingly.
- **`vitest.config.ts` coverage `include` now covers `src/server/security/`.**
  `originPolicy.ts` was excluded from coverage reporting despite having its own
  test file.

### Fixed (previous session)
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
  client's last known sequence number.
- **`PLAYER_LEFT` emitted on reconnect window expiry (ROADMAP #6).** When a
  player's 5-minute reconnect window expires, `GameSession` now emits
  `PLAYER_LEFT` with `reason: 'DISCONNECT_TIMEOUT'` before freeing the slot.
- **`prefer-const` lint errors in `rateLimiter.test.ts`.**
- **Committed `test-results/` artifacts removed.**
- **Stale "no license" boilerplate removed from `README.md`.**

### Added
- **Server exception boundary.** The WebSocket message router now wraps command
  routing and delivery in a try/catch that converts any unexpected handler throw
  into the protocol's `INTERNAL_ERROR` event with a generated `traceId`.
- **HTTP rate limiting.** `POST /api/rooms` protected by a fixed-window limiter
  (20 creations / minute / client), returning `429` with a `Retry-After` header.
- **Graceful-shutdown notice.** On `SIGINT`/`SIGTERM` the server broadcasts
  `SERVER_SHUTTING_DOWN` to all connected clients before closing sockets.
- **CI matrix extended to Node 24.x.**
- **Dependabot updates grouped** — GitHub Actions and related npm packages now
  batch into single PRs instead of flooding with individual ones.
- **`SessionStore.getTokenByPlayerId`** — new lookup used by `OnPlayerLeftFn`
  callback to clear room associations on reconnect window expiry.
- **Repository scaffolding:** GitHub Actions CI, multi-stage `Dockerfile`,
  `docker-compose.yml`, `LICENSE` (MIT), `CONTRIBUTING.md`, `.env.example`,
  `.editorconfig`, `.nvmrc`.

### Changed
- **HTTP room-id validation.** `GET /api/rooms/:id` and `.../history` now reject
  malformed ids with `400 INVALID_ROOM_ID`.
- **Integration tests for `SYNC_REQUEST` updated** to reflect correct
  recipient-scoped behavior.
- **README Getting Started section** clarified with numbered steps and the
  required `npm run build:server` before first run.

### Removed
- Dead code with no call sites (see previous CHANGELOG entries).
- `test-results/` Playwright artifacts from version control.
- Stale "no license selected" boilerplate from `README.md`.

### Known limitations
- See [`docs/ROADMAP.md`](./docs/ROADMAP.md) for remaining items: `DUPLICATE_SESSION`
  enforcement (ROADMAP #5) and `sessionStorage` vs. `localStorage` spec
  divergence are still deferred.
