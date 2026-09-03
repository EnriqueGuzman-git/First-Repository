/**
 * @file GameStatus.tsx
 * @description Turn indicator, result banner, and opponent reconnect countdown.
 *
 * Surfaces three distinct states:
 *  1. Active game  — whose turn it is, pending move indicator
 *  2. Game over    — winner / draw banner with winning line description
 *  3. Opponent disconnected — countdown to game abandonment
 */

import React, { useEffect, useState } from 'react';
import type { GameResult, PlayerSymbol, WinningLine } from '@ttt/shared/protocol';
import type { OpponentConnectionEvent } from '../store/gameStore';

interface GameStatusProps {
  gameStatus:         'WAITING' | 'ACTIVE' | 'FINISHED';
  mySymbol:           PlayerSymbol | null;
  currentTurn:        PlayerSymbol;
  result:             GameResult | null;
  winningLine:        WinningLine | null;
  movePending:        boolean;
  opponentConnection: OpponentConnectionEvent;
  latencyMs:          number | null;
}

export function GameStatus({
  gameStatus,
  mySymbol,
  currentTurn,
  result,
  winningLine,
  movePending,
  opponentConnection,
  latencyMs,
}: GameStatusProps) {
  // ── Opponent disconnect countdown ─────────────────────────────────────────
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);

  useEffect(() => {
    if (opponentConnection?.kind !== 'DISCONNECTED') {
      setSecondsLeft(null);
      return;
    }
    const deadline = opponentConnection.reconnectDeadlineAt;
    const update = () => {
      const diff = Math.max(0, Math.ceil((deadline - Date.now()) / 1_000));
      setSecondsLeft(diff);
    };
    update();
    const id = setInterval(update, 1_000);
    return () => clearInterval(id);
  }, [opponentConnection]);

  // ── Finished ──────────────────────────────────────────────────────────────
  if (gameStatus === 'FINISHED' && result) {
    return (
      <div className={`game-status game-status--finished game-status--${result.outcome.toLowerCase()}`}
           role="status" aria-live="assertive">
        <p className="game-status__headline">{resultHeadline(result, mySymbol)}</p>
        {result.winningLine && (
          <p className="game-status__detail">{winningLineLabel(result.winningLine)}</p>
        )}
      </div>
    );
  }

  // ── Active: opponent disconnected ─────────────────────────────────────────
  if (gameStatus === 'ACTIVE' && opponentConnection?.kind === 'DISCONNECTED') {
    const mins  = Math.floor((secondsLeft ?? 0) / 60);
    const secs  = String((secondsLeft ?? 0) % 60).padStart(2, '0');
    const label = secondsLeft !== null ? `${mins}:${secs}` : '…';
    return (
      <div className="game-status game-status--disconnected" role="status" aria-live="polite">
        <p className="game-status__headline">Opponent disconnected</p>
        <p className="game-status__detail">
          Waiting for them to reconnect — {label} remaining
        </p>
      </div>
    );
  }

  // ── Active: normal ────────────────────────────────────────────────────────
  if (gameStatus === 'ACTIVE') {
    const isMyTurn = currentTurn === mySymbol;
    return (
      <div className={`game-status game-status--active game-status--${isMyTurn ? 'my-turn' : 'their-turn'}`}
           role="status" aria-live="polite">
        {isMyTurn ? (
          <p className="game-status__headline">
            {movePending ? 'Confirming move…' : 'Your turn'}
            {latencyMs !== null && !movePending && (
              <span className="game-status__latency">{latencyMs}ms</span>
            )}
          </p>
        ) : (
          <p className="game-status__headline">Waiting for opponent…</p>
        )}
        <TurnIndicator current={currentTurn} mine={mySymbol} />
      </div>
    );
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────────────

function TurnIndicator({
  current,
  mine,
}: { current: PlayerSymbol; mine: PlayerSymbol | null }) {
  return (
    <div className="turn-indicator" aria-hidden="true">
      {(['X', 'O'] as PlayerSymbol[]).map((sym) => (
        <span
          key={sym}
          className={[
            'turn-indicator__sym',
            `turn-indicator__sym--${sym.toLowerCase()}`,
            current === sym   ? 'turn-indicator__sym--active'  : '',
            mine    === sym   ? 'turn-indicator__sym--mine'    : '',
          ].join(' ').trim()}
        >
          {sym}
        </span>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function resultHeadline(result: GameResult, mySymbol: PlayerSymbol | null): string {
  switch (result.outcome) {
    case 'WIN':
      if (result.winner === mySymbol) return '🎉 You won!';
      return '😔 You lost';
    case 'DRAW':
      return "🤝 It's a draw!";
    case 'FORFEIT':
      if (result.winner === mySymbol) return '🏆 Opponent forfeited — you win!';
      return '🚪 You forfeited';
    case 'ABANDONED':
      if (result.winner === mySymbol) return '🏆 Opponent abandoned — you win!';
      return '💨 Opponent abandoned the game';
  }
}

function winningLineLabel(line: WinningLine): string {
  switch (line.type) {
    case 'row':      return `Row ${line.positions[0].row + 1}`;
    case 'col':      return `Column ${line.positions[0].col + 1}`;
    case 'diagonal': return line.positions[0].col === 0 ? 'Top-left diagonal' : 'Top-right diagonal';
  }
}
