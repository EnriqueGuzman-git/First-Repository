/**
 * @file eventFactory.ts
 * @description Pure functions that build wire-protocol event objects.
 *
 * Every function here is a plain data constructor — no I/O, no side effects.
 * The session layer calls these to translate engine events and room state
 * into the exact shapes the protocol specification requires.
 *
 * Layer contract:
 *  - Input:  engine events / room records / domain primitives
 *  - Output: fully-typed wire protocol event objects ready to serialise
 *
 * The sessionSeq counter is OWNED by GameSession; it is passed in as a
 * parameter so this file has no mutable state.
 */

import { randomUUID } from 'node:crypto';

import type {
  RoomId, GameId, PlayerId, SessionToken, CommandId, MessageId,
  PlayerSymbol, BoardSnapshot, MoveRejectionReason,
  PlayerInfo, RoomStateSnapshot, GameResult, MoveRecord, GameStats,
} from '../../shared/protocol/types.js';
import { PROTOCOL_VERSION, brand } from '../../shared/protocol/types.js';
import { EventType } from '../../shared/protocol/events.js';

import type {
  AuthAckEvent, PongEvent,
  RoomJoinedEvent, PlayerJoinedEvent, RoomLeftEvent, PlayerLeftEvent,
  PlayerReadyAckEvent, OpponentReadyEvent,
  GameStartedEvent,
  MoveAckEvent, MoveBroadcastEvent, MoveRejectedEvent,
  GameFinishedEvent,
  RematchRequestedEvent, RematchDeclinedEvent, RematchExpiredEvent,
  OpponentDisconnectedEvent, OpponentReconnectedEvent,
  ReconnectAckEvent,
  StateSyncReplayEvent, StateSyncSnapshotEvent,
} from '../../shared/protocol/events.js';
import type { AnyRoomEvent } from '../../shared/protocol/events.js';
import type { ErrorEvent } from '../../shared/protocol/errors.js';
import type { ErrorCode } from '../../shared/protocol/errors.js';

// ─────────────────────────────────────────────────────────────────────────────
// Envelope helpers
// ─────────────────────────────────────────────────────────────────────────────

function globalBase<T extends string>(type: T, correlationId?: CommandId) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    messageId: brand<MessageId>(randomUUID()),
    timestamp: Date.now(),
    type,
    ...(correlationId !== undefined ? { correlationId } : {}),
  } as const;
}

function roomBase<T extends string>(
  type: T,
  roomId: RoomId,
  sessionSeq: number,
  correlationId?: CommandId,
) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    messageId: brand<MessageId>(randomUUID()),
    timestamp: Date.now(),
    type,
    roomId,
    sessionSeq,
    ...(correlationId !== undefined ? { correlationId } : {}),
  } as const;
}

// ─────────────────────────────────────────────────────────────────────────────
// Global events (no sessionSeq / roomId)
// ─────────────────────────────────────────────────────────────────────────────

export function makeAuthAck(
  sessionToken: SessionToken,
  playerId: PlayerId,
  serverVersion: string,
  existingRoom: AuthAckEvent['existingRoom'],
  correlationId: CommandId,
): AuthAckEvent {
  return {
    ...globalBase(EventType.AUTH_ACK, correlationId),
    sessionToken,
    playerId,
    serverVersion,
    existingRoom,
  };
}

export function makePong(
  clientTime: number,
  correlationId: CommandId,
): PongEvent {
  return {
    ...globalBase(EventType.PONG, correlationId),
    clientTime,
    serverTime: Date.now(),
  };
}

