/**
 * @file wsClient.ts
 * @description Raw WebSocket transport layer.
 *
 * Responsibilities:
 *  - Manage the WebSocket connection lifecycle (open → auth → running).
 *  - Exponential-backoff reconnection with jitter.
 *  - Application-level PING/PONG heartbeat.
 *  - Frame-level parse + type-guard validation via parseEvent.
 *  - Sequence-gap detection: emit SYNC_REQUEST when events arrive out-of-order.
 *  - Measure round-trip latency per PONG.
 *  - Persist sessionToken + roomId in sessionStorage for reconnect.
 *
 * This module contains NO React, NO game logic, and NO store references.
 * It is a pure transport layer; callers inject callbacks.
 */

import {
  parseEvent,
  PROTOCOL_VERSION,
  WS_SUBPROTOCOL,
  CLIENT_PING_INTERVAL_MS,
  PONG_TIMEOUT_MS,
  brand,
} from '@ttt/shared/protocol';

import type {
  AnyEvent,
  ErrorEvent,
  SessionToken,
  RoomId,
  CommandId,
} from '@ttt/shared/protocol';

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

export type WsState =
  | 'IDLE'
  | 'CONNECTING'
  | 'CONNECTED'       // socket open, not yet authenticated
  | 'AUTHENTICATED'   // AUTH_ACK received
  | 'RECONNECTING'
  | 'CLOSED';

export type WsClientCallbacks = {
  onStateChange:    (state: WsState) => void;
  onEvent:          (event: AnyEvent | ErrorEvent) => void;
  onSequenceGap:    (fromSeq: number) => void;
  onLatency:        (rttMs: number) => void;
  /** Called with the raw string when the frame cannot be parsed at all. */
  onParseError:     (raw: string) => void;
};

export type WsClientConfig = {
  url:             string;
  /** CLIENT_VERSION string included in AUTH command. */
  clientVersion:   string;
  maxRetries?:     number;   // default 8
  baseDelayMs?:    number;   // default 500
  maxDelayMs?:     number;   // default 30_000
};

// ─────────────────────────────────────────────────────────────────────────────
// Storage keys
// ─────────────────────────────────────────────────────────────────────────────

const STORAGE_SESSION_TOKEN = 'ttt_session_token';
const STORAGE_PLAYER_ID     = 'ttt_player_id';
const STORAGE_ROOM_ID       = 'ttt_room_id';

// ─────────────────────────────────────────────────────────────────────────────
// WsClient
// ─────────────────────────────────────────────────────────────────────────────

export class WsClient {
  private ws:             WebSocket | null = null;
  private state:          WsState = 'IDLE';
  private retryCount      = 0;
  private retryTimer:     ReturnType<typeof setTimeout> | null = null;
  private pingTimer:      ReturnType<typeof setInterval> | null = null;
  private pongTimer:      ReturnType<typeof setTimeout> | null = null;
  private lastSeq         = 0;
  private destroyed       = false;

  // Stored for reconnect
  private sessionToken:   SessionToken | null = null;
  private roomId:         RoomId | null = null;
  private pingTime:       number = 0;

  private readonly maxRetries:  number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs:  number;

  constructor(
    private readonly config:    WsClientConfig,
    private readonly callbacks: WsClientCallbacks,
  ) {
    this.maxRetries  = config.maxRetries  ?? 8;
    this.baseDelayMs = config.baseDelayMs ?? 500;
    this.maxDelayMs  = config.maxDelayMs  ?? 30_000;

    // Restore persisted credentials
    const storedToken = sessionStorage.getItem(STORAGE_SESSION_TOKEN);
    const storedRoom  = sessionStorage.getItem(STORAGE_ROOM_ID);
    if (storedToken) this.sessionToken = brand<SessionToken>(storedToken);
    if (storedRoom)  this.roomId       = brand<RoomId>(storedRoom);
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  connect(): void {
    if (this.destroyed) return;
    if (this.ws && this.ws.readyState <= 1 /* OPEN */) return;
    this.openSocket();
  }

  /**
   * Send a pre-built command object. The caller is responsible for building
   * the envelope (commandBuilder.ts). Queues silently when not yet open.
   */
  send(message: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(message));
  }

  /** Store roomId so RECONNECT is sent automatically after re-AUTH. */
  setRoom(roomId: RoomId | null): void {
    this.roomId = roomId;
    if (roomId) {
      sessionStorage.setItem(STORAGE_ROOM_ID, roomId);
    } else {
      sessionStorage.removeItem(STORAGE_ROOM_ID);
    }
  }

  /** Reset sequence counter when a new game session begins (GAME_STARTED). */
  resetSequence(): void {
    this.lastSeq = 0;
  }

  getState(): WsState  { return this.state; }
  getSessionToken():   SessionToken | null { return this.sessionToken; }
  getRoomId():         RoomId | null       { return this.roomId; }

  destroy(): void {
    this.destroyed = true;
    this.stopHeartbeat();
    this.cancelRetry();
    this.ws?.close(1000, 'Client destroyed');
    this.ws = null;
    this.setState('CLOSED');
  }

  // ── Connection ─────────────────────────────────────────────────────────────

