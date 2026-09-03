/**
 * @file sessionStore.ts
 * @description In-memory session store.
 *
 * Responsibilities:
 *  1. Map SessionToken → PlayerSession (playerId + metadata)
 *  2. Command deduplication cache (commandId → cached result, 5-min TTL)
 *  3. Session expiry (7-day TTL)
 *
 * No persistence — intentionally in-memory for Phase 1.
 * All public methods are synchronous; there is no I/O.
 */

import type { PlayerId, SessionToken, CommandId, RoomId } from '../../shared/protocol/types.js';
import { COMMAND_DEDUP_TTL_MS } from '../../shared/protocol/types.js';
import { generatePlayerId, generateSessionToken } from '../utils/idGenerator.js';
import { logger } from '../utils/logger.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** 7-day TTL for session tokens (ms). */
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

export type PlayerSession = {
  readonly playerId: PlayerId;
  readonly sessionToken: SessionToken;
  /** Epoch ms when the session was created. */
  readonly createdAt: number;
  /** Epoch ms of the last received message on this session. */
  lastSeenAt: number;
  /** Current room, if any. */
  roomId: RoomId | null;
};

/**
 * A cached command result. Stored for COMMAND_DEDUP_TTL_MS (5 minutes).
 * The payload is the serialised response object the server originally sent.
 * Using `unknown` here lets each handler store its own result shape without
 * making the store generic.
 */
export type DedupEntry = {
  readonly commandId: CommandId;
  readonly result: unknown;
  readonly cachedAt: number;
};

// ─────────────────────────────────────────────────────────────────────────────
// SessionStore
// ─────────────────────────────────────────────────────────────────────────────

export class SessionStore {
  /** token → session */
  private readonly sessions = new Map<SessionToken, PlayerSession>();

  /** playerId → token (reverse index for fast lookup) */
  private readonly playerIndex = new Map<PlayerId, SessionToken>();

  /** commandId → dedup entry */
  private readonly dedupCache = new Map<CommandId, DedupEntry>();

  // ── Session management ────────────────────────────────────────────────────

  /**
   * Create a new anonymous session and return it.
   * Called when AUTH arrives with guestToken: null.
   */
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
    this.playerIndex.set(playerId, token);

    logger.debug('Session created', { playerId, token: '[redacted]' });
    return session;
  }

  /**
   * Look up a session by token.
   * Returns null if the token is unknown or has expired.
   */
  getSession(token: SessionToken): PlayerSession | null {
    const session = this.sessions.get(token);
    if (!session) return null;

    if (Date.now() - session.createdAt > SESSION_TTL_MS) {
      this.deleteSession(token);
      return null;
    }

    return session;
  }

  /**
   * Look up a session by playerId.
   */
  getSessionByPlayerId(playerId: PlayerId): PlayerSession | null {
    const token = this.playerIndex.get(playerId);
    if (!token) return null;
    return this.getSession(token);
  }

  /** Update last-seen timestamp. Call on every received message. */
  touch(token: SessionToken): void {
    const s = this.sessions.get(token);
    if (s) s.lastSeenAt = Date.now();
  }

  /** Associate or clear the player's current room. */
  setRoom(token: SessionToken, roomId: RoomId | null): void {
    const s = this.sessions.get(token);
    if (s) s.roomId = roomId;
  }

  deleteSession(token: SessionToken): void {
    const s = this.sessions.get(token);
    if (s) {
      this.playerIndex.delete(s.playerId);
      this.sessions.delete(token);
    }
  }

  // ── Deduplication cache ───────────────────────────────────────────────────

  /**
   * Record that commandId was processed and cache its result.
   * The result is whatever the handler wishes to replay on a retry.
   */
  recordCommand(commandId: CommandId, result: unknown): void {
    this.dedupCache.set(commandId, {
      commandId,
      result,
      cachedAt: Date.now(),
    });
  }

  /**
   * Return the cached result for commandId, or null if not found / expired.
   * Expired entries are evicted lazily on access.
   */
  getCachedResult(commandId: CommandId): unknown | null {
    const entry = this.dedupCache.get(commandId);
    if (!entry) return null;

    if (Date.now() - entry.cachedAt > COMMAND_DEDUP_TTL_MS) {
      this.dedupCache.delete(commandId);
      return null;
    }

    return entry.result;
  }

  // ── Maintenance ───────────────────────────────────────────────────────────

  /**
   * Purge expired sessions and dedup cache entries.
   * Should be called periodically (e.g. every 10 minutes).
   */
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
}
