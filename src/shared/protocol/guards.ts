/**
 * @file guards.ts
 * @description Runtime type guards for the complete Tic-Tac-Toe realtime
 * protocol (version 1).
 *
 * Every exported function follows the TypeScript type predicate pattern:
 *
 *   function isXxx(value: unknown): value is XxxType
 *
 * Usage at trust boundaries (server message router, client dispatcher):
 *
 *   const raw = JSON.parse(frame.data);
 *
 *   if (!isAnyCommand(raw)) {
 *     return sendError(conn, 'MALFORMED_MESSAGE');
 *   }
 *   // raw is now narrowed to AnyCommand
 *   switch (raw.type) {
 *     case CommandType.MAKE_MOVE: handleMakeMove(raw); break;
 *     ...
 *   }
 *
 * Design rules:
 *  - Guards are deliberately shallow: they check structural shape and the
 *    discriminant field only. Deep semantic validation (e.g. "is this
 *    position already occupied?") belongs in the game engine and validators.
 *  - Every guard for a concrete type is individually exported for targeted
 *    use in tests and error messages.
 *  - No guard throws — they return false for invalid input.
 *  - The file has zero side effects and no mutable state.
 *
 * @see types.ts, commands.ts, events.ts, errors.ts for the types being guarded.
 */

import { PROTOCOL_VERSION } from './types.js';
import { CommandType } from './commands.js';
import { EventType } from './events.js';

import type {
  BaseEnvelope,
  CommandEnvelope,
  EventEnvelope,
  GlobalEventEnvelope,
  BoardPosition,
  BoardSnapshot,
  CellValue,
  BoardIndex,
} from './types.js';

import type {
  AnyCommand,
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
} from './commands.js';

import type {
  AnyEvent,
  AuthAckEvent,
  PongEvent,
  RoomJoinedEvent,
  PlayerJoinedEvent,
  RoomLeftEvent,
  PlayerLeftEvent,
  PlayerReadyAckEvent,
  OpponentReadyEvent,
  GameStartedEvent,
  MoveAckEvent,
  MoveBroadcastEvent,
  MoveRejectedEvent,
  GameFinishedEvent,
  RematchRequestedEvent,
  RematchDeclinedEvent,
  RematchExpiredEvent,
  OpponentDisconnectedEvent,
  OpponentReconnectedEvent,
  ReconnectAckEvent,
  StateSyncEvent,
  StateSyncReplayEvent,
  StateSyncSnapshotEvent,
} from './events.js';

import type { ErrorEvent } from './errors.js';
import { ERROR_META } from './errors.js';
import type { ErrorCode } from './errors.js';

// ─────────────────────────────────────────────────────────────────────────────
// Primitive helpers (not exported — internal to this module)
// ─────────────────────────────────────────────────────────────────────────────

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isString(v: unknown): v is string {
  return typeof v === 'string';
}

function isNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isNonNegativeInteger(v: unknown): v is number {
  return isNumber(v) && Number.isInteger(v) && v >= 0;
}

function isUuidV4(v: unknown): v is string {
  return (
    isString(v) &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v)
  );
}

function isBoardIndex(v: unknown): v is BoardIndex {
  return v === 0 || v === 1 || v === 2;
}

const VALID_CELL_VALUES = new Set<CellValue>(['', 'X', 'O']);

function isCellValue(v: unknown): v is CellValue {
  return isString(v) && VALID_CELL_VALUES.has(v as CellValue);
}

// ─────────────────────────────────────────────────────────────────────────────
// Domain primitive guards (exported for use in tests and validators)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Checks that a value is a valid { row, col } board position with both
 * indices in [0, 2]. Does NOT check whether the cell is occupied.
 */
export function isBoardPosition(v: unknown): v is BoardPosition {
  return (
    isObject(v) &&
    isBoardIndex(v['row']) &&
    isBoardIndex(v['col'])
  );
}

/**
 * Checks that a value is a 9-element readonly array of valid CellValues.
 */
