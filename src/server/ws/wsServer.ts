/**
 * @file wsServer.ts
 * @description WebSocket server setup, HTTP upgrade handling, and connection
 * lifecycle wiring.
 *
 * This file is the entry point for all WebSocket traffic. It:
 *  1. Creates a ws.WebSocketServer attached to an existing http.Server.
 *  2. Enforces the 'ttt-v1' subprotocol during the HTTP upgrade.
 *  3. Registers each new socket with ConnectionManager.
 *  4. Routes each 'message' event to MessageRouter.handleFrame.
 *  5. Routes each 'close' / 'error' event to MessageRouter.handleClose.
 *  6. Wires the ConnectionManager.send function into the command handler layer
 *     so GameSession can reach connections without importing transport types.
 */

import { WebSocketServer } from 'ws';
import type { IncomingMessage } from 'node:http';
import type { Server as HttpServer } from 'node:http';

import { WS_SUBPROTOCOL } from '../../shared/protocol/types.js';
import { ERROR_META } from '../../shared/protocol/errors.js';
import { makeErrorEvent } from '../utils/eventFactory.js';
import { wireSendToConnection } from '../app/commandHandler.js';
import { ConnectionManager } from './connectionManager.js';
import { MessageRouter } from './messageRouter.js';
import type { ServerContext } from '../app/commandHandler.js';
import { logger } from '../utils/logger.js';
import { isOriginAllowed } from '../security/originPolicy.js';

export type WsServerOptions = {
  readonly allowedOrigins: ReadonlySet<string>;
};

// ─────────────────────────────────────────────────────────────────────────────
// createWsServer
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Attach a WebSocket server to an existing HTTP server.
 *
 * @returns A cleanup function that closes the WebSocket server gracefully.
 */
export function createWsServer(
  httpServer: HttpServer,
  ctx: ServerContext,
  options: WsServerOptions,
): { close: () => Promise<void>; connectionManager: ConnectionManager } {
  const cm     = new ConnectionManager();
  const router = new MessageRouter(cm, ctx);

  // ── Wire GameSession → ConnectionManager ──────────────────────────────────
  // GameSession's sendFn calls playerConnectionRegistry + sendToConnectionId.
  // We inject the concrete send implementation here to complete the dependency.
  wireSendToConnection((connectionId, event) => cm.send(connectionId, event));

  // ── AUTH timeout callback ─────────────────────────────────────────────────
  cm.onAuthTimeout = (connectionId) => {
    const code  = 'AUTH_TIMEOUT';
    const meta  = ERROR_META[code];
    const event = makeErrorEvent(code, meta.summary, false);
    cm.close(connectionId, 4008, 'Authentication timeout',
      event as unknown as Record<string, unknown>);
  };

  // ── Idle timeout callback ─────────────────────────────────────────────────
  cm.onIdleTimeout = (connectionId) => {
    cm.close(connectionId, 4006, 'Connection idle timeout');
  };

  // ── WebSocket server ──────────────────────────────────────────────────────
  const wss = new WebSocketServer({
    server: httpServer,
    path:   '/ws',

    // Subprotocol negotiation — reject connections that don't request ttt-v1
    handleProtocols: (protocols: Set<string>, _req: IncomingMessage) => {
      if (protocols.has(WS_SUBPROTOCOL)) return WS_SUBPROTOCOL;
      return false; // causes ws to send 400
    },

    verifyClient: (info, done) => {
      if (isOriginAllowed(info.origin || undefined, options.allowedOrigins)) {
        done(true);
        return;
      }
      done(false, 403, 'Origin not allowed');
    },

    // Per-message deflate disabled — adds latency for small JSON payloads
    perMessageDeflate: false,
  });

  wss.on('connection', (socket, req) => {
    const ip           = req.socket.remoteAddress ?? 'unknown';
    const connectionId = cm.register(socket);

    logger.info('WebSocket connected', { connectionId, ip });

    socket.on('message', (data) => {
      const raw = data.toString('utf8');
      router.handleFrame(connectionId, raw);
    });

    socket.on('close', (code, reason) => {
      logger.info('WebSocket closed', {
        connectionId,
        code,
        reason: reason.toString(),
      });
      router.handleClose(connectionId);
    });

    socket.on('error', (err) => {
      logger.error('WebSocket error', { connectionId, err: err.message });
      router.handleClose(connectionId);
    });

    // WebSocket-level ping/pong for proxy keepalive (distinct from app-level PING)
    socket.on('pong', () => {
      cm.touch(connectionId);
    });
  });

  // Server-side WS ping every 30s (proxy keepalive)
  const pingInterval = setInterval(() => {
    wss.clients.forEach((client) => {
      if (client.readyState === 1 /* OPEN */) {
        client.ping();
      }
    });
  }, 30_000);

  wss.on('error', (err) => {
    logger.error('WebSocketServer error', { err: err.message });
  });

  // ── Graceful shutdown ─────────────────────────────────────────────────────
  const close = (): Promise<void> =>
    new Promise((resolve) => {
      clearInterval(pingInterval);
      wss.close(() => {
        logger.info('WebSocket server closed');
        resolve();
      });
    });

  logger.info('WebSocket server ready', { path: '/ws', protocol: WS_SUBPROTOCOL });

  return { close, connectionManager: cm };
}
