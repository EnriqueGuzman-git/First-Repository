/**
 * @file connectionManager.ts
 * @description WebSocket connection registry.
 *
 * Responsibilities (transport layer only — no game logic):
 *  1. Assign a stable connectionId to each WebSocket.
 *  2. Map connectionId ↔ SessionToken (set after AUTH succeeds).
 *  3. Map connectionId ↔ PlayerId  (set after AUTH succeeds, for GameSession callbacks).
 *  4. Send serialised events to a specific connection.
 *  5. Enforce per-connection rate limiting.
 *  6. Fire the AUTH timeout if AUTH is not received within AUTH_TIMEOUT_MS.
 *  7. Detect idle connections (no message for CONNECTION_IDLE_TIMEOUT_MS).
 *  8. Track connection metadata for observability.
 *
 * This class has no knowledge of game state, rooms, or the protocol message
 * semantics. It only knows about sockets, bytes, and timing.
 */

import type { WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';

import type { SessionToken, PlayerId } from '../../shared/protocol/types.js';
import {
  AUTH_TIMEOUT_MS,
  CONNECTION_IDLE_TIMEOUT_MS,
  MAX_FRAME_BYTES,
} from '../../shared/protocol/types.js';
import { logger } from '../utils/logger.js';

// ─────────────────────────────────────────────────────────────────────────────
// Rate-limiter (token bucket, per connection)
// ─────────────────────────────────────────────────────────────────────────────

const RATE_WINDOW_MS   = 10_000; // 10 seconds
const RATE_MAX_MSGS    = 60;     // 60 messages per window  (§16 PROTOCOL.md)
const RATE_MAX_MOVES   = 5;      // 5 MAKE_MOVE per second  (enforced in router)

type RateBucket = {
  windowStart: number;
  count:       number;
};

function checkRate(bucket: RateBucket): boolean {
  const now = Date.now();
  if (now - bucket.windowStart > RATE_WINDOW_MS) {
    bucket.windowStart = now;
    bucket.count       = 0;
  }
  bucket.count++;
  return bucket.count <= RATE_MAX_MSGS;
}

// ─────────────────────────────────────────────────────────────────────────────
// Connection record
// ─────────────────────────────────────────────────────────────────────────────

export type ConnectionRecord = {
  readonly connectionId: string;
  readonly socket:       WebSocket;
  readonly connectedAt:  number;
  /** Set after AUTH succeeds. */
  sessionToken:          SessionToken | null;
  /** Set after AUTH succeeds. */
  playerId:              PlayerId | null;
  authenticated:         boolean;
  lastMessageAt:         number;
  /** AUTH timeout handle — cleared on successful AUTH. */
  authTimer:             ReturnType<typeof setTimeout> | null;
  /** Idle timeout handle — reset on every message. */
  idleTimer:             ReturnType<typeof setTimeout> | null;
  rateBucket:            RateBucket;
};

// ─────────────────────────────────────────────────────────────────────────────
// ConnectionManager
// ─────────────────────────────────────────────────────────────────────────────

export class ConnectionManager {
  private readonly connections = new Map<string, ConnectionRecord>();

  /** Called by MessageRouter when AUTH_TIMEOUT fires — tells router to close. */
  onAuthTimeout?: (connectionId: string) => void;
  /** Called when idle timeout fires. */
  onIdleTimeout?:  (connectionId: string) => void;

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Register a new WebSocket connection.
   * Returns the assigned connectionId.
   */
  register(socket: WebSocket): string {
    const connectionId = randomUUID();
    const now          = Date.now();

    const record: ConnectionRecord = {
      connectionId,
      socket,
      connectedAt:   now,
      sessionToken:  null,
      playerId:      null,
      authenticated: false,
      lastMessageAt: now,
      authTimer:     null,
      idleTimer:     null,
      rateBucket:    { windowStart: now, count: 0 },
    };

    // Start AUTH timeout
    record.authTimer = setTimeout(() => {
      logger.warn('Auth timeout', { connectionId });
      this.onAuthTimeout?.(connectionId);
    }, AUTH_TIMEOUT_MS);

    // Start idle timeout
    record.idleTimer = setTimeout(() => {
      logger.warn('Idle timeout', { connectionId });
      this.onIdleTimeout?.(connectionId);
    }, CONNECTION_IDLE_TIMEOUT_MS);

    this.connections.set(connectionId, record);
    logger.debug('Connection registered', { connectionId });
    return connectionId;
  }

  /**
   * Mark the connection as authenticated. Clears the AUTH timeout.
   */
  authenticate(
    connectionId: string,
    sessionToken: SessionToken,
    playerId: PlayerId,
  ): void {
    const rec = this.connections.get(connectionId);
    if (!rec) return;

    if (rec.authTimer !== null) {
      clearTimeout(rec.authTimer);
      rec.authTimer = null;
    }

    rec.sessionToken  = sessionToken;
    rec.playerId      = playerId;
    rec.authenticated = true;

    logger.debug('Connection authenticated', { connectionId, playerId });
  }

  /**
   * Remove a connection and clean up all timers.
   */
  unregister(connectionId: string): void {
    const rec = this.connections.get(connectionId);
    if (!rec) return;

    if (rec.authTimer !== null) clearTimeout(rec.authTimer);
    if (rec.idleTimer !== null) clearTimeout(rec.idleTimer);

    this.connections.delete(connectionId);
    logger.debug('Connection unregistered', { connectionId });
  }

  // ── Sending ───────────────────────────────────────────────────────────────

  /**
   * Serialise and send an event object to a specific connection.
   * Silently drops the message if the connection is gone or closing.
   */
  send(connectionId: string, event: Record<string, unknown>): void {
    const rec = this.connections.get(connectionId);
    if (!rec) return;

    const { socket } = rec;
    if (socket.readyState !== 1 /* OPEN */) return;

    try {
      socket.send(JSON.stringify(event));
    } catch (err) {
      logger.error('Send failed', { connectionId, err: String(err) });
    }
  }

  /**
   * Close a connection with a given code and reason.
   * Also sends a final event if provided (e.g. ERROR before close).
   */
  close(
    connectionId: string,
    code: number,
    reason: string,
    finalEvent?: Record<string, unknown>,
  ): void {
    const rec = this.connections.get(connectionId);
    if (!rec) return;

    if (finalEvent) this.send(connectionId, finalEvent);

    try {
      rec.socket.close(code, reason);
    } catch {
      /* ignore */
    }

    this.unregister(connectionId);
  }

  // ── Rate limiting ─────────────────────────────────────────────────────────

  /**
   * Returns true if the connection is within its rate limit.
   * Side effect: increments the bucket counter.
   */
  checkRateLimit(connectionId: string): boolean {
    const rec = this.connections.get(connectionId);
    if (!rec) return false;
    return checkRate(rec.rateBucket);
  }

  // ── Message tracking ──────────────────────────────────────────────────────

  /**
   * Touch last-message timestamp and reset the idle timer.
   * Call on every received message.
   */
  touch(connectionId: string): void {
    const rec = this.connections.get(connectionId);
    if (!rec) return;

    rec.lastMessageAt = Date.now();

    // Reset idle timer
    if (rec.idleTimer !== null) clearTimeout(rec.idleTimer);
    rec.idleTimer = setTimeout(() => {
      logger.warn('Idle timeout', { connectionId });
      this.onIdleTimeout?.(connectionId);
    }, CONNECTION_IDLE_TIMEOUT_MS);
  }

  // ── Frame size guard ──────────────────────────────────────────────────────

  /**
   * Returns true if the raw frame string is within the allowed size.
   */
  isFrameSizeOk(rawFrame: string): boolean {
    return Buffer.byteLength(rawFrame, 'utf8') <= MAX_FRAME_BYTES;
  }

  // ── Lookups ───────────────────────────────────────────────────────────────

  getRecord(connectionId: string): ConnectionRecord | null {
    return this.connections.get(connectionId) ?? null;
  }

  getConnectionIdForPlayer(playerId: PlayerId): string | null {
    for (const [id, rec] of this.connections) {
      if (rec.playerId === playerId) return id;
    }
    return null;
  }

  get connectionCount(): number { return this.connections.size; }
}
