/**
 * @file roomsRouter.ts
 * @description Express router for non-realtime HTTP endpoints.
 *
 * POST /api/rooms          — Create a new room, return the roomId.
 * GET  /api/rooms/:id      — Get current room state snapshot.
 * GET  /api/rooms/:id/history — Get completed game history for a room.
 * GET  /health             — Health check.
 * GET  /metrics            — Observability snapshot.
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import type { ServerContext } from '../app/commandHandler.js';
import { roomStatus, playerCount } from '../app/roomStore.js';
import { logger } from '../utils/logger.js';

export function createRoomsRouter(ctx: ServerContext): Router {
  const router = Router();

  // ── POST /api/rooms ───────────────────────────────────────────────────────

  router.post('/rooms', (_req: Request, res: Response) => {
    const room = ctx.rooms.createRoom();

    logger.info('Room created via HTTP', { roomId: room.roomId });

    res.status(201).json({
      roomId:    room.roomId,
      createdAt: room.createdAt,
      joinUrl:   `/rooms/${room.roomId}`,
    });
  });

  // ── GET /api/rooms/:id ────────────────────────────────────────────────────

  router.get('/rooms/:id', (req: Request, res: Response) => {
    const room = ctx.rooms.getRoom(req.params['id'] as import('../../shared/protocol/types.js').RoomId);
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

  // ── GET /api/rooms/:id/history ────────────────────────────────────────────

  router.get('/rooms/:id/history', (req: Request, res: Response) => {
    const room = ctx.rooms.getRoom(req.params['id'] as import('../../shared/protocol/types.js').RoomId);
    if (!room) {
      res.status(404).json({ error: 'ROOM_NOT_FOUND' });
      return;
    }

    // Phase 1: history is in-memory only; completed games are stored on GameSession
    const gs    = ctx.gameSessions.get(room.roomId);
    const state = gs?.state;

    const games = [];
    if (state?.status === 'FINISHED' && state.result) {
      games.push({
        gameId:      state.gameId,
        outcome:     state.result.outcome,
        winner:      state.result.winner,
        moveCount:   state.moveHistory.length,
        startedAt:   state.createdAt,
        endedAt:     state.endedAt,
        moveHistory: state.moveHistory,
      });
    }

    res.json({ roomId: room.roomId, games });
  });

  return router;
}

// ─────────────────────────────────────────────────────────────────────────────
// Health + Metrics (attached to the app, not /api prefix)
// ─────────────────────────────────────────────────────────────────────────────

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
      uptime: process.uptime(),
    });
  });

  return router;
}
