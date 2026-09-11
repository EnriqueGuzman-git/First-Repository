import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PlayerId } from '../../shared/protocol/types.js';
import { brand } from '../../shared/protocol/types.js';
import { SessionStore } from './sessionStore.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('SessionStore lifecycle', () => {
  it('refreshes lastSeenAt when a session is active', () => {
    vi.useFakeTimers();
    const store = new SessionStore();
    const session = store.createSession();
    const initialLastSeen = session.lastSeenAt;

    vi.advanceTimersByTime(1_000);
    store.touch(session.sessionToken);

    expect(session.lastSeenAt).toBeGreaterThan(initialLastSeen);
  });

  it('expires sessions after the absolute seven-day lifetime', () => {
    vi.useFakeTimers();
    const store = new SessionStore();
    const session = store.createSession();

    vi.advanceTimersByTime(7 * 24 * 60 * 60 * 1_000 + 1);

    expect(store.getSession(session.sessionToken)).toBeNull();
    expect(store.sessionCount).toBe(0);
  });

  it('getTokenByPlayerId returns the token for a known playerId', () => {
    const store = new SessionStore();
    const session = store.createSession();

    const token = store.getTokenByPlayerId(session.playerId);
    expect(token).toBe(session.sessionToken);
  });

  it('getTokenByPlayerId returns null for an unknown playerId', () => {
    const store = new SessionStore();
    const unknownId = brand<PlayerId>('00000000-0000-4000-8000-000000000000');

    expect(store.getTokenByPlayerId(unknownId)).toBeNull();
  });
});
