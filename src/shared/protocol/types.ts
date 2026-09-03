/**
 * @file types.ts
 * @description Primitive types, enumerations, and envelope definitions for the
 * Tic-Tac-Toe realtime protocol (version 1).
 *
 * This file must remain framework-agnostic and have zero runtime dependencies.
 * It is imported by both the client and server without modification.
 *
 * @see PROTOCOL.md for the full specification.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Protocol Constants
// ─────────────────────────────────────────────────────────────────────────────

/** The single supported protocol version. All messages carry this value. */
export const PROTOCOL_VERSION = 1 as const;

/** WebSocket subprotocol identifier negotiated during the HTTP upgrade. */
export const WS_SUBPROTOCOL = 'ttt-v1' as const;

/**
 * Maximum WebSocket frame size in bytes.
 * Messages exceeding this are rejected with MESSAGE_TOO_LARGE.
 */
export const MAX_FRAME_BYTES = 65_536 as const;

/** How long (ms) the server retains commandId entries for deduplication. */
export const COMMAND_DEDUP_TTL_MS = 300_000 as const; // 5 minutes

/** How long (ms) a disconnected player has to reconnect before abandonment. */
export const RECONNECT_WINDOW_MS = 300_000 as const; // 5 minutes

/** How long (ms) between client PING messages. */
export const CLIENT_PING_INTERVAL_MS = 25_000 as const;

/** How long (ms) the server waits for a PONG before declaring the connection dead. */
export const PONG_TIMEOUT_MS = 5_000 as const;

/** How long (ms) of total inactivity before the server closes the connection. */
export const CONNECTION_IDLE_TIMEOUT_MS = 60_000 as const;

/** How long (ms) the server waits for AUTH after WebSocket open. */
export const AUTH_TIMEOUT_MS = 10_000 as const;

/** How long (ms) a rematch proposal stays open before expiring. */
export const REMATCH_TIMEOUT_MS = 60_000 as const;

/** How long (ms) a room lives without activity before being purged. */
export const ROOM_TTL_MS = 86_400_000 as const; // 24 hours

/** Maximum number of events retained in the per-session replay buffer. */
export const EVENT_BUFFER_SIZE = 500 as const;

/** Maximum allowed length for a player's display name. */
export const MAX_PLAYER_NAME_LENGTH = 30 as const;

// ─────────────────────────────────────────────────────────────────────────────
// Scalar Domain Types
// ─────────────────────────────────────────────────────────────────────────────

/** Opaque string type aliases – improve readability, prevent accidental swap. */
export type RoomId   = string & { readonly __brand: 'RoomId' };
export type GameId   = string & { readonly __brand: 'GameId' };
export type PlayerId = string & { readonly __brand: 'PlayerId' };
export type SessionToken = string & { readonly __brand: 'SessionToken' };
export type MessageId    = string & { readonly __brand: 'MessageId' };
export type CommandId    = string & { readonly __brand: 'CommandId' };

/**
 * A helper to cast a plain string to a branded type.
 * Only use at trust boundaries (e.g. parsing incoming JSON, DB reads).
 *
 * @example
 * const roomId = brand<RoomId>('ABCD1234');
 */
export function brand<T extends string>(value: string): T {
  return value as T;
}

// ─────────────────────────────────────────────────────────────────────────────
// Board / Game Primitives
// ─────────────────────────────────────────────────────────────────────────────

/** The two player symbols. */
export type PlayerSymbol = 'X' | 'O';

/** A cell value: empty string means the cell is unoccupied. */
export type CellValue = '' | 'X' | 'O';

/**
 * A row or column index on the 3×3 board.
 * Using a union literal type rather than `number` to prevent out-of-bounds
 * values from compiling when positions are constructed from constants.
 */
export type BoardIndex = 0 | 1 | 2;

/** A two-element [row, col] position on the board. */
export type BoardPosition = {
  readonly row: BoardIndex;
  readonly col: BoardIndex;
};

/**
 * A 3×3 board snapshot transmitted over the wire.
 * Stored as a flat tuple rather than a nested array for serialisation
 * determinism. Index = row * 3 + col.
 *
 * Position mapping:
 *   [0] = (0,0)  [1] = (0,1)  [2] = (0,2)
 *   [3] = (1,0)  [4] = (1,1)  [5] = (1,2)
 *   [6] = (2,0)  [7] = (2,1)  [8] = (2,2)
 */
