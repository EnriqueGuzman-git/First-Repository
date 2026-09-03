/**
 * @file commandBuilder.ts
 * @description Pure functions that construct typed, envelope-wrapped wire
 * commands ready to JSON.stringify and send.
 *
 * Rules:
 *  - Every function is pure. No I/O, no side-effects.
 *  - commandId is the IDEMPOTENCY KEY — callers supply it.
 *    For new commands, generate with crypto.randomUUID().
 *    For retries, reuse the same commandId.
 *  - messageId is always fresh (new UUID per call).
 *  - Returns plain objects that are assignable to the matching command type.
 */

import { PROTOCOL_VERSION, brand } from '@ttt/shared/protocol';
import type {
  SessionToken, RoomId, GameId, CommandId, MessageId,
  AuthCommand, JoinRoomCommand, LeaveRoomCommand, PlayerReadyCommand,
  MakeMoveCommand, RequestRematchCommand, AcceptRematchCommand,
  DeclineRematchCommand, PingCommand, ReconnectCommand, SyncRequestCommand,
} from '@ttt/shared/protocol';

// ─────────────────────────────────────────────────────────────────────────────
// Envelope factory
// ─────────────────────────────────────────────────────────────────────────────

function envelope(
  type:         string,
  commandId:    CommandId,
  sessionToken: SessionToken | null,
) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    messageId:       brand<MessageId>(crypto.randomUUID()),
    timestamp:       Date.now(),
    type,
    commandId,
    sessionToken,
  } as const;
}

// ─────────────────────────────────────────────────────────────────────────────
// AUTH
// ─────────────────────────────────────────────────────────────────────────────

export function buildAuth(
  commandId:     CommandId,
  guestToken:    SessionToken | null,
  clientVersion: string,
): AuthCommand {
  return {
    ...envelope('AUTH', commandId, null),
    sessionToken:  null,
    guestToken,
    clientVersion,
  } as AuthCommand;
}

// ─────────────────────────────────────────────────────────────────────────────
// JOIN_ROOM
// ─────────────────────────────────────────────────────────────────────────────

export function buildJoinRoom(
  commandId:    CommandId,
  sessionToken: SessionToken,
  roomId:       RoomId,
  playerName:   string | null,
): JoinRoomCommand {
  return {
    ...envelope('JOIN_ROOM', commandId, sessionToken),
    roomId,
    playerName,
  } as JoinRoomCommand;
}

// ─────────────────────────────────────────────────────────────────────────────
// LEAVE_ROOM
// ─────────────────────────────────────────────────────────────────────────────

export function buildLeaveRoom(
  commandId:    CommandId,
  sessionToken: SessionToken,
  roomId:       RoomId,
  reason:       'VOLUNTARY' | 'CLOSING_TAB',
): LeaveRoomCommand {
  return {
    ...envelope('LEAVE_ROOM', commandId, sessionToken),
    roomId,
    reason,
  } as LeaveRoomCommand;
}

// ─────────────────────────────────────────────────────────────────────────────
// PLAYER_READY
// ─────────────────────────────────────────────────────────────────────────────

export function buildPlayerReady(
  commandId:    CommandId,
  sessionToken: SessionToken,
  roomId:       RoomId,
): PlayerReadyCommand {
  return {
    ...envelope('PLAYER_READY', commandId, sessionToken),
    roomId,
  } as PlayerReadyCommand;
}

// ─────────────────────────────────────────────────────────────────────────────
// MAKE_MOVE
// ─────────────────────────────────────────────────────────────────────────────

export function buildMakeMove(
  commandId:    CommandId,
  sessionToken: SessionToken,
  roomId:       RoomId,
  gameId:       GameId,
  row:          number,
  col:          number,
): MakeMoveCommand {
  return {
    ...envelope('MAKE_MOVE', commandId, sessionToken),
    roomId,
    gameId,
    position: { row, col },
  } as MakeMoveCommand;
}

// ─────────────────────────────────────────────────────────────────────────────
// REMATCH
// ─────────────────────────────────────────────────────────────────────────────

export function buildRequestRematch(
  commandId:    CommandId,
  sessionToken: SessionToken,
  roomId:       RoomId,
  gameId:       GameId,
): RequestRematchCommand {
  return {
    ...envelope('REQUEST_REMATCH', commandId, sessionToken),
    roomId,
    gameId,
  } as RequestRematchCommand;
}

export function buildAcceptRematch(
  commandId:    CommandId,
  sessionToken: SessionToken,
  roomId:       RoomId,
  gameId:       GameId,
): AcceptRematchCommand {
  return {
    ...envelope('ACCEPT_REMATCH', commandId, sessionToken),
    roomId,
    gameId,
  } as AcceptRematchCommand;
}

export function buildDeclineRematch(
  commandId:    CommandId,
  sessionToken: SessionToken,
  roomId:       RoomId,
  gameId:       GameId,
): DeclineRematchCommand {
  return {
    ...envelope('DECLINE_REMATCH', commandId, sessionToken),
    roomId,
    gameId,
  } as DeclineRematchCommand;
}

// ─────────────────────────────────────────────────────────────────────────────
// PING
// ─────────────────────────────────────────────────────────────────────────────

export function buildPing(
  commandId:    CommandId,
  sessionToken: SessionToken,
): PingCommand {
  const clientTime = Date.now();
  return {
    ...envelope('PING', commandId, sessionToken),
    clientTime,
  } as PingCommand;
}

// ─────────────────────────────────────────────────────────────────────────────
// RECONNECT
// ─────────────────────────────────────────────────────────────────────────────

export function buildReconnect(
  commandId:        CommandId,
  sessionToken:     SessionToken,
  roomId:           RoomId,
  lastReceivedSeq:  number,
): ReconnectCommand {
  return {
    ...envelope('RECONNECT', commandId, sessionToken),
    roomId,
    lastReceivedSeq,
  } as ReconnectCommand;
}

// ─────────────────────────────────────────────────────────────────────────────
// SYNC_REQUEST
// ─────────────────────────────────────────────────────────────────────────────

export function buildSyncRequest(
  commandId:    CommandId,
  sessionToken: SessionToken,
  roomId:       RoomId,
  fromSeq:      number,
): SyncRequestCommand {
  return {
    ...envelope('SYNC_REQUEST', commandId, sessionToken),
    roomId,
    fromSeq,
  } as SyncRequestCommand;
}

// ─────────────────────────────────────────────────────────────────────────────
// Utility: generate a fresh commandId
// ─────────────────────────────────────────────────────────────────────────────

export function newCommandId(): CommandId {
  return brand<CommandId>(crypto.randomUUID());
}
