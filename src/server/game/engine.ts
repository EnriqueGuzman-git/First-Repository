/**
 * Deterministic, pure, immutable Tic-Tac-Toe game engine.
 * @see PROTOCOL.md for the full specification.
 */

import type {
  PlayerSymbol,
  CellValue,
  BoardIndex,
  BoardSnapshot,
  WinningLine,
  GameResult,
  MoveRecord,
  GameEndReason,
  MoveRejectionReason,
} from '../../shared/protocol/types.js';

import {
  EMPTY_BOARD,
  positionToIndex,
} from '../../shared/protocol/types.js';

/**
 * The complete, authoritative state of one Tic-Tac-Toe game.
 * Immutable once returned — every state transition produces a new object.
 */
export type GameState = {
  readonly gameId: string;
  readonly roomId: string;
  readonly playerX: string;
  readonly playerO: string;
  /** Flat 9-element board. Index = row * 3 + col. */
  readonly board: BoardSnapshot;
  readonly currentTurn: PlayerSymbol;
  readonly status: GameStatus;
  /** Non-null only when status === 'FINISHED'. */
  readonly result: GameResult | null;
  /** Ordered history of every accepted move, oldest first. */
  readonly moveHistory: readonly MoveRecord[];
  /** Which symbol moves first. X for game 1; alternates on rematch. */
  readonly firstTurn: PlayerSymbol;
  readonly createdAt: number;
  /** Epoch ms of the first accepted move, or null before any move. */
  readonly firstMoveAt: number | null;
  /** Epoch ms when the game finished, or null if still active. */
  readonly endedAt: number | null;
};

export type GameStatus = 'WAITING' | 'ACTIVE' | 'FINISHED';

/**
 * A command the engine can process. Only game-level actions; authentication
 * and networking concerns are stripped before this layer is reached.
 */
export type EngineCommand =
  | StartGameCommand
  | MakeMoveCommand
  | ForfeitCommand
  | AbandonCommand;

export type StartGameCommand = {
  readonly kind: 'START_GAME';
  readonly gameId: string;
  readonly roomId: string;
  readonly playerX: string;
  readonly playerO: string;
  /** Which symbol goes first. X for game 1; alternates on rematch. */
  readonly firstTurn: PlayerSymbol;
  readonly timestamp: number;
};

export type MakeMoveCommand = {
  readonly kind: 'MAKE_MOVE';
  readonly playerId: string;
  readonly row: number;
  readonly col: number;
  /** Caller-supplied idempotency key. */
  readonly commandId: string;
  readonly timestamp: number;
};

export type ForfeitCommand = {
  readonly kind: 'FORFEIT';
  readonly playerId: string;
  readonly timestamp: number;
};

export type AbandonCommand = {
  readonly kind: 'ABANDON';
  readonly playerId: string;
  readonly timestamp: number;
};

/**
 * Events emitted as a result of processing a command.
 * The session layer translates these into wire protocol events.
 */
export type EngineEvent =
  | GameStartedEngineEvent
  | MoveMadeEngineEvent
  | GameEndedEngineEvent;

export type GameStartedEngineEvent = {
  readonly kind: 'GAME_STARTED';
  readonly gameId: string;
  readonly roomId: string;
  readonly firstTurn: PlayerSymbol;
  readonly board: BoardSnapshot;
};

export type MoveMadeEngineEvent = {
  readonly kind: 'MOVE_MADE';
  readonly gameId: string;
  readonly symbol: PlayerSymbol;
  readonly row: BoardIndex;
  readonly col: BoardIndex;
  readonly sequenceInGame: number;
  readonly board: BoardSnapshot;
  readonly nextTurn: PlayerSymbol | null;
};

export type GameEndedEngineEvent = {
  readonly kind: 'GAME_ENDED';
  readonly gameId: string;
  readonly result: GameResult;
  readonly finalBoard: BoardSnapshot;
  readonly moveHistory: readonly MoveRecord[];
};

export type StartGameResult = {
  readonly newState: GameState;
  readonly events: readonly [GameStartedEngineEvent];
};

