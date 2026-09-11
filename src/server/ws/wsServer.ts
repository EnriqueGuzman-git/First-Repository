/**
 * WebSocket server setup, HTTP upgrade handling, and connection lifecycle
 * wiring — the entry point for all WebSocket traffic.
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

/** Attach a WebSocket server to an existing HTTP server. */
export function createWsServer(
  httpServer: HttpServer,
  ctx: ServerContext,
  options: WsServerOptions,
): { close: () => Promise<void>; connectionManager: ConnectionManager } {
  const cm     = new ConnectionManager();
  const router = new MessageRouter(cm, ctx);

  // Inject the concrete send implementation so GameSession's sendFn can reach
  // connections without importing transport types.
  wireSendToConnection((connectionId, event) => cm.send(connectionId, event));

  cm.onAuthTimeout = (connectionId) => {
    const code  = 'AUTH_TIMEOUT';
    const meta  = ERROR_META[code];
    const event = makeErrorEvent(code, meta.summary, false);
    cm.close(connectionId, 4008, 'Authentication timeout',
      event as unknown as Record<string, unknown>);
  };

  cm.onIdleTimeout = (connectionId) => {
    cm.close(connectionId, 4006, 'Connection idle timeout');
  };

  const wss = new WebSocketServer({
    server: httpServer,
    path:   '/ws',

    // Reject connections that don't request the ttt-v1 subprotocol.
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

    // Disabled: per-message deflate adds latency for small JSON payloads.
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
