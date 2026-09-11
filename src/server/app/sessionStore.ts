/**
 * In-memory session store: SessionToken → PlayerSession, a command dedup cache,
 * and lazy session expiry. Intentionally non-persistent for Phase 1.
 */

import type { PlayerId, SessionToken, CommandId, RoomId } from '../../shared/protocol/types.js';
import { COMMAND_DEDUP_TTL_MS } from '../../shared/protocol/types.js';
import { generatePlayerId, generateSessionToken } from '../utils/idGenerator.js';
import { logger } from '../utils/logger.js';

/** 7-day TTL for session tokens (ms). */
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

export type PlayerSession = {
  readonly playerId: PlayerId;
  readonly sessionToken: SessionToken;
  /** Epoch ms when the session was created. */
  readonly createdAt: number;
  /** Epoch ms of the last received message on this session. */
  lastSeenAt: number;
  roomId: RoomId | null;
};

/**
 * A cached command result, held for COMMAND_DEDUP_TTL_MS. `result` is `unknown`
 * so each handler can cache its own response shape without a generic store.
 */
export type DedupEntry = {
  readonly commandId: CommandId;
  readonly result: unknown;
  readonly cachedAt: number;
};

export class SessionStore {
  private readonly sessions = new Map<SessionToken, PlayerSession>();
  private readonly dedupCache = new Map<CommandId, DedupEntry>();

  /** Create a new anonymous session; called when AUTH arrives with no guestToken. */
  createSession(): PlayerSession {
    const token    = generateSessionToken();
    const playerId = generatePlayerId();
    const now      = Date.now();

    const session: PlayerSession = {
      playerId,
      sessionToken: token,
      createdAt:    now,
      lastSeenAt:   now,
      roomId:       null,
    };

    this.sessions.set(token, session);

    logger.debug('Session created', { playerId, token: '[redacted]' });
    return session;
  }

  /** Look up a session by token, or null if unknown or expired. */
  getSession(token: SessionToken): PlayerSession | null {
    const session = this.sessions.get(token);
    if (!session) return null;

    if (Date.now() - session.createdAt > SESSION_TTL_MS) {
      this.deleteSession(token);
      return null;
    }

    return session;
  }

  /** Update last-seen timestamp. Call on every received message. */
  touch(token: SessionToken): void {
    const s = this.sessions.get(token);
    if (s) s.lastSeenAt = Date.now();
  }

  setRoom(token: SessionToken, roomId: RoomId | null): void {
    const s = this.sessions.get(token);
    if (s) s.roomId = roomId;
  }

  deleteSession(token: SessionToken): void {
    this.sessions.delete(token);
  }

  /** Cache commandId's result so a retry can replay it. */
  recordCommand(commandId: CommandId, result: unknown): void {
    this.dedupCache.set(commandId, {
      commandId,
      result,
      cachedAt: Date.now(),
    });
  }

  /** Cached result for commandId, or null if absent/expired (evicted lazily). */
  getCachedResult(commandId: CommandId): unknown | null {
    const entry = this.dedupCache.get(commandId);
    if (!entry) return null;

    if (Date.now() - entry.cachedAt > COMMAND_DEDUP_TTL_MS) {
      this.dedupCache.delete(commandId);
      return null;
    }

    return entry.result;
  }

  /** Purge expired sessions and dedup entries; call periodically. */
  purgeExpired(): void {
    const now = Date.now();

    for (const [token, session] of this.sessions) {
      if (now - session.createdAt > SESSION_TTL_MS) {
        this.deleteSession(token);
      }
    }

    for (const [id, entry] of this.dedupCache) {
      if (now - entry.cachedAt > COMMAND_DEDUP_TTL_MS) {
        this.dedupCache.delete(id);
      }
    }
  }

  get sessionCount(): number { return this.sessions.size; }
  get dedupCacheSize(): number { return this.dedupCache.size; }

  /** Find the session token for a given playerId, or null if not found. */
  getTokenByPlayerId(playerId: PlayerId): SessionToken | null {
    for (const [token, session] of this.sessions) {
      if (session.playerId === playerId) return token;
    }
    return null;
  }
}
