/**
 * @file App.tsx
 * @description Root component. Owns the useGame hook and routes between
 * the lobby and the active game view based on GamePhase.
 *
 * URL scheme:
 *   /            — Lobby (create or enter room code)
 *   /?room=XXXX  — Auto-join room XXXX on mount
 */

import React, { useEffect, useRef } from 'react';
import { useGame } from './hooks/useGame';
import { ConnectionPill, ReconnectingOverlay } from './components/ConnectionStatus';
import { Board } from './components/Board';
import { GameStatus } from './components/GameStatus';
import { Lobby } from './components/Lobby';
import { RematchControls } from './components/RematchControls';
import { pendingCellIndices, winningIndices } from './lib/optimisticEngine';
import './App.css';

export default function App() {
  const {
    state,
    board,
    moveAllowed,
    movePending,
    joinRoom,
    leaveRoom,
    playerReady,
    makeMove,
    requestRematch,
    acceptRematch,
    declineRematch,
  } = useGame();

  const { phase, wsState, latency } = state;
  const autoJoinedRoomRef = useRef<string | null>(null);

  // ── Auto-join from URL param ───────────────────────────────────────────────
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const room = params.get('room');

    if (
      room &&
      wsState === 'AUTHENTICATED' &&
      phase === 'LOBBY' &&
      autoJoinedRoomRef.current !== room
    ) {
      autoJoinedRoomRef.current = room;
      joinRoom(room);
    }
  }, [joinRoom, phase, wsState]);

  // ── Derived display data ──────────────────────────────────────────────────
  const pendingIdx = pendingCellIndices(state.confirmedBoard, state.optimisticBoard);
  const winIdx     = winningIndices(state.winningLine);

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="app">
      {/* Always-visible connection indicator */}
      <header className="app__header">
        <span className="app__logo">TTT</span>
        <ConnectionPill wsState={wsState} latency={latency} />
      </header>

      {/* Reconnecting overlay — blocks interaction while socket recovers */}
      <ReconnectingOverlay visible={wsState === 'RECONNECTING'} />

      <main className="app__main">
        {/* ── Lobby phases ── */}
        {(phase === 'LOBBY' || phase === 'WAITING_FOR_PLAYER' || phase === 'READY_CHECK') && (
          <Lobby
            state={state}
            joinRoom={joinRoom}
            playerReady={playerReady}
            leaveRoom={leaveRoom}
          />
        )}

        {/* ── Active game ── */}
        {(phase === 'ACTIVE' || phase === 'RECONNECTING' || phase === 'FINISHED') && (
          <div className="game">
            <GameStatus
              gameStatus={state.gameStatus}
              mySymbol={state.mySymbol}
              currentTurn={state.confirmedTurn}
              result={state.gameResult}
              movePending={movePending}
              opponentConnection={state.opponentConnection}
              latencyMs={latency.smoothRttMs}
            />

            <Board
              board={board}
              pendingIndices={pendingIdx}
              winningIndices={winIdx}
              canMove={moveAllowed}
              onCellClick={makeMove}
            />

            {state.gameStatus === 'FINISHED' && (
              <div className="game__post">
                <RematchControls
                  rematch={state.rematch}
                  onRequest={requestRematch}
                  onAccept={acceptRematch}
                  onDecline={declineRematch}
                />
                <button className="btn btn--ghost game__leave" onClick={leaveRoom}>
                  Leave room
                </button>
              </div>
            )}

            {/* Move latency micro-metric (dev-visible) */}
            {latency.lastMoveAckMs !== null && (
              <div className="game__ack-latency" aria-label="Last move confirmation time">
                ✓ {latency.lastMoveAckMs}ms
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
