/**
 * @file Cell.tsx
 * @description A single board cell with four possible visual states:
 *
 *  'empty'    — blank, clickable when it's the player's turn
 *  'x' / 'o' — confirmed mark (server-authoritative)
 *  'pending'  — optimistic mark (awaiting server confirmation)
 *  'winning'  — part of the winning line (highlight)
 *
 * The cell is a <button> for keyboard + screen-reader accessibility.
 * aria-label describes both position and content.
 */

import React from 'react';
import type { CellValue, BoardIndex } from '@ttt/shared/protocol';

export type CellVisualState = 'empty' | 'x' | 'o' | 'pending' | 'winning-x' | 'winning-o';

interface CellProps {
  row:          BoardIndex;
  col:          BoardIndex;
  value:        CellValue;
  isPending:    boolean;   // optimistic mark in-flight
  isWinning:    boolean;   // part of winning line
  isClickable:  boolean;
  onClick:      (row: BoardIndex, col: BoardIndex) => void;
}

export function Cell({ row, col, value, isPending, isWinning, isClickable, onClick }: CellProps) {
  const handleClick = () => {
    if (isClickable) onClick(row, col);
  };

  const visualState = resolveVisualState(value, isPending, isWinning);
  const label       = cellAriaLabel(row, col, value, isPending);

  return (
    <button
      className={`cell cell--${visualState}`}
      onClick={handleClick}
      disabled={!isClickable}
      aria-label={label}
      data-testid={`cell-${row}-${col}`}
      data-row={row}
      data-col={col}
    >
      <span className="cell__mark" aria-hidden="true">
        {markDisplay(value, isPending)}
      </span>
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function resolveVisualState(
  value:     CellValue,
  isPending: boolean,
  isWinning: boolean,
): CellVisualState {
  if (isPending)          return 'pending';
  if (value === 'X' && isWinning) return 'winning-x';
  if (value === 'O' && isWinning) return 'winning-o';
  if (value === 'X')      return 'x';
  if (value === 'O')      return 'o';
  return 'empty';
}

function markDisplay(value: CellValue, isPending: boolean): string {
  if (isPending) return value || '';   // show mark but styled as pending
  return value;
}

function cellAriaLabel(
  row:       BoardIndex,
  col:       BoardIndex,
  value:     CellValue,
  isPending: boolean,
): string {
  const pos    = `Row ${row + 1}, column ${col + 1}`;
  const status = isPending
    ? 'your move (waiting for confirmation)'
    : value === ''
    ? 'empty'
    : `marked ${value}`;
  return `${pos}: ${status}`;
}
