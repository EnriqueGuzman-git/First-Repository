/**
 * @file commandHandler.ts
 * @description Application-layer command handlers.
 *
 * Each handler receives a validated, typed command plus the server's shared
 * store instances, and returns a HandlerResult describing what events to send
 * to which connection.
 *
 * Architecture rules:
 *  - No WebSocket imports.
 *  - No direct send() calls — returns results that the transport layer acts on.
 *  - No business logic inside WebSocket message callbacks.
 *  - Idempotency is enforced here via SessionStore.getCachedResult.
 */

import type {
  RoomId, PlayerId, SessionToken, CommandId,
  PlayerSymbol, RoomStateSnapshot, GameId,
} from '../../shared/protocol/types.js';
import { MAX_PLAYER_NAME_LENGTH } from '../../shared/protocol/types.js';

import type {
  AuthCommand, JoinRoomCommand, LeaveRoomCommand, PlayerReadyCommand,
  MakeMoveCommand, RequestRematchCommand, AcceptRematchCommand,
  DeclineRematchCommand, PingCommand, ReconnectCommand, SyncRequestCommand,
} from '../../shared/protocol/commands.js';
import type { ErrorCode } from '../../shared/protocol/errors.js';
import { ERROR_META } from '../../shared/protocol/errors.js';

import type { SessionStore } from './sessionStore.js';
import type { RoomStore } from './roomStore.js';
import {
  roomStatus, playerCount, getSlotByPlayerId, getSymbolForPlayer, getOpponentSlot,
} from './roomStore.js';
import { GameSession } from './gameSession.js';
import type { SendFn, WireEvent } from './gameSession.js';
import type { HistoryRepository } from './historyRepository.js';
import {
  makeAuthAck, makePong, makeRoomJoined, makePlayerJoined,
  makeRoomLeft, makePlayerLeft, makePlayerReadyAck, makeOpponentReady,
  makeReconnectAck, makeStateSyncReplay, makeStateSyncSnapshot, makeErrorEvent,
} from '../utils/eventFactory.js';
import { logger } from '../utils/logger.js';
import type { Metrics } from '../utils/metrics.js';

// ─────────────────────────────────────────────────────────────────────────────
// Server context injected into every handler
// ─────────────────────────────────────────────────────────────────────────────

export type ServerContext = {
  sessions:     SessionStore;
  rooms:        RoomStore;
  /** gameSessions keyed by roomId */
  gameSessions: Map<RoomId, GameSession>;
  historyRepository: HistoryRepository;
  metrics:       Metrics;
  serverVersion: string;
};

// ─────────────────────────────────────────────────────────────────────────────
// Handler result
// ─────────────────────────────────────────────────────────────────────────────

export type Delivery = {
  target:   'connection' | 'broadcast' | 'others';
  /** connectionId for 'connection', playerId for 'broadcast'/'others' */
  id:       string;
  event:    Record<string, unknown>;
};

export type HandlerResult = {
  deliveries:  Delivery[];
  /** Non-null when the handler wants to close the connection after sending. */
  closeCode?:  number;
  closeReason?: string;
};

function ok(...deliveries: Delivery[]): HandlerResult {
  return { deliveries };
}

