/**
 * @file events.ts
 * @description All server→client event types for the Tic-Tac-Toe realtime
 * protocol (version 1).
 *
 * Design rules enforced here:
 *  - Room-scoped events extend EventEnvelope (carries sessionSeq + roomId).
 *  - Global events (pre-room or session-level) extend GlobalEventEnvelope.
 *  - Every room-scoped event carries enough data to stand alone: the client
 *    does not need to query prior events to understand the state transition.
 *  - No runtime logic lives here: this file is pure type declarations.
 *  - AnyEvent is the exhaustive discriminated union used at the client's
 *    message dispatcher entry point.
 *
 * Sequence number contract:
 *  - sessionSeq is monotonically increasing, scoped to a single game session.
 *  - It starts at 1 when the game session begins and resets to 1 on rematch.
 *  - A gap in sessionSeq means events were missed; client must send SYNC_REQUEST.
 *
 * @see PROTOCOL.md §11 for lifecycle documentation of each event.
 * @see types.ts for shared primitives and envelope definitions.
 */

import type {
  EventEnvelope,
  GlobalEventEnvelope,
  RoomId,
  GameId,
  PlayerId,
  SessionToken,
  PlayerSymbol,
  BoardSnapshot,
  MoveRejectionReason,
  PlayerInfo,
  RoomStateSnapshot,
  GameResult,
  MoveRecord,
  GameStats,
  GameSummary,
} from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Event Type Literal Constants
// ─────────────────────────────────────────────────────────────────────────────

export const EventType = {
  // Session / global
  AUTH_ACK:              'AUTH_ACK',
  PONG:                  'PONG',

  // Room lifecycle
  ROOM_JOINED:           'ROOM_JOINED',
  PLAYER_JOINED:         'PLAYER_JOINED',
  ROOM_LEFT:             'ROOM_LEFT',
  PLAYER_LEFT:           'PLAYER_LEFT',

  // Ready / game start
  PLAYER_READY_ACK:      'PLAYER_READY_ACK',
  OPPONENT_READY:        'OPPONENT_READY',
  GAME_STARTED:          'GAME_STARTED',

  // Moves
  MOVE_ACK:              'MOVE_ACK',
  MOVE_BROADCAST:        'MOVE_BROADCAST',
  MOVE_REJECTED:         'MOVE_REJECTED',

  // Game end
  GAME_FINISHED:         'GAME_FINISHED',

  // Rematch
  REMATCH_REQUESTED:     'REMATCH_REQUESTED',
  REMATCH_DECLINED:      'REMATCH_DECLINED',
  REMATCH_EXPIRED:       'REMATCH_EXPIRED',

  // Connection / presence
  OPPONENT_DISCONNECTED: 'OPPONENT_DISCONNECTED',
  OPPONENT_RECONNECTED:  'OPPONENT_RECONNECTED',

  // Reconnect / sync
  RECONNECT_ACK:         'RECONNECT_ACK',
  STATE_SYNC:            'STATE_SYNC',

  // Errors
  ERROR:                 'ERROR',
} as const;

export type EventTypeLiteral = typeof EventType[keyof typeof EventType];

// ─────────────────────────────────────────────────────────────────────────────
// 11.2  AUTH_ACK  (global — not room-scoped)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sent in response to a successful AUTH command.
 * Transitions the connection from UNAUTHED → AUTHED.
 *
 * If existingRoom is non-null the client should immediately send RECONNECT
 * rather than JOIN_ROOM to resume the interrupted session.
 */
export type AuthAckEvent = GlobalEventEnvelope & {
  readonly type: typeof EventType.AUTH_ACK;
  /**
   * Opaque session token. Must be persisted to localStorage for reconnects.
   * Transmitted only over wss://; never log this value.
   */
  readonly sessionToken: SessionToken;
  /** Stable UUID for this player. Persist alongside sessionToken. */
  readonly playerId: PlayerId;
  /** Semver of the running server build. Used for client/server compatibility checks. */
  readonly serverVersion: string;
  /**
   * Non-null when the authenticated player is still associated with an active room.
   * The client should send RECONNECT to resume rather than starting fresh.
   */
  readonly existingRoom: {
    readonly roomId: RoomId;
    readonly symbol: PlayerSymbol;
    readonly gameStatus: 'WAITING' | 'ACTIVE' | 'FINISHED';
  } | null;
};

