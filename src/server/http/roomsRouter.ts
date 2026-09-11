/** Express routers for the non-realtime HTTP surface: rooms API plus health/metrics. */

import { Router } from 'express';
import type { Request, Response } from 'express';
import type { ServerContext } from '../app/commandHandler.js';
import { roomStatus, playerCount } from '../app/roomStore.js';
import { logger } from '../utils/logger.js';
import { isRoomId } from '../../shared/protocol/guards.js';
import type { RoomId } from '../../shared/protocol/types.js';
import { createFixedWindowLimiter } from './rateLimiter.js';

/** Coarse abuse protection for the unauthenticated room-creation endpoint. */
const ROOM_CREATE_WINDOW_MS = 60_000;
const ROOM_CREATE_MAX_PER_WINDOW = 20;

/** Extract a best-effort client identifier for rate-limit keying. */
function clientKey(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}

export function createRoomsRouter(ctx: ServerContext): Router {
  const router = Router();

  const createLimiter = createFixedWindowLimiter({
    windowMs: ROOM_CREATE_WINDOW_MS,
    max: ROOM_CREATE_MAX_PER_WINDOW,
  });

  router.post('/rooms', (req: Request, res: Response) => {
    const { allowed, retryAfterMs } = createLimiter.check(clientKey(req));
    if (!allowed) {
      res.setHeader('Retry-After', String(Math.ceil(retryAfterMs / 1000)));
      res.status(429).json({ error: 'RATE_LIMITED', retryAfterMs });
      return;
    }

    const room = ctx.rooms.createRoom();

    logger.info('Room created via HTTP', { roomId: room.roomId });

    res.status(201).json({
      roomId:    room.roomId,
      createdAt: room.createdAt,
      joinUrl:   `/rooms/${room.roomId}`,
    });
  });

  router.get('/rooms/:id', (req: Request, res: Response) => {
    const id = req.params['id'] ?? '';
    if (!isRoomId(id)) {
      res.status(400).json({ error: 'INVALID_ROOM_ID' });
      return;
    }

    const room = ctx.rooms.getRoom(id as RoomId);
    if (!room) {
      res.status(404).json({ error: 'ROOM_NOT_FOUND' });
      return;
    }

    const gs     = ctx.gameSessions.get(room.roomId);
    const state  = gs?.state ?? null;

    res.json({
      roomId:       room.roomId,
      status:       roomStatus(room),
      playerCount:  playerCount(room),
      createdAt:    room.createdAt,
      currentGame:  state ? {
        gameId:     state.gameId,
        status:     state.status,
        moveCount:  state.moveHistory.length,
        currentTurn: state.currentTurn,
      } : null,
    });
  });

  router.get('/rooms/:id/history', (req: Request, res: Response) => {
    const id = req.params['id'] ?? '';
    if (!isRoomId(id)) {
      res.status(400).json({ error: 'INVALID_ROOM_ID' });
      return;
    }

    const room = ctx.rooms.getRoom(id as RoomId);
    if (!room) {
      res.status(404).json({ error: 'ROOM_NOT_FOUND' });
      return;
    }

    const gs = ctx.gameSessions.get(room.roomId);
    res.json({ roomId: room.roomId, games: gs?.completedGameRecords ?? [] });
  });

  return router;
}

export function createSystemRouter(
  ctx: ServerContext,
  getConnectionCount: () => number,
): Router {
  const router = Router();

  router.get('/health', (_req: Request, res: Response) => {
    res.json({
      status:    'healthy',
      timestamp: Date.now(),
      uptime:    process.uptime(),
    });
  });

  router.get('/metrics', (_req: Request, res: Response) => {
    const mem = process.memoryUsage();
    res.json({
      connections:  getConnectionCount(),
      rooms:        ctx.rooms.roomCount,
      sessions:     ctx.sessions.sessionCount,
      gameSessions: ctx.gameSessions.size,
      memory: {
        heapUsedMB:  (mem.heapUsed  / 1024 / 1024).toFixed(2),
        heapTotalMB: (mem.heapTotal / 1024 / 1024).toFixed(2),
        rssMB:       (mem.rss       / 1024 / 1024).toFixed(2),
      },
      protocol: ctx.metrics.snapshot(),
      uptime: process.uptime(),
    });
  });

  return router;
}