export type MakeMoveResult =
  | {
      readonly accepted: true;
      readonly newState: GameState;
      readonly events: readonly EngineEvent[];
      readonly rejectionReason: null;
    }
  | {
      readonly accepted: false;
      readonly newState: GameState; // unchanged
      readonly events: readonly [];
      readonly rejectionReason: MoveRejectionReason;
    };

export type ForfeitResult = {
  readonly newState: GameState;
  readonly events: readonly [GameEndedEngineEvent];
};

export type AbandonResult = {
  readonly newState: GameState;
  readonly events: readonly [GameEndedEngineEvent];
};

/**
 * All 8 possible winning lines on a 3×3 board.
 * Ordered: 3 rows, 3 columns, 2 diagonals.
 */
export const ALL_WINNING_LINES: readonly WinningLine[] = [
  // Rows
  { type: 'row', positions: [{ row: 0, col: 0 }, { row: 0, col: 1 }, { row: 0, col: 2 }] },
  { type: 'row', positions: [{ row: 1, col: 0 }, { row: 1, col: 1 }, { row: 1, col: 2 }] },
  { type: 'row', positions: [{ row: 2, col: 0 }, { row: 2, col: 1 }, { row: 2, col: 2 }] },
  // Columns
  { type: 'col', positions: [{ row: 0, col: 0 }, { row: 1, col: 0 }, { row: 2, col: 0 }] },
  { type: 'col', positions: [{ row: 0, col: 1 }, { row: 1, col: 1 }, { row: 2, col: 1 }] },
  { type: 'col', positions: [{ row: 0, col: 2 }, { row: 1, col: 2 }, { row: 2, col: 2 }] },
  // Diagonals
  { type: 'diagonal', positions: [{ row: 0, col: 0 }, { row: 1, col: 1 }, { row: 2, col: 2 }] },
  { type: 'diagonal', positions: [{ row: 0, col: 2 }, { row: 1, col: 1 }, { row: 2, col: 0 }] },
] as const;

/** Apply a single mark to a board snapshot; input is never mutated. */
export function applyMarkToBoard(
  board: BoardSnapshot,
  row: BoardIndex,
  col: BoardIndex,
  symbol: PlayerSymbol,
): BoardSnapshot {
  const next = [...board] as unknown as CellValue[];
  next[positionToIndex(row, col)] = symbol;
  return next as unknown as BoardSnapshot;
}

/**
 * Safe indexed read from a BoardSnapshot. A BoardIndex-derived index is always
 * in [0, 8], but noUncheckedIndexedAccess can't prove it, so the cast is
 * centralised here.
 */
function boardAt(board: BoardSnapshot, index: number): CellValue {
  return board[index] as CellValue;
}

/** Returns the matching WinningLine for the symbol, or null if no win. */
export function detectWin(
  board: BoardSnapshot,
  symbol: PlayerSymbol,
): WinningLine | null {
  for (const line of ALL_WINNING_LINES) {
    const [a, b, c] = line.positions;
    if (
      boardAt(board, positionToIndex(a.row, a.col)) === symbol &&
      boardAt(board, positionToIndex(b.row, b.col)) === symbol &&
      boardAt(board, positionToIndex(c.row, c.col)) === symbol
    ) {
      return line;
    }
  }
  return null;
}

/** True when all 9 cells are occupied. Call only after confirming no winner. */
export function isBoardFull(board: BoardSnapshot): boolean {
  return board.every((cell) => cell !== '');
}

export function opponent(symbol: PlayerSymbol): PlayerSymbol {
  return symbol === 'X' ? 'O' : 'X';
}

/** Validate raw row/col from a command before trusting them as BoardIndex. */
export function isValidPosition(row: number, col: number): row is BoardIndex {
  return (
    Number.isInteger(row) &&
    Number.isInteger(col) &&
    row >= 0 && row <= 2 &&
    col >= 0 && col <= 2
  );
}

/** Reconstruct a BoardSnapshot by replaying an ordered move history. */
export function boardFromHistory(history: readonly MoveRecord[]): BoardSnapshot {
  let board: BoardSnapshot = EMPTY_BOARD;
  for (const record of history) {
    board = applyMarkToBoard(
      board,
      record.position.row,
      record.position.col,
      record.symbol,
    );
  }
  return board;
}

/**
 * Create the initial GameState for a new game.
 *
 * State starts 'ACTIVE': both players are assumed ready before the engine is
 * called. The engine does not model the WAITING→ACTIVE transition — that
 * belongs to the room/session layer.
 */