// ─────────────────────────────────────────────────────────────────────────────
// 11.13  PONG  (global — not room-scoped)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Response to a PING command.
 * Client computes round-trip time as: rtt = Date.now() - pong.clientTime
 */
export type PongEvent = GlobalEventEnvelope & {
  readonly type: typeof EventType.PONG;
  /** Echoed from PING.clientTime. Client uses this to calculate RTT. */
  readonly clientTime: number;
  /** Server's local timestamp at the moment it sent this PONG. */
  readonly serverTime: number;
};

// ─────────────────────────────────────────────────────────────────────────────
// 11.3  ROOM_JOINED / PLAYER_JOINED
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sent exclusively to the player who just joined.
 * Contains the full room state snapshot so the client can render immediately.
 *
 * sessionSeq starts at 1 for this player's session in this room.
 */
export type RoomJoinedEvent = EventEnvelope & {
  readonly type: typeof EventType.ROOM_JOINED;
  readonly roomId: RoomId;
  readonly playerId: PlayerId;
  readonly symbol: PlayerSymbol;
  /** Full current state of the room. */
  readonly roomState: RoomStateSnapshot;
};

/**
 * Broadcast to all players who were already in the room when a new player joins.
 * The joining player receives ROOM_JOINED instead.
 */
export type PlayerJoinedEvent = EventEnvelope & {
  readonly type: typeof EventType.PLAYER_JOINED;
  readonly roomId: RoomId;
  readonly playerId: PlayerId;
  readonly symbol: PlayerSymbol;
  readonly playerName: string | null;
  /** 1 or 2 — reflects the count after the join. */
  readonly connectedPlayerCount: number;
};

// ─────────────────────────────────────────────────────────────────────────────
// 11.4  ROOM_LEFT / PLAYER_LEFT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sent exclusively to the player who just left.
 * Confirms the LEAVE_ROOM command was processed.
 */
export type RoomLeftEvent = EventEnvelope & {
  readonly type: typeof EventType.ROOM_LEFT;
  readonly roomId: RoomId;
};

/**
 * Broadcast to remaining players when a player leaves the room.
 *
 * reason values:
 *  VOLUNTARY           — player sent LEAVE_ROOM
 *  DISCONNECT_TIMEOUT  — reconnect window elapsed (5 min)
 *  FORFEIT             — player sent LEAVE_ROOM during an ACTIVE game
 *
 * Note: when reason === 'FORFEIT', GAME_FINISHED is emitted first, then
 * PLAYER_LEFT, so clients can update the game result UI before removing
 * the player from the roster.
 */
export type PlayerLeftEvent = EventEnvelope & {
  readonly type: typeof EventType.PLAYER_LEFT;
  readonly roomId: RoomId;
  readonly playerId: PlayerId;
  readonly symbol: PlayerSymbol;
  readonly reason: 'VOLUNTARY' | 'DISCONNECT_TIMEOUT' | 'FORFEIT';
};

// ─────────────────────────────────────────────────────────────────────────────
// 11.5  PLAYER_READY_ACK / OPPONENT_READY
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sent exclusively to the player who sent PLAYER_READY.
 * Confirms the server recorded their readiness.
 */
export type PlayerReadyAckEvent = EventEnvelope & {
  readonly type: typeof EventType.PLAYER_READY_ACK;
  readonly roomId: RoomId;
  /** Current set of ready symbols after this acknowledgement. */
  readonly readyPlayers: ReadonlyArray<PlayerSymbol>;
};

/**
 * Broadcast to the other player when one player declares readiness.
 */
export type OpponentReadyEvent = EventEnvelope & {
  readonly type: typeof EventType.OPPONENT_READY;
  readonly roomId: RoomId;
  readonly symbol: PlayerSymbol;
  /** Current set of ready symbols after this event. */
  readonly readyPlayers: ReadonlyArray<PlayerSymbol>;
};

