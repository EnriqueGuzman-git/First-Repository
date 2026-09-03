/**
 * @file commands.ts
 * @description All client→server command types for the Tic-Tac-Toe realtime
 * protocol (version 1).
 *
 * Design rules enforced here:
 *  - Every command extends CommandEnvelope (carries commandId + sessionToken).
 *  - commandId is the idempotency key — stable across retries.
 *  - messageId (from BaseEnvelope) changes on every transmission attempt.
 *  - No runtime logic lives here: this file is pure type declarations.
 *  - AnyCommand is the exhaustive discriminated union used at the server
 *    message-router entry point.
 *
 * @see PROTOCOL.md §11 for lifecycle documentation of each command.
 * @see types.ts for shared primitives and envelope definitions.
 */

import type {
  CommandEnvelope,
  RoomId,
  GameId,
  SessionToken,
} from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Command Type Literal Constants
// Defined as a const object so they can be used as values in guards.ts
// without duplicating the string literals.
// ─────────────────────────────────────────────────────────────────────────────

export const CommandType = {
  AUTH:             'AUTH',
  JOIN_ROOM:        'JOIN_ROOM',
  LEAVE_ROOM:       'LEAVE_ROOM',
  PLAYER_READY:     'PLAYER_READY',
  MAKE_MOVE:        'MAKE_MOVE',
  REQUEST_REMATCH:  'REQUEST_REMATCH',
  ACCEPT_REMATCH:   'ACCEPT_REMATCH',
  DECLINE_REMATCH:  'DECLINE_REMATCH',
  PING:             'PING',
  RECONNECT:        'RECONNECT',
  SYNC_REQUEST:     'SYNC_REQUEST',
} as const;

export type CommandTypeLiteral = typeof CommandType[keyof typeof CommandType];

// ─────────────────────────────────────────────────────────────────────────────
// 11.2  AUTH
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sent immediately after WebSocket open — must be the first message.
 *
 * Idempotency: A duplicate commandId returns the same AUTH_ACK with the
 * same sessionToken and playerId. No new session is minted.
 *
 * New session:     { guestToken: null }
 * Reconnect:       { guestToken: "<stored token>" }
 *
 * The sessionToken field in CommandEnvelope is null for this command only,
 * because the token has not yet been issued.
 */
export type AuthCommand = CommandEnvelope & {
  readonly type: typeof CommandType.AUTH;
  readonly sessionToken: null;        // Override: no token yet on first connect
  /**
   * null  → brand-new anonymous session
   * string → existing session token (reconnect / tab refresh)
   */
  readonly guestToken: SessionToken | null;
  /** Semver of the client build. Logged server-side for version tracking. */
  readonly clientVersion: string;
};

// ─────────────────────────────────────────────────────────────────────────────
// 11.3  JOIN_ROOM
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Join an existing room by its 8-character code.
 *
 * Preconditions (validated server-side):
 *  - Player is authenticated.
 *  - Room exists and is not expired.
 *  - Room has fewer than 2 players.
 *  - Player is not already in a different active room.
 *
 * Idempotency: If the player is already in this room, returns the same
 * ROOM_JOINED event with current room state; no duplicate slot is created.
 */
export type JoinRoomCommand = CommandEnvelope & {
  readonly type: typeof CommandType.JOIN_ROOM;
  readonly roomId: RoomId;
  /**
   * Optional display name. Max length: MAX_PLAYER_NAME_LENGTH chars.
   * Sanitised server-side (trim, strip HTML characters).
   * null means the server assigns a default ("Player X" / "Player O").
   */
  readonly playerName: string | null;
};

// ─────────────────────────────────────────────────────────────────────────────
// 11.4  LEAVE_ROOM
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Voluntarily leave a room.
 *
 * If a game is ACTIVE when this command is received, the game is immediately
 * ended with outcome FORFEIT before the player is removed.
 *
 * Idempotency: If the player already left, returns ROOM_LEFT with no further
 * state change.
 */
export type LeaveRoomCommand = CommandEnvelope & {
  readonly type: typeof CommandType.LEAVE_ROOM;
  readonly roomId: RoomId;
  /**
   * VOLUNTARY     → Player chose to leave (e.g. clicked "Leave").
   * CLOSING_TAB   → beforeunload handler fired; best-effort delivery.
   */
  readonly reason: 'VOLUNTARY' | 'CLOSING_TAB';
};