  private openSocket(): void {
    this.setState(this.retryCount === 0 ? 'CONNECTING' : 'RECONNECTING');

    try {
      const ws = new WebSocket(this.config.url, WS_SUBPROTOCOL);
      this.ws  = ws;

      ws.onopen = () => {
        this.retryCount = 0;
        this.setState('CONNECTED');
        this.sendAuth();
        this.startHeartbeat();
      };

      ws.onmessage = (ev: MessageEvent<string>) => {
        this.handleFrame(ev.data);
      };

      ws.onclose = (ev) => {
        this.stopHeartbeat();
        if (this.destroyed) return;
        const terminal =
          ev.code === 4001 || // unsupported version
          ev.code === 4003 || // origin denied
          ev.code === 1008;   // policy violation
        if (terminal) {
          this.setState('CLOSED');
        } else {
          this.scheduleRetry();
        }
      };

      ws.onerror = () => {
        // The onclose handler fires after onerror — let it drive retry logic.
      };
    } catch {
      this.scheduleRetry();
    }
  }

  // ── AUTH ───────────────────────────────────────────────────────────────────

  private sendAuth(): void {
    const commandId = crypto.randomUUID();
    const messageId = crypto.randomUUID();
    this.send({
      protocolVersion: PROTOCOL_VERSION,
      messageId,
      timestamp:       Date.now(),
      type:            'AUTH',
      commandId,
      sessionToken:    null,
      guestToken:      this.sessionToken ?? null,
      clientVersion:   this.config.clientVersion,
    });
  }

  // ── Heartbeat ──────────────────────────────────────────────────────────────

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.pingTimer = setInterval(() => this.sendPing(), CLIENT_PING_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.pingTimer !== null) { clearInterval(this.pingTimer); this.pingTimer = null; }
    if (this.pongTimer !== null) { clearTimeout(this.pongTimer);  this.pongTimer = null; }
  }

  private sendPing(): void {
    if (this.state !== 'AUTHENTICATED') return;
    this.pingTime = Date.now();
    const commandId = crypto.randomUUID() as CommandId;
    this.send({
      protocolVersion: PROTOCOL_VERSION,
      messageId:       crypto.randomUUID(),
      timestamp:       this.pingTime,
      type:            'PING',
      commandId,
      sessionToken:    this.sessionToken,
      clientTime:      this.pingTime,
    });

    // Expect PONG within PONG_TIMEOUT_MS
    this.pongTimer = setTimeout(() => {
      // No PONG received — connection is dead
      this.ws?.close(4006, 'Ping timeout');
    }, PONG_TIMEOUT_MS);
  }

  private clearPongTimer(): void {
    if (this.pongTimer !== null) { clearTimeout(this.pongTimer); this.pongTimer = null; }
  }

  // ── Incoming frame handling ────────────────────────────────────────────────

  private handleFrame(raw: string): void {
    const parsed = parseEvent(raw);

    if (!parsed.ok) {
      this.callbacks.onParseError(raw);
      return;
    }

    const event = parsed.event;

    // ── AUTH_ACK: complete authentication ──────────────────────────────────
    if (event.type === 'AUTH_ACK') {
      this.sessionToken = event.sessionToken;
      sessionStorage.setItem(STORAGE_SESSION_TOKEN, event.sessionToken);
      sessionStorage.setItem(STORAGE_PLAYER_ID, event.playerId);
      this.setState('AUTHENTICATED');
    }

    // ── PONG: measure RTT ──────────────────────────────────────────────────
    if (event.type === 'PONG') {
      this.clearPongTimer();
      this.callbacks.onLatency(Date.now() - event.clientTime);
    }

    // ── Sequence-gap detection for room-scoped events ─────────────────────
    if ('sessionSeq' in event && typeof event.sessionSeq === 'number') {
      const seq = event.sessionSeq;
      // GAME_STARTED always resets the counter to 1
      if (event.type === 'GAME_STARTED') {
        this.lastSeq = seq;
      } else if (seq > this.lastSeq + 1) {
        // Gap detected — request sync before advancing
        this.callbacks.onSequenceGap(this.lastSeq + 1);
        this.lastSeq = seq; // advance anyway; store will handle replay
      } else if (seq === this.lastSeq + 1) {
        this.lastSeq = seq;
      }
      // seq <= lastSeq: duplicate — let dispatcher handle idempotently
    }

    // Deliver to caller
    this.callbacks.onEvent(event);
  }

  // ── Retry ──────────────────────────────────────────────────────────────────

  private scheduleRetry(): void {
    if (this.destroyed) return;
    if (this.retryCount >= this.maxRetries) {
      this.setState('CLOSED');
      return;
    }

    this.setState('RECONNECTING');

    const base  = Math.min(this.baseDelayMs * 2 ** this.retryCount, this.maxDelayMs);
    const jitter = Math.random() * 1_000;
    const delay  = base + jitter;

    this.retryCount++;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.openSocket();
    }, delay);
  }

  private cancelRetry(): void {
    if (this.retryTimer !== null) { clearTimeout(this.retryTimer); this.retryTimer = null; }
  }

  // ── State ──────────────────────────────────────────────────────────────────

  private setState(next: WsState): void {
    if (this.state === next) return;
    this.state = next;
    this.callbacks.onStateChange(next);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Singleton factory — one client per browser tab
// ─────────────────────────────────────────────────────────────────────────────

let instance: WsClient | null = null;

export function getWsClient(
  config: WsClientConfig,
  callbacks: WsClientCallbacks,
): WsClient {
  if (!instance) {
    instance = new WsClient(config, callbacks);
  }
  return instance;
}

export function destroyWsClient(): void {
  instance?.destroy();
  instance = null;
}