// ─────────────────────────────────────────────────────────────────────────────
// 11.6  GAME_STARTED
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Broadcast to all players when the server starts a new game.
 * Triggered automatically once both players have sent PLAYER_READY,
 * or when both players accept a rematch.
 *
 * IMPORTANT: sessionSeq resets to 1 on every GAME_STARTED.
 * Clients must reset their lastReceivedSeq counter when they receive this event.
 *
 * firstTurn alternates between games in the same room:
 *  - Game 1: X goes first.
 *  - Game 2 (rematch): O goes first.
 *  - Game 3: X goes first. (etc.)
 */
export type GameStartedEvent = EventEnvelope & {
  readonly type: typeof EventType.GAME_STARTED;
  readonly roomId: RoomId;
  /** New unique ID for this game instance. Include in all MAKE_MOVE commands. */
  readonly gameId: GameId;
  /** An empty 9-cell board. */
  readonly board: BoardSnapshot;
  readonly firstTurn: PlayerSymbol;
  readonly players: {
    readonly X: PlayerInfo;
    readonly O: PlayerInfo;
  };
  /** Server timestamp (ms) when the game was started. */
  readonly startedAt: number;
};

// ─────────────────────────────────────────────────────────────────────────────
// 11.8  MOVE_ACK
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sent exclusively to the player who made the move.
 * Confirms the move was valid, applied, and the new board state.
 *
 * The client should use board to reconcile its optimistic state.
 * nextTurn is null when the move ended the game (see GAME_FINISHED).
 */
export type MoveAckEvent = EventEnvelope & {
  readonly type: typeof EventType.MOVE_ACK;
  readonly roomId: RoomId;
  readonly gameId: GameId;
  /** The position that was accepted and applied. */
  readonly position: { readonly row: number; readonly col: number };
  readonly symbol: PlayerSymbol;
  /** 1-based index of this move within the game. */
  readonly sequenceInGame: number;
  /** Full board state after this move. */
  readonly board: BoardSnapshot;
  /** null when this move ends the game. */
  readonly nextTurn: PlayerSymbol | null;
};

// ─────────────────────────────────────────────────────────────────────────────
// 11.9  MOVE_BROADCAST
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Broadcast to all players in the room EXCEPT the mover.
 *
 * Carries the same board state as MOVE_ACK so both players converge to an
 * identical view of the board after each move.
 *
 * playerId identifies who moved, allowing the client to animate or highlight
 * the move origin regardless of which symbol is "local" to each client.
 */
export type MoveBroadcastEvent = EventEnvelope & {
  readonly type: typeof EventType.MOVE_BROADCAST;
  readonly roomId: RoomId;
  readonly gameId: GameId;
  readonly position: { readonly row: number; readonly col: number };
  readonly symbol: PlayerSymbol;
  readonly playerId: PlayerId;
  readonly sequenceInGame: number;
  readonly board: BoardSnapshot;
  readonly nextTurn: PlayerSymbol | null;
};

// ─────────────────────────────────────────────────────────────────────────────
// 11.10  MOVE_REJECTED
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sent exclusively to the player whose move was rejected.
 *
 * The client MUST roll back any optimistic UI update and re-render from
 * the board snapshot in this event (which reflects the true server state).
 *
 * correlationId echoes the MAKE_MOVE commandId that triggered this rejection.
 */
export type MoveRejectedEvent = EventEnvelope & {
  readonly type: typeof EventType.MOVE_REJECTED;
  readonly roomId: RoomId;
  readonly gameId: GameId;
  /** The position that was rejected (as submitted by the client). */
  readonly position: { readonly row: number; readonly col: number };
  readonly reason: MoveRejectionReason;
  /**
   * Current board state (unchanged by the rejected move).
   * Use this to reset any optimistic client state.
   */
  readonly board: BoardSnapshot;
  /** The turn that remains active after the rejection. */
  readonly currentTurn: PlayerSymbol;
};

// ─────────────────────────────────────────────────────────────────────────────
// 11.11  GAME_FINISHED
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Broadcast to all players when the game ends for any reason.
 *
 * Contains the complete authoritative game record: final board, full move
 * history, result, and stats. This is everything the client needs to render
 * the post-game screen without a follow-up HTTP request.
 *
 * Emitted before PLAYER_LEFT when a player forfeits.
 */