// ─────────────────────────────────────────────────────────────────────────────
// 11.5  PLAYER_READY
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Signal that the player's UI is fully loaded and ready to start.
 *
 * Both players must send PLAYER_READY before the server emits GAME_STARTED.
 * This prevents the game starting before either player can see the board.
 *
 * Preconditions:
 *  - Player is in the room.
 *  - Room has 2 connected players.
 *  - No game is currently ACTIVE (i.e. status is WAITING).
 *
 * Idempotency: If player already sent PLAYER_READY, returns PLAYER_READY_ACK
 * with the current readyPlayers list; no duplicate readiness is recorded.
 */
export type PlayerReadyCommand = CommandEnvelope & {
  readonly type: typeof CommandType.PLAYER_READY;
  readonly roomId: RoomId;
};

// ─────────────────────────────────────────────────────────────────────────────
// 11.7  MAKE_MOVE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Submit a move to the server.
 *
 * The server is the sole authority on move validity. The client may optimistically
 * render the move but MUST roll back if it receives MOVE_REJECTED.
 *
 * Preconditions (all validated server-side in this order):
 *  1. sessionToken is valid and authenticated.
 *  2. roomId matches the player's current room.
 *  3. gameId matches the currently ACTIVE game (prevents cross-game replay).
 *  4. Game status is ACTIVE.
 *  5. It is the sender's turn (player symbol matches currentTurn).
 *  6. position.row and position.col are both in [0, 2].
 *  7. The cell at position is empty.
 *
 * Idempotency: If commandId is found in the deduplication cache:
 *  - If the original move was accepted → re-send MOVE_ACK (same board state).
 *  - If the original move was rejected → re-send MOVE_REJECTED (same reason).
 *  - The board is NOT mutated a second time.
 *
 * Anti-replay: gameId ties this command to a specific game instance.
 * A command with a gameId from a previous game (e.g. pre-rematch) is rejected
 * with GAME_ID_MISMATCH even if commandId is fresh.
 */
