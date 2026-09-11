/**
 * WebSocket connection registry: assigns connectionIds, tracks auth/session
 * mapping, timers, and rate limits. Transport only — no game or protocol logic.
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

const RATE_WINDOW_MS   = 10_000;
const RATE_MAX_MSGS    = 60;     // §16 PROTOCOL.md

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

export class ConnectionManager {
  private readonly connections = new Map<string, ConnectionRecord>();

  /** Called by MessageRouter when AUTH_TIMEOUT fires — tells router to close. */
  onAuthTimeout?: (connectionId: string) => void;
  /** Called when idle timeout fires. */
  onIdleTimeout?:  (connectionId: string) => void;

  /** Register a new WebSocket connection; returns the assigned connectionId. */
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

    record.authTimer = setTimeout(() => {
      logger.warn('Auth timeout', { connectionId });
      this.onAuthTimeout?.(connectionId);
    }, AUTH_TIMEOUT_MS);

    record.idleTimer = setTimeout(() => {
      logger.warn('Idle timeout', { connectionId });
      this.onIdleTimeout?.(connectionId);
    }, CONNECTION_IDLE_TIMEOUT_MS);

    this.connections.set(connectionId, record);
    logger.debug('Connection registered', { connectionId });
    return connectionId;
  }

  /** Mark the connection authenticated and clear the AUTH timeout. */
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

  /** Remove a connection and clean up all timers. */
  unregister(connectionId: string): void {
    const rec = this.connections.get(connectionId);
    if (!rec) return;

    if (rec.authTimer !== null) clearTimeout(rec.authTimer);
    if (rec.idleTimer !== null) clearTimeout(rec.idleTimer);

    this.connections.delete(connectionId);
    logger.debug('Connection unregistered', { connectionId });
  }

  /** Send an event to a connection; silently drops if it's gone or closing. */
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

  /** Best-effort send to every open connection (e.g. SERVER_SHUTTING_DOWN). */
  broadcastAll(event: Record<string, unknown>): void {
    const payload = JSON.stringify(event);
    for (const rec of this.connections.values()) {
      if (rec.socket.readyState !== 1 /* OPEN */) continue;
      try {
        rec.socket.send(payload);
      } catch (err) {
        logger.error('Broadcast send failed', {
          connectionId: rec.connectionId,
          err: String(err),
        });
      }
    }
  }

  /** Close a connection, optionally sending a final event first (e.g. ERROR). */
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

  /** True if within rate limit. Side effect: increments the bucket counter. */
  checkRateLimit(connectionId: string): boolean {
    const rec = this.connections.get(connectionId);
    if (!rec) return false;
    return checkRate(rec.rateBucket);
  }

  /** Update last-message timestamp and reset the idle timer, per message. */
  touch(connectionId: string): void {
    const rec = this.connections.get(connectionId);
    if (!rec) return;

    rec.lastMessageAt = Date.now();

    if (rec.idleTimer !== null) clearTimeout(rec.idleTimer);
    rec.idleTimer = setTimeout(() => {
      logger.warn('Idle timeout', { connectionId });
      this.onIdleTimeout?.(connectionId);
    }, CONNECTION_IDLE_TIMEOUT_MS);
  }

  /** True if the raw frame is within the allowed size. */
  isFrameSizeOk(rawFrame: string): boolean {
    return Buffer.byteLength(rawFrame, 'utf8') <= MAX_FRAME_BYTES;
  }

  getRecord(connectionId: string): ConnectionRecord | null {
    return this.connections.get(connectionId) ?? null;
  }

  get connectionCount(): number { return this.connections.size; }
}