export function isBoardSnapshot(v: unknown): v is BoardSnapshot {
  return (
    Array.isArray(v) &&
    v.length === 9 &&
    v.every(isCellValue)
  );
}

/**
 * Checks that a string is a valid 8-character room code.
 * Valid characters: A-Z, 2-9 (Base32 without ambiguous characters).
 */
export function isRoomId(v: unknown): v is string {
  return isString(v) && /^[A-Z2-9]{8}$/.test(v);
}

/**
 * Checks that a string looks like a UUID v4. Used for gameId, playerId,
 * commandId, messageId, sessionToken.
 */
export function isUuidLike(v: unknown): v is string {
  return isUuidV4(v);
}

/**
 * Checks that a value is either 'X' or 'O'.
 */
export function isPlayerSymbol(v: unknown): v is 'X' | 'O' {
  return v === 'X' || v === 'O';
}

// ─────────────────────────────────────────────────────────────────────────────
// Envelope guards
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Guards that the value has all fields required by BaseEnvelope.
 * Used as the first check before narrowing to a specific message type.
 */
export function isBaseEnvelope(v: unknown): v is BaseEnvelope {
  return (
    isObject(v) &&
    v['protocolVersion'] === PROTOCOL_VERSION &&
    isUuidLike(v['messageId']) &&
    isNumber(v['timestamp']) &&
    v['timestamp'] > 0 &&
    isString(v['type']) &&
    v['type'].length > 0
  );
}

/**
 * Guards that the value satisfies CommandEnvelope (all BaseEnvelope fields
 * plus commandId). The sessionToken may be null (AUTH command) or a string.
 */
export function isCommandEnvelope(v: unknown): v is CommandEnvelope {
  if (!isBaseEnvelope(v)) return false;
  // CommandEnvelope adds commandId and sessionToken to BaseEnvelope.
  // Cast to Record<string, unknown> to access these extra fields safely
  // under noPropertyAccessFromIndexSignature.
  const r = v as Record<string, unknown>;
  return (
    isUuidLike(r['commandId']) &&
    (r['sessionToken'] === null || isString(r['sessionToken']))
  );
}

/**
 * Guards that the value satisfies EventEnvelope (all BaseEnvelope fields
 * plus sessionSeq and roomId). Used on the client to validate incoming
 * room-scoped events.
 */
export function isEventEnvelope(v: unknown): v is EventEnvelope & Record<string, unknown> {
  if (!isBaseEnvelope(v)) return false;
  // EventEnvelope adds sessionSeq and roomId to BaseEnvelope.
  const r = v as Record<string, unknown>;
  return (
    isNonNegativeInteger(r['sessionSeq']) &&
    (r['sessionSeq'] as number) >= 1 &&
    isRoomId(r['roomId'])
  );
}

/**
 * Guards that the value satisfies GlobalEventEnvelope (base fields only —
 * no sessionSeq or roomId).
 */
export function isGlobalEventEnvelope(v: unknown): v is GlobalEventEnvelope & Record<string, unknown> {
  return isBaseEnvelope(v);
}

// ─────────────────────────────────────────────────────────────────────────────
// Command guards — client→server
// ─────────────────────────────────────────────────────────────────────────────

export function isAuthCommand(v: unknown): v is AuthCommand {
  if (!isCommandEnvelope(v)) return false;
  const r = v as Record<string, unknown>;
  return (
    v.type === CommandType.AUTH &&
    v.sessionToken === null &&
    (r['guestToken'] === null || isString(r['guestToken'])) &&
    isString(r['clientVersion'])
  );
}

export function isJoinRoomCommand(v: unknown): v is JoinRoomCommand {
  if (!isCommandEnvelope(v)) return false;
  const r = v as Record<string, unknown>;
  return (
    v.type === CommandType.JOIN_ROOM &&
    isRoomId(r['roomId']) &&
    (r['playerName'] === null || isString(r['playerName']))
  );
}

