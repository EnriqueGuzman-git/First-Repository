/**
 * Pure builders for typed, envelope-wrapped wire commands.
 *
 * commandId is the idempotency key and is caller-supplied: fresh per new
 * command, reused across retries. messageId is always a fresh UUID per call.
 */

import { PROTOCOL_VERSION, brand } from '@ttt/shared/protocol';
import type {
  SessionToken, RoomId, GameId, CommandId, MessageId,
  JoinRoomCommand, LeaveRoomCommand, PlayerReadyCommand,
  MakeMoveCommand, RequestRematchCommand, AcceptRematchCommand,
  DeclineRematchCommand, ReconnectCommand, SyncRequestCommand,
} from '@ttt/shared/protocol';

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

export function newCommandId(): CommandId {
  return brand<CommandId>(crypto.randomUUID());
}
