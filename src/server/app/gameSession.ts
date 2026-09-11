/**
 * GameSession — the stateful owner of one Tic-Tac-Toe match: authoritative game
 * state, sequence counter, reconnect/rematch timers, and wire-event emission via
 * a send callback (the only coupling to the transport layer).
 */

import type {
  RoomId, GameId, PlayerId, PlayerSymbol,
  BoardSnapshot, GameResult, MoveRecord, GameStats, GameSummary, CommandId,
} from '../../shared/protocol/types.js';
import { RECONNECT_WINDOW_MS, REMATCH_TIMEOUT_MS } from '../../shared/protocol/types.js';
import type { PlayerInfo } from '../../shared/protocol/types.js';
import type { AnyRoomEvent } from '../../shared/protocol/events.js';
import { EVENT_BUFFER_SIZE } from '../../shared/protocol/types.js';

import type { GameState } from '../game/engine.js';
import {
  startGame, applyMove, forfeit, abandon, createRematch,
} from '../game/engine.js';

import {
  makeMoveAck, makeMoveBroadcast, makeMoveRejected,
  makeGameFinished, makeGameStarted,
  makeRematchRequested, makeRematchDeclined, makeRematchExpired,
  makeOpponentDisconnected, makeOpponentReconnected,
  makePlayerLeft,
  makeErrorEvent,
} from '../utils/eventFactory.js';
import { generateGameId } from '../utils/idGenerator.js';
import { logger } from '../utils/logger.js';
import type { RoomRecord, PlayerSlot } from './roomStore.js';
import { getSymbolForPlayer, getOpponentSlot } from './roomStore.js';
import type { CompletedGameRecord, HistoryRepository } from './historyRepository.js';

/** A serialisable wire event — any object ready to JSON.stringify. */
export type WireEvent = Record<string, unknown>;

/**
 * Callback through which GameSession delivers events to the transport layer.
 *
 * target:
 *   'player'    → send only to the specified playerId
 *   'broadcast' → send to all connected players in the room
 *   'others'    → send to everyone EXCEPT the specified playerId
 */
export type SendFn = (
  target: 'player' | 'broadcast' | 'others',
  playerId: PlayerId,
  event: WireEvent,
) => void;

/**
 * Called by GameSession when a player's reconnect window expires and their
 * slot should be freed at the room/session layer (which GameSession has no
 * direct reference to).
 */
export type OnPlayerLeftFn = (playerId: PlayerId) => void;

export type RematchProposal = {
  requestedBy: PlayerSymbol;
  requestedAt: number;
  expiresAt:   number;
  acceptedBy:  Set<PlayerSymbol>;
  timer:       ReturnType<typeof setTimeout>;
};

export class GameSession {
  private gameState:      GameState | null = null;
  private sessionSeq:     number = 0;
  private rematch:        RematchProposal | null = null;
  private readonly completedGames: CompletedGameRecord[];
  /**
   * Each entry stores the event together with its delivery metadata so that
   * getReplayEvents can return only the events a specific player would have
   * originally received (fixing the ROADMAP #1 / #2 recipient-scoping bug).
   *
   * target semantics (mirrors SendFn):
   *   'broadcast' → both players receive it
   *   'player'    → only anchorPlayerId receives it
   *   'others'    → everyone EXCEPT anchorPlayerId receives it
   */
  private readonly replayBuffer: Array<{
    event:           AnyRoomEvent;
    target:          'player' | 'broadcast' | 'others';
    anchorPlayerId:  PlayerId;
  }> = [];

