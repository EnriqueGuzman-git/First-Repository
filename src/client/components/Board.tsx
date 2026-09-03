/**
 * @file Board.tsx
 * @description 3×3 game board.
 *
 * Receives the display board (optimistic overlay already applied by the store),
 * the set of pending cell indices, winning cell indices, and click handler.
 *
 * Visual states per cell:
 *  - confirmed X / O  — server-authoritative mark
 *  - pending          — optimistic mark awaiting ACK (semi-transparent)
 *  - winning          — highlighted as part of the winning line
 *  - empty + clickable — hover effect on legal cells
 *  - empty + disabled  — no hover (not your turn / game over)
 */

import React from 'react';
import type { BoardSnapshot, BoardIndex } from '@ttt/shared/protocol';
import { positionToIndex } from '@ttt/shared/protocol';
import { Cell } from './Cell';

interface BoardProps {
  board:          BoardSnapshot;
  /** Flat indices (row*3+col) of the currently pending (optimistic) cell. */
  pendingIndices: ReadonlySet<number>;
  /** Flat indices that belong to the winning line. Empty when no winner. */
  winningIndices: ReadonlySet<number>;
  /** True when clicking any empty cell should fire onCellClick. */
  canMove:        boolean;
  onCellClick:    (row: BoardIndex, col: BoardIndex) => void;
}

export function Board({
  board,
  pendingIndices,
  winningIndices,
  canMove,
  onCellClick,
}: BoardProps) {
  const hasWinner = winningIndices.size > 0;

  return (
    <div
      className={`board${hasWinner ? ' board--finished' : ''}`}
      role="grid"
      aria-label="Tic-Tac-Toe board"
    >
      {([0, 1, 2] as BoardIndex[]).map((row) => (
        <div key={row} className="board__row" role="row">
          {([0, 1, 2] as BoardIndex[]).map((col) => {
            const idx       = positionToIndex(row, col);
            const value     = board[idx];
            const isPending = pendingIndices.has(idx);
            const isWinning = winningIndices.has(idx);
            // A cell is clickable when:
            //  - canMove is true (it's our turn, game active)
            //  - the cell is empty AND not already pending
            const isClickable = canMove && value === '' && !isPending;

            return (
              <Cell
                key={col}
                row={row}
                col={col}
                value={value}
                isPending={isPending}
                isWinning={isWinning}
                isClickable={isClickable}
                onClick={onCellClick}
              />
            );
          })}
        </div>
      ))}
    </div>
  );
}
