# Tic-Tac-Toe Realtime Protocol Specification

**Version:** 1  
**Status:** Authoritative  
**Last Updated:** 2026-09-02

---

## Table of Contents

1. [Overview](#1-overview)
2. [Design Principles](#2-design-principles)
3. [Transport and Framing](#3-transport-and-framing)
4. [Message Envelope](#4-message-envelope)
5. [Protocol Versioning](#5-protocol-versioning)
6. [Sequence Numbers](#6-sequence-numbers)
7. [Idempotency](#7-idempotency)
8. [Connection Lifecycle](#8-connection-lifecycle)
9. [Authentication](#9-authentication)
10. [Authorization](#10-authorization)
11. [Message Catalog](#11-message-catalog)
    - 11.1 [Connection Handshake](#111-connection-handshake)
    - 11.2 [Authentication](#112-authentication)
    - 11.3 [Room Join](#113-room-join)
    - 11.4 [Room Leave](#114-room-leave)
    - 11.5 [Player Ready](#115-player-ready)
    - 11.6 [Game Start](#116-game-start)
    - 11.7 [Move Command](#117-move-command)
    - 11.8 [Move Acknowledgement](#118-move-acknowledgement)
    - 11.9 [Move Broadcast](#119-move-broadcast)
    - 11.10 [Invalid Move](#1110-invalid-move)
    - 11.11 [Game Finished](#1111-game-finished)
    - 11.12 [Rematch](#1112-rematch)
    - 11.13 [Heartbeat](#1113-heartbeat)
    - 11.14 [Reconnect](#1114-reconnect)
    - 11.15 [State Synchronization](#1115-state-synchronization)
    - 11.16 [Error Messages](#1116-error-messages)
12. [Failure Handling](#12-failure-handling)
13. [State Machine: Game Session](#13-state-machine-game-session)
14. [State Machine: Client Connection](#14-state-machine-client-connection)
15. [Complete Flow Examples](#15-complete-flow-examples)
16. [Security Considerations](#16-security-considerations)

---

## 1. Overview

This document is the single source of truth for the WebSocket protocol between the
Tic-Tac-Toe game client and server.

The protocol is designed around the following guarantees:

- **Server-authoritative.** The server owns all game state. The client never modifies game
  state unilaterally; it only sends commands and renders events.
- **Versioned.** Every message carries a protocol version. Version mismatches are detected
  and handled explicitly.
- **Sequenced.** Every server-to-client event carries a monotonically increasing sequence
  number scoped to the game session. Clients use this to detect gaps and order events.
- **Idempotent commands.** Every client command carries a `commandId`. Retrying a command
  with the same `commandId` produces the same observable outcome with no side effects.
- **Observable.** Every event carries enough context to understand the game state transition
  without consulting prior events.

---

## 2. Design Principles

| Principle | Description |
|---|---|
| **Single source of truth** | Server game state is canonical. Client state is a projection. |
| **Commands vs. Events** | Client sends _commands_ (intent). Server emits _events_ (facts). |
| **No silent failures** | Every command produces an explicit acknowledgement or rejection. |
| **No implicit ordering** | Sequence numbers make ordering explicit. |
| **Fail safe** | Unknown message types are logged and ignored, never crash. |
| **Minimal trust** | Server validates every command regardless of client state. |
| **Explicit lifecycle** | Every state transition has a defined trigger and result. |

---

## 3. Transport and Framing

### Transport

```
wss://<host>/ws
```

- Protocol: WebSocket (RFC 6455)
- TLS required in production (`wss://`)
- `ws://` permitted in local development only
- HTTP upgrade path: `GET /ws` with `Upgrade: websocket`

### Framing

All messages are UTF-8 encoded JSON text frames. Binary frames are reserved for
future use and must be rejected with a `PROTOCOL_ERROR` if received.

Maximum frame size: **64 KB**. Messages exceeding this limit are rejected with
`MESSAGE_TOO_LARGE`.

### Subprotocol Header

The client MUST request the negotiated subprotocol on upgrade:

```
Sec-WebSocket-Protocol: ttt-v1
```

The server MUST reject connections that do not send this header, or that request
an unsupported version.

---

## 4. Message Envelope

Every message — whether a command (client→server) or event (server→client) —
is wrapped in a common envelope.

### Base Envelope Fields

```
field          type      direction  required  description
─────────────────────────────────────────────────────────────────────
protocolVersion  number  both       yes       Always 1 for this version
messageId        string  both       yes       UUID v4; unique per message
timestamp        number  both       yes       Unix epoch in milliseconds (sender's clock)
type             string  both       yes       Message type discriminator (see catalog)
```

### Command Envelope (client → server)

Extends the base envelope with:

```
field        type    required  description
──────────────────────────────────────────────────────────────────
commandId    string  yes       UUID v4; stable across retries (idempotency key)
sessionToken string  yes       Opaque token issued at authentication
roomId       string  yes *     Required for all room-scoped commands
```

`*` Not required for AUTH and PING commands.

### Event Envelope (server → client)

Extends the base envelope with:

```
field           type    required  description
───────────────────────────────────────────────────────────────────
roomId          string  yes *     Room the event belongs to
sessionSeq      number  yes *     Server-managed sequence, monotone per game session
                                  Starts at 1. Increments by 1 for every event.
                                  Used by client to detect missing events.
correlationId   string  no        Echoes commandId of the command that caused this event
```

`*` Not required for PONG, AUTH_ACK, and ERROR events emitted before room join.

### Why `commandId` ≠ `messageId`

`messageId` identifies the specific transmission. If the client retries a command
(new TCP connection, new WebSocket), it sends a new `messageId` but the **same**
`commandId`. The server deduplicates on `commandId`.

---

## 5. Protocol Versioning

### Version Negotiation

```
Client (HTTP Upgrade)
  Sec-WebSocket-Protocol: ttt-v1

Server accepts or closes with 4001 (Unsupported Protocol Version)
```

If the server supports `ttt-v1`, it echoes the subprotocol in the response header.
If not, it sends a WebSocket close frame with code `4001` and reason
`"Unsupported protocol version. Supported: ttt-v1"`.

### In-Message Version Field

`protocolVersion: 1` is present in every message regardless of the subprotocol
header. This serves as a secondary check and aids debugging.

### Forward/Backward Compatibility Rules

| Scenario | Behavior |
|---|---|
| Client sends unknown field | Server ignores the field |
| Server sends unknown field | Client ignores the field |
| Client sends unsupported `type` | Server responds with `UNKNOWN_MESSAGE_TYPE` error |
| Server sends unknown `type` to client | Client logs and ignores |
| `protocolVersion` mismatch | Hard failure: server sends `PROTOCOL_VERSION_MISMATCH` and closes |

---

## 6. Sequence Numbers

### `sessionSeq` — Server sequence per game session

- Integer, starts at **1** when the game session is created.
- Increments by exactly **1** for every event the server emits on that session.
- Scoped to a `(roomId, gameId)` pair. A rematch resets `sessionSeq` to `1`.
- The server sends `sessionSeq` on every room-scoped event.

### Client Gap Detection

On every received event, the client checks:

```
expected = lastReceivedSeq + 1

if event.sessionSeq == expected:
    accept event, advance lastReceivedSeq
elif event.sessionSeq > expected:
    gap detected — send SYNC_REQUEST (see §11.15)
elif event.sessionSeq <= lastReceivedSeq:
    duplicate — discard silently
```

### On Reconnect

The client sends `lastReceivedSeq` in the `RECONNECT` command. The server
replays all events from `lastReceivedSeq + 1` up to the current sequence.
If the gap is too large (> 500 events) or the events are no longer in the
buffer, the server sends a full `STATE_SYNC` snapshot instead.

---

## 7. Idempotency

### Rule

A command with a `commandId` that the server has already processed MUST NOT
be applied again. The server MUST return the same response as the original
command (or the closest cached equivalent).

### Command Deduplication Window

The server retains processed `commandId` values for **5 minutes** after
processing. After that window, a replayed commandId is treated as a new
command.

**Rationale:** Network round-trips take at most a few seconds. A 5-minute window
comfortably covers retry scenarios while bounding memory usage.

### Idempotency by Message Type

| Command | Idempotent? | Behavior on duplicate |
|---|---|---|
| `AUTH` | Yes | Return same `AUTH_ACK` with same `sessionToken` |
| `JOIN_ROOM` | Yes | Return same `ROOM_JOINED` event; no state change |
| `LEAVE_ROOM` | Yes | Return same `ROOM_LEFT` event; no state change |
| `PLAYER_READY` | Yes | No-op if already ready; return same `PLAYER_READY_ACK` |
| `MAKE_MOVE` | Yes | No-op if move already applied; return same `MOVE_ACK` |
| `REQUEST_REMATCH` | Yes | No-op if request already recorded |
| `ACCEPT_REMATCH` | Yes | No-op if already accepted |
| `PING` | N/A | Always produces a fresh `PONG` (not idempotent by design) |
| `RECONNECT` | Yes | Returns current state snapshot |
| `SYNC_REQUEST` | Yes | Returns requested event range |

### Move Idempotency Detail

```
Client sends MAKE_MOVE { commandId: "abc-123", position: [0,0] }
Server applies move, stores commandId → result
Server sends MOVE_ACK { commandId: "abc-123", ... }

--- connection drops before client receives ACK ---

Client retries: MAKE_MOVE { commandId: "abc-123", position: [0,0] }
Server finds commandId "abc-123" in deduplication cache
Server re-sends MOVE_ACK { commandId: "abc-123", ... }  ← same response
Board is NOT mutated again.
```

---

## 8. Connection Lifecycle

```
 CLIENT                                         SERVER
   │                                               │
   │──── TCP connect ──────────────────────────────▶│
   │◀─── TCP accept ───────────────────────────────│
   │                                               │
   │──── HTTP GET /ws (Upgrade: websocket) ────────▶│
   │     Sec-WebSocket-Protocol: ttt-v1            │
   │◀─── 101 Switching Protocols ──────────────────│
   │     Sec-WebSocket-Protocol: ttt-v1            │
   │                                               │
   │  [WebSocket open - unauthenticated state]     │
   │                                               │
   │──── AUTH ─────────────────────────────────────▶│
   │◀─── AUTH_ACK ─────────────────────────────────│
   │                                               │
   │  [authenticated state]                        │
   │                                               │
   │──── JOIN_ROOM ────────────────────────────────▶│
   │◀─── ROOM_JOINED ──────────────────────────────│
   │                                               │
   │  [in-room state]                              │
   │                                               │
   │──── PLAYER_READY ─────────────────────────────▶│
   │◀─── GAME_STARTED ─────────────────────────────│
   │                                               │
   │  [game active state]                          │
   │                                               │
   │──── MAKE_MOVE ────────────────────────────────▶│
   │◀─── MOVE_ACK ─────────────────────────────────│
   │◀─── MOVE_BROADCAST ───────────────────────────│
   │                                               │
   │  ... game continues ...                       │
   │                                               │
   │◀─── GAME_FINISHED ────────────────────────────│
   │                                               │
   │──── PING ─────────────────────────────────────▶│ (every 30s)
   │◀─── PONG ─────────────────────────────────────│
   │                                               │
   │──── LEAVE_ROOM ───────────────────────────────▶│
   │◀─── ROOM_LEFT ────────────────────────────────│
   │                                               │
   │──── Close frame ──────────────────────────────▶│
   │◀─── Close frame ──────────────────────────────│
```

### Authentication Timeout

If `AUTH` is not received within **10 seconds** of WebSocket open, the server
sends `ERROR { code: AUTH_TIMEOUT }` and closes the connection with code `4008`.

### Unauthenticated Message Handling

If any message other than `AUTH` or `PING` is received before authentication
succeeds, the server responds with `ERROR { code: NOT_AUTHENTICATED }` and
**does not close the connection** (allows the client to authenticate and retry).

---

## 9. Authentication

### Mechanism: Anonymous Session Tokens

For Phase 1 there are no user accounts. The server issues an opaque session token
the first time a client connects. The client persists this token in `localStorage`
and presents it on every reconnect to claim its identity in an active room.

```
First connection:
  Client sends:  AUTH { guestToken: null }
  Server sends:  AUTH_ACK { sessionToken: "<uuid>", playerId: "<uuid>" }
  Client stores: sessionToken, playerId in localStorage

Reconnecting:
  Client sends:  AUTH { guestToken: "<stored sessionToken>" }
  Server sends:  AUTH_ACK { sessionToken: "<same token>", playerId: "<same id>",
                             existingRoom: { roomId, symbol } | null }
```

### Session Token Properties

- UUID v4, cryptographically random (128 bits entropy)
- Server maintains a mapping `sessionToken → playerId`
- Expires after **7 days** of inactivity
- Token invalidated when client calls `LEAVE_ROOM` and disconnects gracefully
- A stolen token gives access only to ongoing/historical games — no user account data

### Token Delivery

The `sessionToken` is transmitted only over an encrypted connection (`wss://`).
It is never included in URLs or logs.

---

## 10. Authorization

### Room Access

| Operation | Requirement |
|---|---|
| Create room | Authenticated (any session token) |
| Join room | Authenticated + valid room ID + room not full |
| Make move | Authenticated + member of room + current player's turn |
| Request rematch | Authenticated + member of room + game finished |
| View room history | Authenticated + was member of room |

### Command Authorization Failures

All authorization failures result in:

```json
{
  "type": "ERROR",
  "code": "UNAUTHORIZED",
  "commandId": "<echoed>",
  "detail": "<reason>"
}
```

The connection is **not** closed on authorization failures. The client can
send a corrected command.

---

## 11. Message Catalog

Format conventions used in this section:

```
→  client-to-server command
←  server-to-client event
↔  both directions (e.g. PING/PONG)

[required]  field is always present
[optional]  field may be absent
```

All examples show only the payload fields. The envelope fields
(`protocolVersion`, `messageId`, `timestamp`, `type`) are always present and
omitted from examples for brevity.

---

### 11.1 Connection Handshake

The handshake is the HTTP upgrade. There is no explicit WebSocket-level
handshake message. Once the WebSocket is open, the connection is in the
**unauthenticated** state and the client must immediately send `AUTH`.

**Failure codes (HTTP upgrade stage):**

| Code | Reason |
|---|---|
| `4001` | Unsupported protocol version |
| `4002` | Server at capacity |
| `4003` | Origin not allowed |

---

### 11.2 Authentication

#### → `AUTH` (client → server)

Sent immediately after WebSocket open. Must be the first message.

```typescript
{
  type: 'AUTH';
  // commandId is present per the command envelope
  guestToken: string | null;   // null = new session; existing token = reconnect
  clientVersion: string;       // Semver of the client build, e.g. "1.0.0"
}
```

**Idempotency:** Server returns the same `AUTH_ACK` if `commandId` is duplicated.

**Lifecycle:**
1. Client opens WebSocket
2. Client immediately sends `AUTH`
3. Server validates `guestToken` if present (or mints a new session)
4. Server responds with `AUTH_ACK`

#### ← `AUTH_ACK` (server → client)

```typescript
{
  type: 'AUTH_ACK';
  // correlationId echoes the AUTH commandId
  sessionToken: string;         // Opaque token; store in localStorage
  playerId: string;             // Stable UUID for this player
  serverVersion: string;        // Semver of server build
  existingRoom: {               // Present if player was in an active room
    roomId: string;
    symbol: 'X' | 'O';
    gameStatus: GameStatus;
  } | null;
}
```

**Post-condition:** Connection transitions to **authenticated** state.  
If `existingRoom` is non-null, the client should send `RECONNECT` rather than `JOIN_ROOM`.

---

### 11.3 Room Join

#### → `JOIN_ROOM` (client → server)

```typescript
{
  type: 'JOIN_ROOM';
  roomId: string;               // 8-character room code
  playerName: string | null;    // Optional display name (max 30 chars)
}
```

**Idempotency:** If the player is already in the room, server returns the same
`ROOM_JOINED` event with current room state.

**Validations:**
- Room must exist
- Room must not be full (< 2 players)
- Player must not already be in a different active room

#### ← `ROOM_JOINED` (server → client)

Sent to the joining player only.

```typescript
{
  type: 'ROOM_JOINED';
  // sessionSeq: 1 (first event in this session for this player)
  roomId: string;
  playerId: string;
  symbol: 'X' | 'O';
  roomState: RoomStateSnapshot;  // Full current room state
}
```

#### ← `PLAYER_JOINED` (server → client)

Broadcast to all other players already in the room.

```typescript
{
  type: 'PLAYER_JOINED';
  roomId: string;
  playerId: string;
  symbol: 'X' | 'O';
  playerName: string | null;
  connectedPlayerCount: number;  // 1 or 2
}
```

---

### 11.4 Room Leave

#### → `LEAVE_ROOM` (client → server)

```typescript
{
  type: 'LEAVE_ROOM';
  roomId: string;
  reason: 'VOLUNTARY' | 'CLOSING_TAB';
}
```

**Idempotency:** If the player already left, server returns `ROOM_LEFT` with no
state change.

**Effect during active game:** Game ends with `result.reason = 'FORFEIT'`.
The remaining player receives a `GAME_FINISHED` event before `PLAYER_LEFT`.

#### ← `ROOM_LEFT` (server → client)

Sent to the leaving player only.

```typescript
{
  type: 'ROOM_LEFT';
  roomId: string;
}
```

#### ← `PLAYER_LEFT` (server → client)

Broadcast to remaining players.

```typescript
{
  type: 'PLAYER_LEFT';
  roomId: string;
  playerId: string;
  symbol: 'X' | 'O';
  reason: 'VOLUNTARY' | 'DISCONNECT_TIMEOUT' | 'FORFEIT';
}
```

---

### 11.5 Player Ready

The ready system gates game start: both players must declare readiness before
the server starts the game. This prevents the game starting before both players
have rendered their UI.

#### → `PLAYER_READY` (client → server)

```typescript
{
  type: 'PLAYER_READY';
  roomId: string;
}
```

**Idempotency:** If player is already in the `ready` state, server acknowledges
without changing state.

**Preconditions:**
- Player must be in the room
- Game must be in `WAITING` status

#### ← `PLAYER_READY_ACK` (server → client)

Sent to the player who sent `PLAYER_READY`.

```typescript
{
  type: 'PLAYER_READY_ACK';
  roomId: string;
  readyPlayers: ('X' | 'O')[];  // Which symbols are now ready
}
```

#### ← `OPPONENT_READY` (server → client)

Broadcast to the other player.

```typescript
{
  type: 'OPPONENT_READY';
  roomId: string;
  symbol: 'X' | 'O';
  readyPlayers: ('X' | 'O')[];
}
```

---

### 11.6 Game Start

Emitted by the server **automatically** when both players are ready.
Not triggered by a direct client command.

#### ← `GAME_STARTED` (server → client)

Broadcast to all players in the room.

```typescript
{
  type: 'GAME_STARTED';
  roomId: string;
  gameId: string;              // Unique ID for this match
  board: BoardSnapshot;        // 3x3 empty board
  firstTurn: 'X' | 'O';       // Always 'X' for game 1; alternates on rematch
  players: {
    X: PlayerInfo;
    O: PlayerInfo;
  };
  startedAt: number;           // Server timestamp (ms)
}
```

**Post-condition:** Game session transitions to `ACTIVE` status.
The `sessionSeq` counter resets to `1` for the new game.

---

### 11.7 Move Command

#### → `MAKE_MOVE` (client → server)

```typescript
{
  type: 'MAKE_MOVE';
  roomId: string;
  gameId: string;              // Client must echo the gameId from GAME_STARTED
  position: BoardPosition;     // { row: 0|1|2, col: 0|1|2 }
}
```

**Idempotency:** If `commandId` is already in the deduplication cache and the
move was accepted, server re-sends `MOVE_ACK` with the original result.
If the move was rejected, server re-sends `MOVE_REJECTED`.

**Anti-replay:** Including `gameId` prevents a move command from a previous game
being replayed into a new game (rematch). The server rejects commands whose
`gameId` does not match the current active game.

**Validations (in order):**
1. `sessionToken` valid and authenticated
2. `roomId` matches player's room
3. `gameId` matches current active game
4. Game status is `ACTIVE`
5. It is the command sender's turn
6. Position `(row, col)` is within bounds `[0..2]`
7. Cell at position is empty

---

### 11.8 Move Acknowledgement

#### ← `MOVE_ACK` (server → client)

Sent **only** to the player who submitted the move. Confirms the move was
accepted and applied.

```typescript
{
  type: 'MOVE_ACK';
  roomId: string;
  gameId: string;
  // correlationId echoes the MAKE_MOVE commandId
  position: BoardPosition;
  symbol: 'X' | 'O';
  sequenceInGame: number;      // Move number (1-based). First move = 1.
  board: BoardSnapshot;        // Full board after the move
  nextTurn: 'X' | 'O' | null; // null if game ended
  sessionSeq: number;
}
```

**Latency target:** < 50ms from server receiving command to sending `MOVE_ACK`.

---

### 11.9 Move Broadcast

#### ← `MOVE_BROADCAST` (server → client)

Sent to **all other players** in the room (not the mover). Carries the same
information as `MOVE_ACK` so recipients can update their board.

```typescript
{
  type: 'MOVE_BROADCAST';
  roomId: string;
  gameId: string;
  position: BoardPosition;
  symbol: 'X' | 'O';
  playerId: string;            // Who made the move
  sequenceInGame: number;
  board: BoardSnapshot;
  nextTurn: 'X' | 'O' | null;
  sessionSeq: number;
}
```

**Note:** `MOVE_ACK` and `MOVE_BROADCAST` carry identical board state, ensuring
both players converge to the same view after each move.

---

### 11.10 Invalid Move

#### ← `MOVE_REJECTED` (server → client)

Sent **only** to the player who submitted the invalid move.

```typescript
{
  type: 'MOVE_REJECTED';
  roomId: string;
  gameId: string;
  // correlationId echoes the MAKE_MOVE commandId
  position: BoardPosition;     // The rejected position
  reason: MoveRejectionReason;
  board: BoardSnapshot;        // Current board (unchanged) — for client resync
  currentTurn: 'X' | 'O';     // Current turn (unchanged)
}
```

**`MoveRejectionReason` values:**

| Value | Meaning |
|---|---|
| `NOT_YOUR_TURN` | It is not the sender's turn |
| `CELL_OCCUPIED` | The target cell is already filled |
| `OUT_OF_BOUNDS` | Row or col outside `[0, 2]` |
| `GAME_NOT_ACTIVE` | Game is not in `ACTIVE` status |
| `GAME_ID_MISMATCH` | The `gameId` does not match current game |

**Client behavior on rejection:** Roll back any optimistic UI update and
re-render from `MOVE_REJECTED.board`.

---

### 11.11 Game Finished

#### ← `GAME_FINISHED` (server → client)

Broadcast to all players when the game ends for any reason.

```typescript
{
  type: 'GAME_FINISHED';
  roomId: string;
  gameId: string;
  result: GameResult;
  finalBoard: BoardSnapshot;
  moveHistory: MoveRecord[];   // Complete ordered history of all moves
  stats: GameStats;
  sessionSeq: number;
}
```

**`GameResult`:**

```typescript
{
  outcome: 'WIN' | 'DRAW' | 'FORFEIT' | 'ABANDONED';
  winner: 'X' | 'O' | null;   // null for DRAW, FORFEIT (no winner), ABANDONED
  winningLine: WinningLine | null;
  reason: GameEndReason;
  endedAt: number;             // Server timestamp (ms)
}
```

**`GameEndReason` values:**

| Value | Trigger |
|---|---|
| `THREE_IN_A_ROW` | Normal win condition |
| `BOARD_FULL` | All 9 cells filled, no winner |
| `PLAYER_FORFEITED` | Player sent `LEAVE_ROOM` during active game |
| `PLAYER_ABANDONED` | Player disconnect timeout expired (5 minutes) |

**Post-condition:** Game session status transitions to `FINISHED`.
Rematch commands become valid.

---

### 11.12 Rematch

The rematch flow requires both players to explicitly agree.

#### → `REQUEST_REMATCH` (client → server)

```typescript
{
  type: 'REQUEST_REMATCH';
  roomId: string;
  gameId: string;              // The just-finished game's ID
}
```

**Preconditions:** Game with `gameId` must be in `FINISHED` status.  
**Idempotency:** Duplicate request returns `REMATCH_REQUESTED` with no state change.

#### ← `REMATCH_REQUESTED` (server → client)

Broadcast to all players.

```typescript
{
  type: 'REMATCH_REQUESTED';
  roomId: string;
  gameId: string;
  requestedBy: 'X' | 'O';
  expiresAt: number;           // Epoch ms; request expires in 60 seconds
  sessionSeq: number;
}
```

#### → `ACCEPT_REMATCH` (client → server)

```typescript
{
  type: 'ACCEPT_REMATCH';
  roomId: string;
  gameId: string;
}
```

When both players have accepted (or when the requester's opponent accepts),
the server emits `GAME_STARTED` for the new game. Roles swap: if X went first
last game, O goes first this game.

#### → `DECLINE_REMATCH` (client → server)

```typescript
{
  type: 'DECLINE_REMATCH';
  roomId: string;
  gameId: string;
}
```

#### ← `REMATCH_DECLINED` (server → client)

Broadcast to all players.

```typescript
{
  type: 'REMATCH_DECLINED';
  roomId: string;
  gameId: string;
  declinedBy: 'X' | 'O';
  sessionSeq: number;
}
```

#### ← `REMATCH_EXPIRED` (server → client)

Broadcast when the 60-second window elapses with no mutual acceptance.

```typescript
{
  type: 'REMATCH_EXPIRED';
  roomId: string;
  gameId: string;
  sessionSeq: number;
}
```

---

### 11.13 Heartbeat

Heartbeats detect dead connections and maintain NAT/proxy keepalives.

#### → `PING` (client → server)

Sent every **25 seconds** by the client.

```typescript
{
  type: 'PING';
  // commandId required per envelope
  clientTime: number;          // Client timestamp for round-trip measurement
}
```

#### ← `PONG` (server → client)

```typescript
{
  type: 'PONG';
  // correlationId echoes the PING commandId
  clientTime: number;          // Echoed from PING; client computes RTT
  serverTime: number;          // Server timestamp
}
```

**Server-side:** If no message (including `PING`) is received from a client
in **60 seconds**, the server:

1. Marks the player as `DISCONNECTED`
2. Notifies room via `OPPONENT_DISCONNECTED`
3. Starts the **5-minute reconnection window**

**Client-side:** If no `PONG` is received within **5 seconds** of `PING`, the
client considers the connection dead and begins reconnection.

---

### 11.14 Reconnect

#### → `RECONNECT` (client → server)

Sent instead of `JOIN_ROOM` when a client has an existing `sessionToken` and
wants to resume a game.

```typescript
{
  type: 'RECONNECT';
  roomId: string;
  lastReceivedSeq: number;     // Last sessionSeq the client received
                               // 0 if client has no events for this session
}
```

**Preconditions:**
- `sessionToken` in command envelope must map to a known player
- Player must still be in the room (not timed out)
- Reconnection window (5 min) must not have expired

#### ← `RECONNECT_ACK` (server → client)

```typescript
{
  type: 'RECONNECT_ACK';
  roomId: string;
  playerId: string;
  symbol: 'X' | 'O';
  roomState: RoomStateSnapshot;  // Full current room/game state
  sessionSeq: number;            // Current server sequence
}
```

After `RECONNECT_ACK`, the server immediately follows with a `STATE_SYNC` if
there are buffered events the client missed (see §11.15).

#### ← `OPPONENT_DISCONNECTED` (server → client)

Broadcast to remaining players when a player disconnects.

```typescript
{
  type: 'OPPONENT_DISCONNECTED';
  roomId: string;
  symbol: 'X' | 'O';
  reconnectDeadlineAt: number; // Epoch ms; if not reconnected by this time,
                               // game will be abandoned
  sessionSeq: number;
}
```

#### ← `OPPONENT_RECONNECTED` (server → client)

Broadcast when a disconnected player successfully reconnects.

```typescript
{
  type: 'OPPONENT_RECONNECTED';
  roomId: string;
  symbol: 'X' | 'O';
  sessionSeq: number;
}
```

**Reconnect failure (timeout expired):**
Server emits `GAME_FINISHED` with `reason: 'PLAYER_ABANDONED'`.

---

### 11.15 State Synchronization

#### → `SYNC_REQUEST` (client → server)

Sent by the client when it detects a gap in `sessionSeq`.

```typescript
{
  type: 'SYNC_REQUEST';
  roomId: string;
  fromSeq: number;             // First missing sequence number
}
```

#### ← `STATE_SYNC` (server → client)

The server can send this in two modes:

**Mode A — Event replay** (gap ≤ 500 events, events still buffered):

```typescript
{
  type: 'STATE_SYNC';
  roomId: string;
  mode: 'REPLAY';
  fromSeq: number;
  toSeq: number;
  events: AnyServerEvent[];    // Ordered list of missed events
  sessionSeq: number;          // Current server sequence
}
```

**Mode B — Full snapshot** (gap too large, or client sent `lastReceivedSeq: 0`):

```typescript
{
  type: 'STATE_SYNC';
  roomId: string;
  mode: 'SNAPSHOT';
  roomState: RoomStateSnapshot;
  sessionSeq: number;
}
```

**`RoomStateSnapshot`:**

```typescript
{
  roomId: string;
  status: RoomStatus;
  players: {
    X: PlayerInfo | null;
    O: PlayerInfo | null;
  };
  readyPlayers: ('X' | 'O')[];
  currentGame: {
    gameId: string;
    status: GameStatus;
    board: BoardSnapshot;
    currentTurn: 'X' | 'O';
    moveCount: number;
    startedAt: number;
  } | null;
  gameHistory: GameSummary[];    // Summaries of completed games in this room
}
```

---

### 11.16 Error Messages

#### ← `ERROR` (server → client)

Used for both command-scoped errors and session-level errors.

```typescript
{
  type: 'ERROR';
  // correlationId present if error is in response to a command
  code: ErrorCode;
  detail: string;              // Human-readable; may vary between builds
  recoverable: boolean;        // true = client can retry; false = connection will close
  data?: Record<string, unknown>; // Optional structured error context
}
```

#### Complete `ErrorCode` Catalog

**Authentication / Session:**

| Code | Recoverable | Meaning |
|---|---|---|
| `AUTH_TIMEOUT` | No | No AUTH received within 10s |
| `AUTH_FAILED` | Yes | Invalid or expired guestToken |
| `NOT_AUTHENTICATED` | Yes | Command sent before AUTH |
| `SESSION_EXPIRED` | No | Session token expired (7 days) |
| `DUPLICATE_SESSION` | No | Same sessionToken opened a second connection |

**Room:**

| Code | Recoverable | Meaning |
|---|---|---|
| `ROOM_NOT_FOUND` | Yes | Room ID does not exist |
| `ROOM_FULL` | Yes | Room already has 2 players |
| `ROOM_EXPIRED` | No | Room exceeded 24-hour TTL |
| `ALREADY_IN_ROOM` | Yes | Player already in a different room |
| `NOT_IN_ROOM` | Yes | Command requires room membership |

**Game:**

| Code | Recoverable | Meaning |
|---|---|---|
| `GAME_NOT_ACTIVE` | Yes | Command requires ACTIVE game |
| `GAME_ID_MISMATCH` | Yes | gameId does not match current game |
| `NOT_YOUR_TURN` | Yes | Player sent MAKE_MOVE out of turn |
| `CELL_OCCUPIED` | Yes | Target cell already filled |
| `OUT_OF_BOUNDS` | Yes | Position row/col not in [0,2] |
| `REMATCH_PENDING` | Yes | Duplicate rematch request |
| `REMATCH_NOT_REQUESTED` | Yes | Accept/decline with no pending request |
| `RECONNECT_WINDOW_EXPIRED` | No | 5-minute reconnect window elapsed |
| `RECONNECT_INVALID` | Yes | sessionToken not associated with room |

**Protocol:**

| Code | Recoverable | Meaning |
|---|---|---|
| `PROTOCOL_VERSION_MISMATCH` | No | `protocolVersion` field mismatch |
| `MALFORMED_MESSAGE` | Yes | JSON parse failure or missing required fields |
| `UNKNOWN_MESSAGE_TYPE` | Yes | Unrecognized `type` field |
| `MESSAGE_TOO_LARGE` | Yes | Frame exceeds 64 KB |
| `RATE_LIMITED` | Yes | Sender exceeded rate limit |
| `UNAUTHORIZED` | Yes | Authorization check failed |

**Server:**

| Code | Recoverable | Meaning |
|---|---|---|
| `INTERNAL_ERROR` | Yes | Unexpected server error; includes `traceId` in `data` |
| `SERVER_SHUTTING_DOWN` | No | Graceful shutdown in progress |

---

## 12. Failure Handling

### 12.1 Client Disconnect

**Detection:** Server receives WebSocket `close` event OR ping timeout fires.

**Immediate actions (< 100ms):**
1. Mark player connection state as `DISCONNECTED`
2. Cancel any pending rematch timer for this player
3. Broadcast `OPPONENT_DISCONNECTED` to remaining players in the room

**Deferred actions:**
1. Start reconnection window timer (5 minutes)
2. Keep game state fully intact in memory

**After 5 minutes without reconnect:**
1. Emit `GAME_FINISHED { reason: 'PLAYER_ABANDONED' }` to remaining players
2. Persist game record to database
3. Mark room as `WAITING` (waiting for rematch or new players)
4. Clean up reconnection window timer

### 12.2 Reconnect

See §11.14 for message details.

**Happy path:**

```
Client reconnects → AUTH → RECONNECT
Server validates sessionToken → session still valid, room still open
Server sends RECONNECT_ACK with full state snapshot
Server sends STATE_SYNC (REPLAY mode) with missed events
Server broadcasts OPPONENT_RECONNECTED
Game resumes from exact point of disconnection
```

**Failure paths:**

| Scenario | Server Response |
|---|---|
| sessionToken expired or unknown | `AUTH_FAILED` |
| Reconnect window expired (> 5 min) | `RECONNECT_WINDOW_EXPIRED` |
| Player was removed from room | `NOT_IN_ROOM` |
| Room expired | `ROOM_EXPIRED` |

### 12.3 Server Restart

**Phase 1 (single server, SQLite):**  
Active game state is held in memory. A server restart loses all in-flight game state.
On reconnect after a server restart, players receive `RECONNECT_WINDOW_EXPIRED`
because the session is no longer in memory. This is a documented limitation.

**Mitigation for Phase 1:**
- Server periodically snapshots active game state to the database (every 30 seconds)
- On startup, server reloads in-progress games from the snapshot table
- Players can reconnect within 5 minutes and resume

**Phase 2 (Redis-backed sessions):**
Active game state stored in Redis. Server restart does not lose session state.
Players reconnect transparently.

### 12.4 Duplicate Commands

Handled via commandId deduplication (see §7).

**Server behavior:**
1. Command received
2. Look up `commandId` in deduplication cache (5-minute TTL)
3. If found: return cached response, do not re-execute
4. If not found: execute, store result in cache, return result

### 12.5 Delayed / Out-of-Order Messages

WebSocket over TCP guarantees in-order delivery. Out-of-order messages are
theoretically impossible on a single connection.

**On reconnect (new TCP connection):** Events are replayed from the server's
event buffer in order. The client processes them in sequence.

**Stale commands:** A `MAKE_MOVE` command whose `gameId` no longer matches
the active game is rejected with `GAME_ID_MISMATCH`. This prevents moves from
a previous game leaking into a rematch.

### 12.6 Missing Messages

Client detects `sessionSeq` gap → sends `SYNC_REQUEST` → server responds with
`STATE_SYNC` in REPLAY or SNAPSHOT mode.

**Server event buffer:** Retains last 500 events per game session in a ring buffer.
Events older than 500 slots or 10 minutes are evicted. Clients requesting events
outside the buffer receive a full snapshot.

### 12.7 Invalid Commands

1. Schema validation fails → `MALFORMED_MESSAGE`
2. Auth check fails → `NOT_AUTHENTICATED` or `UNAUTHORIZED`
3. Business rule check fails → specific error code (e.g. `NOT_YOUR_TURN`)
4. Unknown `type` → `UNKNOWN_MESSAGE_TYPE`

The server never crashes on invalid input. It always returns an error and
continues operating.

### 12.8 Connection Timeout

**Client-to-server inactivity timeout:** 60 seconds.  
Enforced by server. Client must send at least a `PING` every 25 seconds.

**Server-to-client:** Server sends `PING` every 30 seconds as additional keepalive.
If client does not respond with `PONG` within 10 seconds, server closes the
connection with code `4006` (timeout).

### 12.9 Player Abandoning a Match

A player is considered to have abandoned a match when:
- Their connection is `DISCONNECTED`
- The 5-minute reconnection window expires
- **OR** they send `LEAVE_ROOM` during an active game

In both cases: `GAME_FINISHED { reason: 'PLAYER_ABANDONED' | 'PLAYER_FORFEITED' }`.

The remaining player is credited with the win.

---

## 13. State Machine: Game Session

```
                    ┌───────────────────────────────────────────────┐
                    │                ROOM STATES                    │
                    └───────────────────────────────────────────────┘

         create room
              │
              ▼
          ┌────────┐   player 2 joins    ┌──────────┐
          │ OPEN   │────────────────────▶│  FULL    │
          │(1 plyr)│                     │ (2 plyr) │
          └────────┘                     └────┬─────┘
                                              │ both ready
                                              ▼
                    ┌──────────────────────────────────────────────┐
                    │              GAME SESSION STATES             │
                    └──────────────────────────────────────────────┘

                                       ┌──────────┐
                       ┌──────────────▶│  ACTIVE  │
                       │  both ready   └────┬─────┘
                       │                   │
                  ┌────┴──────┐            │ win / draw / forfeit / abandon
                  │  WAITING  │◀──────────┐│
                  └───────────┘  rematch  ▼▼
                                       ┌──────────┐
                                       │ FINISHED │
                                       └──────────┘
```

### Game Session Status Transitions

| From | To | Trigger |
|---|---|---|
| — | `WAITING` | Room created, 2nd player joins |
| `WAITING` | `ACTIVE` | Both players send `PLAYER_READY` |
| `ACTIVE` | `FINISHED` | Win condition detected |
| `ACTIVE` | `FINISHED` | Draw condition detected |
| `ACTIVE` | `FINISHED` | Player sends `LEAVE_ROOM` (forfeit) |
| `ACTIVE` | `FINISHED` | Player disconnect timeout expires (abandon) |
| `FINISHED` | `WAITING` | Both players accept rematch |

---

## 14. State Machine: Client Connection

```
              open WebSocket
                    │
                    ▼
            ┌──────────────┐
            │ UNAUTHED     │─── AUTH ──────────────────▶ AUTHED
            └──────────────┘
                                       ┌───────────┐
            AUTHED ──── JOIN_ROOM ────▶│  IN_ROOM  │
                                       └─────┬─────┘
                                             │
                                   ┌─────────┴──────────┐
                                   │                    │
                              PLAYER_READY          LEAVE_ROOM
                                   │                    │
                                   ▼                    ▼
                            ┌───────────┐          AUTHED state
                            │   READY   │
                            └─────┬─────┘
                                  │
                             GAME_STARTED
                                  │
                                  ▼
                           ┌────────────┐
                           │ IN_GAME    │──── network drop ──▶ DISCONNECTED
                           └─────┬──────┘                           │
                                 │                         5-min window
                             GAME_FINISHED                       │
                                 │               reconnect ───────┘
                                 ▼                    │
                           ┌──────────┐         IN_GAME (resumed)
                           │ FINISHED │
                           └──────────┘
```

---

## 15. Complete Flow Examples

### 15.1 Normal Game from Start to Finish

```
PLAYER 1 (X)                    SERVER                   PLAYER 2 (O)
────────────────────────────────────────────────────────────────────────
WebSocket open                  ← accepts
AUTH { guestToken: null }   →
                                AUTH_ACK { sessionToken, playerId }   →
                                                             WebSocket open
                                                             AUTH { guestToken: null }   →
                                ←   AUTH_ACK { sessionToken, playerId }

POST /api/rooms              →
                                ← 201 { roomId: "ABCD1234" }

JOIN_ROOM { roomId }         →
                                ROOM_JOINED (seq=1) →
                                                              JOIN_ROOM { roomId }   →
                                ROOM_JOINED (seq=1)   ←──────
                                PLAYER_JOINED (seq=2) →  (broadcast to P1)

PLAYER_READY                 →
                                PLAYER_READY_ACK     →
                                OPPONENT_READY        ──────────────────────────────▶
                                                              PLAYER_READY   ←──────
                                ←   PLAYER_READY_ACK
                                OPPONENT_READY       →
                                ── auto: both ready ──
                                GAME_STARTED (seq=3) →
                                GAME_STARTED (seq=3) ──────────────────────────────▶

MAKE_MOVE pos=[0,0]          →
                                (validate, apply)
                                MOVE_ACK (seq=4)     →
                                MOVE_BROADCAST (seq=4) ────────────────────────────▶

                                                              MAKE_MOVE pos=[1,1]   ←──
                                ←   MOVE_ACK (seq=5)
                                MOVE_BROADCAST (seq=5) →

... more moves ...

MAKE_MOVE pos=[0,2]          →   ← X wins
                                MOVE_ACK (seq=9)     →
                                GAME_FINISHED (seq=9) →
                                GAME_FINISHED (seq=9) ─────────────────────────────▶

REQUEST_REMATCH              →
                                REMATCH_REQUESTED (seq=10) →
                                REMATCH_REQUESTED (seq=10) ────────────────────────▶
                                                              ACCEPT_REMATCH   ←──
                                ← (both accepted — server starts new game)
                                GAME_STARTED (seq=1) →  ← new game, seq resets
                                GAME_STARTED (seq=1) ──────────────────────────────▶
```

### 15.2 Reconnection Flow

```
PLAYER 1 (X)                    SERVER                   PLAYER 2 (O)
────────────────────────────────────────────────────────────────────────
[connected, in active game, lastReceivedSeq=7]

── network drop ──
                                close event detected
                                player X → DISCONNECTED
                                OPPONENT_DISCONNECTED (seq=8) ──────────────────────▶
                                start 5-min timer

── 3 seconds later ──

WebSocket open               →
AUTH { guestToken: <token> } →
                                AUTH_ACK { existingRoom: { roomId, status } } →

RECONNECT { roomId, lastReceivedSeq: 7 } →
                                (validate token, room, window)
                                RECONNECT_ACK (full snapshot)  →
                                STATE_SYNC mode=REPLAY fromSeq=8 toSeq=8 →
                                cancel 5-min timer
                                OPPONENT_RECONNECTED (seq=9) ───────────────────────▶

[game resumes from exact state at seq=7]
```

---

## 16. Security Considerations

### Replay Attacks

**Threat:** Attacker captures a valid `MAKE_MOVE` command and replays it later.

**Mitigation:**
- `gameId` in every move command — replaying a move from game 1 into game 2 fails with `GAME_ID_MISMATCH`
- `commandId` deduplication — exact replay of same commandId returns cached result without re-executing
- `sessionToken` is connection-scoped — a stolen token used on a new connection triggers `DUPLICATE_SESSION`

### Command Tampering

**Threat:** Attacker modifies a move command to target a different cell.

**Mitigation:** All moves validated server-side. The server ignores client-reported
board state. It only processes `position` and validates against authoritative in-memory state.

### Rate Limiting

Applied per `sessionToken` / per connection:

| Action | Limit |
|---|---|
| WebSocket messages (any) | 60 / 10 seconds |
| `MAKE_MOVE` commands | 5 / second |
| `AUTH` attempts | 5 / minute per IP |
| Room creation (via HTTP) | 5 / minute per IP |
| `RECONNECT` attempts | 10 / minute per IP |

Exceeding limits returns `RATE_LIMITED` error. The connection is not closed on
first offense. After 3 consecutive rate-limit violations, the connection is closed
with code `4029`.

### Connection Abuse

- Max 2 simultaneous WebSocket connections per `sessionToken`
- Max 5 WebSocket connections per IP per minute
- Frame size limit: 64 KB

### Room ID Entropy

Room IDs are 8-character Base32 strings drawn from
`ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (32 chars, no ambiguous characters).

Entropy: 32^8 = 2^40 ≈ 1 trillion combinations.  
At 1000 active rooms, the probability of guessing a valid room ID is
1000 / 10^12 ≈ 10^-9 per attempt. With rate limiting of 5 attempts/minute,
brute-force is computationally infeasible.

### Cheating

The server is the only authority on game state. The client:
- Cannot submit moves on behalf of the opponent
- Cannot modify the board directly
- Cannot advance the turn counter
- Cannot force a win or draw

Every command is independently validated against server-side state.

---

## Appendix A: WebSocket Close Codes

| Code | Meaning |
|---|---|
| `1000` | Normal closure |
| `1001` | Going away (server shutdown) |
| `1008` | Policy violation (used for auth failures) |
| `4001` | Unsupported protocol version |
| `4002` | Server at capacity |
| `4003` | Origin not allowed |
| `4006` | Connection timeout |
| `4008` | Authentication timeout |
| `4029` | Rate limit: connection terminated |

---

## Appendix B: Type Reference Quick-Index

All TypeScript types are defined in `src/shared/protocol/`.

| Type | File |
|---|---|
| `BaseEnvelope` | `types.ts` |
| `CommandEnvelope` | `types.ts` |
| `EventEnvelope` | `types.ts` |
| `BoardPosition` | `types.ts` |
| `BoardSnapshot` | `types.ts` |
| `PlayerInfo` | `types.ts` |
| `RoomStateSnapshot` | `types.ts` |
| `GameResult` | `types.ts` |
| `WinningLine` | `types.ts` |
| `GameStats` | `types.ts` |
| `MoveRecord` | `types.ts` |
| `GameSummary` | `types.ts` |
| All client→server commands | `commands.ts` |
| All server→client events | `events.ts` |
| `ErrorCode`, `ERROR` event | `errors.ts` |
| Runtime type guards | `guards.ts` |
| Barrel export | `index.ts` |