export type MakeMoveCommand = CommandEnvelope & {
  readonly type: typeof CommandType.MAKE_MOVE;
  readonly roomId: RoomId;
  /** Must match the gameId from the most recent GAME_STARTED event. */
  readonly gameId: GameId;
  readonly position: {
    /** Row index. Must be 0, 1, or 2. */
    readonly row: number;
    /** Column index. Must be 0, 1, or 2. */
    readonly col: number;
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// 11.12  REMATCH COMMANDS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Propose a rematch after the current game ends.
 *
 * Preconditions:
 *  - Player is in the room.
 *  - gameId matches the most recently FINISHED game.
 *  - No rematch proposal is already pending from this player.
 *
 * Idempotency: Duplicate commandId returns REMATCH_REQUESTED with no state
 * change.
 */
export type RequestRematchCommand = CommandEnvelope & {
  readonly type: typeof CommandType.REQUEST_REMATCH;
  readonly roomId: RoomId;
  /** The just-finished game's ID. Prevents stale rematch proposals. */
  readonly gameId: GameId;
};

/**
 * Accept a pending rematch proposal.
 *
 * When both players have accepted (or when the non-requesting player accepts),
 * the server starts a new game and emits GAME_STARTED with:
 *  - A new gameId.
 *  - sessionSeq reset to 1.
 *  - firstTurn swapped from the previous game.
 *
 * Preconditions:
 *  - A rematch proposal exists for this roomId/gameId.
 *  - The rematch proposal has not expired.
 *  - Player has not already accepted.
 *
 * Idempotency: Duplicate commandId returns no error; acceptance is not
 * duplicated.
 */
export type AcceptRematchCommand = CommandEnvelope & {
  readonly type: typeof CommandType.ACCEPT_REMATCH;
  readonly roomId: RoomId;
  readonly gameId: GameId;
};

/**
 * Decline a pending rematch proposal.
 *
 * Emits REMATCH_DECLINED to all players and cancels the proposal.
 *
 * Idempotency: Duplicate commandId returns no error; only one
 * REMATCH_DECLINED event is emitted.
 */
export type DeclineRematchCommand = CommandEnvelope & {
  readonly type: typeof CommandType.DECLINE_REMATCH;
  readonly roomId: RoomId;
  readonly gameId: GameId;
};

// ─────────────────────────────────────────────────────────────────────────────
// 11.13  PING
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Application-level heartbeat. Sent by the client every CLIENT_PING_INTERVAL_MS
 * (25 seconds). Distinct from the WebSocket protocol-level ping frame.
 *
 * NOT idempotent by design — every PING produces a fresh PONG.
 * sessionToken is required (prevents unauthenticated keepalive flooding).
 *
 * The round-trip time can be computed by the client as:
 *   rtt = Date.now() - pong.clientTime
 */
export type PingCommand = CommandEnvelope & {
  readonly type: typeof CommandType.PING;
  /** Client's local timestamp at send time. Echoed in the PONG. */
  readonly clientTime: number;
};

// ─────────────────────────────────────────────────────────────────────────────
// 11.14  RECONNECT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resume an interrupted session after AUTH, instead of using JOIN_ROOM.
 *
 * Should be sent when AUTH_ACK.existingRoom is non-null, indicating the
 * player's previous session is still open on the server.
 *
 * Preconditions:
 *  - sessionToken maps to a known player.
 *  - That player is still associated with roomId.
 *  - The reconnection window (RECONNECT_WINDOW_MS = 5 minutes) has not elapsed.
 *
 * Idempotency: Duplicate commandId returns RECONNECT_ACK with current state;
 * no duplicate associations are created.
 *
 * The server responds with:
 *  1. RECONNECT_ACK (full room state snapshot)
 *  2. STATE_SYNC mode=REPLAY for any events missed since lastReceivedSeq
 *     (or STATE_SYNC mode=SNAPSHOT if the gap is too large).
 */
export type ReconnectCommand = CommandEnvelope & {
  readonly type: typeof CommandType.RECONNECT;
  readonly roomId: RoomId;
  /**
   * The last sessionSeq the client successfully received and processed.
   * Use 0 if the client has no events for this session (e.g. after a
   * browser crash that cleared in-memory state).
   */
  readonly lastReceivedSeq: number;
};

// ─────────────────────────────────────────────────────────────────────────────
// 11.15  SYNC_REQUEST
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Request a replay of events that the client detected it missed.
 *
 * Triggered when the client receives an event with:
 *   event.sessionSeq > (lastReceivedSeq + 1)
 *
 * The server responds with STATE_SYNC in REPLAY or SNAPSHOT mode depending
 * on buffer availability.
 *
 * Idempotency: Multiple SYNC_REQUESTs for the same fromSeq return the same
 * STATE_SYNC response.
 */
export type SyncRequestCommand = CommandEnvelope & {
  readonly type: typeof CommandType.SYNC_REQUEST;
  readonly roomId: RoomId;
  /**
   * The first sequence number the client is missing.
   * Server will replay from this sequence to the current head.
   */
  readonly fromSeq: number;
};

// ─────────────────────────────────────────────────────────────────────────────
// Exhaustive Union
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Discriminated union of every possible client→server command.
 *
 * Used at the server's WebSocket message handler as the target type for
 * the parsed JSON payload. The `type` field drives the switch/discriminant.
 *
 * Adding a new command requires:
 *  1. Defining the command type above.
 *  2. Adding it to this union.
 *  3. Adding a corresponding case in the server's message router.
 *  4. Adding a type guard in guards.ts.
 */
export type AnyCommand =
  | AuthCommand
  | JoinRoomCommand
  | LeaveRoomCommand
  | PlayerReadyCommand
  | MakeMoveCommand
  | RequestRematchCommand
  | AcceptRematchCommand
  | DeclineRematchCommand
  | PingCommand
  | ReconnectCommand
  | SyncRequestCommand;

/**
 * Extract the concrete command type for a given type literal.
 *
 * @example
 * type Move = CommandByType<'MAKE_MOVE'>; // → MakeMoveCommand
 */
export type CommandByType<T extends CommandTypeLiteral> = Extract<AnyCommand, { type: T }>;
