/**
 * @file gameSession.ts
 * @description GameSession — the stateful owner of one active Tic-Tac-Toe match.
 *
 * Responsibilities:
 *  - Own the authoritative GameState (delegated to the engine).
 *  - Maintain the per-session sessionSeq counter.
 *  - Process engine commands and translate engine events → wire events.
 *  - Manage the reconnect window timer for disconnected players.
 *  - Manage the rematch proposal state and expiry timer.
 *  - Emit wire events via a callback so the transport layer stays decoupled.
 *
 * Architecture rules:
 *  - No WebSocket or HTTP imports.
 *  - No database calls.
 *  - The send callback is the only coupling to the transport layer.
 */

import type {
  RoomId, GameId, PlayerId, PlayerSymbol,
  BoardSnapshot, GameResult, MoveRecord, GameStats, CommandId,
} from '../../shared/protocol/types.js';
import { RECONNECT_WINDOW_MS, REMATCH_TIMEOUT_MS } from '../../shared/protocol/types.js';
import type { PlayerInfo } from '../../shared/protocol/types.js';

import type { GameState } from '../game/engine.js';
import {
  startGame, applyMove, forfeit, abandon, createRematch,
} from '../game/engine.js';

import {
  makeMoveAck, makeMoveBroadcast, makeMoveRejected,
  makeGameFinished, makeGameStarted,
  makeRematchRequested, makeRematchDeclined, makeRematchExpired,
  makeOpponentDisconnected, makeOpponentReconnected,
  makeErrorEvent,
} from '../utils/eventFactory.js';
import { generateGameId } from '../utils/idGenerator.js';
import { logger } from '../utils/logger.js';
import type { RoomRecord, PlayerSlot } from './roomStore.js';
import { getSlotByPlayerId, getSymbolForPlayer, getOpponentSlot } from './roomStore.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

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

export type RematchProposal = {
  requestedBy: PlayerSymbol;
  requestedAt: number;
  expiresAt:   number;
  acceptedBy:  Set<PlayerSymbol>;
  timer:       ReturnType<typeof setTimeout>;
};

// ─────────────────────────────────────────────────────────────────────────────
// GameSession
// ─────────────────────────────────────────────────────────────────────────────

export class GameSession {
  private gameState:      GameState | null = null;
  private sessionSeq:     number = 0;
  private rematch:        RematchProposal | null = null;

