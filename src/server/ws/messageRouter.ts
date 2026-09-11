/**
 * Thin transport adapter between raw WebSocket frames and the application-layer
 * command handlers. No business logic — every decision is delegated to
 * commandHandler.ts or the game engine via GameSession.
 */

import { randomUUID } from 'node:crypto';

import type { SessionToken, PlayerId, CommandId } from '../../shared/protocol/types.js';
import { brand } from '../../shared/protocol/types.js';
import { CommandType } from '../../shared/protocol/commands.js';
import { parseCommand } from '../../shared/protocol/guards.js';
import { ERROR_META } from '../../shared/protocol/errors.js';
import { makeErrorEvent } from '../utils/eventFactory.js';
import { logger } from '../utils/logger.js';
import type { ConnectionManager } from './connectionManager.js';
import type { ServerContext } from '../app/commandHandler.js';
import {
  handleAuth, handleJoinRoom, handleLeaveRoom, handlePlayerReady,
  handleMakeMove, handleRequestRematch, handleAcceptRematch, handleDeclineRematch,
  handlePing, handleReconnect, handleSyncRequest, handleDisconnect,
  registerPlayerConnection, unregisterPlayerConnection, getPlayerConnectionIds,
} from '../app/commandHandler.js';
import type { Delivery } from '../app/commandHandler.js';

export class MessageRouter {
  constructor(
    private readonly cm:  ConnectionManager,
    private readonly ctx: ServerContext,
  ) {}

  /** Entry point called by WsServer on every 'message' event. */
  handleFrame(connectionId: string, rawFrame: string): void {
    if (!this.cm.isFrameSizeOk(rawFrame)) {
      this.sendError(connectionId, 'MESSAGE_TOO_LARGE');
      return;
    }

    this.cm.touch(connectionId);

    if (!this.cm.checkRateLimit(connectionId)) {
      this.sendError(connectionId, 'RATE_LIMITED');
      return;
    }

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

    // Auth guard — AUTH and PING are exempt.
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

    // The routing switch and delivery run inside an exception boundary: any
    // unexpected throw in a handler is converted into the protocol's
    // INTERNAL_ERROR event (carrying a traceId) rather than propagating out of
    // the ws 'message' callback and taking down the connection silently.
    let result;

    try {
    switch (cmd.type) {
      case CommandType.AUTH: {
        result = handleAuth(connectionId, cmd, this.ctx);
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

    this.deliver(result.deliveries);
    this.ctx.metrics.recordCommandDuration(Date.now() - commandStartedAt);

    if (result.closeCode !== undefined) {
      this.cm.close(connectionId, result.closeCode, result.closeReason ?? '');
    }
    } catch (err) {
      // Unexpected server-side failure while handling a well-formed command.
      const traceId = randomUUID();
      logger.error('Unhandled error while processing command', {
        connectionId,
        commandType: cmd.type,
        traceId,
        err: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });

      this.ctx.metrics.recordError('INTERNAL_ERROR');
      const meta  = ERROR_META['INTERNAL_ERROR'];
      const event = makeErrorEvent(
        'INTERNAL_ERROR',
        meta.summary,
        meta.recoverable,
        cmd.commandId as CommandId,
        { traceId },
      );
      this.cm.send(connectionId, event as unknown as Record<string, unknown>);
    }
  }

  /** Called by WsServer on connection close; notifies the application layer. */
  handleClose(connectionId: string): void {
    const rec = this.cm.getRecord(connectionId);
    if (!rec?.sessionToken) {
      this.cm.unregister(connectionId);
      return;
    }

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

  private deliver(deliveries: Delivery[]): void {
    for (const d of deliveries) {
      if (d.target === 'connection') {
        this.cm.send(d.id, d.event);
      } else if (d.target === 'broadcast') {
        // Handlers only return 'broadcast' for presence events (PLAYER_JOINED etc.);
        // room-level broadcast is driven by GameSession.sendFn. Here d.id is a
        // playerId resolved to its connections via the registry.
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