export type BoardSnapshot = readonly [
  CellValue, CellValue, CellValue,
  CellValue, CellValue, CellValue,
  CellValue, CellValue, CellValue,
];

/** An empty board — useful as an initialiser. */
export const EMPTY_BOARD: BoardSnapshot = ['','','','','','','','',''] as const;

/** Convert (row, col) to a flat BoardSnapshot index. */
export function positionToIndex(row: BoardIndex, col: BoardIndex): number {
  return row * 3 + col;
}

/** Convert a flat BoardSnapshot index to (row, col). */
export function indexToPosition(index: number): BoardPosition {
  return { row: (Math.floor(index / 3)) as BoardIndex, col: (index % 3) as BoardIndex };
}

/** Read a cell value from a snapshot without mutation. */
export function getCell(board: BoardSnapshot, row: BoardIndex, col: BoardIndex): CellValue {
  // positionToIndex(BoardIndex, BoardIndex) is always in [0, 8], which is a
  // valid index on the 9-element BoardSnapshot tuple.  The type system cannot
  // prove this automatically under noUncheckedIndexedAccess, so we assert here
  // once — the invariant is structurally enforced by the BoardIndex type.
  return board[positionToIndex(row, col)] as CellValue;
}

// ─────────────────────────────────────────────────────────────────────────────
// Winning Line
// ─────────────────────────────────────────────────────────────────────────────

export type WinningLineType = 'row' | 'col' | 'diagonal';

/**
 * Describes the three cells that form a winning line.
 * Positions are ordered from top-left to bottom-right.
 */
export type WinningLine = {
  readonly type: WinningLineType;
  /**
   * Exactly three board positions, in order.
   * e.g. a top-row win: [{ row:0,col:0 }, { row:0,col:1 }, { row:0,col:2 }]
   */
  readonly positions: readonly [BoardPosition, BoardPosition, BoardPosition];
};

// ─────────────────────────────────────────────────────────────────────────────
// Game Status / Result Types
// ─────────────────────────────────────────────────────────────────────────────

export type GameStatus = 'WAITING' | 'ACTIVE' | 'FINISHED';

export type RoomStatus = 'OPEN' | 'FULL' | 'CLOSED';

export type GameOutcome = 'WIN' | 'DRAW' | 'FORFEIT' | 'ABANDONED';

export type GameEndReason =
  | 'THREE_IN_A_ROW'    // Normal win
  | 'BOARD_FULL'        // Draw: no empty cells and no winner
  | 'PLAYER_FORFEITED'  // Player voluntarily left during active game
  | 'PLAYER_ABANDONED'; // Player's reconnect window expired

/** Immutable result attached to a finished game. */
export type GameResult = {
  readonly outcome: GameOutcome;
  /** null for DRAW, ABANDONED (no single winner), and FORFEIT where it's not awarded */
  readonly winner: PlayerSymbol | null;
  readonly winningLine: WinningLine | null;
  readonly reason: GameEndReason;
  /** Server timestamp (ms) when the game ended. */
  readonly endedAt: number;
};

// ─────────────────────────────────────────────────────────────────────────────
// Move Record
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A single move as stored in the authoritative move history.
 * Immutable once created.
 */
export type MoveRecord = {
  /** 1-based index of this move within the current game. */
  readonly sequenceInGame: number;
  readonly symbol: PlayerSymbol;
  readonly position: BoardPosition;
  /** Server timestamp (ms) when the move was applied. */
  readonly appliedAt: number;
};

// ─────────────────────────────────────────────────────────────────────────────
// Player Info
// ─────────────────────────────────────────────────────────────────────────────

/** Connection state for a player slot in a room. */
export type ConnectionState = 'CONNECTED' | 'DISCONNECTED' | 'RECONNECTING';

export type PlayerInfo = {
  readonly playerId: PlayerId;
  readonly symbol: PlayerSymbol;
  /** Optional display name; null if not set. */
  readonly name: string | null;
  readonly connectionState: ConnectionState;
  /** Server timestamp (ms) of the last received message from this player. */
  readonly lastSeenAt: number;
};

// ─────────────────────────────────────────────────────────────────────────────
// Game Stats
// ─────────────────────────────────────────────────────────────────────────────

export type GameStats = {
  /** Total number of moves played. */
  readonly moveCount: number;
  /** Duration from first move to game end, in milliseconds. */
  readonly durationMs: number;
  /** Server timestamp (ms) when the first move was made. */
  readonly firstMoveAt: number | null;
};

