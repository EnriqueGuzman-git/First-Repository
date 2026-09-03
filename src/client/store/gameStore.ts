/**
 * @file gameStore.ts
 * @description Centralised immutable client state machine.
 *
 * State model:
 *
 *   confirmed   — The last server-authoritative snapshot.
 *                 Only updated when a server event is applied.
 *
 *   optimistic  — Overlay produced by local pre-validation.
 *                 May diverge from confirmed for a brief window (RTT).
 *                 On MOVE_ACK: reconcile confirmed with ACK board.
 *                 On MOVE_REJECTED: discard optimistic, revert to confirmed.
 *
 *   pending     — The single in-flight MAKE_MOVE command (if any).
 *                 There is at most ONE pending move at a time.
 *                 A second click is blocked while one is in-flight.
 *
 * Architecture:
 *  - Plain reducer function: (state, action) → state.
 *  - No external framework — the store is plain TypeScript.
 *  - React hook wraps it with useState + useReducer.
 *  - All server events funnel through a single dispatch entry point.
 */

import type {
  BoardSnapshot,
  PlayerSymbol,
  GameResult,
  GameStatus,
  MoveRecord,
  PlayerInfo,
  RoomId,
  GameId,
  PlayerId,
  SessionToken,
  WinningLine,
} from '@ttt/shared/protocol';
import { EMPTY_BOARD } from '@ttt/shared/protocol';

import type { WsState } from '../lib/wsClient';
import { prevalidateMove } from '../lib/optimisticEngine';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type PendingMove = {
  readonly commandId: string;
  readonly row:       number;
  readonly col:       number;
  readonly sentAt:    number;
};

export type RematchState =
  | { status: 'NONE' }
  | { status: 'REQUESTED_BY_ME';   expiresAt: number }
  | { status: 'REQUESTED_BY_THEM'; expiresAt: number }
  | { status: 'DECLINED' }
  | { status: 'EXPIRED' };

/** All opponent connection events we want to surface in the UI. */
export type OpponentConnectionEvent =
  | { kind: 'DISCONNECTED'; reconnectDeadlineAt: number }
  | { kind: 'RECONNECTED' }
  | null;

export type GamePhase =
  | 'LOBBY'             // No room joined
  | 'WAITING_FOR_PLAYER'// In room, only one player
  | 'READY_CHECK'       // Both players connected, pre-game
  | 'ACTIVE'            // Game running
  | 'FINISHED'          // Game ended, showing results
  | 'RECONNECTING';     // WebSocket is reconnecting

export type LatencyMetrics = {
  /** Last measured RTT in ms. */
  lastRttMs:   number | null;
  /** Exponentially smoothed RTT. */
  smoothRttMs: number | null;
  /** Move sent → MOVE_ACK latency. */
  lastMoveAckMs: number | null;
};

export type ClientState = {
  // ── Identity ──
  sessionToken:   SessionToken | null;
  playerId:       PlayerId | null;
  mySymbol:       PlayerSymbol | null;

  // ── Room ──
  roomId:         RoomId | null;
  gameId:         GameId | null;
  players: {
    X: PlayerInfo | null;
    O: PlayerInfo | null;
  };
  readyPlayers:   ReadonlyArray<PlayerSymbol>;
  opponentConnection: OpponentConnectionEvent;

  // ── Confirmed game state (from server) ──
  confirmedBoard:  BoardSnapshot;
  confirmedTurn:   PlayerSymbol;
  gameStatus:      GameStatus;
  gameResult:      GameResult | null;
  moveHistory:     ReadonlyArray<MoveRecord>;
  winningLine:     WinningLine | null;

  // ── Optimistic overlay ──
  optimisticBoard: BoardSnapshot | null;  // null when no pending move
  pendingMove:     PendingMove | null;

  // ── UI phase ──
  phase:           GamePhase;
  wsState:         WsState;
  rematch:         RematchState;

  // ── Metrics ──
  latency:         LatencyMetrics;

  // ── Sequence tracking ──
  lastReceivedSeq: number;
};

// ─────────────────────────────────────────────────────────────────────────────
// Initial state
// ─────────────────────────────────────────────────────────────────────────────

