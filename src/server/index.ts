/**
 * Server entry point. Creates all layers in dependency order, wires them
 * together, starts listening, and handles graceful shutdown on SIGTERM/SIGINT.
 */

import { createServer } from 'node:http';
import express from 'express';

import { SessionStore }  from './app/sessionStore.js';
import { RoomStore }     from './app/roomStore.js';
import type { ServerContext } from './app/commandHandler.js';
import { createWsServer } from './ws/wsServer.js';
import { createRoomsRouter, createSystemRouter } from './http/roomsRouter.js';
import type { RoomId } from '../shared/protocol/types.js';
import type { GameSession } from './app/gameSession.js';
import { logger } from './utils/logger.js';
import { JsonHistoryRepository } from './app/historyRepository.js';
import { Metrics } from './utils/metrics.js';
import { parseAllowedOrigins, isOriginAllowed } from './security/originPolicy.js';
import { makeErrorEvent } from './utils/eventFactory.js';
import { ERROR_META } from '../shared/protocol/errors.js';

const PORT           = parseInt(process.env['PORT'] ?? '8080', 10);
const SERVER_VERSION = process.env['SERVER_VERSION'] ?? '0.1.0';
const CORS_ORIGIN    = process.env['CORS_ORIGIN'] ?? 'http://localhost:3000';

export function buildServer(options: { historyFilePath?: string } = {}): {
  httpServer: ReturnType<typeof createServer>;
  ctx: ServerContext;
  close: () => Promise<void>;
} {
  const sessions:     SessionStore                = new SessionStore();
  const rooms:        RoomStore                   = new RoomStore();
  const gameSessions: Map<RoomId, GameSession>    = new Map();
  const historyRepository = new JsonHistoryRepository(
    options.historyFilePath ?? process.env['HISTORY_FILE'] ?? 'data/history.json',
  );
  const allowedOrigins = parseAllowedOrigins(CORS_ORIGIN);
  const metrics = new Metrics();

  const ctx: ServerContext = {
    sessions,
    rooms,
    gameSessions,
    historyRepository,
    metrics,
    serverVersion: SERVER_VERSION,
  };

  const app = express();

  app.use(express.json({ limit: '64kb' }));

  // CORS — simple header for Phase 1
  app.use((req, res, next) => {
    const requestOrigin = req.headers.origin;
    if (isOriginAllowed(requestOrigin, allowedOrigins) && requestOrigin) {
      res.setHeader(
        'Access-Control-Allow-Origin',
        allowedOrigins.has('*') ? '*' : requestOrigin,
      );
      res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  app.use('/api', createRoomsRouter(ctx));
  app.use('/',    createSystemRouter(ctx, () => wsServer.connectionManager.connectionCount));

  const httpServer = createServer(app);

  const wsServer = createWsServer(httpServer, ctx, { allowedOrigins });

  const maintenanceInterval = setInterval(() => {
    sessions.purgeExpired();
    rooms.purgeExpired();
  }, 10 * 60 * 1_000); // every 10 minutes

  const close = async (): Promise<void> => {
    logger.info('Server shutting down…');

    clearInterval(maintenanceInterval);

    // Notify connected clients before tearing down sockets so they can show a
    // "server restarting" state and back off, rather than seeing an opaque
    // socket close. SERVER_SHUTTING_DOWN is recoverable-by-reconnect.
    const shutdownMeta = ERROR_META['SERVER_SHUTTING_DOWN'];
    const shutdownEvent = makeErrorEvent(
      'SERVER_SHUTTING_DOWN',
      shutdownMeta.summary,
      shutdownMeta.recoverable,
    );
    wsServer.connectionManager.broadcastAll(
      shutdownEvent as unknown as Record<string, unknown>,
    );

    // Destroy all active game sessions (clears timers)
    for (const gs of gameSessions.values()) gs.destroy();
    gameSessions.clear();

    await wsServer.close();

    await new Promise<void>((resolve, reject) => {
      httpServer.close((err) => (err ? reject(err) : resolve()));
    });

    logger.info('Server shutdown complete');
  };

  return { httpServer, ctx, close };
}

// Guard: do not start listening when imported by tests
if (process.argv[1] && process.argv[1].endsWith('index.js')) {
  const { httpServer, close } = buildServer();

  httpServer.listen(PORT, () => {
    logger.info('Server listening', { port: PORT, version: SERVER_VERSION });
  });

  const shutdown = async (signal: string) => {
    logger.info('Signal received', { signal });
    try {
      await close();
      process.exit(0);
    } catch (err) {
      logger.error('Shutdown error', { err: String(err) });
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => { shutdown('SIGTERM').catch(() => process.exit(1)); });
  process.on('SIGINT',  () => { shutdown('SIGINT').catch(() => process.exit(1)); });
}