  private reconnectTimers = new Map<PlayerId, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly roomId:   RoomId,
    private readonly send:     SendFn,
    private readonly historyRepository: HistoryRepository,
    private readonly onPlayerLeft?: OnPlayerLeftFn,
  ) {
    this.completedGames = [...historyRepository.loadCompletedGames(roomId)];
  }

  private nextSeq(): number { return ++this.sessionSeq; }

  private resetSeq(): void {
    this.sessionSeq = 0;
    this.replayBuffer.length = 0;
  }

  get currentSeq(): number { return this.sessionSeq; }

  allocateSequence(): number { return this.nextSeq(); }

  /**
   * Start a new game. Called by the room layer when both players are ready,
   * or when a rematch is accepted.
   */
  startGame(
    room: RoomRecord,
    firstTurn: PlayerSymbol,
  ): void {
    if (!room.playerX || !room.playerO) return;

    this.resetSeq();

    const gameId  = generateGameId();
    const now     = Date.now();

    const result  = startGame({
      kind:      'START_GAME',
      gameId,
      roomId:    this.roomId,
      playerX:   room.playerX.playerId,
      playerO:   room.playerO.playerId,
      firstTurn,
      timestamp: now,
    });

    this.gameState = result.newState;

    const players = this.buildPlayers(room);

    const event = makeGameStarted(
      this.roomId,
      gameId,
      result.newState.board,
      firstTurn,
      players,
      now,
      this.nextSeq(),
    );

    // Broadcast to all players — use playerX.playerId as the "from" anchor
    this.emit('broadcast', room.playerX.playerId, event as unknown as WireEvent);

    logger.info('Game started', { roomId: this.roomId, gameId, firstTurn });
  }

  /**
   * Process a MAKE_MOVE command; returns the mover's response event (ack or
   * rejection) for dedup caching, or null when nothing should be cached.
   */
  handleMove(
    room: RoomRecord,
    playerId: PlayerId,
    gameId: GameId,
    position: { row: number; col: number },
    commandId: CommandId,
  ): WireEvent | null {
    const state = this.gameState;
    if (!state) {
      this.sendError(room, playerId, 'GAME_NOT_ACTIVE', commandId);
      return null;
    }

    // Anti-replay: gameId must match the running game
    if (state.gameId !== gameId) {
      this.sendError(room, playerId, 'GAME_ID_MISMATCH', commandId);
      return null;
    }

    if (state.status !== 'ACTIVE') {
      this.sendError(room, playerId, 'GAME_NOT_ACTIVE', commandId);
      return null;
    }

    const result = applyMove(state, {
      kind:      'MAKE_MOVE',
      playerId,
      row:       position.row,
      col:       position.col,
      commandId,
      timestamp: Date.now(),
    });

    if (!result.accepted) {
      const rejEvent = makeMoveRejected(
        this.roomId, state.gameId as GameId,
        position,
        result.rejectionReason,
        state.board,
        state.currentTurn,
        this.nextSeq(),
        commandId,
      );
      this.emit('player', playerId, rejEvent as unknown as WireEvent);
      return rejEvent as unknown as WireEvent;
    }

    this.gameState = result.newState;

    const moveEv = result.events.find((e) => e.kind === 'MOVE_MADE');
    if (!moveEv || moveEv.kind !== 'MOVE_MADE') return null;

    const ackSeq = this.nextSeq();

    const ack = makeMoveAck(
      this.roomId, state.gameId as GameId,
      position, moveEv.symbol,
      moveEv.sequenceInGame, moveEv.board,
      moveEv.nextTurn, ackSeq, commandId,
    );
    this.emit('player', playerId, ack as unknown as WireEvent);

    const broadcast = makeMoveBroadcast(
      this.roomId, state.gameId as GameId,
      position, moveEv.symbol,
      playerId as PlayerId,
      moveEv.sequenceInGame, moveEv.board,
      moveEv.nextTurn, this.nextSeq(),
    );
    this.emit('others', playerId, broadcast as unknown as WireEvent);

    const endEv = result.events.find((e) => e.kind === 'GAME_ENDED');
    if (endEv && endEv.kind === 'GAME_ENDED') {
      this.emitGameFinished(room, endEv.result, endEv.finalBoard, endEv.moveHistory, playerId);
    }

    return ack as unknown as WireEvent;
  }

  handleForfeit(room: RoomRecord, playerId: PlayerId): void {
    if (!this.gameState || this.gameState.status !== 'ACTIVE') return;

    const result = forfeit(this.gameState, {
      kind: 'FORFEIT', playerId, timestamp: Date.now(),
    });
    this.gameState = result.newState;

    const endEv = result.events[0];
    this.emitGameFinished(room, endEv.result, endEv.finalBoard, endEv.moveHistory, playerId);
  }

  handleAbandon(room: RoomRecord, playerId: PlayerId): void {
    if (!this.gameState || this.gameState.status !== 'ACTIVE') return;

    const result = abandon(this.gameState, {
      kind: 'ABANDON', playerId, timestamp: Date.now(),
    });
    this.gameState = result.newState;

    const endEv = result.events[0];
    this.emitGameFinished(room, endEv.result, endEv.finalBoard, endEv.moveHistory, playerId);
  }

  private emitGameFinished(
    room: RoomRecord,
    result: GameResult,
    finalBoard: BoardSnapshot,
    moveHistory: ReadonlyArray<MoveRecord>,
    fromPlayerId: PlayerId,
  ): void {
    if (!this.gameState) return;

    const stats: GameStats = {
      moveCount:   moveHistory.length,
      durationMs:  this.gameState.endedAt && this.gameState.firstMoveAt
        ? this.gameState.endedAt - this.gameState.firstMoveAt
        : 0,
      firstMoveAt: this.gameState.firstMoveAt,
    };

    const event = makeGameFinished(
      this.roomId,
      this.gameState.gameId as GameId,
      result, finalBoard, moveHistory, stats,
      this.nextSeq(),
    );

    const completedGame: CompletedGameRecord = {
      gameId: this.gameState.gameId as GameId,
      outcome: result.outcome,
      winner: result.winner,
      moveCount: moveHistory.length,
      startedAt: this.gameState.createdAt,
      endedAt: result.endedAt,
      finalBoard,
      result,
      moveHistory: [...moveHistory],
    };
    if (!this.completedGames.some((game) => game.gameId === completedGame.gameId)) {
      this.completedGames.unshift(completedGame);
      this.historyRepository.saveCompletedGame(this.roomId, completedGame);
    }

    this.emit('broadcast', fromPlayerId, event as unknown as WireEvent);

    logger.info('Game finished', {
      roomId: this.roomId,
      gameId: this.gameState.gameId,
      outcome: result.outcome,
      winner: result.winner,
    });
  }

  handleRematchRequest(
    room: RoomRecord,
    playerId: PlayerId,
    gameId: GameId,
  ): boolean {
    const state = this.gameState;
    if (!state || state.status !== 'FINISHED' || state.gameId !== gameId) return false;
    if (this.rematch) return false;

    const symbol = getSymbolForPlayer(room, playerId);
    if (!symbol) return false;

    const expiresAt = Date.now() + REMATCH_TIMEOUT_MS;
    const timer     = setTimeout(() => this.expireRematch(room, gameId), REMATCH_TIMEOUT_MS);

    this.rematch = {
      requestedBy: symbol,
      requestedAt: Date.now(),
      expiresAt,
      acceptedBy:  new Set([symbol]),
      timer,
    };

    const event = makeRematchRequested(
      this.roomId, gameId, symbol, expiresAt, this.nextSeq(),
    );
    this.emit('broadcast', playerId, event as unknown as WireEvent);
    return true;
  }

  handleRematchAccept(
    room: RoomRecord,
    playerId: PlayerId,
    gameId: GameId,
  ): boolean {
    const state = this.gameState;
    if (!state || state.status !== 'FINISHED' || state.gameId !== gameId) return false;
    if (!this.rematch) return false;

    const symbol = getSymbolForPlayer(room, playerId);
    if (!symbol) return false;

    this.rematch.acceptedBy.add(symbol);

    if (this.rematch.acceptedBy.size === 2) {
      clearTimeout(this.rematch.timer);
      this.rematch = null;

      // createRematch swaps the first turn relative to the finished game.
      const rematchResult = createRematch(state, generateGameId(), Date.now());
      room.readySymbols   = new Set();
      this.startGame(room, rematchResult.newState.firstTurn);
    }
    return true;
  }

  handleRematchDecline(
    room: RoomRecord,
    playerId: PlayerId,
    gameId: GameId,
  ): boolean {
    if (!this.rematch) return false;
    const symbol = getSymbolForPlayer(room, playerId);
    if (!symbol) return false;

    clearTimeout(this.rematch.timer);
    this.rematch = null;

    const event = makeRematchDeclined(this.roomId, gameId, symbol, this.nextSeq());
    this.send('broadcast', playerId, event as unknown as WireEvent);
    return true;
  }

  private expireRematch(room: RoomRecord, gameId: GameId): void {
    if (!this.rematch) return;
    this.rematch = null;

    // Use any player as sender anchor — broadcast to all
    const anyPlayer = room.playerX?.playerId ?? room.playerO?.playerId;
    if (!anyPlayer) return;

    const event = makeRematchExpired(this.roomId, gameId, this.nextSeq());
    this.emit('broadcast', anyPlayer, event as unknown as WireEvent);
  }

  /**
   * Start the reconnect countdown for a disconnected player; the game is
   * abandoned if the window (RECONNECT_WINDOW_MS) expires.
   */
  startReconnectWindow(room: RoomRecord, playerId: PlayerId): void {
    this.clearReconnectWindow(playerId);

    const symbol   = getSymbolForPlayer(room, playerId);
    const opponent = getOpponentSlot(room, playerId);
    const deadline = Date.now() + RECONNECT_WINDOW_MS;

    if (symbol && opponent?.connected) {
      const event = makeOpponentDisconnected(
        this.roomId, symbol, deadline, this.nextSeq(),
      );
      this.emit('player', opponent.playerId, event as unknown as WireEvent);
    }

    const timer = setTimeout(() => {
      if (this.gameState?.status === 'ACTIVE') {
        this.handleAbandon(room, playerId);
      }

      // Emit PLAYER_LEFT with reason DISCONNECT_TIMEOUT and free the slot
      // at the room/session layer via the injected callback.
      if (symbol) {
        const leaveEvent = makePlayerLeft(
          this.roomId,
          playerId,
          symbol,
          'DISCONNECT_TIMEOUT',
          this.nextSeq(),
        );
        this.emit('broadcast', playerId, leaveEvent as unknown as WireEvent);
      }

      this.onPlayerLeft?.(playerId);
      this.reconnectTimers.delete(playerId);
    }, RECONNECT_WINDOW_MS);

    this.reconnectTimers.set(playerId, timer);
  }

  /** Cancel the reconnect window when the player successfully reconnects. */
  clearReconnectWindow(playerId: PlayerId): void {
    const timer = this.reconnectTimers.get(playerId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.reconnectTimers.delete(playerId);
    }
  }

  notifyOpponentReconnected(room: RoomRecord, playerId: PlayerId): void {
    const symbol   = getSymbolForPlayer(room, playerId);
    const opponent = getOpponentSlot(room, playerId);

    if (symbol && opponent?.connected) {
      const event = makeOpponentReconnected(this.roomId, symbol, this.nextSeq());
      this.emit('player', opponent.playerId, event as unknown as WireEvent);
    }
  }

  get state(): GameState | null { return this.gameState; }

  /**
   * Return the slice of buffered events that `requestingPlayerId` would have
   * originally received (i.e. recipient-scoped replay).
   *
   * Returns null when the buffer no longer covers `fromSeq` (caller should
   * fall back to a SNAPSHOT). Returns an empty array when fromSeq > currentSeq
   * (nothing to catch up on).
   *
   * Filtering rules (mirrors SendFn target semantics):
   *   'broadcast' → included for everyone
   *   'player P'  → included only when requestingPlayerId === P
   *   'others P'  → included only when requestingPlayerId !== P
   */
  getReplayEvents(fromSeq: number, requestingPlayerId: PlayerId): ReadonlyArray<AnyRoomEvent> | null {
    if (fromSeq > this.currentSeq) return [];

    const relevant = this.replayBuffer.filter((entry) => {
      if (entry.event.sessionSeq < fromSeq) return false;
      switch (entry.target) {
        case 'broadcast': return true;
        case 'player':    return entry.anchorPlayerId === requestingPlayerId;
        case 'others':    return entry.anchorPlayerId !== requestingPlayerId;
      }
    });

    // Verify the buffer still fully covers the requested range for this player.
    // We must check the oldest entry *scoped to this player* — not the global
    // oldest entry — because the buffer may contain events for the other player
    // with lower seq numbers that this player never received.
    // If the oldest scoped entry has a seq > fromSeq, the buffer has been
    // trimmed past the start of the requested range; signal SNAPSHOT fallback.
    const oldestScoped = relevant[0];
    if (!oldestScoped && fromSeq <= this.currentSeq) {
      // The player has no events in range (e.g. they received only MOVE_BROADCAST
      // but we're replaying from before any broadcast). Not a gap — just nothing
      // to replay for this player in this range.
      return [];
    }
    if (oldestScoped && oldestScoped.event.sessionSeq > fromSeq) {
      // Gap at the start of this player's scoped stream — buffer is exhausted.
      return null;
    }

    return relevant.map((e) => e.event);
  }

  get history(): ReadonlyArray<GameSummary> {
    return this.completedGames;
  }

  get completedGameRecords(): ReadonlyArray<CompletedGameRecord> {
    return this.completedGames;
  }

  get rematchPending(): boolean { return this.rematch !== null; }

  private emit(
    target: 'player' | 'broadcast' | 'others',
    playerId: PlayerId,
    event: WireEvent,
  ): void {
    if (typeof event['sessionSeq'] === 'number' && event['type'] !== 'ERROR') {
      this.replayBuffer.push({
        event:          event as unknown as AnyRoomEvent,
        target,
        anchorPlayerId: playerId,
      });
      if (this.replayBuffer.length > EVENT_BUFFER_SIZE) {
        this.replayBuffer.splice(0, this.replayBuffer.length - EVENT_BUFFER_SIZE);
      }
    }
    this.send(target, playerId, event);
  }

  private sendError(
    _room: RoomRecord,
    playerId: PlayerId,
    code: string,
    correlationId: CommandId,
  ): void {
    const event = makeErrorEvent(
      code as import('../../shared/protocol/errors.js').ErrorCode,
      code, true, correlationId,
    );
    this.emit('player', playerId, event as unknown as WireEvent);
  }

  private buildPlayers(room: RoomRecord): { X: PlayerInfo; O: PlayerInfo } {
    const now = Date.now();
    const toInfo = (slot: PlayerSlot): PlayerInfo => ({
      playerId:        slot.playerId,
      symbol:          slot.symbol,
      name:            slot.name,
      connectionState: slot.connected ? 'CONNECTED' : 'DISCONNECTED',
      lastSeenAt:      slot.lastSeenAt ?? now,
    });

    return {
      X: toInfo(room.playerX!),
      O: toInfo(room.playerO!),
    };
  }

  /** Tear down all timers. Call when a room is being destroyed. */
  destroy(): void {
    for (const timer of this.reconnectTimers.values()) clearTimeout(timer);
    this.reconnectTimers.clear();
    if (this.rematch) {
      clearTimeout(this.rematch.timer);
      this.rematch = null;
    }
  }
}