export const INITIAL_STATE: ClientState = {
  sessionToken:        null,
  playerId:            null,
  mySymbol:            null,

  roomId:              null,
  gameId:              null,
  players:             { X: null, O: null },
  readyPlayers:        [],
  opponentConnection:  null,

  confirmedBoard:      EMPTY_BOARD,
  confirmedTurn:       'X',
  gameStatus:          'WAITING',
  gameResult:          null,
  moveHistory:         [],
  winningLine:         null,

  optimisticBoard:     null,
  pendingMove:         null,

  phase:               'LOBBY',
  wsState:             'IDLE',
  rematch:             { status: 'NONE' },

  latency: {
    lastRttMs:    null,
    smoothRttMs:  null,
    lastMoveAckMs: null,
  },

  lastReceivedSeq: 0,
};

// ─────────────────────────────────────────────────────────────────────────────
// Actions
// ─────────────────────────────────────────────────────────────────────────────

export type GameAction =
  // Transport
  | { type: 'WS_STATE_CHANGED';         wsState: WsState }
  | { type: 'LATENCY_MEASURED';         rttMs: number }

  // Auth
  | { type: 'AUTH_ACK';                 sessionToken: SessionToken; playerId: PlayerId;
      existingRoom: { roomId: RoomId; symbol: PlayerSymbol; gameStatus: GameStatus } | null }

  // Room
  | { type: 'ROOM_JOINED';              roomId: RoomId; symbol: PlayerSymbol;
      players: ClientState['players'];   readyPlayers: ReadonlyArray<PlayerSymbol>;
      confirmedBoard: BoardSnapshot; confirmedTurn: PlayerSymbol;
      gameStatus: GameStatus; gameId: GameId | null; gameResult: GameResult | null }
  | { type: 'PLAYER_JOINED';            symbol: PlayerSymbol; playerInfo: PlayerInfo }
  | { type: 'PLAYER_LEFT';              symbol: PlayerSymbol }
  | { type: 'PLAYER_READY_ACK';         readyPlayers: ReadonlyArray<PlayerSymbol> }
  | { type: 'OPPONENT_READY';           readyPlayers: ReadonlyArray<PlayerSymbol> }

  // Game lifecycle
  | { type: 'GAME_STARTED';             gameId: GameId; board: BoardSnapshot;
      firstTurn: PlayerSymbol; players: { X: PlayerInfo; O: PlayerInfo }; startedAt: number }

  // Optimistic move (local, pre-flight)
  | { type: 'MOVE_OPTIMISTIC';          commandId: string; row: number; col: number;
      predictedBoard: BoardSnapshot }

  // Server move responses
  | { type: 'MOVE_ACK';                 board: BoardSnapshot; nextTurn: PlayerSymbol | null;
      sequenceInGame: number; commandId: string }
  | { type: 'MOVE_BROADCAST';           board: BoardSnapshot; nextTurn: PlayerSymbol | null;
      symbol: PlayerSymbol; position: { row: number; col: number } }
  | { type: 'MOVE_REJECTED';            board: BoardSnapshot; currentTurn: PlayerSymbol;
      commandId: string }

  // Game end
  | { type: 'GAME_FINISHED';            result: GameResult; finalBoard: BoardSnapshot;
      moveHistory: ReadonlyArray<MoveRecord>; winningLine: WinningLine | null }

  // Rematch
  | { type: 'REMATCH_REQUESTED';        requestedBy: PlayerSymbol; expiresAt: number }
  | { type: 'REMATCH_DECLINED';         declinedBy: PlayerSymbol }
  | { type: 'REMATCH_EXPIRED' }

  // Presence
  | { type: 'OPPONENT_DISCONNECTED';    reconnectDeadlineAt: number }
  | { type: 'OPPONENT_RECONNECTED' }

  // Reconnect
  | { type: 'RECONNECT_ACK';            symbol: PlayerSymbol;
      confirmedBoard: BoardSnapshot; confirmedTurn: PlayerSymbol;
      gameStatus: GameStatus; gameId: GameId | null; gameResult: GameResult | null;
      players: ClientState['players']; readyPlayers: ReadonlyArray<PlayerSymbol>;
      sessionSeq: number }

  // Sequence
  | { type: 'SEQ_ADVANCED';            seq: number }

  // Local
  | { type: 'LEAVE_ROOM' }
  | { type: 'MOVE_ACK_LATENCY';        ackMs: number };

// ─────────────────────────────────────────────────────────────────────────────
// Reducer
// ─────────────────────────────────────────────────────────────────────────────