export function startGame(command: StartGameCommand): StartGameResult {
  const state: GameState = {
    gameId:      command.gameId,
    roomId:      command.roomId,
    playerX:     command.playerX,
    playerO:     command.playerO,
    board:       EMPTY_BOARD,
    currentTurn: command.firstTurn,
    status:      'ACTIVE',
    result:      null,
    moveHistory: [],
    firstTurn:   command.firstTurn,
    createdAt:   command.timestamp,
    firstMoveAt: null,
    endedAt:     null,
  };

  const event: GameStartedEngineEvent = {
    kind:      'GAME_STARTED',
    gameId:    command.gameId,
    roomId:    command.roomId,
    firstTurn: command.firstTurn,
    board:     EMPTY_BOARD,
  };

  return { newState: state, events: [event] };
}

/**
 * Apply a move command to the current game state.
 *
 * Validation order (mirrors PROTOCOL.md §11.7):
 *  1. Game must be ACTIVE.
 *  2. playerId must belong to one of the two players.
 *  3. It must be the submitting player's turn.
 *  4. Position must be within bounds.
 *  5. Target cell must be empty.
 *
 * On success: returns the updated state and one or two events:
 *   [MOVE_MADE]               — move applied, game continues
 *   [MOVE_MADE, GAME_ENDED]   — move applied, game over (win or draw)
 *
 * On failure: returns the unchanged state, empty events array, and the
 * rejection reason. The caller is responsible for sending MOVE_REJECTED
 * to the client.
 */
export function applyMove(
  state: GameState,
  command: MakeMoveCommand,
): MakeMoveResult {
  if (state.status !== 'ACTIVE') {
    return reject(state, 'GAME_NOT_ACTIVE');
  }

  const movingSymbol = resolveSymbol(state, command.playerId);
  if (movingSymbol === null) {
    // Unknown player: fall back to GAME_NOT_ACTIVE. The session layer should
    // catch unknown players as UNAUTHORIZED before reaching the engine.
    return reject(state, 'GAME_NOT_ACTIVE');
  }

  if (movingSymbol !== state.currentTurn) {
    return reject(state, 'NOT_YOUR_TURN');
  }

  if (!isValidPosition(command.row, command.col)) {
    return reject(state, 'OUT_OF_BOUNDS');
  }

  const row = command.row as BoardIndex;
  const col = command.col as BoardIndex;

  if (boardAt(state.board, positionToIndex(row, col)) !== '') {
    return reject(state, 'CELL_OCCUPIED');
  }

  const newBoard = applyMarkToBoard(state.board, row, col, movingSymbol);

  const moveRecord: MoveRecord = {
    sequenceInGame: state.moveHistory.length + 1,
    symbol:         movingSymbol,
    position:       { row, col },
    appliedAt:      command.timestamp,
  };

  const newHistory = [...state.moveHistory, moveRecord];

  const winLine = detectWin(newBoard, movingSymbol);

  if (winLine !== null) {
    const result: GameResult = {
      outcome:     'WIN',
      winner:      movingSymbol,
      winningLine: winLine,
      reason:      'THREE_IN_A_ROW',
      endedAt:     command.timestamp,
    };

    const finishedState: GameState = {
      ...state,
      board:       newBoard,
      currentTurn: movingSymbol, // turn does not advance after game ends
      status:      'FINISHED',
      result,
      moveHistory: newHistory,
      firstMoveAt: state.firstMoveAt ?? command.timestamp,
      endedAt:     command.timestamp,
    };

    const moveEvent: MoveMadeEngineEvent = {
      kind:           'MOVE_MADE',
      gameId:         state.gameId,
      symbol:         movingSymbol,
      row,
      col,
      sequenceInGame: moveRecord.sequenceInGame,
      board:          newBoard,
      nextTurn:       null,
    };

    const endEvent: GameEndedEngineEvent = {
      kind:        'GAME_ENDED',
      gameId:      state.gameId,
      result,
      finalBoard:  newBoard,
      moveHistory: newHistory,
    };

    return {
      accepted:        true,
      newState:        finishedState,
      events:          [moveEvent, endEvent],
      rejectionReason: null,
    };
  }

  if (isBoardFull(newBoard)) {
    const result: GameResult = {
      outcome:     'DRAW',
      winner:      null,
      winningLine: null,
      reason:      'BOARD_FULL',
      endedAt:     command.timestamp,
    };

    const finishedState: GameState = {
      ...state,
      board:       newBoard,
      currentTurn: movingSymbol,
      status:      'FINISHED',
      result,
      moveHistory: newHistory,
      firstMoveAt: state.firstMoveAt ?? command.timestamp,
      endedAt:     command.timestamp,
    };

    const moveEvent: MoveMadeEngineEvent = {
      kind:           'MOVE_MADE',
      gameId:         state.gameId,
      symbol:         movingSymbol,
      row,
      col,
      sequenceInGame: moveRecord.sequenceInGame,
      board:          newBoard,
      nextTurn:       null,
    };

    const endEvent: GameEndedEngineEvent = {
      kind:        'GAME_ENDED',
      gameId:      state.gameId,
      result,
      finalBoard:  newBoard,
      moveHistory: newHistory,
    };

    return {
      accepted:        true,
      newState:        finishedState,
      events:          [moveEvent, endEvent],
      rejectionReason: null,
    };
  }

  const nextTurn = opponent(movingSymbol);

  const continuingState: GameState = {
    ...state,
    board:       newBoard,
    currentTurn: nextTurn,
    moveHistory: newHistory,
    firstMoveAt: state.firstMoveAt ?? command.timestamp,
  };

  const moveEvent: MoveMadeEngineEvent = {
    kind:           'MOVE_MADE',
    gameId:         state.gameId,
    symbol:         movingSymbol,
    row,
    col,
    sequenceInGame: moveRecord.sequenceInGame,
    board:          newBoard,
    nextTurn,
  };

  return {
    accepted:        true,
    newState:        continuingState,
    events:          [moveEvent],
    rejectionReason: null,
  };
}