export function isLeaveRoomCommand(v: unknown): v is LeaveRoomCommand {
  if (!isCommandEnvelope(v)) return false;
  const r = v as Record<string, unknown>;
  return (
    v.type === CommandType.LEAVE_ROOM &&
    isRoomId(r['roomId']) &&
    (r['reason'] === 'VOLUNTARY' || r['reason'] === 'CLOSING_TAB')
  );
}

export function isPlayerReadyCommand(v: unknown): v is PlayerReadyCommand {
  if (!isCommandEnvelope(v)) return false;
  const r = v as Record<string, unknown>;
  return (
    v.type === CommandType.PLAYER_READY &&
    isRoomId(r['roomId'])
  );
}

export function isMakeMoveCommand(v: unknown): v is MakeMoveCommand {
  if (!isCommandEnvelope(v)) return false;
  const r = v as Record<string, unknown>;
  if (v.type !== CommandType.MAKE_MOVE) return false;
  if (!isRoomId(r['roomId'])) return false;
  if (!isUuidLike(r['gameId'])) return false;
  const pos = r['position'];
  return (
    isObject(pos) &&
    isBoardIndex(pos['row']) &&
    isBoardIndex(pos['col'])
  );
}

export function isRequestRematchCommand(v: unknown): v is RequestRematchCommand {
  if (!isCommandEnvelope(v)) return false;
  const r = v as Record<string, unknown>;
  return (
    v.type === CommandType.REQUEST_REMATCH &&
    isRoomId(r['roomId']) &&
    isUuidLike(r['gameId'])
  );
}

export function isAcceptRematchCommand(v: unknown): v is AcceptRematchCommand {
  if (!isCommandEnvelope(v)) return false;
  const r = v as Record<string, unknown>;
  return (
    v.type === CommandType.ACCEPT_REMATCH &&
    isRoomId(r['roomId']) &&
    isUuidLike(r['gameId'])
  );
}

export function isDeclineRematchCommand(v: unknown): v is DeclineRematchCommand {
  if (!isCommandEnvelope(v)) return false;
  const r = v as Record<string, unknown>;
  return (
    v.type === CommandType.DECLINE_REMATCH &&
    isRoomId(r['roomId']) &&
    isUuidLike(r['gameId'])
  );
}

export function isPingCommand(v: unknown): v is PingCommand {
  if (!isCommandEnvelope(v)) return false;
  const r = v as Record<string, unknown>;
  return (
    v.type === CommandType.PING &&
    isNumber(r['clientTime']) &&
    (r['clientTime'] as number) > 0
  );
}

export function isReconnectCommand(v: unknown): v is ReconnectCommand {
  if (!isCommandEnvelope(v)) return false;
  const r = v as Record<string, unknown>;
  return (
    v.type === CommandType.RECONNECT &&
    isRoomId(r['roomId']) &&
    isNonNegativeInteger(r['lastReceivedSeq'])
  );
}

