/**
 * @file index.ts
 * @description Barrel export for the shared Tic-Tac-Toe realtime protocol package.
 *
 * Import everything from this single entry point:
 *
 *   // Server
 *   import type { AnyCommand, MakeMoveCommand } from '@ttt/shared/protocol';
 *   import { CommandType, parseCommand, isAnyCommand } from '@ttt/shared/protocol';
 *
 *   // Client
 *   import type { AnyEvent, GameStartedEvent } from '@ttt/shared/protocol';
 *   import { EventType, parseEvent, isGameStartedEvent } from '@ttt/shared/protocol';
 *
 * Package alias is configured in each workspace's tsconfig.json paths:
 *   "@ttt/shared/protocol" → "src/shared/protocol/index.ts"
 *
 * The protocol package has NO runtime dependencies beyond what is declared
 * here. It imports no framework code, no HTTP libraries, no database drivers.
 * It is independently importable in:
 *  - The Node.js server process
 *  - The Vite/React client bundle
 *  - Vitest unit tests for the game engine
 *  - Any future CLI tooling or admin scripts
 *
 * Versioning note:
 *   Any breaking change to this file's public surface is a protocol version
 *   bump. Additive changes (new optional fields, new event types) are
 *   backward-compatible per the rules in PROTOCOL.md §5.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Re-export from types.ts — primitives, envelopes, domain types
// ─────────────────────────────────────────────────────────────────────────────

export {
  // Protocol constants
  PROTOCOL_VERSION,
  WS_SUBPROTOCOL,
  MAX_FRAME_BYTES,
  COMMAND_DEDUP_TTL_MS,
  RECONNECT_WINDOW_MS,
  CLIENT_PING_INTERVAL_MS,
  PONG_TIMEOUT_MS,
  CONNECTION_IDLE_TIMEOUT_MS,
  AUTH_TIMEOUT_MS,
  REMATCH_TIMEOUT_MS,
  ROOM_TTL_MS,
  EVENT_BUFFER_SIZE,
  MAX_PLAYER_NAME_LENGTH,

  // Board helpers
  EMPTY_BOARD,
  brand,
  positionToIndex,
  indexToPosition,
  getCell,
} from './types.js';

export type {
  // Branded scalars
  RoomId,
  GameId,
  PlayerId,
  SessionToken,
  MessageId,
  CommandId,

  // Board / game primitives
  PlayerSymbol,
  CellValue,
  BoardIndex,
  BoardPosition,
  BoardSnapshot,
  WinningLineType,
  WinningLine,

  // Game status / result
  GameStatus,
  RoomStatus,
  GameOutcome,
  GameEndReason,
  GameResult,

  // Records and snapshots
  MoveRecord,
  ConnectionState,
  PlayerInfo,
  GameStats,
  GameSummary,
  RoomStateSnapshot,

  // Envelopes
  BaseEnvelope,
  CommandEnvelope,
  EventEnvelope,
  GlobalEventEnvelope,

  // Domain types
  MoveRejectionReason,
  RematchState,
} from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Re-export from commands.ts — client→server
// ─────────────────────────────────────────────────────────────────────────────

export { CommandType } from './commands.js';

export type {
  CommandTypeLiteral,

  // Individual command types
  AuthCommand,
  JoinRoomCommand,
  LeaveRoomCommand,
  PlayerReadyCommand,
  MakeMoveCommand,
  RequestRematchCommand,
  AcceptRematchCommand,
  DeclineRematchCommand,
  PingCommand,
  ReconnectCommand,
  SyncRequestCommand,

  // Union and utility
  AnyCommand,
  CommandByType,
} from './commands.js';

// ─────────────────────────────────────────────────────────────────────────────
// Re-export from events.ts — server→client
// ─────────────────────────────────────────────────────────────────────────────

export { EventType } from './events.js';

export type {
  EventTypeLiteral,

  // Global events
  AuthAckEvent,
  PongEvent,

  // Room lifecycle events
  RoomJoinedEvent,
  PlayerJoinedEvent,
  RoomLeftEvent,
  PlayerLeftEvent,

  // Ready / start events
  PlayerReadyAckEvent,
  OpponentReadyEvent,
  GameStartedEvent,

  // Move events
  MoveAckEvent,
  MoveBroadcastEvent,
  MoveRejectedEvent,

  // Game end events
  GameFinishedEvent,

  // Rematch events
  RematchRequestedEvent,
  RematchDeclinedEvent,
  RematchExpiredEvent,

  // Presence events
  OpponentDisconnectedEvent,
  OpponentReconnectedEvent,

  // Reconnect / sync events
  ReconnectAckEvent,
  StateSyncEvent,
  StateSyncReplayEvent,
  StateSyncSnapshotEvent,

  // Unions and utilities
  AnyRoomEvent,
  AnyGlobalEvent,
  AnyEvent,
  EventByType,

  // HTTP type
  RoomHistoryResponse,
} from './events.js';

// ─────────────────────────────────────────────────────────────────────────────
// Re-export from errors.ts — error codes, ERROR event, metadata
// ─────────────────────────────────────────────────────────────────────────────

export {
  // Runtime metadata lookup table
  ERROR_META,

  // Utility functions
  isRecoverableError,
  errorClosesConnection,
  errorShouldRetry,
} from './errors.js';

export type {
  // Error code categories
  AuthErrorCode,
  RoomErrorCode,
  GameErrorCode,
  ProtocolErrorCode,
  ServerErrorCode,
  ErrorCode,

  // Metadata shape
  ErrorMeta,

  // Event type
  ErrorEvent,
} from './errors.js';

// ─────────────────────────────────────────────────────────────────────────────
// Re-export from guards.ts — runtime type guards and parse helpers
// ─────────────────────────────────────────────────────────────────────────────

export {
  // Domain primitive guards
  isBoardPosition,
  isBoardSnapshot,
  isRoomId,
  isUuidLike,
  isPlayerSymbol,

  // Envelope guards
  isBaseEnvelope,
  isCommandEnvelope,
  isEventEnvelope,
  isGlobalEventEnvelope,

  // Command guards
  isAuthCommand,
  isJoinRoomCommand,
  isLeaveRoomCommand,
  isPlayerReadyCommand,
  isMakeMoveCommand,
  isRequestRematchCommand,
  isAcceptRematchCommand,
  isDeclineRematchCommand,
  isPingCommand,
  isReconnectCommand,
  isSyncRequestCommand,
  isAnyCommand,

  // Event guards
  isAuthAckEvent,
  isPongEvent,
  isRoomJoinedEvent,
  isPlayerJoinedEvent,
  isRoomLeftEvent,
  isPlayerLeftEvent,
  isPlayerReadyAckEvent,
  isOpponentReadyEvent,
  isGameStartedEvent,
  isMoveAckEvent,
  isMoveBroadcastEvent,
  isMoveRejectedEvent,
  isGameFinishedEvent,
  isRematchRequestedEvent,
  isRematchDeclinedEvent,
  isRematchExpiredEvent,
  isOpponentDisconnectedEvent,
  isOpponentReconnectedEvent,
  isReconnectAckEvent,
  isStateSyncReplayEvent,
  isStateSyncSnapshotEvent,
  isStateSyncEvent,
  isErrorEvent,
  isAnyEvent,

  // Top-level parse helpers (primary entry points)
  parseCommand,
  parseEvent,

  // Error code guard
  isErrorCode,
} from './guards.js';

// ─────────────────────────────────────────────────────────────────────────────
// Convenience re-export: full wire message type
// ─────────────────────────────────────────────────────────────────────────────

/**
 * AnyWireMessage is the complete union of every message that can appear on
 * the wire in either direction. Useful for generic logging, tracing, and
 * serialisation utilities that need to handle any message without knowing
 * the direction.
 *
 * For directional handling, prefer AnyCommand (server ingress) or
 * AnyEvent | ErrorEvent (client ingress).
 */
export type { AnyCommand as AnyWireMessage } from './commands.js';