/**
 * Forfeit: a player voluntarily surrenders during an active game.
 * The other player is declared the winner. Outcome: FORFEIT.
 */
export function forfeit(
  state: GameState,
  command: ForfeitCommand,
): ForfeitResult {
  const forfeitingSymbol = resolveSymbol(state, command.playerId);

  const winner: PlayerSymbol | null =
    forfeitingSymbol !== null ? opponent(forfeitingSymbol) : null;

  const result: GameResult = buildEndResult('FORFEIT', 'PLAYER_FORFEITED', winner, null, command.timestamp);
  const finishedState = buildFinishedState(state, result, command.timestamp);
  const endEvent = buildEndEvent(state.gameId, result, finishedState.board, finishedState.moveHistory);

  return { newState: finishedState, events: [endEvent] };
}

/**
 * Abandon: a player's reconnect window expired.
 * Same mechanical outcome as forfeit, different reason code.
 */
export function abandon(
  state: GameState,
  command: AbandonCommand,
): AbandonResult {
  const abandoningSymbol = resolveSymbol(state, command.playerId);

  const winner: PlayerSymbol | null =
    abandoningSymbol !== null ? opponent(abandoningSymbol) : null;

  const result: GameResult = buildEndResult('ABANDONED', 'PLAYER_ABANDONED', winner, null, command.timestamp);
  const finishedState = buildFinishedState(state, result, command.timestamp);
  const endEvent = buildEndEvent(state.gameId, result, finishedState.board, finishedState.moveHistory);

  return { newState: finishedState, events: [endEvent] };
}

/**
 * Create the initial state for a rematch from a finished game.
 *
 * Rules:
 *  - New gameId (provided by caller).
 *  - firstTurn is the OPPONENT of the previous game's firstTurn.
 *  - Board resets to empty.
 *  - Player assignments (X/O) stay the same.
 *
 * Returns the same shape as startGame so callers handle both identically.
 */
export function createRematch(
  previousState: GameState,
  newGameId: string,
  timestamp: number,
): StartGameResult {
  const newFirstTurn = opponent(previousState.firstTurn);

  return startGame({
    kind:       'START_GAME',
    gameId:     newGameId,
    roomId:     previousState.roomId,
    playerX:    previousState.playerX,
    playerO:    previousState.playerO,
    firstTurn:  newFirstTurn,
    timestamp,
  });
}

