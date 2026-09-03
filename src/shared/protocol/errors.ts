/**
 * @file errors.ts
 * @description Error codes and the ERROR event type for the Tic-Tac-Toe
 * realtime protocol (version 1).
 *
 * Design rules:
 *  - ErrorCode is a string literal union — exhaustive and explicit.
 *  - Every code maps to a single recoverable/non-recoverable classification.
 *  - The ErrorEvent is a discriminated member of AnyEvent.
 *  - No runtime logic lives here: this file is pure type declarations
 *    except for the ErrorCodeMeta lookup table, which is intentionally
 *    kept here so client and server share identical behaviour metadata.
 *
 * @see PROTOCOL.md §11.16 and §16 for the full error catalog.
 */

import type { GlobalEventEnvelope } from './types.js';
import type { EventType } from './events.js';

// ─────────────────────────────────────────────────────────────────────────────
// Error Code Catalog
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Authentication and session errors.
 */
export type AuthErrorCode =
  | 'AUTH_TIMEOUT'          // No AUTH received within AUTH_TIMEOUT_MS after WebSocket open
  | 'AUTH_FAILED'           // Invalid or expired guestToken
  | 'NOT_AUTHENTICATED'     // Room/game command sent before AUTH succeeded
  | 'SESSION_EXPIRED'       // sessionToken has exceeded its 7-day TTL
  | 'DUPLICATE_SESSION';    // Same sessionToken used to open a second simultaneous connection

/**
 * Room lifecycle errors.
 */
export type RoomErrorCode =
  | 'ROOM_NOT_FOUND'        // No room with the given roomId exists
  | 'ROOM_FULL'             // Room already has 2 players
  | 'ROOM_EXPIRED'          // Room exceeded its 24-hour TTL
  | 'ALREADY_IN_ROOM'       // Player attempted to join a second room
  | 'NOT_IN_ROOM';          // Command requires room membership but player is not in one

/**
 * Game play errors.
 */
export type GameErrorCode =
  | 'GAME_NOT_ACTIVE'           // Command requires ACTIVE game; game is in another status
  | 'GAME_ID_MISMATCH'          // gameId in command does not match current active game
  | 'NOT_YOUR_TURN'             // Player sent MAKE_MOVE when it is the opponent's turn
  | 'CELL_OCCUPIED'             // Target cell is already filled
  | 'OUT_OF_BOUNDS'             // Position row or col is outside [0, 2]
  | 'REMATCH_PENDING'           // Duplicate REQUEST_REMATCH when one is already pending
  | 'REMATCH_NOT_REQUESTED'     // ACCEPT_REMATCH / DECLINE_REMATCH with no pending request
  | 'RECONNECT_WINDOW_EXPIRED'  // 5-minute reconnect window elapsed before player returned
  | 'RECONNECT_INVALID';        // sessionToken not associated with the target room

/**
 * Protocol-level errors.
 */
export type ProtocolErrorCode =
  | 'PROTOCOL_VERSION_MISMATCH' // protocolVersion field does not equal PROTOCOL_VERSION (1)
  | 'MALFORMED_MESSAGE'         // JSON parse failure or missing required envelope fields
  | 'UNKNOWN_MESSAGE_TYPE'      // type field does not match any known CommandType
  | 'MESSAGE_TOO_LARGE'         // Frame exceeds MAX_FRAME_BYTES (64 KB)
  | 'RATE_LIMITED'              // Sender exceeded a rate limit (see PROTOCOL.md §16)
  | 'UNAUTHORIZED';             // Authorization check failed (e.g. acting as opponent)

/**
 * Server-level errors.
 */
export type ServerErrorCode =
  | 'INTERNAL_ERROR'       // Unexpected server-side exception; data.traceId is present
  | 'SERVER_SHUTTING_DOWN'; // Server is performing a graceful shutdown

/**
 * Complete error code union — every possible value of ErrorEvent.code.
 */
export type ErrorCode =
  | AuthErrorCode
  | RoomErrorCode
  | GameErrorCode
  | ProtocolErrorCode
  | ServerErrorCode;