  /** reconnect timers keyed by playerId */
  private reconnectTimers = new Map<PlayerId, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly roomId:   RoomId,
    private readonly send:     SendFn,
  ) {}

  // ── Sequence counter ──────────────────────────────────────────────────────

  private nextSeq(): number { return ++this.sessionSeq; }

  private resetSeq(): void { this.sessionSeq = 0; }

  get currentSeq(): number { return this.sessionSeq; }

  // ── Game lifecycle ────────────────────────────────────────────────────────

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
    this.send('broadcast', room.playerX.playerId, event as unknown as WireEvent);

    logger.info('Game started', { roomId: this.roomId, gameId, firstTurn });
  }

  // ── Move processing ───────────────────────────────────────────────────────

  /**
   * Process a MAKE_MOVE command from the wire layer.
   * Returns the gameId that was used, for deduplication caching.
   */
  handleMove(
    room: RoomRecord,
    playerId: PlayerId,
    gameId: GameId,
    position: { row: number; col: number },
    commandId: CommandId,
  ): void {
    const state = this.gameState;
    if (!state) {
      this.sendError(room, playerId, 'GAME_NOT_ACTIVE', commandId);
      return;
    }

    // Anti-replay: gameId must match the running game
    if (state.gameId !== gameId) {
      this.sendError(room, playerId, 'GAME_ID_MISMATCH', commandId);
      return;
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
      // Send MOVE_REJECTED only to the mover
      const rejEvent = makeMoveRejected(
        this.roomId, state.gameId as GameId,
        position,
        result.rejectionReason,
        state.board,
        state.currentTurn,
        this.nextSeq(),
        commandId,
      );
      this.send('player', playerId, rejEvent as unknown as WireEvent);
      return;
    }

    this.gameState = result.newState;

    // Find the MOVE_MADE engine event
    const moveEv = result.events.find((e) => e.kind === 'MOVE_MADE');
    if (!moveEv || moveEv.kind !== 'MOVE_MADE') return;

    const ackSeq = this.nextSeq();

    // MOVE_ACK → mover only
    const ack = makeMoveAck(
      this.roomId, state.gameId as GameId,
      position, moveEv.symbol,
      moveEv.sequenceInGame, moveEv.board,
      moveEv.nextTurn, ackSeq, commandId,
    );
    this.send('player', playerId, ack as unknown as WireEvent);

    // MOVE_BROADCAST → everyone else
    const broadcast = makeMoveBroadcast(
      this.roomId, state.gameId as GameId,
      position, moveEv.symbol,
      playerId as PlayerId,
      moveEv.sequenceInGame, moveEv.board,
      moveEv.nextTurn, this.nextSeq(),
    );
    this.send('others', playerId, broadcast as unknown as WireEvent);

    // Check for game end
    const endEv = result.events.find((e) => e.kind === 'GAME_ENDED');
    if (endEv && endEv.kind === 'GAME_ENDED') {
      this.emitGameFinished(room, endEv.result, endEv.finalBoard, endEv.moveHistory, playerId);
    }
  }

  // ── Forfeit / abandon ─────────────────────────────────────────────────────

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

    this.send('broadcast', fromPlayerId, event as unknown as WireEvent);

    logger.info('Game finished', {
      roomId: this.roomId,
      gameId: this.gameState.gameId,
      outcome: result.outcome,
      winner: result.winner,
    });
  }

  // ── Rematch ───────────────────────────────────────────────────────────────

  handleRematchRequest(
    room: RoomRecord,
    playerId: PlayerId,
    gameId: GameId,
  ): boolean {
    const state = this.gameState;
    if (!state || state.status !== 'FINISHED' || state.gameId !== gameId) return false;
    if (this.rematch) return false; // already pending

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
    this.send('broadcast', playerId, event as unknown as WireEvent);
    return true;
  }

  handleRematchAccept(
    room: RoomRecord,
    playerId: PlayerId,
    gameId: GameId,
    firstTurnOverride?: PlayerSymbol,
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

      // Rematch: create new game with swapped first turn
      const rematchResult = createRematch(state, generateGameId(), Date.now());
      const newFirstTurn  = firstTurnOverride ?? rematchResult.newState.firstTurn;
      room.readySymbols   = new Set(); // reset ready state
      this.startGame(room, newFirstTurn);
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
    this.send('broadcast', anyPlayer, event as unknown as WireEvent);
  }

  // ── Reconnection window ───────────────────────────────────────────────────

  /**
   * Start the 5-minute reconnect countdown for a disconnected player.
   * If the window expires, the game is abandoned.
   */
  startReconnectWindow(room: RoomRecord, playerId: PlayerId): void {
    // Clear any existing timer first
    this.clearReconnectWindow(playerId);

    const symbol   = getSymbolForPlayer(room, playerId);
    const opponent = getOpponentSlot(room, playerId);
    const deadline = Date.now() + RECONNECT_WINDOW_MS;

    // Notify the remaining player
    if (symbol && opponent?.connected) {
      const event = makeOpponentDisconnected(
        this.roomId, symbol, deadline, this.nextSeq(),
      );
      this.send('player', opponent.playerId, event as unknown as WireEvent);
    }

    const timer = setTimeout(() => {
      // Window expired — abandon if game still active
      if (this.gameState?.status === 'ACTIVE') {
        this.handleAbandon(room, playerId);
      }
      this.reconnectTimers.delete(playerId);
    }, RECONNECT_WINDOW_MS);

    this.reconnectTimers.set(playerId, timer);
  }

  /**
   * Cancel the reconnect window. Called when the player successfully reconnects.
   */
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
      this.send('player', opponent.playerId, event as unknown as WireEvent);
    }
  }

  // ── Accessors ─────────────────────────────────────────────────────────────

  get state(): GameState | null { return this.gameState; }

  get activeGameId(): GameId | null {
    return this.gameState ? this.gameState.gameId as GameId : null;
  }

  get rematchPending(): boolean { return this.rematch !== null; }

  // ── Helpers ───────────────────────────────────────────────────────────────

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
    this.send('player', playerId, event as unknown as WireEvent);
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