export type GameFinishedEvent = EventEnvelope & {
  readonly type: typeof EventType.GAME_FINISHED;
  readonly roomId: RoomId;
  readonly gameId: GameId;
  readonly result: GameResult;
  readonly finalBoard: BoardSnapshot;
  /** Complete ordered move history for this game. */
  readonly moveHistory: ReadonlyArray<MoveRecord>;
  readonly stats: GameStats;
};

// ─────────────────────────────────────────────────────────────────────────────
// 11.12  REMATCH EVENTS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Broadcast to all players when one player requests a rematch.
 *
 * The non-requesting player should prompt the user to accept or decline.
 * The proposing player's client should show a "waiting" state.
 *
 * expiresAt: if no mutual acceptance by this epoch ms, the server emits
 * REMATCH_EXPIRED and the proposal is cancelled.
 */
export type RematchRequestedEvent = EventEnvelope & {
  readonly type: typeof EventType.REMATCH_REQUESTED;
  readonly roomId: RoomId;
  readonly gameId: GameId;
  readonly requestedBy: PlayerSymbol;
  /** Unix epoch ms when the rematch proposal automatically expires. */
  readonly expiresAt: number;
};

/**
 * Broadcast to all players when one player declines the rematch.
 */
export type RematchDeclinedEvent = EventEnvelope & {
  readonly type: typeof EventType.REMATCH_DECLINED;
  readonly roomId: RoomId;
  readonly gameId: GameId;
  readonly declinedBy: PlayerSymbol;
};

/**
 * Broadcast when the 60-second rematch proposal window elapses without
 * mutual acceptance.
 */
export type RematchExpiredEvent = EventEnvelope & {
  readonly type: typeof EventType.REMATCH_EXPIRED;
  readonly roomId: RoomId;
  readonly gameId: GameId;
};

// ─────────────────────────────────────────────────────────────────────────────
// 11.14  CONNECTION PRESENCE EVENTS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Broadcast to remaining players when a player's connection is lost.
 *
 * reconnectDeadlineAt: Unix epoch ms. If the disconnected player does not
 * reconnect by this time, GAME_FINISHED will be emitted with reason
 * 'PLAYER_ABANDONED'.
 *
 * The connected player should show a "waiting for opponent to reconnect"
 * overlay with a countdown derived from reconnectDeadlineAt.
 */
export type OpponentDisconnectedEvent = EventEnvelope & {
  readonly type: typeof EventType.OPPONENT_DISCONNECTED;
  readonly roomId: RoomId;
  readonly symbol: PlayerSymbol;
  /**
   * Unix epoch ms deadline for reconnection.
   * After this point the game will be abandoned.
   */
  readonly reconnectDeadlineAt: number;
};

/**
 * Broadcast to remaining players when a disconnected player successfully
 * reconnects. The reconnect countdown overlay should be dismissed.
 */
export type OpponentReconnectedEvent = EventEnvelope & {
  readonly type: typeof EventType.OPPONENT_RECONNECTED;
  readonly roomId: RoomId;
  readonly symbol: PlayerSymbol;
};

// ─────────────────────────────────────────────────────────────────────────────
// 11.14  RECONNECT_ACK
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sent exclusively to the player who sent RECONNECT.
 *
 * Contains the full current room state so the client can restore its UI
 * without replaying all historical events.
 *
 * Immediately followed by STATE_SYNC (REPLAY mode) for any events the client
 * missed, OR STATE_SYNC (SNAPSHOT mode) if the replay buffer was exhausted.
 */
export type ReconnectAckEvent = EventEnvelope & {
  readonly type: typeof EventType.RECONNECT_ACK;
  readonly roomId: RoomId;
  readonly playerId: PlayerId;
  readonly symbol: PlayerSymbol;
  /** Full current room state. Use to bootstrap the client before applying replayed events. */
  readonly roomState: RoomStateSnapshot;
  /** Current server sequence. Client should update lastReceivedSeq after applying STATE_SYNC. */
  readonly sessionSeq: number;
};