export function isSyncRequestCommand(v: unknown): v is SyncRequestCommand {
  if (!isCommandEnvelope(v)) return false;
  const r = v as Record<string, unknown>;
  return (
    v.type === CommandType.SYNC_REQUEST &&
    isRoomId(r['roomId']) &&
    isNonNegativeInteger(r['fromSeq']) &&
    (r['fromSeq'] as number) >= 1
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// AnyCommand top-level guard
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Entry-point guard at the server's WebSocket message handler.
 *
 * Returns true if the value is structurally valid for any known command type.
 * After this passes, switch on `value.type` and use the concrete guards above
 * for full deep validation within each branch.
 *
 * @example
 * const parsed = JSON.parse(rawFrame);
 * if (!isAnyCommand(parsed)) {
 *   return sendError(conn, 'MALFORMED_MESSAGE');
 * }
 * switch (parsed.type) { ... }
 */
export function isAnyCommand(v: unknown): v is AnyCommand {
  if (!isCommandEnvelope(v)) return false;
  switch (v.type) {
    case CommandType.AUTH:            return isAuthCommand(v);
    case CommandType.JOIN_ROOM:       return isJoinRoomCommand(v);
    case CommandType.LEAVE_ROOM:      return isLeaveRoomCommand(v);
    case CommandType.PLAYER_READY:    return isPlayerReadyCommand(v);
    case CommandType.MAKE_MOVE:       return isMakeMoveCommand(v);
    case CommandType.REQUEST_REMATCH: return isRequestRematchCommand(v);
    case CommandType.ACCEPT_REMATCH:  return isAcceptRematchCommand(v);
    case CommandType.DECLINE_REMATCH: return isDeclineRematchCommand(v);
    case CommandType.PING:            return isPingCommand(v);
    case CommandType.RECONNECT:       return isReconnectCommand(v);
    case CommandType.SYNC_REQUEST:    return isSyncRequestCommand(v);
    default:                          return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Event guards — server→client
// ─────────────────────────────────────────────────────────────────────────────

export function isAuthAckEvent(v: unknown): v is AuthAckEvent {
  if (!isGlobalEventEnvelope(v)) return false;
  if (v.type !== EventType.AUTH_ACK) return false;
  if (!isString(v['sessionToken'])) return false;
  if (!isUuidLike(v['playerId'])) return false;
  if (!isString(v['serverVersion'])) return false;
  const room = v['existingRoom'];
  if (room !== null) {
    if (!isObject(room)) return false;
    if (!isRoomId(room['roomId'])) return false;
    if (!isPlayerSymbol(room['symbol'])) return false;
    if (!(['WAITING', 'ACTIVE', 'FINISHED'].includes(room['gameStatus'] as string))) return false;
  }
  return true;
}

export function isPongEvent(v: unknown): v is PongEvent {
  if (!isGlobalEventEnvelope(v)) return false;
  return (
    v.type === EventType.PONG &&
    isNumber(v['clientTime']) &&
    isNumber(v['serverTime'])
  );
}

export function isRoomJoinedEvent(v: unknown): v is RoomJoinedEvent {
  if (!isEventEnvelope(v)) return false;
  return (
    v.type === EventType.ROOM_JOINED &&
    isRoomId(v['roomId']) &&
    isUuidLike(v['playerId']) &&
    isPlayerSymbol(v['symbol']) &&
    isObject(v['roomState'])
  );
}

export function isPlayerJoinedEvent(v: unknown): v is PlayerJoinedEvent {
  if (!isEventEnvelope(v)) return false;
  return (
    v.type === EventType.PLAYER_JOINED &&
    isRoomId(v['roomId']) &&
    isUuidLike(v['playerId']) &&
    isPlayerSymbol(v['symbol']) &&
    (v['playerName'] === null || isString(v['playerName'])) &&
    isNumber(v['connectedPlayerCount'])
  );
}

export function isRoomLeftEvent(v: unknown): v is RoomLeftEvent {
  if (!isEventEnvelope(v)) return false;
  return v.type === EventType.ROOM_LEFT && isRoomId(v['roomId']);
}

export function isPlayerLeftEvent(v: unknown): v is PlayerLeftEvent {
  if (!isEventEnvelope(v)) return false;
  return (
    v.type === EventType.PLAYER_LEFT &&
    isRoomId(v['roomId']) &&
    isUuidLike(v['playerId']) &&
    isPlayerSymbol(v['symbol']) &&
    (['VOLUNTARY', 'DISCONNECT_TIMEOUT', 'FORFEIT'].includes(v['reason'] as string))
  );
}

export function isPlayerReadyAckEvent(v: unknown): v is PlayerReadyAckEvent {
  if (!isEventEnvelope(v)) return false;
  return (
    v.type === EventType.PLAYER_READY_ACK &&
    isRoomId(v['roomId']) &&
    Array.isArray(v['readyPlayers']) &&
    (v['readyPlayers'] as unknown[]).every(isPlayerSymbol)
  );
}

export function isOpponentReadyEvent(v: unknown): v is OpponentReadyEvent {
  if (!isEventEnvelope(v)) return false;
  return (
    v.type === EventType.OPPONENT_READY &&
    isRoomId(v['roomId']) &&
    isPlayerSymbol(v['symbol']) &&
    Array.isArray(v['readyPlayers']) &&
    (v['readyPlayers'] as unknown[]).every(isPlayerSymbol)
  );
}

export function isGameStartedEvent(v: unknown): v is GameStartedEvent {
  if (!isEventEnvelope(v)) return false;
  return (
    v.type === EventType.GAME_STARTED &&
    isRoomId(v['roomId']) &&
    isUuidLike(v['gameId']) &&
    isBoardSnapshot(v['board']) &&
    isPlayerSymbol(v['firstTurn']) &&
    isObject(v['players']) &&
    isNumber(v['startedAt'])
  );
}

export function isMoveAckEvent(v: unknown): v is MoveAckEvent {
  if (!isEventEnvelope(v)) return false;
  if (v.type !== EventType.MOVE_ACK) return false;
  if (!isRoomId(v['roomId'])) return false;
  if (!isUuidLike(v['gameId'])) return false;
  if (!isObject(v['position'])) return false;
  if (!isPlayerSymbol(v['symbol'])) return false;
  if (!isNonNegativeInteger(v['sequenceInGame'])) return false;
  if (!isBoardSnapshot(v['board'])) return false;
  if (v['nextTurn'] !== null && !isPlayerSymbol(v['nextTurn'])) return false;
  return true;
}

export function isMoveBroadcastEvent(v: unknown): v is MoveBroadcastEvent {
  if (!isEventEnvelope(v)) return false;
  if (v.type !== EventType.MOVE_BROADCAST) return false;
  if (!isRoomId(v['roomId'])) return false;
  if (!isUuidLike(v['gameId'])) return false;
  if (!isObject(v['position'])) return false;
  if (!isPlayerSymbol(v['symbol'])) return false;
  if (!isUuidLike(v['playerId'])) return false;
  if (!isNonNegativeInteger(v['sequenceInGame'])) return false;
  if (!isBoardSnapshot(v['board'])) return false;
  if (v['nextTurn'] !== null && !isPlayerSymbol(v['nextTurn'])) return false;
  return true;
}

export function isMoveRejectedEvent(v: unknown): v is MoveRejectedEvent {
  if (!isEventEnvelope(v)) return false;
  const validReasons = new Set([
    'NOT_YOUR_TURN', 'CELL_OCCUPIED', 'OUT_OF_BOUNDS',
    'GAME_NOT_ACTIVE', 'GAME_ID_MISMATCH',
  ]);
  return (
    v.type === EventType.MOVE_REJECTED &&
    isRoomId(v['roomId']) &&
    isUuidLike(v['gameId']) &&
    isObject(v['position']) &&
    validReasons.has(v['reason'] as string) &&
    isBoardSnapshot(v['board']) &&
    isPlayerSymbol(v['currentTurn'])
  );
}

export function isGameFinishedEvent(v: unknown): v is GameFinishedEvent {
  if (!isEventEnvelope(v)) return false;
  return (
    v.type === EventType.GAME_FINISHED &&
    isRoomId(v['roomId']) &&
    isUuidLike(v['gameId']) &&
    isObject(v['result']) &&
    isBoardSnapshot(v['finalBoard']) &&
    Array.isArray(v['moveHistory']) &&
    isObject(v['stats'])
  );
}

export function isRematchRequestedEvent(v: unknown): v is RematchRequestedEvent {
  if (!isEventEnvelope(v)) return false;
  return (
    v.type === EventType.REMATCH_REQUESTED &&
    isRoomId(v['roomId']) &&
    isUuidLike(v['gameId']) &&
    isPlayerSymbol(v['requestedBy']) &&
    isNumber(v['expiresAt'])
  );
}

export function isRematchDeclinedEvent(v: unknown): v is RematchDeclinedEvent {
  if (!isEventEnvelope(v)) return false;
  return (
    v.type === EventType.REMATCH_DECLINED &&
    isRoomId(v['roomId']) &&
    isUuidLike(v['gameId']) &&
    isPlayerSymbol(v['declinedBy'])
  );
}

export function isRematchExpiredEvent(v: unknown): v is RematchExpiredEvent {
  if (!isEventEnvelope(v)) return false;
  return (
    v.type === EventType.REMATCH_EXPIRED &&
    isRoomId(v['roomId']) &&
    isUuidLike(v['gameId'])
  );
}

export function isOpponentDisconnectedEvent(v: unknown): v is OpponentDisconnectedEvent {
  if (!isEventEnvelope(v)) return false;
  return (
    v.type === EventType.OPPONENT_DISCONNECTED &&
    isRoomId(v['roomId']) &&
    isPlayerSymbol(v['symbol']) &&
    isNumber(v['reconnectDeadlineAt'])
  );
}

export function isOpponentReconnectedEvent(v: unknown): v is OpponentReconnectedEvent {
  if (!isEventEnvelope(v)) return false;
  return (
    v.type === EventType.OPPONENT_RECONNECTED &&
    isRoomId(v['roomId']) &&
    isPlayerSymbol(v['symbol'])
  );
}

export function isReconnectAckEvent(v: unknown): v is ReconnectAckEvent {
  if (!isEventEnvelope(v)) return false;
  return (
    v.type === EventType.RECONNECT_ACK &&
    isRoomId(v['roomId']) &&
    isUuidLike(v['playerId']) &&
    isPlayerSymbol(v['symbol']) &&
    isObject(v['roomState']) &&
    isNonNegativeInteger(v['sessionSeq'])
  );
}

export function isStateSyncReplayEvent(v: unknown): v is StateSyncReplayEvent {
  if (!isEventEnvelope(v)) return false;
  return (
    v.type === EventType.STATE_SYNC &&
    v['mode'] === 'REPLAY' &&
    isRoomId(v['roomId']) &&
    isNonNegativeInteger(v['fromSeq']) &&
    isNonNegativeInteger(v['toSeq']) &&
    Array.isArray(v['events'])
  );
}

export function isStateSyncSnapshotEvent(v: unknown): v is StateSyncSnapshotEvent {
  if (!isEventEnvelope(v)) return false;
  return (
    v.type === EventType.STATE_SYNC &&
    v['mode'] === 'SNAPSHOT' &&
    isRoomId(v['roomId']) &&
    isObject(v['roomState'])
  );
}

export function isStateSyncEvent(v: unknown): v is StateSyncEvent {
  return isStateSyncReplayEvent(v) || isStateSyncSnapshotEvent(v);
}

export function isErrorEvent(v: unknown): v is ErrorEvent {
  if (!isBaseEnvelope(v)) return false;
  const r = v as Record<string, unknown>;
  return (
    v.type === EventType.ERROR &&
    isString(r['code']) &&
    (r['code'] as string) in ERROR_META &&
    isString(r['detail']) &&
    typeof r['recoverable'] === 'boolean'
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// AnyEvent top-level guard
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Entry-point guard at the client's WebSocket message dispatcher.
 *
 * Returns true if the value is structurally valid for any known event type.
 *
 * @example
 * const parsed = JSON.parse(frame.data);
 * if (!isAnyEvent(parsed)) {
 *   console.warn('Unknown event received', parsed);
 *   return;
 * }
 * dispatch(parsed);
 */
export function isAnyEvent(v: unknown): v is AnyEvent {
  if (!isBaseEnvelope(v)) return false;
  switch (v.type) {
    // Global
    case EventType.AUTH_ACK:              return isAuthAckEvent(v);
    case EventType.PONG:                  return isPongEvent(v);
    case EventType.ERROR:                 return isErrorEvent(v);
    // Room lifecycle
    case EventType.ROOM_JOINED:           return isRoomJoinedEvent(v);
    case EventType.PLAYER_JOINED:         return isPlayerJoinedEvent(v);
    case EventType.ROOM_LEFT:             return isRoomLeftEvent(v);
    case EventType.PLAYER_LEFT:           return isPlayerLeftEvent(v);
    // Ready / game start
    case EventType.PLAYER_READY_ACK:      return isPlayerReadyAckEvent(v);
    case EventType.OPPONENT_READY:        return isOpponentReadyEvent(v);
    case EventType.GAME_STARTED:          return isGameStartedEvent(v);
    // Moves
    case EventType.MOVE_ACK:              return isMoveAckEvent(v);
    case EventType.MOVE_BROADCAST:        return isMoveBroadcastEvent(v);
    case EventType.MOVE_REJECTED:         return isMoveRejectedEvent(v);
    // Game end
    case EventType.GAME_FINISHED:         return isGameFinishedEvent(v);
    // Rematch
    case EventType.REMATCH_REQUESTED:     return isRematchRequestedEvent(v);
    case EventType.REMATCH_DECLINED:      return isRematchDeclinedEvent(v);
    case EventType.REMATCH_EXPIRED:       return isRematchExpiredEvent(v);
    // Presence
    case EventType.OPPONENT_DISCONNECTED: return isOpponentDisconnectedEvent(v);
    case EventType.OPPONENT_RECONNECTED:  return isOpponentReconnectedEvent(v);
    // Reconnect / sync
    case EventType.RECONNECT_ACK:         return isReconnectAckEvent(v);
    case EventType.STATE_SYNC:            return isStateSyncEvent(v);
    // Unknown
    default:                              return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Narrow-from-parsed helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse a raw WebSocket frame string and narrow to AnyCommand.
 *
 * Returns `{ ok: true, command }` on success.
 * Returns `{ ok: false, reason }` on parse failure or guard failure,
 * without throwing.
 *
 * Intended for use in the server's WebSocket `message` event handler.
 */
export function parseCommand(
  raw: string,
): { ok: true; command: AnyCommand } | { ok: false; reason: 'MALFORMED_MESSAGE' | 'UNKNOWN_MESSAGE_TYPE' | 'PROTOCOL_VERSION_MISMATCH' } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'MALFORMED_MESSAGE' };
  }

  if (!isObject(parsed)) {
    return { ok: false, reason: 'MALFORMED_MESSAGE' };
  }

  // Check protocol version before anything else
  if (parsed['protocolVersion'] !== PROTOCOL_VERSION) {
    return { ok: false, reason: 'PROTOCOL_VERSION_MISMATCH' };
  }

  if (!isCommandEnvelope(parsed)) {
    return { ok: false, reason: 'MALFORMED_MESSAGE' };
  }

  if (!isAnyCommand(parsed)) {
    // Envelope is valid but type is unknown or payload is malformed
    const knownTypes = new Set(Object.values(CommandType) as string[]);
    return {
      ok: false,
      reason: knownTypes.has(parsed.type) ? 'MALFORMED_MESSAGE' : 'UNKNOWN_MESSAGE_TYPE',
    };
  }

  return { ok: true, command: parsed };
}

/**
 * Parse a raw WebSocket frame string and narrow to AnyEvent.
 *
 * Returns `{ ok: true, event }` on success.
 * Returns `{ ok: false }` on failure.
 *
 * Intended for use in the client's WebSocket `message` event handler.
 * The client silently ignores unknown events (forward-compatibility).
 */
export function parseEvent(
  raw: string,
): { ok: true; event: AnyEvent | ErrorEvent } | { ok: false } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false };
  }

  if (isErrorEvent(parsed)) return { ok: true, event: parsed };
  if (isAnyEvent(parsed))   return { ok: true, event: parsed };
  return { ok: false };
}

// ─────────────────────────────────────────────────────────────────────────────
// ErrorCode guard
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns true if the string is a known ErrorCode value.
 * Useful for validating error codes received from external sources.
 */
export function isErrorCode(v: unknown): v is ErrorCode {
  return isString(v) && v in ERROR_META;
}