function sendToConn(connectionId: string, event: Record<string, unknown>): Delivery {
  return { target: 'connection', id: connectionId, event };
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared utilities
// ─────────────────────────────────────────────────────────────────────────────

function errorDelivery(
  connectionId: string,
  code: ErrorCode,
  correlationId?: CommandId,
  data?: Record<string, unknown>,
): Delivery {
  const meta  = ERROR_META[code];
  const event = makeErrorEvent(code, meta.summary, meta.recoverable, correlationId, data);
  return sendToConn(connectionId, event as unknown as Record<string, unknown>);
}

function sanitiseName(raw: string | null): string | null {
  if (raw === null) return null;
  return raw.trim().slice(0, MAX_PLAYER_NAME_LENGTH).replace(/[<>"'&]/g, '');
}

function buildRoomSnapshot(
  ctx: ServerContext,
  roomId: RoomId,
): RoomStateSnapshot {
  const room    = ctx.rooms.getRoom(roomId);
  const session = ctx.gameSessions.get(roomId);
  const state   = session?.state ?? null;

  const toInfo = (playerId: PlayerId, symbol: PlayerSymbol, name: string | null, connected: boolean, lastSeenAt: number) => ({
    playerId, symbol, name,
    connectionState: (connected ? 'CONNECTED' : 'DISCONNECTED') as 'CONNECTED' | 'DISCONNECTED',
    lastSeenAt,
  });

  return {
    roomId,
    status: room ? roomStatus(room) : 'OPEN',
    players: {
      X: room?.playerX ? toInfo(room.playerX.playerId, 'X', room.playerX.name, room.playerX.connected, room.playerX.lastSeenAt) : null,
      O: room?.playerO ? toInfo(room.playerO.playerId, 'O', room.playerO.name, room.playerO.connected, room.playerO.lastSeenAt) : null,
    },
    readyPlayers: room ? Array.from(room.readySymbols) : [],
    currentGame: state ? {
      gameId:      state.gameId as GameId,
      status:      state.status,
      board:       state.board,
      currentTurn: state.currentTurn,
      moveCount:   state.moveHistory.length,
      startedAt:   state.createdAt,
      result:      state.result,
    } : null,
    gameHistory: session?.history ?? [],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// AUTH
// ─────────────────────────────────────────────────────────────────────────────

export function handleAuth(
  connectionId: string,
  cmd: AuthCommand,
  ctx: ServerContext,
): HandlerResult {
  const correlationId = cmd.commandId;

  // Idempotency check
  const cached = ctx.sessions.getCachedResult(correlationId);
  if (cached) {
    return ok(sendToConn(connectionId, cached as Record<string, unknown>));
  }

  let session = cmd.guestToken ? ctx.sessions.getSession(cmd.guestToken as SessionToken) : null;

  if (cmd.guestToken && !session) {
    // Token provided but not found / expired
    const ev = makeErrorEvent('AUTH_FAILED', ERROR_META['AUTH_FAILED'].summary, true, correlationId);
    return ok(sendToConn(connectionId, ev as unknown as Record<string, unknown>));
  }

  if (!session) {
    session = ctx.sessions.createSession();
  }

  ctx.sessions.touch(session.sessionToken);

  // Check for existing room
  let existingRoom: import('../../shared/protocol/events.js').AuthAckEvent['existingRoom'] = null;
  if (session.roomId) {
    const room    = ctx.rooms.getRoom(session.roomId);
    const gs      = ctx.gameSessions.get(session.roomId);
    const symbol  = room ? getSymbolForPlayer(room, session.playerId) : null;
    if (room && symbol) {
      existingRoom = {
        roomId:     session.roomId,
        symbol,
        gameStatus: gs?.state?.status ?? 'WAITING',
      };
    } else {
      // Room gone — clear association
      ctx.sessions.setRoom(session.sessionToken, null);
    }
  }

  const ack = makeAuthAck(
    session.sessionToken, session.playerId,
    ctx.serverVersion, existingRoom, correlationId,
  );

  ctx.sessions.recordCommand(correlationId, ack);
  return ok(sendToConn(connectionId, ack as unknown as Record<string, unknown>));
}

// ─────────────────────────────────────────────────────────────────────────────
// JOIN_ROOM
// ─────────────────────────────────────────────────────────────────────────────

export function handleJoinRoom(
  connectionId: string,
  cmd: JoinRoomCommand,
  ctx: ServerContext,
  sessionToken: SessionToken,
): HandlerResult {
  const correlationId = cmd.commandId;

  const session = ctx.sessions.getSession(sessionToken);
  if (!session) return ok(errorDelivery(connectionId, 'NOT_AUTHENTICATED', correlationId));

  // Idempotency
  const cached = ctx.sessions.getCachedResult(correlationId);
  if (cached) return ok(sendToConn(connectionId, cached as Record<string, unknown>));

  // Already in a different room?
  if (session.roomId && session.roomId !== cmd.roomId) {
    return ok(errorDelivery(connectionId, 'ALREADY_IN_ROOM', correlationId));
  }

  const room = ctx.rooms.getRoom(cmd.roomId);
  if (!room) return ok(errorDelivery(connectionId, 'ROOM_NOT_FOUND', correlationId));

  // Already in this room (reconnect via JOIN rather than RECONNECT)
  const existingSlot = getSlotByPlayerId(room, session.playerId);
  if (existingSlot) {
    const snapshot  = buildRoomSnapshot(ctx, cmd.roomId);
    const seqPivot  = ctx.gameSessions.get(cmd.roomId)?.allocateSequence() ?? 1;
    const event     = makeRoomJoined(cmd.roomId, session.playerId, existingSlot.symbol, snapshot, seqPivot, correlationId);
    ctx.sessions.recordCommand(correlationId, event);
    return ok(sendToConn(connectionId, event as unknown as Record<string, unknown>));
  }

  if (playerCount(room) >= 2) {
    return ok(errorDelivery(connectionId, 'ROOM_FULL', correlationId));
  }

  const name   = sanitiseName(cmd.playerName);
  const symbol = ctx.rooms.addPlayer(room, session.playerId, name);
  if (!symbol) return ok(errorDelivery(connectionId, 'ROOM_FULL', correlationId));

  ctx.sessions.setRoom(sessionToken, cmd.roomId);
  ctx.rooms.touch(cmd.roomId);

  // Ensure a GameSession exists for this room
  if (!ctx.gameSessions.has(cmd.roomId)) {
    const sendFn = makeSendFn(ctx, cmd.roomId);
    ctx.gameSessions.set(cmd.roomId, new GameSession(cmd.roomId, sendFn, ctx.historyRepository));
  }

  const gameSession = ctx.gameSessions.get(cmd.roomId)!;
  const seqCounter = gameSession.allocateSequence();

  const snapshot = buildRoomSnapshot(ctx, cmd.roomId);
  const joinedEv = makeRoomJoined(cmd.roomId, session.playerId, symbol, snapshot, seqCounter, correlationId);
  ctx.sessions.recordCommand(correlationId, joinedEv);

  const deliveries: Delivery[] = [
    sendToConn(connectionId, joinedEv as unknown as Record<string, unknown>),
  ];

  // Notify existing player
  const countAfter = playerCount(room);
  if (countAfter > 1) {
    const otherSlot = symbol === 'X' ? room.playerO : room.playerX;
    if (otherSlot) {
      const gs   = ctx.gameSessions.get(cmd.roomId)!;
      const pjEv = makePlayerJoined(cmd.roomId, session.playerId, symbol, name, countAfter, gs.allocateSequence());
      deliveries.push({ target: 'broadcast', id: otherSlot.playerId, event: pjEv as unknown as Record<string, unknown> });
    }
  }

  logger.info('Player joined room', { roomId: cmd.roomId, playerId: session.playerId, symbol });
  return { deliveries };
}

// ─────────────────────────────────────────────────────────────────────────────
// LEAVE_ROOM
// ─────────────────────────────────────────────────────────────────────────────

export function handleLeaveRoom(
  connectionId: string,
  cmd: LeaveRoomCommand,
  ctx: ServerContext,
  sessionToken: SessionToken,
): HandlerResult {
  const correlationId = cmd.commandId;
  const session = ctx.sessions.getSession(sessionToken);
  if (!session) return ok(errorDelivery(connectionId, 'NOT_AUTHENTICATED', correlationId));

  const cached = ctx.sessions.getCachedResult(correlationId);
  if (cached) return ok(sendToConn(connectionId, cached as Record<string, unknown>));
  const room = ctx.rooms.getRoom(cmd.roomId);
  if (!room) return ok(errorDelivery(connectionId, 'ROOM_NOT_FOUND', correlationId));

  const slot   = getSlotByPlayerId(room, session.playerId);
  if (!slot)   return ok(errorDelivery(connectionId, 'NOT_IN_ROOM', correlationId));

  const gs     = ctx.gameSessions.get(cmd.roomId);
  const deliveries: Delivery[] = [];

  // If game is active, forfeit first
  if (gs?.state?.status === 'ACTIVE') {
    gs.handleForfeit(room, session.playerId);
    // GAME_FINISHED is broadcast via the sendFn callback — no extra delivery here
  }

  // ROOM_LEFT → leaving player
  const seqNow = gs?.allocateSequence() ?? 1;
  const leftEv = makeRoomLeft(cmd.roomId, seqNow, correlationId);
  deliveries.push(sendToConn(connectionId, leftEv as unknown as Record<string, unknown>));
  ctx.sessions.recordCommand(correlationId, leftEv);

  // PLAYER_LEFT → remaining players
  const reason = gs?.state?.status === 'FINISHED' && gs.state.result?.reason === 'PLAYER_FORFEITED'
    ? 'FORFEIT' as const
    : 'VOLUNTARY' as const;
  const plEv = makePlayerLeft(
    cmd.roomId,
    session.playerId,
    slot.symbol,
    reason,
    gs?.allocateSequence() ?? seqNow + 1,
  );
  const opponentSlot = getOpponentSlot(room, session.playerId);
  if (opponentSlot) {
    deliveries.push({
      target: 'broadcast',
      id: opponentSlot.playerId,
      event: plEv as unknown as Record<string, unknown>,
    });
  }

  ctx.rooms.removePlayer(room, session.playerId);
  ctx.sessions.setRoom(sessionToken, null);

  logger.info('Player left room', { roomId: cmd.roomId, playerId: session.playerId, reason });
  return { deliveries };
}

// ─────────────────────────────────────────────────────────────────────────────
// PLAYER_READY
// ─────────────────────────────────────────────────────────────────────────────

export function handlePlayerReady(
  connectionId: string,
  cmd: PlayerReadyCommand,
  ctx: ServerContext,
  sessionToken: SessionToken,
): HandlerResult {
  const correlationId = cmd.commandId;
  const session = ctx.sessions.getSession(sessionToken);
  if (!session) return ok(errorDelivery(connectionId, 'NOT_AUTHENTICATED', correlationId));

  const cached = ctx.sessions.getCachedResult(correlationId);
  if (cached) return ok(sendToConn(connectionId, cached as Record<string, unknown>));

  const room = ctx.rooms.getRoom(cmd.roomId);
  if (!room) return ok(errorDelivery(connectionId, 'ROOM_NOT_FOUND', correlationId));
  if (playerCount(room) < 2) return ok(errorDelivery(connectionId, 'NOT_IN_ROOM', correlationId));

  const symbol = getSymbolForPlayer(room, session.playerId);
  if (!symbol) return ok(errorDelivery(connectionId, 'NOT_IN_ROOM', correlationId));

  let gs = ctx.gameSessions.get(cmd.roomId);
  if (!gs) {
    const sendFn = makeSendFn(ctx, cmd.roomId);
    gs = new GameSession(cmd.roomId, sendFn, ctx.historyRepository);
    ctx.gameSessions.set(cmd.roomId, gs);
  }

  // Idempotency: already ready
  if (room.readySymbols.has(symbol)) {
    const ack = makePlayerReadyAck(cmd.roomId, Array.from(room.readySymbols), gs.currentSeq, correlationId);
    ctx.sessions.recordCommand(correlationId, ack);
    return ok(sendToConn(connectionId, ack as unknown as Record<string, unknown>));
  }

  ctx.rooms.markReady(room, symbol);
  const readyList = Array.from(room.readySymbols);

  const ack = makePlayerReadyAck(cmd.roomId, readyList, gs.allocateSequence(), correlationId);
  const deliveries: Delivery[] = [
    sendToConn(connectionId, ack as unknown as Record<string, unknown>),
  ];

  // Notify opponent
  const oppSlot = symbol === 'X' ? room.playerO : room.playerX;
  if (oppSlot) {
    const oppEv = makeOpponentReady(cmd.roomId, symbol, readyList, gs.allocateSequence());
    deliveries.push({ target: 'broadcast', id: oppSlot.playerId, event: oppEv as unknown as Record<string, unknown> });
  }

  // Auto-start when both ready
  if (ctx.rooms.bothReady(room)) {
    ctx.rooms.resetReady(room);
    // firstTurn: X for game 1; createRematch handles alternation for rematches
    const firstTurn: PlayerSymbol = gs.state?.firstTurn === 'X' ? 'O' : 'X';
    // For very first game, always start with X
    const ft: PlayerSymbol = gs.state ? firstTurn : 'X';
    gs.startGame(room, ft);
  }

  ctx.sessions.recordCommand(correlationId, ack);
  return { deliveries };
}

// ─────────────────────────────────────────────────────────────────────────────
// MAKE_MOVE
// ─────────────────────────────────────────────────────────────────────────────

export function handleMakeMove(
  connectionId: string,
  cmd: MakeMoveCommand,
  ctx: ServerContext,
  sessionToken: SessionToken,
): HandlerResult {
  const correlationId = cmd.commandId;
  const session = ctx.sessions.getSession(sessionToken);
  if (!session) return ok(errorDelivery(connectionId, 'NOT_AUTHENTICATED', correlationId));

  // Idempotency
  const cached = ctx.sessions.getCachedResult(correlationId);
  if (cached) return ok(sendToConn(connectionId, cached as Record<string, unknown>));

  const room = ctx.rooms.getRoom(cmd.roomId);
  if (!room) return ok(errorDelivery(connectionId, 'ROOM_NOT_FOUND', correlationId));

  const gs = ctx.gameSessions.get(cmd.roomId);
  if (!gs) return ok(errorDelivery(connectionId, 'GAME_NOT_ACTIVE', correlationId));

  // GameSession sends live events and returns the mover's exact response so a
  // retry can receive the same acknowledgement or rejection.
  const response = gs.handleMove(room, session.playerId, cmd.gameId, cmd.position, correlationId);
  if (response) ctx.sessions.recordCommand(correlationId, response);

  // The move result is delivered via sendFn callbacks in GameSession.
  // The HandlerResult here is empty — no additional deliveries from this level.
  return { deliveries: [] };
}

// ─────────────────────────────────────────────────────────────────────────────
// REMATCH
// ─────────────────────────────────────────────────────────────────────────────

export function handleRequestRematch(
  connectionId: string,
  cmd: RequestRematchCommand,
  ctx: ServerContext,
  sessionToken: SessionToken,
): HandlerResult {
  const correlationId = cmd.commandId;
  const session = ctx.sessions.getSession(sessionToken);
  if (!session) return ok(errorDelivery(connectionId, 'NOT_AUTHENTICATED', correlationId));

  if (ctx.sessions.getCachedResult(correlationId)) return { deliveries: [] };

  const room = ctx.rooms.getRoom(cmd.roomId);
  if (!room) return ok(errorDelivery(connectionId, 'ROOM_NOT_FOUND', correlationId));

  const gs = ctx.gameSessions.get(cmd.roomId);
  if (!gs) return ok(errorDelivery(connectionId, 'GAME_NOT_ACTIVE', correlationId));

  if (gs.rematchPending) return ok(errorDelivery(connectionId, 'REMATCH_PENDING', correlationId));

  if (gs.handleRematchRequest(room, session.playerId, cmd.gameId)) {
    ctx.sessions.recordCommand(correlationId, { processed: true });
  }
  return { deliveries: [] };
}

export function handleAcceptRematch(
  connectionId: string,
  cmd: AcceptRematchCommand,
  ctx: ServerContext,
  sessionToken: SessionToken,
): HandlerResult {
  const correlationId = cmd.commandId;
  const session = ctx.sessions.getSession(sessionToken);
  if (!session) return ok(errorDelivery(connectionId, 'NOT_AUTHENTICATED', correlationId));

  if (ctx.sessions.getCachedResult(correlationId)) return { deliveries: [] };

  const room = ctx.rooms.getRoom(cmd.roomId);
  if (!room) return ok(errorDelivery(connectionId, 'ROOM_NOT_FOUND', correlationId));

  const gs = ctx.gameSessions.get(cmd.roomId);
  if (!gs) return ok(errorDelivery(connectionId, 'GAME_NOT_ACTIVE', correlationId));
  if (!gs.rematchPending) return ok(errorDelivery(connectionId, 'REMATCH_NOT_REQUESTED', correlationId));

  if (gs.handleRematchAccept(room, session.playerId, cmd.gameId)) {
    ctx.sessions.recordCommand(correlationId, { processed: true });
  }
  return { deliveries: [] };
}

export function handleDeclineRematch(
  connectionId: string,
  cmd: DeclineRematchCommand,
  ctx: ServerContext,
  sessionToken: SessionToken,
): HandlerResult {
  const correlationId = cmd.commandId;
  const session = ctx.sessions.getSession(sessionToken);
  if (!session) return ok(errorDelivery(connectionId, 'NOT_AUTHENTICATED', correlationId));

  if (ctx.sessions.getCachedResult(correlationId)) return { deliveries: [] };

  const room = ctx.rooms.getRoom(cmd.roomId);
  if (!room) return ok(errorDelivery(connectionId, 'ROOM_NOT_FOUND', correlationId));

  const gs = ctx.gameSessions.get(cmd.roomId);
  if (!gs || !gs.rematchPending) return ok(errorDelivery(connectionId, 'REMATCH_NOT_REQUESTED', correlationId));

  if (gs.handleRematchDecline(room, session.playerId, cmd.gameId)) {
    ctx.sessions.recordCommand(correlationId, { processed: true });
  }
  return { deliveries: [] };
}

// ─────────────────────────────────────────────────────────────────────────────
// PING
// ─────────────────────────────────────────────────────────────────────────────

export function handlePing(
  connectionId: string,
  cmd: PingCommand,
): HandlerResult {
  const pong = makePong(cmd.clientTime, cmd.commandId);
  return ok(sendToConn(connectionId, pong as unknown as Record<string, unknown>));
}

// ─────────────────────────────────────────────────────────────────────────────
// RECONNECT
// ─────────────────────────────────────────────────────────────────────────────

export function handleReconnect(
  connectionId: string,
  cmd: ReconnectCommand,
  ctx: ServerContext,
  sessionToken: SessionToken,
): HandlerResult {
  const correlationId = cmd.commandId;
  const session = ctx.sessions.getSession(sessionToken);
  if (!session) return ok(errorDelivery(connectionId, 'NOT_AUTHENTICATED', correlationId));

  const cached = ctx.sessions.getCachedResult(correlationId);
  if (cached) return ok(sendToConn(connectionId, cached as Record<string, unknown>));

  const room = ctx.rooms.getRoom(cmd.roomId);
  if (!room) return ok(errorDelivery(connectionId, 'ROOM_NOT_FOUND', correlationId));

  const slot = getSlotByPlayerId(room, session.playerId);
  if (!slot) return ok(errorDelivery(connectionId, 'RECONNECT_INVALID', correlationId));

  const gs = ctx.gameSessions.get(cmd.roomId);

  // Re-mark as connected
  ctx.rooms.setConnected(room, session.playerId, true);
  ctx.sessions.setRoom(sessionToken, cmd.roomId);

  // Cancel reconnect window timer
  gs?.clearReconnectWindow(session.playerId);

  // Notify opponent
  gs?.notifyOpponentReconnected(room, session.playerId);

  const seqNow   = gs?.allocateSequence() ?? 1;
  const snapshot = buildRoomSnapshot(ctx, cmd.roomId);

  const ack = makeReconnectAck(cmd.roomId, session.playerId, slot.symbol, snapshot, seqNow, correlationId);
  const deliveries: Delivery[] = [
    sendToConn(connectionId, ack as unknown as Record<string, unknown>),
  ];
  ctx.sessions.recordCommand(correlationId, ack);

  // If client has missed events, send a SNAPSHOT sync
  if (cmd.lastReceivedSeq < seqNow) {
    const sync = makeStateSyncSnapshot(cmd.roomId, snapshot, seqNow);
    deliveries.push(sendToConn(connectionId, sync as unknown as Record<string, unknown>));
  }

  logger.info('Player reconnected', { roomId: cmd.roomId, playerId: session.playerId });
  return { deliveries };
}

// ─────────────────────────────────────────────────────────────────────────────
// SYNC_REQUEST
// ─────────────────────────────────────────────────────────────────────────────

export function handleSyncRequest(
  connectionId: string,
  cmd: SyncRequestCommand,
  ctx: ServerContext,
  sessionToken: SessionToken,
): HandlerResult {
  const correlationId = cmd.commandId;
  const session = ctx.sessions.getSession(sessionToken);
  if (!session) return ok(errorDelivery(connectionId, 'NOT_AUTHENTICATED', correlationId));

  const cached = ctx.sessions.getCachedResult(correlationId);
  if (cached) return ok(sendToConn(connectionId, cached as Record<string, unknown>));

  const room = ctx.rooms.getRoom(cmd.roomId);
  if (!room) return ok(errorDelivery(connectionId, 'ROOM_NOT_FOUND', correlationId));
  if (!getSlotByPlayerId(room, session.playerId)) {
    return ok(errorDelivery(connectionId, 'NOT_IN_ROOM', correlationId));
  }

  const sessionState = ctx.gameSessions.get(cmd.roomId);
  const replay = sessionState?.getReplayEvents(cmd.fromSeq) ?? null;
  if (replay !== null) {
    const sync = makeStateSyncReplay(
      cmd.roomId,
      cmd.fromSeq,
      sessionState?.currentSeq ?? cmd.fromSeq - 1,
      replay,
    );
    ctx.sessions.recordCommand(correlationId, sync);
    return ok(sendToConn(connectionId, sync as unknown as Record<string, unknown>));
  }

  const snapshot = buildRoomSnapshot(ctx, cmd.roomId);
  const sync = makeStateSyncSnapshot(
    cmd.roomId,
    snapshot,
    sessionState?.currentSeq ?? 0,
  );

  ctx.sessions.recordCommand(correlationId, sync);
  return ok(sendToConn(connectionId, sync as unknown as Record<string, unknown>));
}

// ─────────────────────────────────────────────────────────────────────────────
// Disconnect handler (not a protocol command — called by transport on close)
// ─────────────────────────────────────────────────────────────────────────────

export function handleDisconnect(
  sessionToken: SessionToken,
  ctx: ServerContext,
): void {
  const session = ctx.sessions.getSession(sessionToken);
  if (!session?.roomId) return;

  const room = ctx.rooms.getRoom(session.roomId);
  if (!room) return;

  ctx.rooms.setConnected(room, session.playerId, false);

  const gs = ctx.gameSessions.get(session.roomId);
  if (gs?.state?.status === 'ACTIVE') {
    gs.startReconnectWindow(room, session.playerId);
  }

  logger.info('Player disconnected', { roomId: session.roomId, playerId: session.playerId });
}

// ─────────────────────────────────────────────────────────────────────────────
// SendFn factory — wires GameSession back to the ConnectionManager
// This is populated at wiring time (see wsServer.ts) via the registry pattern.
// We use a late-binding registry so GameSession has no import of ConnectionManager.
// ─────────────────────────────────────────────────────────────────────────────

/** Registry: playerId → active connection IDs. */
export const playerConnectionRegistry = new Map<PlayerId, Set<string>>();

export function registerPlayerConnection(playerId: PlayerId, connectionId: string): void {
  const connections = playerConnectionRegistry.get(playerId) ?? new Set<string>();
  connections.add(connectionId);
  playerConnectionRegistry.set(playerId, connections);
}

export function unregisterPlayerConnection(playerId: PlayerId, connectionId: string): boolean {
  const connections = playerConnectionRegistry.get(playerId);
  if (!connections) return false;

  connections.delete(connectionId);
  if (connections.size === 0) playerConnectionRegistry.delete(playerId);
  return connections.size > 0;
}

export function getPlayerConnectionIds(playerId: PlayerId): ReadonlySet<string> {
  return playerConnectionRegistry.get(playerId) ?? new Set<string>();
}

function sendToPlayerConnections(playerId: PlayerId, event: WireEvent): void {
  for (const connectionId of playerConnectionRegistry.get(playerId) ?? []) {
    sendToConnectionId(connectionId, event);
  }
}

function makeSendFn(ctx: ServerContext, roomId: RoomId): SendFn {
  return (target, playerId, event) => {
    const room = ctx.rooms.getRoom(roomId);
    if (!room) return;

    if (target === 'player') {
      sendToPlayerConnections(playerId, event);
      return;
    }

    if (target === 'broadcast') {
      [room.playerX, room.playerO].forEach((slot) => {
        if (slot?.connected) {
          sendToPlayerConnections(slot.playerId, event);
        }
      });
      return;
    }

    if (target === 'others') {
      [room.playerX, room.playerO].forEach((slot) => {
        if (slot && slot.playerId !== playerId && slot.connected) {
          sendToPlayerConnections(slot.playerId, event);
        }
      });
    }
  };
}

/** Populated by ConnectionManager at startup. */
export let sendToConnectionId: (connectionId: string, event: Record<string, unknown>) => void =
  () => { /* no-op until wired */ };

export function wireSendToConnection(
  fn: (connectionId: string, event: Record<string, unknown>) => void,
): void {
  sendToConnectionId = fn;
}
