/**
 * @file messageRouter.ts
 * @description Thin transport adapter between raw WebSocket frames and the
 * application-layer command handlers.
 *
 * Responsibilities (transport only):
 *  1. Parse raw text frame → validate with parseCommand guard.
 *  2. Enforce frame size, rate limit, and authentication pre-checks.
 *  3. Route validated commands to the correct handler function.
 *  4. Deliver HandlerResult.deliveries back through ConnectionManager.
 *  5. Close connection when HandlerResult.closeCode is set.
 *
 * No business logic lives here. Every decision is delegated to commandHandler.ts
 * or the game engine via GameSession.
 */

import type { SessionToken, PlayerId } from '../../shared/protocol/types.js';
import { brand } from '../../shared/protocol/types.js';
import { CommandType } from '../../shared/protocol/commands.js';
import { parseCommand } from '../../shared/protocol/guards.js';
import { ERROR_META } from '../../shared/protocol/errors.js';
import { makeErrorEvent } from '../utils/eventFactory.js';
import type { ConnectionManager } from './connectionManager.js';
import type { ServerContext } from '../app/commandHandler.js';
import {
  handleAuth, handleJoinRoom, handleLeaveRoom, handlePlayerReady,
  handleMakeMove, handleRequestRematch, handleAcceptRematch, handleDeclineRematch,
  handlePing, handleReconnect, handleSyncRequest, handleDisconnect,
  registerPlayerConnection, unregisterPlayerConnection, getPlayerConnectionIds,
} from '../app/commandHandler.js';
import type { Delivery } from '../app/commandHandler.js';

// ─────────────────────────────────────────────────────────────────────────────
// MessageRouter
// ─────────────────────────────────────────────────────────────────────────────

export class MessageRouter {
  constructor(
    private readonly cm:  ConnectionManager,
    private readonly ctx: ServerContext,
  ) {}

  /**
   * Entry point called by WsServer on every 'message' event.
   */
  handleFrame(connectionId: string, rawFrame: string): void {
    // ── 1. Frame size check ────────────────────────────────────────────────
    if (!this.cm.isFrameSizeOk(rawFrame)) {
      this.sendError(connectionId, 'MESSAGE_TOO_LARGE');
      return;
    }

    // ── 2. Touch idle timer ────────────────────────────────────────────────
    this.cm.touch(connectionId);

    // ── 3. Rate limit ──────────────────────────────────────────────────────
    if (!this.cm.checkRateLimit(connectionId)) {
      this.sendError(connectionId, 'RATE_LIMITED');
      return;
    }

    // ── 4. Parse ───────────────────────────────────────────────────────────
    const parseResult = parseCommand(rawFrame);

    if (!parseResult.ok) {
      const code =
        parseResult.reason === 'PROTOCOL_VERSION_MISMATCH'
          ? 'PROTOCOL_VERSION_MISMATCH'
          : parseResult.reason === 'UNKNOWN_MESSAGE_TYPE'
          ? 'UNKNOWN_MESSAGE_TYPE'
          : 'MALFORMED_MESSAGE';

      const meta  = ERROR_META[code];
      this.ctx.metrics.recordError(code);
      const event = makeErrorEvent(code, meta.summary, meta.recoverable);
      if (meta.closesConnection) {
        this.cm.close(connectionId, 4001, code, event as unknown as Record<string, unknown>);
      } else {
        this.cm.send(connectionId, event as unknown as Record<string, unknown>);
      }
      return;
    }

    const cmd = parseResult.command;
    const commandStartedAt = Date.now();
    this.ctx.metrics.recordCommand(cmd.type);

    // ── 5. Auth guard (except AUTH and PING) ───────────────────────────────
    const rec = this.cm.getRecord(connectionId);
    if (!rec) return;

    const isAuthExempt = cmd.type === CommandType.AUTH || cmd.type === CommandType.PING;

    if (!rec.authenticated && !isAuthExempt) {
      this.sendError(connectionId, 'NOT_AUTHENTICATED', cmd.commandId as string);
      return;
    }

    const sessionToken: SessionToken | null = rec.sessionToken;

    if (rec.authenticated && sessionToken) {
      if (!this.ctx.sessions.getSession(sessionToken)) {
        this.sendError(connectionId, 'SESSION_EXPIRED', cmd.commandId as string);
        return;
      }
      this.ctx.sessions.touch(sessionToken);
    }

    // ── 6. Route ───────────────────────────────────────────────────────────
    let result;

    switch (cmd.type) {
      case CommandType.AUTH: {
        result = handleAuth(connectionId, cmd, this.ctx);
        // On success, wire up connection → session
        if (result.deliveries.length > 0) {
          const ev = result.deliveries[0]?.event;
          if (ev?.['type'] === 'AUTH_ACK') {
            const token    = ev['sessionToken'] as SessionToken;
            const playerId = ev['playerId'] as PlayerId;
            this.cm.authenticate(connectionId, token, playerId);
            // Register in the player→connection map used by GameSession.sendFn
            registerPlayerConnection(playerId, connectionId);
          }
        }
        break;
      }

      case CommandType.JOIN_ROOM:
        result = handleJoinRoom(connectionId, cmd, this.ctx, sessionToken!);
        break;

      case CommandType.LEAVE_ROOM:
        result = handleLeaveRoom(connectionId, cmd, this.ctx, sessionToken!);
        break;

      case CommandType.PLAYER_READY:
        result = handlePlayerReady(connectionId, cmd, this.ctx, sessionToken!);
        break;

      case CommandType.MAKE_MOVE:
        result = handleMakeMove(connectionId, cmd, this.ctx, sessionToken!);
        break;

      case CommandType.REQUEST_REMATCH:
        result = handleRequestRematch(connectionId, cmd, this.ctx, sessionToken!);
        break;

      case CommandType.ACCEPT_REMATCH:
        result = handleAcceptRematch(connectionId, cmd, this.ctx, sessionToken!);
        break;

      case CommandType.DECLINE_REMATCH:
        result = handleDeclineRematch(connectionId, cmd, this.ctx, sessionToken!);
        break;

      case CommandType.PING:
        result = handlePing(connectionId, cmd);
        break;

      case CommandType.RECONNECT:
        result = handleReconnect(connectionId, cmd, this.ctx, sessionToken!);
        // Re-register player→connection after reconnect
        if (rec.playerId) {
          registerPlayerConnection(rec.playerId, connectionId);
        }
        break;

      case CommandType.SYNC_REQUEST:
        result = handleSyncRequest(connectionId, cmd, this.ctx, sessionToken!);
        break;

      default: {
        // TypeScript exhaustiveness — should never reach here
        const _: never = cmd;
        result = { deliveries: [] as Delivery[] };
        break;
      }
    }

    // ── 7. Deliver results ─────────────────────────────────────────────────
    this.deliver(result.deliveries);
    this.ctx.metrics.recordCommandDuration(Date.now() - commandStartedAt);

    if (result.closeCode !== undefined) {
      this.cm.close(connectionId, result.closeCode, result.closeReason ?? '');
    }
  }