export function makeErrorEvent(
  code: ErrorCode,
  detail: string,
  recoverable: boolean,
  correlationId?: CommandId,
  data?: Record<string, unknown>,
): ErrorEvent {
  return {
    ...globalBase(EventType.ERROR, correlationId),
    code,
    detail,
    recoverable,
    ...(data !== undefined ? { data } : {}),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Room lifecycle events
// ─────────────────────────────────────────────────────────────────────────────

export function makeRoomJoined(
  roomId: RoomId,
  playerId: PlayerId,
  symbol: PlayerSymbol,
  roomState: RoomStateSnapshot,
  sessionSeq: number,
  correlationId: CommandId,
): RoomJoinedEvent {
  return {
    ...roomBase(EventType.ROOM_JOINED, roomId, sessionSeq, correlationId),
    playerId,
    symbol,
    roomState,
  };
}

export function makePlayerJoined(
  roomId: RoomId,
  playerId: PlayerId,
  symbol: PlayerSymbol,
  playerName: string | null,
  connectedPlayerCount: number,
  sessionSeq: number,
): PlayerJoinedEvent {
  return {
    ...roomBase(EventType.PLAYER_JOINED, roomId, sessionSeq),
    playerId,
    symbol,
    playerName,
    connectedPlayerCount,
  };
}

export function makeRoomLeft(
  roomId: RoomId,
  sessionSeq: number,
  correlationId: CommandId,
): RoomLeftEvent {
  return { ...roomBase(EventType.ROOM_LEFT, roomId, sessionSeq, correlationId) };
}

export function makePlayerLeft(
  roomId: RoomId,
  playerId: PlayerId,
  symbol: PlayerSymbol,
  reason: PlayerLeftEvent['reason'],
  sessionSeq: number,
): PlayerLeftEvent {
  return {
    ...roomBase(EventType.PLAYER_LEFT, roomId, sessionSeq),
    playerId,
    symbol,
    reason,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Ready / game start events
// ─────────────────────────────────────────────────────────────────────────────

export function makePlayerReadyAck(
  roomId: RoomId,
  readyPlayers: ReadonlyArray<PlayerSymbol>,
  sessionSeq: number,
  correlationId: CommandId,
): PlayerReadyAckEvent {
  return {
    ...roomBase(EventType.PLAYER_READY_ACK, roomId, sessionSeq, correlationId),
    readyPlayers,
  };
}

export function makeOpponentReady(
  roomId: RoomId,
  symbol: PlayerSymbol,
  readyPlayers: ReadonlyArray<PlayerSymbol>,
  sessionSeq: number,
): OpponentReadyEvent {
  return {
    ...roomBase(EventType.OPPONENT_READY, roomId, sessionSeq),
    symbol,
    readyPlayers,
  };
}

export function makeGameStarted(
  roomId: RoomId,
  gameId: GameId,
  board: BoardSnapshot,
  firstTurn: PlayerSymbol,
  players: { X: PlayerInfo; O: PlayerInfo },
  startedAt: number,
  sessionSeq: number,
): GameStartedEvent {
  return {
    ...roomBase(EventType.GAME_STARTED, roomId, sessionSeq),
    gameId,
    board,
    firstTurn,
    players,
    startedAt,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Move events
// ─────────────────────────────────────────────────────────────────────────────

export function makeMoveAck(
  roomId: RoomId,
  gameId: GameId,
  position: { row: number; col: number },
  symbol: PlayerSymbol,
  sequenceInGame: number,
  board: BoardSnapshot,
  nextTurn: PlayerSymbol | null,
  sessionSeq: number,
  correlationId: CommandId,
): MoveAckEvent {
  return {
    ...roomBase(EventType.MOVE_ACK, roomId, sessionSeq, correlationId),
    gameId,
    position,
    symbol,
    sequenceInGame,
    board,
    nextTurn,
  };
}

export function makeMoveBroadcast(
  roomId: RoomId,
  gameId: GameId,
  position: { row: number; col: number },
  symbol: PlayerSymbol,
  playerId: PlayerId,
  sequenceInGame: number,
  board: BoardSnapshot,
  nextTurn: PlayerSymbol | null,
  sessionSeq: number,
): MoveBroadcastEvent {
  return {
    ...roomBase(EventType.MOVE_BROADCAST, roomId, sessionSeq),
    gameId,
    position,
    symbol,
    playerId,
    sequenceInGame,
    board,
    nextTurn,
  };
}

export function makeMoveRejected(
  roomId: RoomId,
  gameId: GameId,
  position: { row: number; col: number },
  reason: MoveRejectionReason,
  board: BoardSnapshot,
  currentTurn: PlayerSymbol,
  sessionSeq: number,
  correlationId: CommandId,
): MoveRejectedEvent {
  return {
    ...roomBase(EventType.MOVE_REJECTED, roomId, sessionSeq, correlationId),
    gameId,
    position,
    reason,
    board,
    currentTurn,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Game finished
// ─────────────────────────────────────────────────────────────────────────────

export function makeGameFinished(
  roomId: RoomId,
  gameId: GameId,
  result: GameResult,
  finalBoard: BoardSnapshot,
  moveHistory: ReadonlyArray<MoveRecord>,
  stats: GameStats,
  sessionSeq: number,
): GameFinishedEvent {
  return {
    ...roomBase(EventType.GAME_FINISHED, roomId, sessionSeq),
    gameId,
    result,
    finalBoard,
    moveHistory,
    stats,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Rematch events
// ─────────────────────────────────────────────────────────────────────────────

export function makeRematchRequested(
  roomId: RoomId,
  gameId: GameId,
  requestedBy: PlayerSymbol,
  expiresAt: number,
  sessionSeq: number,
): RematchRequestedEvent {
  return {
    ...roomBase(EventType.REMATCH_REQUESTED, roomId, sessionSeq),
    gameId,
    requestedBy,
    expiresAt,
  };
}

export function makeRematchDeclined(
  roomId: RoomId,
  gameId: GameId,
  declinedBy: PlayerSymbol,
  sessionSeq: number,
): RematchDeclinedEvent {
  return {
    ...roomBase(EventType.REMATCH_DECLINED, roomId, sessionSeq),
    gameId,
    declinedBy,
  };
}

export function makeRematchExpired(
  roomId: RoomId,
  gameId: GameId,
  sessionSeq: number,
): RematchExpiredEvent {
  return {
    ...roomBase(EventType.REMATCH_EXPIRED, roomId, sessionSeq),
    gameId,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Presence events
// ─────────────────────────────────────────────────────────────────────────────

export function makeOpponentDisconnected(
  roomId: RoomId,
  symbol: PlayerSymbol,
  reconnectDeadlineAt: number,
  sessionSeq: number,
): OpponentDisconnectedEvent {
  return {
    ...roomBase(EventType.OPPONENT_DISCONNECTED, roomId, sessionSeq),
    symbol,
    reconnectDeadlineAt,
  };
}

export function makeOpponentReconnected(
  roomId: RoomId,
  symbol: PlayerSymbol,
  sessionSeq: number,
): OpponentReconnectedEvent {
  return {
    ...roomBase(EventType.OPPONENT_RECONNECTED, roomId, sessionSeq),
    symbol,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Reconnect / sync
// ─────────────────────────────────────────────────────────────────────────────

export function makeReconnectAck(
  roomId: RoomId,
  playerId: PlayerId,
  symbol: PlayerSymbol,
  roomState: RoomStateSnapshot,
  sessionSeq: number,
  correlationId: CommandId,
): ReconnectAckEvent {
  return {
    ...roomBase(EventType.RECONNECT_ACK, roomId, sessionSeq, correlationId),
    playerId,
    symbol,
    roomState,
  };
}

export function makeStateSyncSnapshot(
  roomId: RoomId,
  roomState: RoomStateSnapshot,
  sessionSeq: number,
): StateSyncSnapshotEvent {
  return {
    ...roomBase(EventType.STATE_SYNC, roomId, sessionSeq),
    mode: 'SNAPSHOT',
    roomState,
  };
}

export function makeStateSyncReplay(
  roomId: RoomId,
  fromSeq: number,
  toSeq: number,
  events: ReadonlyArray<AnyRoomEvent>,
): StateSyncReplayEvent {
  return {
    ...roomBase(EventType.STATE_SYNC, roomId, toSeq),
    mode: 'REPLAY',
    fromSeq,
    toSeq,
    events,
  };
}