/**
 * Replay an ordered sequence of MakeMoveCommand values against a fresh game
 * state, returning the final state.
 *
 * This function is the determinism guarantee: the same sequence always
 * produces the same state regardless of when or where it is called.
 *
 * If any command in the sequence is rejected, replay stops and returns
 * the state at the point of failure along with the index and reason.
 */
export function replayMoves(
  initialState: GameState,
  commands: readonly MakeMoveCommand[],
): ReplayResult {
  let state = initialState;
  const allEvents: EngineEvent[] = [];

  for (let i = 0; i < commands.length; i++) {
    const cmd = commands[i];
    if (cmd === undefined) break;

    const result = applyMove(state, cmd);
    if (!result.accepted) {
      return {
        completed: false,
        finalState: state,
        failedAtIndex: i,
        failureReason: result.rejectionReason,
        events: allEvents,
      };
    }
    state = result.newState;
    allEvents.push(...result.events);
  }

  return { completed: true, finalState: state, events: allEvents };
}

export type ReplayResult =
  | {
      readonly completed: true;
      readonly finalState: GameState;
      readonly events: readonly EngineEvent[];
    }
  | {
      readonly completed: false;
      readonly finalState: GameState;
      readonly failedAtIndex: number;
      readonly failureReason: MoveRejectionReason;
      readonly events: readonly EngineEvent[];
    };

// Invariant verifiers: used in tests and optionally as runtime assertions in development.

export type InvariantViolation = {
  readonly invariant: string;
  readonly detail: string;
};

/**
 * Verify all engine invariants against a GameState.
 * Returns an array of violations; an empty array means the state is valid.
 */
