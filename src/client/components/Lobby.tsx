/**
 * @file Lobby.tsx
 * @description Room creation and join UI.
 *
 * Two flows:
 *  1. Create a new room → POST /api/rooms → receive roomId → auto-join via WS
 *  2. Join an existing room → enter 8-char code → join via WS
 *
 * Also shows the waiting-for-second-player state once a room is joined.
 * The "Ready" button is shown when both players are connected.
 */

import React, { useState, useCallback } from 'react';
import type { GameApi } from '../hooks/useGame';
import type { ClientState } from '../store/gameStore';

interface LobbyProps {
  state:       ClientState;
  joinRoom:    GameApi['joinRoom'];
  playerReady: GameApi['playerReady'];
  leaveRoom:   GameApi['leaveRoom'];
}

export function Lobby({ state, joinRoom, playerReady, leaveRoom }: LobbyProps) {
  const { phase, roomId, players, readyPlayers, mySymbol } = state;

  // ── Waiting for second player ─────────────────────────────────────────────
  if (phase === 'WAITING_FOR_PLAYER' && roomId) {
    return (
      <WaitingRoom
        roomId={roomId}
        mySymbol={mySymbol}
        onLeave={leaveRoom}
      />
    );
  }

  // ── Both players present: ready check ────────────────────────────────────
  if (phase === 'READY_CHECK' && roomId) {
    const amReady = mySymbol !== null && readyPlayers.includes(mySymbol);
    return (
      <ReadyRoom
        roomId={roomId}
        mySymbol={mySymbol}
        players={players}
        readyPlayers={readyPlayers}
        amReady={amReady}
        onReady={playerReady}
        onLeave={leaveRoom}
      />
    );
  }

  // ── Default: create / join form ───────────────────────────────────────────
  return (
    <LobbyForm
      wsConnected={state.wsState === 'AUTHENTICATED'}
      onJoin={joinRoom}
    />
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Lobby form (create / join)
// ─────────────────────────────────────────────────────────────────────────────

function LobbyForm({
  wsConnected,
  onJoin,
}: { wsConnected: boolean; onJoin: (roomId: string) => void }) {
  const [code,       setCode]       = useState('');
  const [creating,   setCreating]   = useState(false);
  const [error,      setError]      = useState<string | null>(null);

  const createRoom = useCallback(async () => {
    setError(null);
    setCreating(true);
    try {
      const res  = await fetch('/api/rooms', { method: 'POST' });
      if (!res.ok) throw new Error(`Server error: ${res.status}`);
      const body = await res.json() as { roomId: string };
      onJoin(body.roomId);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create room');
    } finally {
      setCreating(false);
    }
  }, [onJoin]);

  const joinByCode = useCallback(() => {
    const clean = code.trim().toUpperCase();
    if (!/^[A-Z2-9]{8}$/.test(clean)) {
      setError('Room code must be 8 characters (letters A–Z, digits 2–9)');
      return;
    }
    setError(null);
    onJoin(clean);
  }, [code, onJoin]);

  return (
    <div className="lobby">
      <h1 className="lobby__title">Tic-Tac-Toe</h1>
      <p className="lobby__subtitle">Two-player real-time</p>

      {!wsConnected && (
        <p className="lobby__connecting" role="status">Connecting to server…</p>
      )}

      <div className="lobby__actions">
        <button
          className="btn btn--primary"
          onClick={createRoom}
          disabled={!wsConnected || creating}
          aria-busy={creating}
        >
          {creating ? 'Creating…' : 'Create new game'}
        </button>

        <div className="lobby__divider" aria-hidden="true">or</div>

        <div className="lobby__join-form">
          <input
            className="lobby__code-input"
            type="text"
            value={code}
            onChange={(e) => { setCode(e.target.value); setError(null); }}
            onKeyDown={(e) => e.key === 'Enter' && joinByCode()}
            placeholder="Enter room code"
            maxLength={8}
            aria-label="Room code"
            autoCapitalize="characters"
            spellCheck={false}
          />
          <button
            className="btn btn--secondary"
            onClick={joinByCode}
            disabled={!wsConnected || code.trim().length === 0}
          >
            Join game
          </button>
        </div>

        {error && (
          <p className="lobby__error" role="alert">{error}</p>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Waiting room (first player waiting for second)
// ─────────────────────────────────────────────────────────────────────────────

function WaitingRoom({
  roomId,
  mySymbol,
  onLeave,
}: { roomId: string; mySymbol: string | null; onLeave: () => void }) {
  const [copied, setCopied] = useState(false);

  const copyLink = useCallback(async () => {
    const url = `${window.location.origin}/?room=${roomId}`;
    await navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2_000);
  }, [roomId]);

  return (
    <div className="lobby waiting-room">
      <h2 className="waiting-room__title">Waiting for opponent</h2>
      <p className="waiting-room__symbol">You are playing as <strong>{mySymbol}</strong></p>

      <div className="waiting-room__share">
        <p className="waiting-room__label">Share this code with a friend:</p>
        <div className="waiting-room__code" aria-label={`Room code: ${roomId}`}>
          {roomId}
        </div>
        <button className="btn btn--secondary" onClick={copyLink}>
          {copied ? '✓ Copied!' : 'Copy invite link'}
        </button>
      </div>

      <div className="waiting-room__spinner" aria-hidden="true" />

      <button className="btn btn--ghost" onClick={onLeave}>Leave room</button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Ready room (both players present)
// ─────────────────────────────────────────────────────────────────────────────

function ReadyRoom({
  roomId,
  mySymbol,
  players,
  readyPlayers,
  amReady,
  onReady,
  onLeave,
}: {
  roomId:       string;
  mySymbol:     string | null;
  players:      ClientState['players'];
  readyPlayers: ReadonlyArray<string>;
  amReady:      boolean;
  onReady:      () => void;
  onLeave:      () => void;
}) {
  return (
    <div className="lobby ready-room">
      <h2 className="ready-room__title">Both players connected</h2>
      <p className="ready-room__room">Room: <span className="ready-room__code">{roomId}</span></p>

      <ul className="ready-room__players" aria-label="Players">
        {(['X', 'O'] as const).map((sym) => {
          const p       = players[sym];
          const isReady = readyPlayers.includes(sym);
          return (
            <li key={sym} className={`ready-room__player${isReady ? ' ready-room__player--ready' : ''}`}>
              <span className={`ready-room__sym ready-room__sym--${sym.toLowerCase()}`}>{sym}</span>
              <span className="ready-room__name">
                {p?.name ?? `Player ${sym}`}
                {sym === mySymbol && ' (you)'}
              </span>
              {isReady && <span className="ready-room__check" aria-label="Ready">✓</span>}
            </li>
          );
        })}
      </ul>

      {!amReady && (
        <button className="btn btn--primary" onClick={onReady}>
          Ready!
        </button>
      )}
      {amReady && (
        <p className="ready-room__waiting" role="status">
          Waiting for opponent to ready up…
        </p>
      )}

      <button className="btn btn--ghost" onClick={onLeave}>Leave room</button>
    </div>
  );
}