// ─────────────────────────────────────────────────────────────────────────────
// 11.15  STATE_SYNC
// ─────────────────────────────────────────────────────────────────────────────

/**
 * REPLAY mode: sent when the server can replay specific missed events.
 *
 * Conditions:
 *  - The requested gap is ≤ EVENT_BUFFER_SIZE (500) events.
 *  - The events are still in the session's ring buffer.
 *  - Sent in response to SYNC_REQUEST or after RECONNECT_ACK.
 *
 * Client processing:
 *  1. Receive REPLAY events in the `events` array.
 *  2. Apply each in order, advancing lastReceivedSeq for each.
 *  3. After all events applied, lastReceivedSeq === toSeq.
 */
export type StateSyncReplayEvent = EventEnvelope & {
  readonly type: typeof EventType.STATE_SYNC;
  readonly roomId: RoomId;
  readonly mode: 'REPLAY';
  readonly fromSeq: number;
  readonly toSeq: number;
  /** Ordered list of missed events. Apply in array order. */
  readonly events: ReadonlyArray<AnyRoomEvent>;
};

/**
 * SNAPSHOT mode: sent when the replay buffer cannot cover the gap.
 *
 * Conditions:
 *  - The gap is > EVENT_BUFFER_SIZE events.
 *  - The requested events have been evicted from the buffer.
 *  - The client sent lastReceivedSeq: 0 (no prior state).
 *
 * Client processing:
 *  1. Discard all current in-memory game state.
 *  2. Bootstrap entirely from roomState.
 *  3. Set lastReceivedSeq = sessionSeq.
 */
export type StateSyncSnapshotEvent = EventEnvelope & {
  readonly type: typeof EventType.STATE_SYNC;
  readonly roomId: RoomId;
  readonly mode: 'SNAPSHOT';
  readonly roomState: RoomStateSnapshot;
};

/** Union of both STATE_SYNC modes. Discriminated by `mode`. */
export type StateSyncEvent = StateSyncReplayEvent | StateSyncSnapshotEvent;

// ─────────────────────────────────────────────────────────────────────────────
// Exhaustive Unions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * All events that are scoped to a room and carry sessionSeq.
 * These are the events that drive the game session state machine.
 */
export type AnyRoomEvent =
  | RoomJoinedEvent
  | PlayerJoinedEvent
  | RoomLeftEvent
  | PlayerLeftEvent
  | PlayerReadyAckEvent
  | OpponentReadyEvent
  | GameStartedEvent
  | MoveAckEvent
  | MoveBroadcastEvent
  | MoveRejectedEvent
  | GameFinishedEvent
  | RematchRequestedEvent
  | RematchDeclinedEvent
  | RematchExpiredEvent
  | OpponentDisconnectedEvent
  | OpponentReconnectedEvent
  | ReconnectAckEvent
  | StateSyncEvent;

/**
 * All events that are global (not room-scoped): AUTH_ACK, PONG, ERROR.
 * ERROR is defined in errors.ts and re-exported from index.ts.
 */
export type AnyGlobalEvent =
  | AuthAckEvent
  | PongEvent;

/**
 * Complete discriminated union of every server→client event.
 * Import ErrorEvent from errors.ts to extend this at the usage site:
 *
 * @example
 * import type { AnyEvent } from './protocol/index.js';
 * // AnyEvent already includes ErrorEvent via the barrel.
 */
export type AnyEvent = AnyRoomEvent | AnyGlobalEvent;

/**
 * Extract the concrete event type for a given type literal.
 *
 * @example
 * type Move = EventByType<'MOVE_BROADCAST'>; // → MoveBroadcastEvent
 */
export type EventByType<T extends EventTypeLiteral> = Extract<AnyEvent, { type: T }>;

// ─────────────────────────────────────────────────────────────────────────────
// Game History — HTTP (non-realtime)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Shape of the HTTP GET /api/rooms/:roomId/history response body.
 * Not a WebSocket event — defined here for co-location with related types.
 */
export type RoomHistoryResponse = {
  readonly roomId: RoomId;
  readonly games: ReadonlyArray<
    GameSummary & {
      readonly moveHistory: ReadonlyArray<MoveRecord>;
    }
  >;
};