// ─────────────────────────────────────────────────────────────────────────────
// Recoverability Metadata
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Per-code behaviour metadata shared by client and server.
 *
 * `recoverable`:
 *   true  — The connection remains open. The client may correct the command
 *            and retry (optionally with the same commandId if idempotent).
 *   false — The server will close the WebSocket after sending this error.
 *            The client must reconnect from scratch.
 *
 * `closesConnection`:
 *   true  — Server sends a WebSocket close frame immediately after the ERROR event.
 *
 * `clientShouldRetry`:
 *   true  — Client should automatically retry the triggering command after a
 *            brief back-off (e.g. on RATE_LIMITED, INTERNAL_ERROR).
 *   false — Client should surface the error to the user.
 */
export type ErrorMeta = {
  readonly recoverable: boolean;
  readonly closesConnection: boolean;
  readonly clientShouldRetry: boolean;
  /** Human-readable summary. Used in development-mode error overlays. */
  readonly summary: string;
};

export const ERROR_META: Readonly<Record<ErrorCode, ErrorMeta>> = {
  // ── Auth ──────────────────────────────────────────────────────────────────
  AUTH_TIMEOUT: {
    recoverable: false, closesConnection: true, clientShouldRetry: false,
    summary: 'No AUTH command received within the time limit after WebSocket open.',
  },
  AUTH_FAILED: {
    recoverable: true, closesConnection: false, clientShouldRetry: false,
    summary: 'The provided guestToken is invalid or expired. Send AUTH with guestToken: null to create a new session.',
  },
  NOT_AUTHENTICATED: {
    recoverable: true, closesConnection: false, clientShouldRetry: false,
    summary: 'A room or game command was sent before authentication succeeded.',
  },
  SESSION_EXPIRED: {
    recoverable: false, closesConnection: true, clientShouldRetry: false,
    summary: 'The session token has expired (7-day TTL). Clear stored credentials and re-authenticate.',
  },
  DUPLICATE_SESSION: {
    recoverable: false, closesConnection: true, clientShouldRetry: false,
    summary: 'The same session token is already in use on another connection.',
  },

  // ── Room ──────────────────────────────────────────────────────────────────
  ROOM_NOT_FOUND: {
    recoverable: true, closesConnection: false, clientShouldRetry: false,
    summary: 'No room exists with the given roomId.',
  },
  ROOM_FULL: {
    recoverable: true, closesConnection: false, clientShouldRetry: false,
    summary: 'The room already has 2 players and cannot accept more.',
  },
  ROOM_EXPIRED: {
    recoverable: false, closesConnection: false, clientShouldRetry: false,
    summary: 'The room has exceeded its 24-hour TTL and has been purged.',
  },
  ALREADY_IN_ROOM: {
    recoverable: true, closesConnection: false, clientShouldRetry: false,
    summary: 'The player is already in a different active room.',
  },
  NOT_IN_ROOM: {
    recoverable: true, closesConnection: false, clientShouldRetry: false,
    summary: 'This command requires the player to be in a room.',
  },

  // ── Game ──────────────────────────────────────────────────────────────────
  GAME_NOT_ACTIVE: {
    recoverable: true, closesConnection: false, clientShouldRetry: false,
    summary: 'This command requires the game to be in ACTIVE status.',
  },
  GAME_ID_MISMATCH: {
    recoverable: true, closesConnection: false, clientShouldRetry: false,
    summary: 'The gameId in the command does not match the current active game.',
  },
  NOT_YOUR_TURN: {
    recoverable: true, closesConnection: false, clientShouldRetry: false,
    summary: 'It is not this player\'s turn.',
  },
  CELL_OCCUPIED: {
    recoverable: true, closesConnection: false, clientShouldRetry: false,
    summary: 'The target cell is already occupied.',
  },
  OUT_OF_BOUNDS: {
    recoverable: true, closesConnection: false, clientShouldRetry: false,
    summary: 'The position row or col is outside the valid range [0, 2].',
  },
  REMATCH_PENDING: {
    recoverable: true, closesConnection: false, clientShouldRetry: false,
    summary: 'A rematch proposal is already pending for this game.',
  },
  REMATCH_NOT_REQUESTED: {
    recoverable: true, closesConnection: false, clientShouldRetry: false,
    summary: 'Cannot accept or decline: no rematch has been requested for this game.',
  },
  RECONNECT_WINDOW_EXPIRED: {
    recoverable: false, closesConnection: false, clientShouldRetry: false,
    summary: 'The 5-minute reconnection window has elapsed. The game has been abandoned.',
  },
  RECONNECT_INVALID: {
    recoverable: true, closesConnection: false, clientShouldRetry: false,
    summary: 'The session token is not associated with the given roomId.',
  },

  // ── Protocol ──────────────────────────────────────────────────────────────
  PROTOCOL_VERSION_MISMATCH: {
    recoverable: false, closesConnection: true, clientShouldRetry: false,
    summary: 'The protocolVersion field does not match the server\'s supported version.',
  },
  MALFORMED_MESSAGE: {
    recoverable: true, closesConnection: false, clientShouldRetry: false,
    summary: 'The message could not be parsed or is missing required envelope fields.',
  },
  UNKNOWN_MESSAGE_TYPE: {
    recoverable: true, closesConnection: false, clientShouldRetry: false,
    summary: 'The type field does not match any known command.',
  },
  MESSAGE_TOO_LARGE: {
    recoverable: true, closesConnection: false, clientShouldRetry: false,
    summary: 'The message frame exceeds the maximum allowed size of 64 KB.',
  },
  RATE_LIMITED: {
    recoverable: true, closesConnection: false, clientShouldRetry: true,
    summary: 'The sender has exceeded the rate limit. Back off and retry.',
  },
  UNAUTHORIZED: {
    recoverable: true, closesConnection: false, clientShouldRetry: false,
    summary: 'Authorization failed for this command (e.g. acting as another player).',
  },

  // ── Server ────────────────────────────────────────────────────────────────
  INTERNAL_ERROR: {
    recoverable: true, closesConnection: false, clientShouldRetry: true,
    summary: 'An unexpected server error occurred. A traceId is provided in data for support.',
  },
  SERVER_SHUTTING_DOWN: {
    recoverable: false, closesConnection: true, clientShouldRetry: false,
    summary: 'The server is shutting down. Reconnect in a few seconds.',
  },
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// ERROR Event Type
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sent by the server when a command fails or a session-level problem occurs.
 *
 * Routing:
 *  - If correlationId is present: the error is a direct response to a command.
 *    The client can match it to a pending command by commandId.
 *  - If correlationId is absent: the error is session-level (e.g. AUTH_TIMEOUT,
 *    SERVER_SHUTTING_DOWN). No pending command caused it.
 *
 * Connection behaviour:
 *  - If recoverable === false: the server closes the WebSocket immediately
 *    after sending this event. The client should begin reconnection.
 *  - If recoverable === true: the connection stays open.
 *
 * The `detail` field is human-readable and safe to display in development.
 * In production builds the server sends a generic message for INTERNAL_ERROR
 * to avoid leaking implementation details.
 *
 * The `data` field carries structured context:
 *  - INTERNAL_ERROR:          { traceId: string }
 *  - RATE_LIMITED:            { retryAfterMs: number }
 *  - PROTOCOL_VERSION_MISMATCH: { serverVersion: number, clientVersion: number }
 *  - RECONNECT_WINDOW_EXPIRED:  { expiredAt: number }
 */
export type ErrorEvent = GlobalEventEnvelope & {
  readonly type: typeof EventType.ERROR;
  readonly code: ErrorCode;
  /** Human-readable description of the error. May differ between environments. */
  readonly detail: string;
  readonly recoverable: boolean;
  /** Structured context relevant to the specific error code. */
  readonly data?: Readonly<Record<string, unknown>>;
};

// ─────────────────────────────────────────────────────────────────────────────
// Utility: Check recoverability at runtime
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns true if the given error code indicates a recoverable condition.
 * Avoids sprinkling ERROR_META lookups throughout application code.
 */
export function isRecoverableError(code: ErrorCode): boolean {
  return ERROR_META[code].recoverable;
}

/**
 * Returns true if the server will close the connection after this error.
 */
export function errorClosesConnection(code: ErrorCode): boolean {
  return ERROR_META[code].closesConnection;
}

/**
 * Returns true if the client should automatically retry the triggering command.
 */
export function errorShouldRetry(code: ErrorCode): boolean {
  return ERROR_META[code].clientShouldRetry;
}