export function verifyInvariants(state: GameState): InvariantViolation[] {
  const violations: InvariantViolation[] = [];

  const push = (invariant: string, detail: string) =>
    violations.push({ invariant, detail });

  // 1. No cell contains both players
  for (let i = 0; i < 9; i++) {
    const cell = boardAt(state.board, i);
    if (cell !== '' && cell !== 'X' && cell !== 'O') {
      push('NO_INVALID_CELL_VALUE', `Cell ${i} contains illegal value "${cell as string}"`);
    }
  }

  // 2. History length equals board mark count
  const markCount = state.board.filter((c) => c !== '').length;
  if (markCount !== state.moveHistory.length) {
    push(
      'HISTORY_LENGTH_MATCHES_BOARD',
      `Board has ${markCount} marks but history has ${state.moveHistory.length} entries`,
    );
  }

  // 3 + 9. History symbols alternate, sequenceInGame is 1-based and increasing
  for (let i = 0; i < state.moveHistory.length; i++) {
    const record = state.moveHistory[i];
    if (record === undefined) continue;

    // sequenceInGame monotone
    if (record.sequenceInGame !== i + 1) {
      push(
        'SEQUENCE_IN_GAME_MONOTONE',
        `Move at index ${i} has sequenceInGame=${record.sequenceInGame}, expected ${i + 1}`,
      );
    }

    // Turn alternation: move 0 must be firstTurn, move 1 must be opponent, etc.
    const expectedSymbol: PlayerSymbol = i % 2 === 0 ? state.firstTurn : opponent(state.firstTurn);
    if (record.symbol !== expectedSymbol) {
      push(
        'TURNS_ALTERNATE',
        `Move ${i + 1}: expected ${expectedSymbol} but got ${record.symbol}`,
      );
    }
  }

  // 4. currentTurn is correct
  if (state.status === 'ACTIVE') {
    const expectedTurn: PlayerSymbol =
      state.moveHistory.length % 2 === 0 ? state.firstTurn : opponent(state.firstTurn);
    if (state.currentTurn !== expectedTurn) {
      push(
        'CURRENT_TURN_CORRECT',
        `Expected currentTurn=${expectedTurn} after ${state.moveHistory.length} moves, got ${state.currentTurn}`,
      );
    }
  }

  // 5. Board derivable from history
  const derivedBoard = boardFromHistory(state.moveHistory);
  for (let i = 0; i < 9; i++) {
    if (boardAt(derivedBoard, i) !== boardAt(state.board, i)) {
      push(
        'BOARD_DERIVABLE_FROM_HISTORY',
        `Cell ${i}: board=${boardAt(state.board, i) || 'empty'} but history derives ${boardAt(derivedBoard, i) || 'empty'}`,
      );
    }
  }

  // 6–8 + 12–13. Result consistency
  if (state.status === 'FINISHED' && state.result !== null) {
    const { result } = state;

    // 6. WIN requires a winning line
    if (result.outcome === 'WIN' && result.winningLine === null) {
      push('WIN_HAS_WINNING_LINE', 'Game outcome is WIN but winningLine is null');
    }

    // 7. DRAW has no winner; FORFEIT and ABANDONED award the opponent.
    if (result.outcome === 'DRAW' && result.winner !== null) {
      push(
        'NON_WIN_HAS_NO_WINNER',
        `Game outcome is ${result.outcome} but winner is ${result.winner as string}`,
      );
    }

    if ((result.outcome === 'FORFEIT' || result.outcome === 'ABANDONED') && result.winner === null) {
      push('TERMINAL_FORFEIT_HAS_WINNER', `Game outcome is ${result.outcome} but winner is null`);
    }

    // 8. WIN requires a non-null winner
    if (result.outcome === 'WIN' && result.winner === null) {
      push('WIN_HAS_WINNER', 'Game outcome is WIN but winner is null');
    }

    // 12. DRAW requires a full board
    if (result.outcome === 'DRAW' && !isBoardFull(state.board)) {
      push('DRAW_REQUIRES_FULL_BOARD', 'Game outcome is DRAW but board is not full');
    }

    // 13. WIN: all cells in winningLine must match the winner
    if (result.outcome === 'WIN' && result.winningLine !== null && result.winner !== null) {
      for (const pos of result.winningLine.positions) {
        const cell = boardAt(state.board, positionToIndex(pos.row, pos.col));
        if (cell !== result.winner) {
          push(
            'WINNING_LINE_CELLS_MATCH_WINNER',
            `Cell (${pos.row},${pos.col}) on winning line is "${cell || 'empty'}", expected "${result.winner}"`,
          );
        }
      }
    }
  }

  // 10. firstMoveAt ↔ moveHistory empty
  if (state.moveHistory.length === 0 && state.firstMoveAt !== null) {
    push('FIRST_MOVE_AT_NULL_WHEN_NO_MOVES', 'firstMoveAt is non-null but there are no moves');
  }
  if (state.moveHistory.length > 0 && state.firstMoveAt === null) {
    push('FIRST_MOVE_AT_SET_WHEN_MOVES_EXIST', 'firstMoveAt is null but there are moves');
  }

  // 11. endedAt ↔ status FINISHED
  if (state.status === 'FINISHED' && state.endedAt === null) {
    push('ENDED_AT_SET_WHEN_FINISHED', 'status is FINISHED but endedAt is null');
  }
  if (state.status !== 'FINISHED' && state.endedAt !== null) {
    push('ENDED_AT_NULL_WHEN_NOT_FINISHED', 'endedAt is non-null but game is not FINISHED');
  }

  return violations;
}

function resolveSymbol(state: GameState, playerId: string): PlayerSymbol | null {
  if (playerId === state.playerX) return 'X';
  if (playerId === state.playerO) return 'O';
  return null;
}

function reject(
  state: GameState,
  reason: MoveRejectionReason,
): MakeMoveResult & { accepted: false } {
  return { accepted: false, newState: state, events: [], rejectionReason: reason };
}

function buildEndResult(
  outcome: GameResult['outcome'],
  reason: GameEndReason,
  winner: PlayerSymbol | null,
  winningLine: WinningLine | null,
  timestamp: number,
): GameResult {
  return { outcome, winner, winningLine, reason, endedAt: timestamp };
}

function buildFinishedState(
  state: GameState,
  result: GameResult,
  timestamp: number,
): GameState {
  return {
    ...state,
    status:  'FINISHED',
    result,
    endedAt: timestamp,
  };
}

function buildEndEvent(
  gameId: string,
  result: GameResult,
  finalBoard: BoardSnapshot,
  moveHistory: readonly MoveRecord[],
): GameEndedEngineEvent {
  return { kind: 'GAME_ENDED', gameId, result, finalBoard, moveHistory };
}
