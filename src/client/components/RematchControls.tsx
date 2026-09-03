/**
 * @file RematchControls.tsx
 * @description Rematch proposal, acceptance, and decline with live countdown.
 *
 * States handled:
 *  NONE              — show "Request rematch" button
 *  REQUESTED_BY_ME   — show "Waiting for opponent…" with countdown
 *  REQUESTED_BY_THEM — show "Rematch?" accept/decline buttons with countdown
 *  DECLINED          — show "Rematch declined" message
 *  EXPIRED           — show "Rematch request expired" message
 */

import React, { useEffect, useState } from 'react';
import type { RematchState } from '../store/gameStore';

interface RematchControlsProps {
  rematch:        RematchState;
  onRequest:      () => void;
  onAccept:       () => void;
  onDecline:      () => void;
}

export function RematchControls({
  rematch,
  onRequest,
  onAccept,
  onDecline,
}: RematchControlsProps) {
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);

  useEffect(() => {
    if (
      rematch.status !== 'REQUESTED_BY_ME' &&
      rematch.status !== 'REQUESTED_BY_THEM'
    ) {
      setSecondsLeft(null);
      return;
    }

    const deadline = rematch.expiresAt;
    const tick = () => {
      const diff = Math.max(0, Math.ceil((deadline - Date.now()) / 1_000));
      setSecondsLeft(diff);
    };
    tick();
    const id = setInterval(tick, 500);
    return () => clearInterval(id);
  }, [rematch]);

  switch (rematch.status) {
    case 'NONE':
      return (
        <div className="rematch rematch--none">
          <button className="btn btn--secondary" onClick={onRequest}>
            Request rematch
          </button>
        </div>
      );

    case 'REQUESTED_BY_ME':
      return (
        <div className="rematch rematch--waiting" role="status" aria-live="polite">
          <p className="rematch__msg">Rematch request sent…</p>
          {secondsLeft !== null && (
            <p className="rematch__countdown">
              Expires in {secondsLeft}s
            </p>
          )}
        </div>
      );

    case 'REQUESTED_BY_THEM':
      return (
        <div className="rematch rematch--incoming" role="status" aria-live="assertive">
          <p className="rematch__msg">Opponent wants a rematch!</p>
          {secondsLeft !== null && (
            <p className="rematch__countdown">{secondsLeft}s to respond</p>
          )}
          <div className="rematch__buttons">
            <button className="btn btn--primary" onClick={onAccept}>
              Accept
            </button>
            <button className="btn btn--ghost" onClick={onDecline}>
              Decline
            </button>
          </div>
        </div>
      );

    case 'DECLINED':
      return (
        <div className="rematch rematch--declined" role="status">
          <p className="rematch__msg">Rematch declined</p>
          <button className="btn btn--ghost" onClick={onRequest}>
            Request again
          </button>
        </div>
      );

    case 'EXPIRED':
      return (
        <div className="rematch rematch--expired" role="status">
          <p className="rematch__msg">Rematch request expired</p>
          <button className="btn btn--ghost" onClick={onRequest}>
            Request again
          </button>
        </div>
      );
  }
}