  /**
   * Called by WsServer on connection close. Notifies the application layer.
   */
  handleClose(connectionId: string): void {
    const rec = this.cm.getRecord(connectionId);
    if (!rec?.sessionToken) {
      this.cm.unregister(connectionId);
      return;
    }

    // Remove from player→connection registry
    if (rec.playerId) {
      const hasRemainingConnection = unregisterPlayerConnection(rec.playerId, connectionId);
      if (hasRemainingConnection) {
        this.cm.unregister(connectionId);
        return;
      }
    }

    handleDisconnect(rec.sessionToken, this.ctx);
    this.cm.unregister(connectionId);
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  private deliver(deliveries: Delivery[]): void {
    for (const d of deliveries) {
      if (d.target === 'connection') {
        this.cm.send(d.id, d.event);
      } else if (d.target === 'broadcast') {
        // Broadcast via playerConnectionRegistry — send to all players in the room
        // The room-level broadcast is driven by GameSession.sendFn; the handler
        // only returns 'broadcast' for presence events (PLAYER_JOINED etc.)
        // In that case, d.id is a playerId, and we find the connection via registry.
        for (const connId of getPlayerConnectionIds(brand<PlayerId>(d.id))) {
          this.cm.send(connId, d.event);
        }
      } else if (d.target === 'others') {
        for (const connId of getPlayerConnectionIds(brand<PlayerId>(d.id))) {
          this.cm.send(connId, d.event);
        }
      }
    }
  }

  private sendError(
    connectionId: string,
    code: keyof typeof ERROR_META,
    correlationId?: string,
  ): void {
    const meta  = ERROR_META[code];
    this.ctx.metrics.recordError(code);
    const event = makeErrorEvent(
      code, meta.summary, meta.recoverable,
      correlationId ? brand<import('../../shared/protocol/types.js').CommandId>(correlationId) : undefined,
    );
    if (meta.closesConnection) {
      this.cm.close(connectionId, 4001, code, event as unknown as Record<string, unknown>);
    } else {
      this.cm.send(connectionId, event as unknown as Record<string, unknown>);
    }
  }
}
