/**
 * Primary React hook for game interactions, exposing a stable API to the UI.
 *
 * Optimistic move flow: prevalidateMove() locally (zero RTT); if valid,
 * dispatch MOVE_OPTIMISTIC so the board updates instantly and send MAKE_MOVE.
 * The server then replies MOVE_ACK (reconcile, clear pending) or MOVE_REJECTED
 * (roll back the optimistic board).
 */

import { useReducer, useCallback, useMemo } from 'react';

import type { RoomId, SessionToken } from '@ttt/shared/protocol';
import { brand } from '@ttt/shared/protocol';

import {
  gameReducer, INITIAL_STATE, displayBoard, canMove, hasPendingMove,
} from '../store/gameStore';
import type { ClientState } from '../store/gameStore';
import { useWebSocket } from './useWebSocket';
import { prevalidateMove } from '../lib/optimisticEngine';
import {
  buildJoinRoom, buildLeaveRoom, buildPlayerReady, buildMakeMove,
  buildRequestRematch, buildAcceptRematch, buildDeclineRematch,
  newCommandId,
} from '../lib/commandBuilder';
import type { WsClientConfig } from '../lib/wsClient';

const WS_URL = (
  typeof window !== 'undefined'
    ? `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/ws`
    : 'ws://localhost:8080/ws'
);

const CLIENT_CONFIG: WsClientConfig = {
  url:           WS_URL,
  clientVersion: '1.0.0',
};

export function useGame(): GameApi {
  const [state, dispatch] = useReducer(gameReducer, INITIAL_STATE);
  const { sendRaw, client } = useWebSocket(CLIENT_CONFIG, state, dispatch);

  const token = useCallback((): SessionToken | null => {
    return client?.getSessionToken() ?? state.sessionToken;
  }, [client, state.sessionToken]);

  const joinRoom = useCallback((roomId: string) => {
    const t = token();
    if (!t) return;
    const cmd = buildJoinRoom(newCommandId(), t, brand<RoomId>(roomId), null);
    sendRaw(cmd as unknown as Record<string, unknown>);
  }, [sendRaw, token]);

  const leaveRoom = useCallback(() => {
    const t = token();
    const r = state.roomId;
    if (!t || !r) return;
    const cmd = buildLeaveRoom(newCommandId(), t, r, 'VOLUNTARY');
    sendRaw(cmd as unknown as Record<string, unknown>);
    dispatch({ type: 'LEAVE_ROOM' });
    client?.setRoom(null);
  }, [sendRaw, token, state.roomId, client]);

  const playerReady = useCallback(() => {
    const t = token();
    const r = state.roomId;
    if (!t || !r) return;
    const cmd = buildPlayerReady(newCommandId(), t, r);
    sendRaw(cmd as unknown as Record<string, unknown>);
  }, [sendRaw, token, state.roomId]);

  const makeMove = useCallback((row: number, col: number) => {
    if (!canMove(state)) return;

    const t = token();
    const r = state.roomId;
    const g = state.gameId;
    const s = state.mySymbol;

    if (!t || !r || !g || !s) return;

    const result = prevalidateMove(
      state.confirmedBoard,
      state.confirmedTurn,
      state.gameStatus === 'ACTIVE',
      s,
      row,
      col,
    );

    if (!result.valid) {
      // Not a plausible move — do nothing (server would reject anyway).
      return;
    }

    const commandId = newCommandId();
    dispatch({
      type:           'MOVE_OPTIMISTIC',
      commandId,
      row,
      col,
      predictedBoard: result.predictedBoard,
    });

    const cmd = buildMakeMove(commandId, t, r, g, row, col);
    sendRaw(cmd as unknown as Record<string, unknown>);
  }, [state, sendRaw, token]);

  const requestRematch = useCallback(() => {
    const t = token();
    const r = state.roomId;
    const g = state.gameId;
    if (!t || !r || !g) return;
    const cmd = buildRequestRematch(newCommandId(), t, r, g);
    sendRaw(cmd as unknown as Record<string, unknown>);
  }, [sendRaw, token, state.roomId, state.gameId]);

  const acceptRematch = useCallback(() => {
    const t = token();
    const r = state.roomId;
    const g = state.gameId;
    if (!t || !r || !g) return;
    const cmd = buildAcceptRematch(newCommandId(), t, r, g);
    sendRaw(cmd as unknown as Record<string, unknown>);
  }, [sendRaw, token, state.roomId, state.gameId]);

  const declineRematch = useCallback(() => {
    const t = token();
    const r = state.roomId;
    const g = state.gameId;
    if (!t || !r || !g) return;
    const cmd = buildDeclineRematch(newCommandId(), t, r, g);
    sendRaw(cmd as unknown as Record<string, unknown>);
  }, [sendRaw, token, state.roomId, state.gameId]);

  const board         = useMemo(() => displayBoard(state),  [state]);
  const moveAllowed   = useMemo(() => canMove(state),       [state]);
  const movePending   = useMemo(() => hasPendingMove(state), [state]);

  return {
    state,
    board,
    moveAllowed,
    movePending,
    joinRoom,
    leaveRoom,
    playerReady,
    makeMove,
    requestRematch,
    acceptRematch,
    declineRematch,
  };
}

export type GameApi = {
  state:         ClientState;
  board:         ClientState['confirmedBoard'];
  moveAllowed:   boolean;
  movePending:   boolean;
  joinRoom:      (roomId: string) => void;
  leaveRoom:     () => void;
  playerReady:   () => void;
  makeMove:      (row: number, col: number) => void;
  requestRematch: () => void;
  acceptRematch:  () => void;
  declineRematch: () => void;
};
