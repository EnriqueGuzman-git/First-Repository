/**
 * @file optimisticEngine.ts
 * @description Client-side deterministic board operations for optimistic UI.
 *
 * The server is the sole authority on game correctness. This module exists
 * to answer ONE question instantly — before the round-trip completes:
 *
 *   "Is this move locally plausible, and what would the board look like?"
 *
 * It is NOT a substitute for server validation. It is used only to:
 *  1. Decide whether to show an optimistic UI update at all.
 *  2. Produce the predicted board so the user sees their mark immediately.
 *
 * If the server later rejects the move, the confirmed board replaces the
 * optimistic board. The user will never see an incorrect final state.
 *
 * Implementation intentionally mirrors the server engine validation order
 * so that optimistic pre-checks and server checks agree in the common case.
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

// ─────────────────────────────────────────────────────────────────────────────
// Pre-validation result
// ─────────────────────────────────────────────────────────────────────────────

export type PrevalidateResult =
  | { valid: true;  predictedBoard: BoardSnapshot }
  | { valid: false; reason: 'NOT_YOUR_TURN' | 'CELL_OCCUPIED' | 'GAME_NOT_ACTIVE' | 'OUT_OF_BOUNDS' };

/**
 * Locally validate a proposed move and return the predicted board if valid.
 *
 * Parameters mirror the server's applyMove guard order:
 *  1. Game must be active.
 *  2. It must be the player's turn.
 *  3. Position must be in bounds.
 *  4. Cell must be empty.
 */
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

  // Produce predicted board
  const next = [...confirmedBoard] as CellValue[];
  next[idx]  = mySymbol;
  return {
    valid:          true,
    predictedBoard: next as unknown as BoardSnapshot,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Winning line detection (mirrors server ALL_WINNING_LINES)
// ─────────────────────────────────────────────────────────────────────────────

const WINNING_LINES: readonly WinningLine[] = [
  { type: 'row',      positions: [{ row: 0, col: 0 }, { row: 0, col: 1 }, { row: 0, col: 2 }] },
  { type: 'row',      positions: [{ row: 1, col: 0 }, { row: 1, col: 1 }, { row: 1, col: 2 }] },
  { type: 'row',      positions: [{ row: 2, col: 0 }, { row: 2, col: 1 }, { row: 2, col: 2 }] },
  { type: 'col',      positions: [{ row: 0, col: 0 }, { row: 1, col: 0 }, { row: 2, col: 0 }] },
  { type: 'col',      positions: [{ row: 0, col: 1 }, { row: 1, col: 1 }, { row: 2, col: 1 }] },
  { type: 'col',      positions: [{ row: 0, col: 2 }, { row: 1, col: 2 }, { row: 2, col: 2 }] },
  { type: 'diagonal', positions: [{ row: 0, col: 0 }, { row: 1, col: 1 }, { row: 2, col: 2 }] },
  { type: 'diagonal', positions: [{ row: 0, col: 2 }, { row: 1, col: 1 }, { row: 2, col: 0 }] },
] as const;

export function detectWinningLine(
  board:  BoardSnapshot,
  symbol: PlayerSymbol,
): WinningLine | null {
  for (const line of WINNING_LINES) {
    const [a, b, c] = line.positions;
    if (
      (board[positionToIndex(a.row, a.col)] as CellValue) === symbol &&
      (board[positionToIndex(b.row, b.col)] as CellValue) === symbol &&
      (board[positionToIndex(c.row, c.col)] as CellValue) === symbol
    ) {
      return line;
    }
  }
  return null;
}

/**
 * Return the set of flat indices that belong to a winning line.
 * Used by the Board component to highlight winning cells.
 */
export function winningIndices(line: WinningLine | null): ReadonlySet<number> {
  if (!line) return new Set();
  return new Set(
    line.positions.map((p) => positionToIndex(p.row, p.col)),
  );
}

/**
 * Compute which cells are "frozen" because of a pending optimistic move.
 * A cell is frozen when the optimistic board shows a mark that the confirmed
 * board does not yet have — i.e. our move is in-flight.
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
