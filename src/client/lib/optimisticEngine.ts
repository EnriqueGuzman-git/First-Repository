/**
 * Client-side deterministic board ops for optimistic UI. The server remains the
 * sole authority; this only decides whether to show an optimistic update and
 * produces the predicted board — on rejection the confirmed board replaces it.
 *
 * Validation order intentionally mirrors the server engine so optimistic
 * pre-checks and server checks agree in the common case.
 */

import {
  positionToIndex,
  EMPTY_BOARD,
} from '@ttt/shared/protocol';

import type {
  BoardSnapshot,
  CellValue,
  BoardIndex,
  PlayerSymbol,
  WinningLine,
} from '@ttt/shared/protocol';

export type PrevalidateResult =
  | { valid: true;  predictedBoard: BoardSnapshot }
  | { valid: false; reason: 'NOT_YOUR_TURN' | 'CELL_OCCUPIED' | 'GAME_NOT_ACTIVE' | 'OUT_OF_BOUNDS' };

/** Locally validate a proposed move, returning the predicted board if valid. */
export function prevalidateMove(
  confirmedBoard:  BoardSnapshot,
  confirmedTurn:   PlayerSymbol,
  gameActive:      boolean,
  mySymbol:        PlayerSymbol,
  row:             number,
  col:             number,
): PrevalidateResult {
  if (!gameActive) {
    return { valid: false, reason: 'GAME_NOT_ACTIVE' };
  }

  if (confirmedTurn !== mySymbol) {
    return { valid: false, reason: 'NOT_YOUR_TURN' };
  }

  if (
    !Number.isInteger(row) || !Number.isInteger(col) ||
    row < 0 || row > 2 || col < 0 || col > 2
  ) {
    return { valid: false, reason: 'OUT_OF_BOUNDS' };
  }

  const idx = positionToIndex(row as BoardIndex, col as BoardIndex);
  if ((confirmedBoard[idx] as CellValue) !== '') {
    return { valid: false, reason: 'CELL_OCCUPIED' };
  }

  const next = [...confirmedBoard] as CellValue[];
  next[idx]  = mySymbol;
  return {
    valid:          true,
    predictedBoard: next as unknown as BoardSnapshot,
  };
}

/** Flat indices belonging to a winning line (for highlighting). */
export function winningIndices(line: WinningLine | null): ReadonlySet<number> {
  if (!line) return new Set();
  return new Set(
    line.positions.map((p) => positionToIndex(p.row, p.col)),
  );
}

/**
 * Flat indices "frozen" by a pending optimistic move: cells the optimistic
 * board marks but the confirmed board does not yet have (our move is in-flight).
 */
export function pendingCellIndices(
  confirmedBoard: BoardSnapshot,
  optimisticBoard: BoardSnapshot | null,
): ReadonlySet<number> {
  if (!optimisticBoard) return new Set();
  const pending = new Set<number>();
  for (let i = 0; i < 9; i++) {
    if ((confirmedBoard[i] as CellValue) === '' && (optimisticBoard[i] as CellValue) !== '') {
      pending.add(i);
    }
  }
  return pending;
}

export { EMPTY_BOARD };
