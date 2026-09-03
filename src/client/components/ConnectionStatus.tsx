/**
 * @file ConnectionStatus.tsx
 * @description Live WebSocket state indicator with RTT display.
 *
 * Renders a small pill in the top-right corner.
 * When reconnecting, renders a full-screen overlay so the user cannot
 * interact with a stale board.
 */

import React, { useEffect, useState } from 'react';
import type { WsState } from '../lib/wsClient';
import type { LatencyMetrics } from '../store/gameStore';

// ─────────────────────────────────────────────────────────────────────────────
// Pill
// ─────────────────────────────────────────────────────────────────────────────

interface ConnectionPillProps {
  wsState: WsState;
  latency: LatencyMetrics;
}

export function ConnectionPill({ wsState, latency }: ConnectionPillProps) {
  const label = wsStateLabel(wsState);
  const rtt   = latency.smoothRttMs !== null
    ? `${latency.smoothRttMs}ms`
    : null;

  return (
    <div className={`conn-pill conn-pill--${wsState.toLowerCase()}`} aria-live="polite">
      <span className="conn-pill__dot" aria-hidden="true" />
      <span className="conn-pill__label">{label}</span>
      {wsState === 'AUTHENTICATED' && rtt && (
        <span className="conn-pill__rtt" title="Round-trip time">{rtt}</span>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Reconnecting overlay
// ─────────────────────────────────────────────────────────────────────────────

interface ReconnectingOverlayProps {
  visible: boolean;
}

export function ReconnectingOverlay({ visible }: ReconnectingOverlayProps) {
  const [dots, setDots] = useState('');

  useEffect(() => {
    if (!visible) { setDots(''); return; }
    const id = setInterval(() => {
      setDots((d) => (d.length >= 3 ? '' : d + '.'));
    }, 500);
    return () => clearInterval(id);
  }, [visible]);

  if (!visible) return null;

  return (
    <div className="reconnect-overlay" role="status" aria-label="Reconnecting to server">
      <div className="reconnect-overlay__card">
        <div className="reconnect-overlay__spinner" aria-hidden="true" />
        <p className="reconnect-overlay__text">Reconnecting{dots}</p>
        <p className="reconnect-overlay__sub">Your game will resume automatically</p>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper
// ─────────────────────────────────────────────────────────────────────────────

function wsStateLabel(state: WsState): string {
  switch (state) {
    case 'IDLE':          return 'Offline';
    case 'CONNECTING':    return 'Connecting…';
    case 'CONNECTED':     return 'Authenticating…';
    case 'AUTHENTICATED': return 'Connected';
    case 'RECONNECTING':  return 'Reconnecting…';
    case 'CLOSED':        return 'Disconnected';
  }
}