// ─────────────────────────────────────────────────────────────────────────────
// Game Summary (for history lists)
// ─────────────────────────────────────────────────────────────────────────────

/** Compact game record for the room history list. */
export type GameSummary = {
  readonly gameId: GameId;
  readonly outcome: GameOutcome;
  readonly winner: PlayerSymbol | null;
  readonly moveCount: number;
  readonly startedAt: number;
  readonly endedAt: number;
};

// ─────────────────────────────────────────────────────────────────────────────
// Room State Snapshot
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Full room state transmitted to a client on join or reconnect.
 * Contains everything the client needs to render the current UI state.
 */
export type RoomStateSnapshot = {
  readonly roomId: RoomId;
  readonly status: RoomStatus;
  readonly players: {
    readonly X: PlayerInfo | null;
    readonly O: PlayerInfo | null;
  };
  /** Which player symbols have declared readiness. */
  readonly readyPlayers: ReadonlyArray<PlayerSymbol>;
  /** Present when a game is ACTIVE or FINISHED. */
  readonly currentGame: {
    readonly gameId: GameId;
    readonly status: GameStatus;
    readonly board: BoardSnapshot;
    readonly currentTurn: PlayerSymbol;
    /** 1-based count of moves applied so far. */
    readonly moveCount: number;
    readonly startedAt: number;
    /** Only present when status === 'FINISHED'. */
    readonly result: GameResult | null;
  } | null;
  /** Summaries of all completed games in this room, newest-first. */
  readonly gameHistory: ReadonlyArray<GameSummary>;
};

// ─────────────────────────────────────────────────────────────────────────────
// Message Envelopes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fields present on every message in both directions.
 */
export type BaseEnvelope = {
  /** Always 1 for this protocol version. */
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  /** UUID v4, unique per transmission (not stable across retries). */
  readonly messageId: MessageId;
  /** Sender's Unix epoch in milliseconds. Not trusted for ordering. */
  readonly timestamp: number;
  /** Discriminant used for runtime type narrowing. */
  readonly type: string;
};

/**
 * Additional fields present on every client→server command.
 *
 * The `commandId` is the idempotency key: it must remain stable across
 * retries of the same logical operation. A new `messageId` is generated
 * per transmission attempt, but the same `commandId` is reused.
 */
export type CommandEnvelope = BaseEnvelope & {
  /** UUID v4, stable across retries. Used for server-side deduplication. */
  readonly commandId: CommandId;
  /**
   * Opaque session token issued at AUTH.
   * Not required on the AUTH command itself — use null there.
   */
  readonly sessionToken: SessionToken | null;
};

/**
 * Additional fields present on every server→client event that is scoped
 * to a room/game session.
 *
 * Events that are not room-scoped (PONG, AUTH_ACK, pre-room ERRORs) omit
 * `roomId` and `sessionSeq`.
 */
export type EventEnvelope = BaseEnvelope & {
  /**
   * Monotonically increasing integer, scoped to the current game session.
   * Starts at 1. Resets to 1 at the beginning of each rematch game.
   * Clients use this to detect missing or out-of-order events.
   */
  readonly sessionSeq: number;
  readonly roomId: RoomId;
  /**
   * Present when the event is a direct response to a command.
   * Echoes the `commandId` of the triggering command.
   */
  readonly correlationId?: CommandId;
};

/**
 * A server-to-client event that is NOT room-scoped.
 * Used for AUTH_ACK, PONG, and pre-room ERRORs.
 */
export type GlobalEventEnvelope = BaseEnvelope & {
  readonly correlationId?: CommandId;
};

// ─────────────────────────────────────────────────────────────────────────────
// Move Rejection Reason
// ─────────────────────────────────────────────────────────────────────────────

export type MoveRejectionReason =
  | 'NOT_YOUR_TURN'
  | 'CELL_OCCUPIED'
  | 'OUT_OF_BOUNDS'
  | 'GAME_NOT_ACTIVE'
  | 'GAME_ID_MISMATCH';

// ─────────────────────────────────────────────────────────────────────────────
// Rematch State
// ─────────────────────────────────────────────────────────────────────────────

export type RematchState = {
  readonly requestedBy: PlayerSymbol;
  readonly requestedAt: number;
  /** Server timestamp (ms) when the proposal expires. */
  readonly expiresAt: number;
  readonly acceptedBy: ReadonlyArray<PlayerSymbol>;
};
