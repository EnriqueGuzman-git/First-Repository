/**
 * @file useWebSocket.ts
 * @description React hook that owns the WsClient lifecycle and maps every
 * incoming server event to a GameAction dispatch.
 *
 * This is the only file that imports WsClient in React code.
 * It bridges transport events → store actions → React re-renders.
 */

import { useEffect, useRef, useCallback } from 'react';

import type {
  AnyEvent, ErrorEvent,
  RoomId, GameId, WinningLine, PlayerInfo,
} from '@ttt/shared/protocol';
import { EventType } from '@ttt/shared/protocol';

import { WsClient } from '../lib/wsClient';
import type { WsClientConfig, WsState } from '../lib/wsClient';
import { buildReconnect, buildSyncRequest, newCommandId } from '../lib/commandBuilder';
import type { GameAction, ClientState } from '../store/gameStore';

// ─────────────────────────────────────────────────────────────────────────────
// useWebSocket
// ─────────────────────────────────────────────────────────────────────────────

export function useWebSocket(
  config:    WsClientConfig,
  state:     ClientState,
  dispatch:  (action: GameAction) => void,
): {
  sendRaw: (msg: Record<string, unknown>) => void;
  client:  WsClient | null;
} {
  const clientRef  = useRef<WsClient | null>(null);
  const stateRef   = useRef<ClientState>(state);
  stateRef.current = state;

  // Keep a stable send function so consumers don't re-render on every change
  const sendRaw = useCallback((msg: Record<string, unknown>) => {
    clientRef.current?.send(msg);
  }, []);

  useEffect(() => {
    const callbacks = {
      onStateChange: (wsState: WsState) => {
        dispatch({ type: 'WS_STATE_CHANGED', wsState });

        // When we reconnect and had a room open, auto-send RECONNECT command
        if (wsState === 'AUTHENTICATED') {
          const s = stateRef.current;
          if (s.roomId && s.sessionToken) {
            const cmd = buildReconnect(
              newCommandId(),
              s.sessionToken,
              s.roomId,
              s.lastReceivedSeq,
            );
            clientRef.current?.send(cmd as unknown as Record<string, unknown>);
          }
        }
      },

      onEvent: (event: AnyEvent | ErrorEvent) => {
        dispatchEvent(event, stateRef.current, dispatch, clientRef.current);
      },

      onSequenceGap: (fromSeq: number) => {
        const s = stateRef.current;
        if (!s.roomId || !s.sessionToken) return;
        const cmd = buildSyncRequest(
          newCommandId(),
          s.sessionToken,
          s.roomId,
          fromSeq,
        );
        clientRef.current?.send(cmd as unknown as Record<string, unknown>);
      },

      onLatency: (rttMs: number) => {
        dispatch({ type: 'LATENCY_MEASURED', rttMs });
      },

      onParseError: (_raw: string) => {
        // Non-fatal: log and ignore
      },
    };

    const client = new WsClient(config, callbacks);
    clientRef.current = client;
    client.connect();

    return () => {
      client.destroy();
      clientRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // intentionally empty — config is stable, callbacks use stateRef

  return { sendRaw, client: clientRef.current };
}

// ─────────────────────────────────────────────────────────────────────────────
// Event → Action dispatcher
// ─────────────────────────────────────────────────────────────────────────────

function dispatchEvent(
  event:    AnyEvent | ErrorEvent,
  state:    ClientState,
  dispatch: (action: GameAction) => void,
  client:   WsClient | null,
): void {

  switch (event.type) {

    case EventType.AUTH_ACK: {
      dispatch({
        type:          'AUTH_ACK',
        sessionToken:  event.sessionToken,
        playerId:      event.playerId,
        existingRoom:  event.existingRoom,
      });
      // Update client-side room tracking
      if (event.existingRoom) {
        client?.setRoom(event.existingRoom.roomId);
      }
      break;
    }

    case EventType.PONG: {
      // Latency is measured in wsClient before this callback fires.
      // Nothing more to dispatch here.
      break;
    }

    case EventType.ROOM_JOINED: {
      const rs = event.roomState;
      const cg = rs.currentGame;
      client?.setRoom(event.roomId);
      dispatch({
        type:           'ROOM_JOINED',
        roomId:         event.roomId,
        symbol:         event.symbol,
        players:        rs.players,
        readyPlayers:   rs.readyPlayers,
        confirmedBoard: cg?.board ?? (Array(9).fill('') as unknown as import('@ttt/shared/protocol').BoardSnapshot),
        confirmedTurn:  cg?.currentTurn ?? 'X',
        gameStatus:     cg?.status ?? 'WAITING',
        gameId:         cg?.gameId ?? null,
        gameResult:     cg?.result ?? null,
      });
      break;
    }

    case EventType.PLAYER_JOINED: {
      const info: PlayerInfo = {
        playerId:        event.playerId,
        symbol:          event.symbol,
        name:            event.playerName,
        connectionState: 'CONNECTED',
        lastSeenAt:      Date.now(),
      };
      dispatch({ type: 'PLAYER_JOINED', symbol: event.symbol, playerInfo: info });
      break;
    }

    case EventType.PLAYER_LEFT: {
      dispatch({ type: 'PLAYER_LEFT', symbol: event.symbol });
      break;
    }

    case EventType.PLAYER_READY_ACK: {
      dispatch({ type: 'PLAYER_READY_ACK', readyPlayers: event.readyPlayers });
      break;
    }

    case EventType.OPPONENT_READY: {
      dispatch({ type: 'OPPONENT_READY', readyPlayers: event.readyPlayers });
      break;
    }

    case EventType.GAME_STARTED: {
      client?.resetSequence();
      dispatch({
        type:      'GAME_STARTED',
        gameId:    event.gameId,
        board:     event.board,
        firstTurn: event.firstTurn,
        players:   event.players,
        startedAt: event.startedAt,
      });
      break;
    }

    case EventType.MOVE_ACK: {
      dispatch({
        type:           'MOVE_ACK',
        board:          event.board,
        nextTurn:       event.nextTurn,
        sequenceInGame: event.sequenceInGame,
        commandId:      event.correlationId ?? '',
      });
      break;
    }

    case EventType.MOVE_BROADCAST: {
      dispatch({
        type:     'MOVE_BROADCAST',
        board:    event.board,
        nextTurn: event.nextTurn,
        symbol:   event.symbol,
        position: event.position,
      });
      break;
    }

    case EventType.MOVE_REJECTED: {
      dispatch({
        type:         'MOVE_REJECTED',
        board:        event.board,
        currentTurn:  event.currentTurn,
        commandId:    event.correlationId ?? '',
      });
      break;
    }

    case EventType.GAME_FINISHED: {
      const line: WinningLine | null = event.result.winningLine;
      dispatch({
        type:         'GAME_FINISHED',
        result:       event.result,
        finalBoard:   event.finalBoard,
        moveHistory:  event.moveHistory,
        winningLine:  line,
      });
      break;
    }

    case EventType.REMATCH_REQUESTED: {
      dispatch({
        type:        'REMATCH_REQUESTED',
        requestedBy: event.requestedBy,
        expiresAt:   event.expiresAt,
      });
      break;
    }

    case EventType.REMATCH_DECLINED: {
      dispatch({ type: 'REMATCH_DECLINED', declinedBy: event.declinedBy });
      break;
    }

    case EventType.REMATCH_EXPIRED: {
      dispatch({ type: 'REMATCH_EXPIRED' });
      break;
    }

    case EventType.OPPONENT_DISCONNECTED: {
      dispatch({
        type:                'OPPONENT_DISCONNECTED',
        reconnectDeadlineAt: event.reconnectDeadlineAt,
      });
      break;
    }

    case EventType.OPPONENT_RECONNECTED: {
      dispatch({ type: 'OPPONENT_RECONNECTED' });
      break;
    }

    case EventType.RECONNECT_ACK: {
      const rs = event.roomState;
      const cg = rs.currentGame;
      dispatch({
        type:           'RECONNECT_ACK',
        symbol:         event.symbol,
        players:        rs.players,
        readyPlayers:   rs.readyPlayers,
        confirmedBoard: cg?.board ?? (Array(9).fill('') as unknown as import('@ttt/shared/protocol').BoardSnapshot),
        confirmedTurn:  cg?.currentTurn ?? 'X',
        gameStatus:     cg?.status ?? 'WAITING',
        gameId:         cg?.gameId ?? null,
        gameResult:     cg?.result ?? null,
        sessionSeq:     event.sessionSeq,
      });
      break;
    }

    case EventType.STATE_SYNC: {
      if (event.mode === 'SNAPSHOT') {
        const rs = event.roomState;
        const cg = rs.currentGame;
        dispatch({
          type:           'RECONNECT_ACK',
          symbol:         state.mySymbol ?? 'X',
          players:        rs.players,
          readyPlayers:   rs.readyPlayers,
          confirmedBoard: cg?.board ?? (Array(9).fill('') as unknown as import('@ttt/shared/protocol').BoardSnapshot),
          confirmedTurn:  cg?.currentTurn ?? 'X',
          gameStatus:     cg?.status ?? 'WAITING',
          gameId:         cg?.gameId ?? null,
          gameResult:     cg?.result ?? null,
          sessionSeq:     event.sessionSeq,
        });
      }
      // REPLAY mode: individual events are dispatched by the server in order —
      // they arrive as individual events and are handled above.
      break;
    }

    case EventType.ERROR: {
      // Non-recoverable errors are handled by wsClient closing the socket.
      // Recoverable errors surface contextually (MOVE_REJECTED etc.) — no
      // global dispatch needed here beyond what the specific event handlers do.
      break;
    }

    default: {
      // Unknown event — ignore (forward compatibility).
      break;
    }
  }

  // Advance sequence counter for room-scoped events
  if ('sessionSeq' in event && typeof event.sessionSeq === 'number') {
    dispatch({ type: 'SEQ_ADVANCED', seq: event.sessionSeq });
  }
}