export function gameReducer(state: ClientState, action: GameAction): ClientState {
  switch (action.type) {

    // ── Transport ────────────────────────────────────────────────────────────
    case 'WS_STATE_CHANGED': {
      const phase: GamePhase =
        action.wsState === 'RECONNECTING' ? 'RECONNECTING'
        : state.phase === 'RECONNECTING'  ? derivePhase(state)
        : state.phase;
      return { ...state, wsState: action.wsState, phase };
    }

    case 'LATENCY_MEASURED': {
      const prev = state.latency.smoothRttMs;
      const smooth = prev === null
        ? action.rttMs
        : Math.round(prev * 0.8 + action.rttMs * 0.2);
      return {
        ...state,
        latency: { ...state.latency, lastRttMs: action.rttMs, smoothRttMs: smooth },
      };
    }

    // ── Auth ─────────────────────────────────────────────────────────────────
    case 'AUTH_ACK': {
      return {
        ...state,
        sessionToken: action.sessionToken,
        playerId:     action.playerId,
      };
    }

    // ── Room joined ───────────────────────────────────────────────────────────
    case 'ROOM_JOINED': {
      return {
        ...state,
        roomId:         action.roomId,
        mySymbol:       action.symbol,
        players:        action.players,
        readyPlayers:   action.readyPlayers,
        confirmedBoard: action.confirmedBoard,
        confirmedTurn:  action.confirmedTurn,
        gameStatus:     action.gameStatus,
        gameId:         action.gameId,
        gameResult:     action.gameResult,
        optimisticBoard: null,
        pendingMove:    null,
        phase:          action.players.X !== null && action.players.O !== null
                          ? 'READY_CHECK' : 'WAITING_FOR_PLAYER',
        rematch:        { status: 'NONE' },
      };
    }

    case 'PLAYER_JOINED': {
      const players = { ...state.players, [action.symbol]: action.playerInfo };
      const bothPresent = players.X !== null && players.O !== null;
      return {
        ...state,
        players,
        phase: bothPresent ? 'READY_CHECK' : 'WAITING_FOR_PLAYER',
      };
    }

    case 'PLAYER_LEFT': {
      const players = { ...state.players, [action.symbol]: null };
      return {
        ...state,
        players,
        readyPlayers: state.readyPlayers.filter((s) => s !== action.symbol),
        phase: 'WAITING_FOR_PLAYER',
      };
    }

    case 'PLAYER_READY_ACK':
    case 'OPPONENT_READY': {
      return { ...state, readyPlayers: action.readyPlayers };
    }

    // ── Game started ──────────────────────────────────────────────────────────
    case 'GAME_STARTED': {
      return {
        ...state,
        gameId:          action.gameId,
        confirmedBoard:  action.board,
        confirmedTurn:   action.firstTurn,
        gameStatus:      'ACTIVE',
        gameResult:      null,
        moveHistory:     [],
        winningLine:     null,
        optimisticBoard: null,
        pendingMove:     null,
        players:         action.players,
        phase:           'ACTIVE',
        rematch:         { status: 'NONE' },
        lastReceivedSeq: 1,
      };
    }

    // ── Optimistic move (before server response) ──────────────────────────────
    case 'MOVE_OPTIMISTIC': {
      // Only apply if there is no already-pending move
      if (state.pendingMove !== null) return state;
      return {
        ...state,
        optimisticBoard: action.predictedBoard,
        pendingMove: {
          commandId: action.commandId,
          row:       action.row,
          col:       action.col,
          sentAt:    Date.now(),
        },
      };
    }

    // ── Move ACK (server confirmed our move) ──────────────────────────────────
    case 'MOVE_ACK': {
      // Drop if this ack is for a stale pending move (idempotent retry)
      const ackMs =
        state.pendingMove?.sentAt !== undefined
          ? Date.now() - state.pendingMove.sentAt
          : null;
      const newTurn = action.nextTurn ?? state.confirmedTurn;
      return {
        ...state,
        confirmedBoard:  action.board,
        confirmedTurn:   newTurn,
        optimisticBoard: null,
        pendingMove:     null,
        latency: {
          ...state.latency,
          lastMoveAckMs: ackMs,
        },
      };
    }

    // ── Move broadcast (opponent moved) ───────────────────────────────────────
    case 'MOVE_BROADCAST': {
      const newTurn = action.nextTurn ?? state.confirmedTurn;
      return {
        ...state,
        confirmedBoard: action.board,
        confirmedTurn:  newTurn,
        // Clear any lingering optimistic state from the opponent's move
        optimisticBoard: state.pendingMove ? state.optimisticBoard : null,
      };
    }

    // ── Move rejected: roll back optimistic overlay ───────────────────────────
    case 'MOVE_REJECTED': {
      return {
        ...state,
        confirmedBoard:  action.board,
        confirmedTurn:   action.currentTurn,
        optimisticBoard: null,
        pendingMove:     null,
      };
    }

    // ── Game finished ─────────────────────────────────────────────────────────
    case 'GAME_FINISHED': {
      return {
        ...state,
        confirmedBoard:  action.finalBoard,
        gameStatus:      'FINISHED',
        gameResult:      action.result,
        moveHistory:     action.moveHistory,
        winningLine:     action.winningLine,
        optimisticBoard: null,
        pendingMove:     null,
        phase:           'FINISHED',
      };
    }

    // ── Rematch ───────────────────────────────────────────────────────────────
    case 'REMATCH_REQUESTED': {
      const isMe = action.requestedBy === state.mySymbol;
      return {
        ...state,
        rematch: isMe
          ? { status: 'REQUESTED_BY_ME',   expiresAt: action.expiresAt }
          : { status: 'REQUESTED_BY_THEM', expiresAt: action.expiresAt },
      };
    }
    case 'REMATCH_DECLINED':  return { ...state, rematch: { status: 'DECLINED' } };
    case 'REMATCH_EXPIRED':   return { ...state, rematch: { status: 'EXPIRED' } };

    // ── Presence ──────────────────────────────────────────────────────────────
    case 'OPPONENT_DISCONNECTED': {
      return {
        ...state,
        opponentConnection: {
          kind: 'DISCONNECTED',
          reconnectDeadlineAt: action.reconnectDeadlineAt,
        },
      };
    }
    case 'OPPONENT_RECONNECTED': {
      return { ...state, opponentConnection: { kind: 'RECONNECTED' } };
    }

    // ── Reconnect ACK ─────────────────────────────────────────────────────────
    case 'RECONNECT_ACK': {
      return {
        ...state,
        mySymbol:        action.symbol,
        players:         action.players,
        readyPlayers:    action.readyPlayers,
        confirmedBoard:  action.confirmedBoard,
        confirmedTurn:   action.confirmedTurn,
        gameStatus:      action.gameStatus,
        gameId:          action.gameId,
        gameResult:      action.gameResult,
        optimisticBoard: null,
        pendingMove:     null,
        lastReceivedSeq: action.sessionSeq,
        phase:           action.gameStatus === 'ACTIVE'   ? 'ACTIVE'
                       : action.gameStatus === 'FINISHED'  ? 'FINISHED'
                       : action.players.X && action.players.O ? 'READY_CHECK'
                       : 'WAITING_FOR_PLAYER',
      };
    }

    case 'SEQ_ADVANCED': {
      return { ...state, lastReceivedSeq: action.seq };
    }

    case 'MOVE_ACK_LATENCY': {
      return { ...state, latency: { ...state.latency, lastMoveAckMs: action.ackMs } };
    }

    case 'LEAVE_ROOM': {
      return {
        ...INITIAL_STATE,
        sessionToken: state.sessionToken,
        playerId:     state.playerId,
        wsState:      state.wsState,
        latency:      state.latency,
      };
    }

    default: {
      const _: never = action;
      return state;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function derivePhase(s: ClientState): GamePhase {
  if (!s.roomId) return 'LOBBY';
  if (s.gameStatus === 'ACTIVE')    return 'ACTIVE';
  if (s.gameStatus === 'FINISHED')  return 'FINISHED';
  if (s.players.X && s.players.O)   return 'READY_CHECK';
  return 'WAITING_FOR_PLAYER';
}

/**
 * Compute the board that should be displayed.
 * Shows the optimistic overlay while a move is in-flight,
 * falling back to the confirmed board.
 */
export function displayBoard(state: ClientState): BoardSnapshot {
  return state.optimisticBoard ?? state.confirmedBoard;
}

/**
 * True if the local player can click a cell right now.
 */
export function canMove(state: ClientState): boolean {
  return (
    state.gameStatus === 'ACTIVE' &&
    state.confirmedTurn === state.mySymbol &&
    state.pendingMove === null &&
    state.wsState === 'AUTHENTICATED' &&
    state.opponentConnection?.kind !== 'DISCONNECTED'
  );
}

/**
 * True when the optimistic overlay differs from the confirmed board.
 * Used to disable the board while waiting for server confirmation.
 */
export function hasPendingMove(state: ClientState): boolean {
  return state.pendingMove !== null;
}
