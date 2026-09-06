# Production-Oriented Tic-Tac-Toe Game - Design Document

## Table of Contents
1. [Product Requirements](#1-product-requirements)
2. [Functional Requirements](#2-functional-requirements)
3. [Non-Functional Requirements](#3-non-functional-requirements)
4. [Architecture Proposal](#4-architecture-proposal)
5. [Component Boundaries](#5-component-boundaries)
6. [Realtime Protocol Design](#6-realtime-protocol-design)
7. [Game-State Model](#7-game-state-model)
8. [Database Model](#8-database-model)
9. [Reconnection Strategy](#9-reconnection-strategy)
10. [Security Model](#10-security-model)
11. [Observability Strategy](#11-observability-strategy)
12. [Testing Strategy](#12-testing-strategy)
13. [Performance Strategy](#13-performance-strategy)
14. [Deployment Architecture](#14-deployment-architecture)
15. [Development Phases](#15-development-phases)

---

## 1. Product Requirements

### Vision
A premium real-time multiplayer Tic-Tac-Toe game that feels instant, responsive, and trustworthy.

### Core User Flows

**Flow 1: Create and Share Game**
- User creates a private game room
- System generates unique room code/link
- User shares link with friend
- Room persists for 24 hours or until game completion

**Flow 2: Join Game**
- User receives room link/code
- User joins room
- System validates room exists and has capacity
- Both players see each other's presence

**Flow 3: Play Game**
- First player makes move
- Move appears instantly on opponent's screen
- Server validates and broadcasts move
- Game detects win/draw conditions
- Results displayed to both players

**Flow 4: Network Resilience**
- Player loses connection
- Game state preserved on server
- Player reconnects within timeout window
- Game state restored seamlessly
- Opponent sees connection status

**Flow 5: Rematch**
- After game ends, either player can request rematch
- Both players must accept
- New game starts with roles/turns adjusted
- Game history preserved

**Flow 6: Game History**
- Players can view past games in their room
- See moves, timestamps, winner
- Navigate through game history

### Out of Scope (Phase 1)
- AI opponent
- Public matchmaking
- Ranked ladder/ELO
- Spectator mode
- Chat functionality
- Multiple simultaneous games per user

---

## 2. Functional Requirements

### FR-1: Room Management
- **FR-1.1**: Create room with unique ID (8-character alphanumeric)
- **FR-1.2**: Room capacity: exactly 2 players
- **FR-1.3**: Room expires after 24 hours of inactivity
- **FR-1.4**: Generate shareable link/code
- **FR-1.5**: Validate room exists before join
- **FR-1.6**: Prevent third player from joining full room

### FR-2: Game Initialization
- **FR-2.1**: First player to join becomes Player X
- **FR-2.2**: Second player becomes Player O
- **FR-2.3**: X always moves first in new game
- **FR-2.4**: Game starts automatically when both players ready

### FR-3: Gameplay Mechanics
- **FR-3.1**: Players alternate turns
- **FR-3.2**: Valid move: empty cell, player's turn
- **FR-3.3**: Server validates all moves
- **FR-3.4**: Invalid moves rejected with reason
- **FR-3.5**: Detect win conditions (3-in-row/col/diagonal)
- **FR-3.6**: Detect draw condition (board full, no winner)
- **FR-3.7**: Game state immutable after end

### FR-4: Real-time Updates
- **FR-4.1**: Broadcast moves to all room players < 100ms
- **FR-4.2**: Show opponent connection status
- **FR-4.3**: Display current turn indicator
- **FR-4.4**: Optimistic UI updates with rollback on error

### FR-5: Reconnection
- **FR-5.1**: Detect disconnection within 5 seconds
- **FR-5.2**: Preserve game state for 5 minutes after disconnect
- **FR-5.3**: Automatic reconnection attempt on network recovery
- **FR-5.4**: Full game state restoration on reconnect
- **FR-5.5**: Resume from exact point of disconnection

### FR-6: Rematch
- **FR-6.1**: Either player can propose rematch after game end
- **FR-6.2**: Both players must accept within 60 seconds
- **FR-6.3**: Rematch swaps starting player
- **FR-6.4**: New game board, preserved room
- **FR-6.5**: Rejection or timeout cancels rematch

### FR-7: History
- **FR-7.1**: Store all completed games for room
- **FR-7.2**: Display chronological game list
- **FR-7.3**: Show: timestamp, winner, move count
- **FR-7.4**: Replay game move-by-move (stretch)

---

## 3. Non-Functional Requirements

### NFR-1: Performance
- **NFR-1.1**: Move latency: < 100ms p95
- **NFR-1.2**: Reconnection time: < 2 seconds p95
- **NFR-1.3**: Initial page load: < 1 second
- **NFR-1.4**: Support 1000 concurrent games (single instance)
- **NFR-1.5**: Memory per game: < 10KB

### NFR-2: Reliability
- **NFR-2.1**: 99.9% uptime
- **NFR-2.2**: Zero data loss for completed games
- **NFR-2.3**: Graceful degradation on server overload
- **NFR-2.4**: No game state corruption on crash

### NFR-3: Security
- **NFR-3.1**: Prevent move injection/spoofing
- **NFR-3.2**: Rate limiting: 10 moves/second per player
- **NFR-3.3**: Room IDs cryptographically random
- **NFR-3.4**: No player can see/join rooms without ID
- **NFR-3.5**: XSS and injection prevention

### NFR-4: Observability
- **NFR-4.1**: Log all game events with trace IDs
- **NFR-4.2**: Metrics: move latency, connection count, error rates
- **NFR-4.3**: Structured logging (JSON)
- **NFR-4.4**: Health check endpoint
- **NFR-4.5**: Detailed error messages in development

### NFR-5: Maintainability
- **NFR-5.1**: < 5000 lines of core game code
- **NFR-5.2**: Game engine independent of networking
- **NFR-5.3**: New games addable in < 200 lines
- **NFR-5.4**: TypeScript strict mode
- **NFR-5.5**: 100% type coverage

### NFR-6: Testability
- **NFR-6.1**: Game engine pure functions
- **NFR-6.2**: Integration tests for WebSocket protocol
- **NFR-6.3**: E2E tests for critical paths
- **NFR-6.4**: 80%+ code coverage for game logic

---

## 4. Architecture Proposal

### High-Level Architecture

```
┌─────────────────────────────────────────────────────────┐
│                     CLIENT (Browser)                     │
├─────────────────────────────────────────────────────────┤
│  React UI → WebSocket Client → Game State Manager       │
│  Optimistic Updates │ Reconnection Logic │ Rendering    │
└─────────────────────────────────────────────────────────┘
                            │
                            │ WebSocket
                            │ (ws:// or wss://)
                            ▼
┌─────────────────────────────────────────────────────────┐
│                  SERVER (Node.js)                        │
├─────────────────────────────────────────────────────────┤
│  HTTP Server (Express)                                   │
│    ├─ Health checks                                      │
│    ├─ Room creation (POST /api/rooms)                   │
│    └─ Game history (GET /api/rooms/:id/history)         │
│                                                          │
│  WebSocket Server (ws library)                           │
│    ├─ Connection manager                                 │
│    ├─ Message router                                     │
│    └─ Broadcast coordinator                              │
│                                                          │
│  Game Service Layer                                      │
│    ├─ Room manager (in-memory + DB)                     │
│    ├─ Game engine (pure logic)                          │
│    ├─ Event sourcing (optional phase 2)                 │
│    └─ Persistence coordinator                            │
│                                                          │
│  Storage                                                 │
│    ├─ In-Memory: Active game state (Map/Redis)          │
│    └─ Database: Completed games, room metadata          │
└─────────────────────────────────────────────────────────┘
                            │
                            ▼
                    ┌───────────────┐
                    │   PostgreSQL  │
                    │   (or SQLite) │
                    └───────────────┘
```

### Technology Stack

**Frontend:**
- React 18+ (Hooks, no Redux initially)
- TypeScript
- Native WebSocket API
- CSS Modules or Tailwind
- Vite for build tooling

**Backend:**
- Node.js 20+ LTS
- TypeScript
- Express (REST endpoints)
- ws library (WebSocket)
- PostgreSQL or SQLite (start with SQLite for simplicity)
- Optional: Redis for scaling (Phase 2)

**Rationale:**
- Node.js: JavaScript full-stack, excellent WebSocket support
- ws library: Lightweight, production-ready, no framework lock-in
- TypeScript: Type safety across client/server protocol
- SQLite: Zero-config, sufficient for 1000s of games, easy local dev
- No framework overhead (no NestJS, Socket.io) for maximum control

---

## 5. Component Boundaries

### Client Components

```
src/client/
├── components/
│   ├── Game/
│   │   ├── Board.tsx              # Renders 3x3 grid
│   │   ├── Cell.tsx               # Individual cell, click handler
│   │   ├── GameStatus.tsx         # Turn indicator, winner display
│   │   └── GameControls.tsx       # Rematch, leave buttons
│   ├── Room/
│   │   ├── RoomLobby.tsx          # Waiting for players
│   │   ├── RoomLink.tsx           # Share link component
│   │   └── PlayerList.tsx         # Show connected players
│   └── Layout/
│       ├── Header.tsx
│       └── ConnectionStatus.tsx   # WebSocket state indicator
├── services/
│   ├── websocket.ts               # WebSocket client wrapper
│   ├── gameClient.ts              # Protocol message send/receive
│   └── reconnection.ts            # Reconnect logic, backoff
├── hooks/
│   ├── useGameState.ts            # Game state management
│   ├── useWebSocket.ts            # WebSocket connection hook
│   └── useOptimisticMove.ts      # Optimistic update logic
├── types/
│   └── protocol.ts                # Shared protocol types
└── utils/
    ├── boardLogic.ts              # Client-side validation (mirror)
    └── constants.ts
```

### Server Components

```
src/server/
├── api/
│   ├── rooms.ts                   # HTTP: POST /rooms, GET /rooms/:id
│   ├── history.ts                 # HTTP: GET /rooms/:id/history
│   └── health.ts                  # HTTP: GET /health
├── websocket/
│   ├── server.ts                  # WebSocket server setup
│   ├── connectionManager.ts       # Track connections, mapping
│   ├── messageHandler.ts          # Route incoming messages
│   └── broadcaster.ts             # Send to room/player
├── game/
│   ├── engine.ts                  # Pure game logic (deterministic)
│   ├── roomManager.ts             # Room lifecycle, player assignment
│   ├── gameSession.ts             # Per-game state machine
│   └── validator.ts               # Move validation, cheat detection
├── persistence/
│   ├── database.ts                # DB connection, queries
│   ├── repositories/
│   │   ├── roomRepository.ts
│   │   └── gameRepository.ts
│   └── migrations/
├── types/
│   └── protocol.ts                # Shared with client
├── utils/
│   ├── logger.ts                  # Structured logging
│   ├── idGenerator.ts             # Room ID generation
│   └── metrics.ts                 # Performance tracking
└── index.ts                       # Server entry point
```

### Shared Types (Client + Server)

```
src/shared/
└── protocol.ts                    # Protocol definition
```

**Key Boundaries:**

1. **Game Engine** (`game/engine.ts`): 
   - Pure functions only
   - No I/O, no side effects
   - Input: game state + move → Output: new state + events
   - Fully deterministic

2. **WebSocket Layer**: 
   - No game logic
   - Message parsing, routing, broadcasting only
   - Protocol versioning

3. **Persistence Layer**:
   - No game logic
   - CRUD operations only
   - Async, non-blocking

4. **HTTP API**:
   - Non-realtime operations only
   - Room creation, history queries

---

## 6. Realtime Protocol Design

### Protocol Principles

1. **Explicit Versioning**: Every message includes protocol version
2. **Sequence Numbers**: Client/server track message order
3. **Idempotency**: Commands include unique ID, safe to retry
4. **Type Safety**: TypeScript discriminated unions
5. **Extensibility**: Easy to add new message types

### Message Format

```typescript
// Base message structure
interface BaseMessage {
  version: 1;                      // Protocol version
  messageId: string;               // UUID for deduplication
  timestamp: number;               // Client/server send time
  type: string;                    // Discriminator
}

// Client → Server messages
type ClientMessage = 
  | JoinRoomMessage
  | MakeMoveMessage
  | RequestRematchMessage
  | LeaveRoomMessage;

// Server → Client messages
type ServerMessage =
  | RoomStateMessage
  | MoveAcceptedMessage
  | MoveRejectedMessage
  | GameEndedMessage
  | OpponentConnectedMessage
  | OpponentDisconnectedMessage
  | RematchProposedMessage
  | ErrorMessage;
```

### Client → Server Messages

```typescript
interface JoinRoomMessage extends BaseMessage {
  type: 'JOIN_ROOM';
  roomId: string;
  playerId?: string;               // For reconnection
  playerName?: string;             // Optional display name
}

interface MakeMoveMessage extends BaseMessage {
  type: 'MAKE_MOVE';
  roomId: string;
  playerId: string;
  move: {
    row: 0 | 1 | 2;
    col: 0 | 1 | 2;
  };
  sequenceNumber: number;          // Client's sequence counter
}

interface RequestRematchMessage extends BaseMessage {
  type: 'REQUEST_REMATCH';
  roomId: string;
  playerId: string;
}

interface LeaveRoomMessage extends BaseMessage {
  type: 'LEAVE_ROOM';
  roomId: string;
  playerId: string;
}
```

### Server → Client Messages

```typescript
interface RoomStateMessage extends BaseMessage {
  type: 'ROOM_STATE';
  roomId: string;
  playerId: string;                // Assigned player ID
  playerSymbol: 'X' | 'O';
  gameState: {
    board: ('' | 'X' | 'O')[][];   // 3x3 grid
    currentTurn: 'X' | 'O';
    status: 'waiting' | 'active' | 'ended';
    winner: 'X' | 'O' | 'draw' | null;
    moveHistory: Move[];
  };
  players: {
    X: { id: string; name?: string; connected: boolean };
    O: { id: string; name?: string; connected: boolean };
  };
  serverSequence: number;
}

interface MoveAcceptedMessage extends BaseMessage {
  type: 'MOVE_ACCEPTED';
  roomId: string;
  move: {
    player: 'X' | 'O';
    row: 0 | 1 | 2;
    col: 0 | 1 | 2;
    timestamp: number;
  };
  newGameState: {
    board: ('' | 'X' | 'O')[][];
    currentTurn: 'X' | 'O';
    moveCount: number;
  };
  serverSequence: number;
}

interface MoveRejectedMessage extends BaseMessage {
  type: 'MOVE_REJECTED';
  roomId: string;
  reason: 'NOT_YOUR_TURN' | 'CELL_OCCUPIED' | 'GAME_ENDED' | 'INVALID_POSITION';
  clientSequence: number;          // Echo back client's sequence
}

interface GameEndedMessage extends BaseMessage {
  type: 'GAME_ENDED';
  roomId: string;
  result: {
    winner: 'X' | 'O' | 'draw';
    winningLine?: { start: [number, number]; end: [number, number] };
    finalBoard: ('' | 'X' | 'O')[][];
    timestamp: number;
  };
}

interface OpponentConnectedMessage extends BaseMessage {
  type: 'OPPONENT_CONNECTED';
  roomId: string;
  opponentSymbol: 'X' | 'O';
}

interface OpponentDisconnectedMessage extends BaseMessage {
  type: 'OPPONENT_DISCONNECTED';
  roomId: string;
  opponentSymbol: 'X' | 'O';
  reconnectTimeout: number;        // Seconds until game abandonment
}

interface RematchProposedMessage extends BaseMessage {
  type: 'REMATCH_PROPOSED';
  roomId: string;
  proposedBy: 'X' | 'O';
  expiresAt: number;               // Unix timestamp
}

interface ErrorMessage extends BaseMessage {
  type: 'ERROR';
  code: string;
  message: string;
  recoverable: boolean;
}
```

### Sequence Number Strategy

**Client Sequence:**
- Increments for each command sent
- Server echoes in rejections for matching
- Used for deduplication on reconnect

**Server Sequence:**
- Global per room
- Increments for each broadcast
- Client detects gaps, requests retransmission

**Reconnection:**
```typescript
interface ReconnectMessage extends BaseMessage {
  type: 'RECONNECT';
  roomId: string;
  playerId: string;
  lastReceivedSequence: number;    // Last server sequence seen
}

interface SyncMessage extends BaseMessage {
  type: 'SYNC';
  messages: ServerMessage[];       // Missing messages since last sequence
}
```

---

## 7. Game-State Model

### Core Game State

```typescript
// Immutable game state
interface GameState {
  gameId: string;
  roomId: string;
  board: Board;
  currentTurn: PlayerSymbol;
  status: GameStatus;
  result: GameResult | null;
  moveHistory: Move[];
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
}

type Board = [
  [CellValue, CellValue, CellValue],
  [CellValue, CellValue, CellValue],
  [CellValue, CellValue, CellValue]
];

type CellValue = '' | 'X' | 'O';
type PlayerSymbol = 'X' | 'O';
type GameStatus = 'waiting' | 'active' | 'ended' | 'abandoned';

interface GameResult {
  winner: 'X' | 'O' | 'draw';
  winningLine: WinningLine | null;
  reason: 'WIN' | 'DRAW' | 'FORFEIT' | 'TIMEOUT';
}

interface WinningLine {
  type: 'row' | 'col' | 'diagonal';
  positions: [[number, number], [number, number], [number, number]];
}

interface Move {
  player: PlayerSymbol;
  position: [number, number];      // [row, col]
  timestamp: number;
  sequenceNumber: number;
}
```

### Room State

```typescript
interface Room {
  id: string;
  players: {
    X: Player | null;
    O: Player | null;
  };
  currentGame: GameState | null;
  gameHistory: string[];           // Array of gameIds
  createdAt: number;
  lastActivityAt: number;
  settings: RoomSettings;
}

interface Player {
  id: string;
  symbol: PlayerSymbol;
  name: string | null;
  connected: boolean;
  connectionId: string | null;     // WebSocket connection ID
  lastSeenAt: number;
}

interface RoomSettings {
  rematchEnabled: boolean;
  rematchTimeoutSeconds: number;
  reconnectTimeoutSeconds: number;
}
```

### State Transitions

```
Game Status State Machine:

waiting → active
  Trigger: Both players connected
  
active → ended
  Trigger: Win condition OR draw OR forfeit
  
ended → waiting (rematch)
  Trigger: Both players accept rematch
  
active → abandoned
  Trigger: Player disconnected > timeout
```

### Game Engine Pure Functions

```typescript
// Core game engine interface
interface GameEngine {
  // Initialize new game
  createGame(roomId: string, playerX: string, playerO: string): GameState;
  
  // Apply move, return new state + events
  applyMove(
    state: GameState,
    player: PlayerSymbol,
    position: [number, number]
  ): GameStateResult;
  
  // Validate move
  isValidMove(
    state: GameState,
    player: PlayerSymbol,
    position: [number, number]
  ): ValidationResult;
  
  // Check game end
  checkGameEnd(state: GameState): GameResult | null;
  
  // Check win condition
  checkWin(board: Board, player: PlayerSymbol): WinningLine | null;
  
  // Check draw
  isDraw(board: Board): boolean;
}

interface GameStateResult {
  newState: GameState;
  events: GameEvent[];
  valid: boolean;
  error?: string;
}

type GameEvent = 
  | { type: 'MOVE_MADE'; move: Move }
  | { type: 'GAME_WON'; winner: PlayerSymbol; line: WinningLine }
  | { type: 'GAME_DRAWN' }
  | { type: 'TURN_CHANGED'; newTurn: PlayerSymbol };

interface ValidationResult {
  valid: boolean;
  reason?: 'NOT_YOUR_TURN' | 'CELL_OCCUPIED' | 'GAME_ENDED' | 'INVALID_POSITION';
}
```

**Key Properties:**
- All functions pure (no side effects)
- Deterministic (same input → same output)
- No I/O, no async
- Exhaustive win checking
- Immutable state updates

---

## 8. Database Model

### Schema Design

**Principle:** Store durable data, keep hot path in memory.

```sql
-- Rooms table
CREATE TABLE rooms (
  id VARCHAR(8) PRIMARY KEY,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_activity_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  settings JSONB NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  INDEX idx_last_activity (last_activity_at),
  INDEX idx_status (status)
);

-- Players table
CREATE TABLE players (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id VARCHAR(8) NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  symbol CHAR(1) NOT NULL CHECK (symbol IN ('X', 'O')),
  name VARCHAR(50),
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (room_id, symbol),
  INDEX idx_room (room_id)
);

-- Games table (completed games only)
CREATE TABLE games (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id VARCHAR(8) NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  player_x_id UUID NOT NULL REFERENCES players(id),
  player_o_id UUID NOT NULL REFERENCES players(id),
  
  final_board CHAR(9) NOT NULL,    -- "XXOO X O " (row-major order)
  winner CHAR(1) CHECK (winner IN ('X', 'O', 'D')),  -- D = draw
  winning_line JSONB,              -- {type, positions}
  
  move_history JSONB NOT NULL,     -- Array of moves
  move_count INTEGER NOT NULL,
  
  started_at TIMESTAMP NOT NULL,
  ended_at TIMESTAMP NOT NULL,
  duration_ms INTEGER NOT NULL,
  
  result_reason VARCHAR(20) NOT NULL,  -- WIN, DRAW, FORFEIT, TIMEOUT
  
  INDEX idx_room_ended (room_id, ended_at DESC),
  INDEX idx_ended_at (ended_at DESC)
);

-- Optional: Move-by-move audit log (for debugging/analytics)
CREATE TABLE move_log (
  id BIGSERIAL PRIMARY KEY,
  game_id UUID NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  sequence_number INTEGER NOT NULL,
  player_symbol CHAR(1) NOT NULL,
  position_row SMALLINT NOT NULL CHECK (position_row BETWEEN 0 AND 2),
  position_col SMALLINT NOT NULL CHECK (position_col BETWEEN 0 AND 2),
  timestamp TIMESTAMP NOT NULL,
  client_message_id VARCHAR(36),
  
  INDEX idx_game (game_id, sequence_number)
);
```

### SQLite Equivalent

For simplicity in development:

```sql
CREATE TABLE rooms (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,     -- Unix timestamp
  last_activity_at INTEGER NOT NULL,
  settings TEXT NOT NULL,          -- JSON string
  status TEXT NOT NULL DEFAULT 'active'
);

CREATE TABLE players (
  id TEXT PRIMARY KEY,             -- UUID string
  room_id TEXT NOT NULL,
  symbol TEXT NOT NULL CHECK (symbol IN ('X', 'O')),
  name TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,
  UNIQUE (room_id, symbol)
);

CREATE TABLE games (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  player_x_id TEXT NOT NULL,
  player_o_id TEXT NOT NULL,
  final_board TEXT NOT NULL,
  winner TEXT CHECK (winner IN ('X', 'O', 'D')),
  winning_line TEXT,               -- JSON string
  move_history TEXT NOT NULL,      -- JSON string
  move_count INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  result_reason TEXT NOT NULL,
  FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,
  FOREIGN KEY (player_x_id) REFERENCES players(id),
  FOREIGN KEY (player_o_id) REFERENCES players(id)
);

CREATE INDEX idx_room_ended ON games(room_id, ended_at DESC);
CREATE INDEX idx_last_activity ON rooms(last_activity_at);
```

### Data Access Patterns

**Hot Path (In-Memory):**
- Active game state (current board, turn)
- Player connections
- Room membership

**Cold Path (Database):**
- Room creation/lookup
- Game history queries
- Completed game persistence
- Analytics queries

**Write Strategy:**
- Game start: INSERT players, room metadata
- Move: No DB write (in-memory only)
- Game end: INSERT game record asynchronously
- Room cleanup: Cron job deletes old rooms

---

## 9. Reconnection Strategy

### Principles
1. Preserve game state during temporary disconnections
2. Automatic reconnection with exponential backoff
3. Full state synchronization on reconnect
4. Clear timeout boundaries

### Client-Side Reconnection

```typescript
class ReconnectionManager {
  private reconnectAttempts = 0;
  private maxAttempts = 5;
  private baseDelay = 1000;        // 1 second
  private maxDelay = 30000;        // 30 seconds
  
  // Exponential backoff: 1s, 2s, 4s, 8s, 16s, 30s
  getNextDelay(): number {
    const delay = Math.min(
      this.baseDelay * Math.pow(2, this.reconnectAttempts),
      this.maxDelay
    );
    this.reconnectAttempts++;
    return delay;
  }
  
  // Jitter to prevent thundering herd
  getDelayWithJitter(delay: number): number {
    return delay + Math.random() * 1000;
  }
}
```

**Reconnection Flow:**

1. **Detect Disconnect**
   - WebSocket `close` event
   - Ping timeout (no pong after 5s)
   - Network change event

2. **Store State**
   - Save roomId, playerId, lastSequence
   - Persist to localStorage (survive refresh)

3. **Attempt Reconnect**
   - Wait for backoff delay
   - Establish new WebSocket connection
   - Send RECONNECT message with credentials

4. **Server Validates**
   - Check room still exists
   - Check player was in room
   - Check within timeout window (5 minutes)

5. **State Sync**
   - Server sends ROOM_STATE with full current state
   - Server sends SYNC with missed messages
   - Client reconciles local state

6. **Resume**
   - Game continues from current position
   - Player can make moves again

### Server-Side Reconnection Handling

```typescript
class ConnectionManager {
  // Map: connectionId → { roomId, playerId, lastSeen }
  private connections = new Map();
  
  // Map: playerId → connectionId
  private playerConnections = new Map();
  
  handleDisconnect(connectionId: string) {
    const info = this.connections.get(connectionId);
    if (!info) return;
    
    const { roomId, playerId } = info;
    
    // Mark player as disconnected, but keep room state
    this.markPlayerDisconnected(roomId, playerId);
    
    // Notify opponent
    this.broadcast(roomId, {
      type: 'OPPONENT_DISCONNECTED',
      opponentSymbol: this.getPlayerSymbol(playerId),
      reconnectTimeout: 300  // 5 minutes
    });
    
    // Schedule cleanup after timeout
    this.scheduleRoomCleanup(roomId, 300000);  // 5 min
  }
  
  handleReconnect(connectionId: string, message: ReconnectMessage) {
    const { roomId, playerId, lastReceivedSequence } = message;
    
    // Validate room exists and player was member
    const room = this.roomManager.getRoom(roomId);
    if (!room || !room.hasPlayer(playerId)) {
      return this.sendError(connectionId, 'INVALID_RECONNECT');
    }
    
    // Cancel cleanup timer
    this.cancelRoomCleanup(roomId);
    
    // Update connection mapping
    this.connections.set(connectionId, { roomId, playerId, lastSeen: Date.now() });
    this.playerConnections.set(playerId, connectionId);
    
    // Mark player as connected
    this.markPlayerConnected(roomId, playerId, connectionId);
    
    // Send full room state
    this.sendRoomState(connectionId, room);
    
    // Send missed messages
    const missedMessages = this.getMissedMessages(roomId, lastReceivedSequence);
    if (missedMessages.length > 0) {
      this.send(connectionId, {
        type: 'SYNC',
        messages: missedMessages
      });
    }
    
    // Notify opponent
    this.broadcast(roomId, {
      type: 'OPPONENT_CONNECTED',
      opponentSymbol: this.getPlayerSymbol(playerId)
    });
  }
}
```

### Edge Cases

**Scenario 1: Both players disconnect**
- Server preserves game state for 5 minutes
- First to reconnect sees "waiting for opponent"
- Second reconnection resumes game
- If neither reconnects within timeout, game marked abandoned

**Scenario 2: Disconnect during move**
- Server received move, client didn't get confirmation
- Client resends move on reconnect (idempotent)
- Server deduplicates using messageId
- State converges correctly

**Scenario 3: Browser refresh**
- Client loses in-memory state
- Credentials in localStorage used to reconnect
- Server sends full state
- Game continues

**Scenario 4: Network partition**
- Client thinks it's connected but server disagrees
- Client ping timeout (5s) detects issue
- Triggers reconnection flow
- Resolves via state sync

---

## 10. Security Model

### Threat Model

**Threats:**
1. Move injection (player makes invalid moves)
2. Impersonation (player acts as opponent)
3. Room hijacking (joining private room without invite)
4. DoS (flooding with moves/connections)
5. Cheating (manipulating client to win)
6. Data leakage (seeing other rooms' data)

### Security Measures

#### 1. Server-Authoritative Gameplay

```typescript
// Server validates EVERY move
function handleMove(playerId: string, move: MakeMoveMessage) {
  const room = roomManager.getRoom(move.roomId);
  
  // Verify player is in room
  if (!room.hasPlayer(playerId)) {
    return reject('UNAUTHORIZED');
  }
  
  // Verify it's player's turn
  const playerSymbol = room.getPlayerSymbol(playerId);
  if (room.game.currentTurn !== playerSymbol) {
    return reject('NOT_YOUR_TURN');
  }
  
  // Validate move via game engine
  const validation = gameEngine.isValidMove(
    room.game,
    playerSymbol,
    [move.row, move.col]
  );
  
  if (!validation.valid) {
    return reject(validation.reason);
  }
  
  // Apply move
  const result = gameEngine.applyMove(room.game, playerSymbol, [move.row, move.col]);
  room.game = result.newState;
  
  // Broadcast to room
  broadcast(room, { type: 'MOVE_ACCEPTED', ... });
}
```

**Client can:**
- Request moves
- Optimistically render (with rollback)

**Client cannot:**
- Force move acceptance
- Modify game state
- Skip validation

#### 2. Player Authentication

```typescript
// On join, server assigns cryptographically random player ID
function handleJoin(connectionId: string, message: JoinRoomMessage) {
  const room = roomManager.getRoom(message.roomId);
  
  if (!room) {
    return sendError(connectionId, 'ROOM_NOT_FOUND');
  }
  
  // Assign or retrieve player ID
  let playerId: string;
  if (message.playerId && room.hasPlayer(message.playerId)) {
    // Reconnecting
    playerId = message.playerId;
  } else {
    // New player
    playerId = crypto.randomUUID();
    room.addPlayer(playerId);
  }
  
  // Map connection to player
  connectionManager.associate(connectionId, playerId, room.id);
  
  // Send player their ID (stored in client for reconnect)
  send(connectionId, {
    type: 'ROOM_STATE',
    playerId,  // Critical: player learns their ID
    ...
  });
}
```

**Every subsequent message:**
```typescript
// Extract playerId from connection
const playerId = connectionManager.getPlayerId(connectionId);

// Verify playerId matches message
if (message.playerId !== playerId) {
  return reject('IMPERSONATION_ATTEMPT');
}
```

#### 3. Room Access Control

```typescript
// Room IDs: 8-character alphanumeric, crypto-random
function generateRoomId(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';  // No ambiguous chars
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes)
    .map(b => chars[b % chars.length])
    .join('');
}

// Entropy: 32^8 ≈ 1.2 trillion combinations
// Guessing probability: negligible
```

**No public room list:**
- Can't enumerate rooms
- Must have exact ID to join
- ID only shared via out-of-band (messaging, etc.)

#### 4. Rate Limiting

```typescript
class RateLimiter {
  private moveCounts = new Map<string, { count: number; window: number }>();
  
  checkMoveLimit(playerId: string): boolean {
    const now = Date.now();
    const record = this.moveCounts.get(playerId) || { count: 0, window: now };
    
    // Reset window every second
    if (now - record.window > 1000) {
      record.count = 0;
      record.window = now;
    }
    
    record.count++;
    this.moveCounts.set(playerId, record);
    
    // Max 10 moves/second (legitimate play: ~1 move/few seconds)
    return record.count <= 10;
  }
}

// Apply in message handler
if (!rateLimiter.checkMoveLimit(playerId)) {
  return reject('RATE_LIMIT_EXCEEDED');
}
```

**Additional limits:**
- Max 2 connections per IP per room (allows mobile + desktop)
- Max 100 WebSocket messages/minute per connection
- Max room creation: 5/hour per IP

#### 5. Input Validation

```typescript
// Validate all message fields
function validateMoveMessage(msg: any): msg is MakeMoveMessage {
  return (
    typeof msg.type === 'string' &&
    msg.type === 'MAKE_MOVE' &&
    typeof msg.roomId === 'string' &&
    /^[A-Z0-9]{8}$/.test(msg.roomId) &&
    typeof msg.playerId === 'string' &&
    typeof msg.move === 'object' &&
    [0, 1, 2].includes(msg.move.row) &&
    [0, 1, 2].includes(msg.move.col) &&
    typeof msg.sequenceNumber === 'number' &&
    msg.sequenceNumber >= 0
  );
}

// Reject malformed messages immediately
if (!validateMoveMessage(message)) {
  logger.warn('Invalid message received', { connectionId, message });
  return sendError(connectionId, 'MALFORMED_MESSAGE');
}
```

#### 6. XSS Prevention

**Client-side:**
- React automatically escapes JSX content
- Never use `dangerouslySetInnerHTML`
- Sanitize player names (if user-provided)

```typescript
function sanitizePlayerName(name: string): string {
  return name
    .trim()
    .slice(0, 50)
    .replace(/[<>\"']/g, '');  // Remove HTML/JS chars
}
```

#### 7. CORS Configuration

```typescript
// Only allow same-origin WebSocket upgrades
const wss = new WebSocketServer({
  server: httpServer,
  verifyClient: (info) => {
    const origin = info.origin;
    const allowedOrigins = [
      'http://localhost:3000',
      'https://yourdomain.com'
    ];
    return allowedOrigins.includes(origin);
  }
});
```

#### 8. Secrets Management

**Never expose:**
- Database credentials (use environment variables)
- Internal implementation details in error messages (production)

**Development vs Production:**
```typescript
const isDev = process.env.NODE_ENV === 'development';

function getErrorMessage(error: Error): string {
  if (isDev) {
    return error.stack || error.message;  // Full details
  } else {
    return 'An error occurred';           // Generic message
  }
}
```

---

## 11. Observability Strategy

### Logging

**Structured Logging (JSON):**

```typescript
import winston from 'winston';

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'tictactoe-server' },
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
    new winston.transports.File({ filename: 'logs/combined.log' })
  ]
});
```

**Log Levels:**
- `error`: Unrecoverable errors, exceptions
- `warn`: Recoverable errors, rate limits, invalid input
- `info`: Key events (game start, end, player join)
- `debug`: Detailed flow (moves, state changes)
- `trace`: Protocol messages (dev only)

**Key Events to Log:**

```typescript
// Room lifecycle
logger.info('Room created', { roomId, timestamp });
logger.info('Player joined', { roomId, playerId, symbol });
logger.info('Game started', { roomId, gameId, players });
logger.info('Game ended', { roomId, gameId, winner, duration });

// Moves
logger.debug('Move received', { roomId, playerId, move });
logger.debug('Move accepted', { roomId, gameId, move, sequence });
logger.warn('Move rejected', { roomId, playerId, move, reason });

// Connections
logger.info('WebSocket connected', { connectionId, ip });
logger.info('WebSocket disconnected', { connectionId, duration });
logger.info('Player reconnected', { roomId, playerId, downtime });

// Errors
logger.error('Game engine error', { roomId, gameId, error: err.stack });
logger.warn('Rate limit exceeded', { playerId, endpoint });
```

**Trace IDs:**
```typescript
// Generate per-request trace ID
function generateTraceId(): string {
  return crypto.randomUUID();
}

// Include in all logs for request
logger.info('Processing move', { traceId, roomId, playerId, move });

// Return to client for support requests
sendError(connectionId, 'INTERNAL_ERROR', { traceId });
```

### Metrics

**Key Metrics to Track:**

```typescript
class Metrics {
  // Counters
  roomsCreated = 0;
  gamesCompleted = 0;
  movesProcessed = 0;
  errors = { validation: 0, internal: 0, network: 0 };
  
  // Gauges
  activeConnections = 0;
  activeRooms = 0;
  activeGames = 0;
  
  // Histograms
  moveLatencies: number[] = [];
  gamedurations: number[] = [];
  reconnectTimes: number[] = [];
  
  // Calculate percentiles
  getP95(values: number[]): number {
    const sorted = values.sort((a, b) => a - b);
    const index = Math.floor(sorted.length * 0.95);
    return sorted[index] || 0;
  }
}
```

**Metrics Endpoint:**
```typescript
app.get('/metrics', (req, res) => {
  const metrics = metricsCollector.getSnapshot();
  res.json({
    counters: {
      rooms_created: metrics.roomsCreated,
      games_completed: metrics.gamesCompleted,
      moves_processed: metrics.movesProcessed,
      errors: metrics.errors
    },
    gauges: {
      active_connections: metrics.activeConnections,
      active_rooms: metrics.activeRooms,
      active_games: metrics.activeGames
    },
    histograms: {
      move_latency_p50: metrics.getP50(metrics.moveLatencies),
      move_latency_p95: metrics.getP95(metrics.moveLatencies),
      move_latency_p99: metrics.getP99(metrics.moveLatencies),
      game_duration_avg: metrics.getAvg(metrics.gameDurations)
    },
    timestamp: Date.now()
  });
});
```

### Health Checks

```typescript
app.get('/health', (req, res) => {
  const health = {
    status: 'healthy',
    timestamp: Date.now(),
    uptime: process.uptime(),
    checks: {
      database: checkDatabase(),
      memory: checkMemory(),
      websocket: checkWebSocket()
    }
  };
  
  const allHealthy = Object.values(health.checks).every(c => c.status === 'ok');
  const statusCode = allHealthy ? 200 : 503;
  
  res.status(statusCode).json(health);
});

function checkDatabase(): HealthCheck {
  try {
    db.query('SELECT 1');  // Ping database
    return { status: 'ok' };
  } catch (err) {
    return { status: 'error', message: err.message };
  }
}

function checkMemory(): HealthCheck {
  const usage = process.memoryUsage();
  const heapUsedMB = usage.heapUsed / 1024 / 1024;
  const heapTotalMB = usage.heapTotal / 1024 / 1024;
  
  if (heapUsedMB / heapTotalMB > 0.9) {
    return { status: 'warning', message: 'High memory usage' };
  }
  
  return { status: 'ok', heapUsedMB, heapTotalMB };
}
```

### Distributed Tracing (Optional - Phase 2)

For multi-instance deployments, integrate OpenTelemetry or similar.

---

## 12. Testing Strategy

### Test Pyramid

```
      ┌─────────────────┐
      │   E2E Tests     │  < 10 tests (critical flows)
      │   (Playwright)  │
      └─────────────────┘
    ┌───────────────────────┐
    │  Integration Tests    │  ~50 tests (protocol, DB)
    │  (Vitest + Supertest) │
    └───────────────────────┘
  ┌─────────────────────────────┐
  │     Unit Tests              │  ~200 tests (game logic)
  │     (Vitest)                │
  └─────────────────────────────┘
```

### Unit Tests

**Target: Game Engine (Pure Functions)**

```typescript
// game/engine.test.ts
describe('GameEngine', () => {
  describe('isValidMove', () => {
    it('accepts move on empty cell during player turn', () => {
      const state = createGame('room1', 'p1', 'p2');
      const result = gameEngine.isValidMove(state, 'X', [0, 0]);
      expect(result.valid).toBe(true);
    });
    
    it('rejects move on occupied cell', () => {
      const state = createGame('room1', 'p1', 'p2');
      state.board[0][0] = 'X';
      const result = gameEngine.isValidMove(state, 'O', [0, 0]);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('CELL_OCCUPIED');
    });
    
    it('rejects move when not player turn', () => {
      const state = createGame('room1', 'p1', 'p2');
      const result = gameEngine.isValidMove(state, 'O', [0, 0]);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('NOT_YOUR_TURN');
    });
  });
  
  describe('checkWin', () => {
    it('detects horizontal win', () => {
      const board: Board = [
        ['X', 'X', 'X'],
        ['O', 'O', ''],
        ['', '', '']
      ];
      const result = gameEngine.checkWin(board, 'X');
      expect(result).toEqual({
        type: 'row',
        positions: [[0, 0], [0, 1], [0, 2]]
      });
    });
    
    it('detects diagonal win', () => {
      const board: Board = [
        ['X', 'O', ''],
        ['O', 'X', ''],
        ['', '', 'X']
      ];
      const result = gameEngine.checkWin(board, 'X');
      expect(result).toEqual({
        type: 'diagonal',
        positions: [[0, 0], [1, 1], [2, 2]]
      });
    });
    
    it('returns null when no win', () => {
      const board: Board = [
        ['X', 'O', 'X'],
        ['X', 'O', ''],
        ['O', 'X', '']
      ];
      const result = gameEngine.checkWin(board, 'X');
      expect(result).toBeNull();
    });
  });
  
  describe('applyMove', () => {
    it('updates board and changes turn', () => {
      const state = createGame('room1', 'p1', 'p2');
      const result = gameEngine.applyMove(state, 'X', [1, 1]);
      
      expect(result.newState.board[1][1]).toBe('X');
      expect(result.newState.currentTurn).toBe('O');
      expect(result.newState.moveHistory).toHaveLength(1);
      expect(result.events).toContainEqual({ type: 'MOVE_MADE', move: expect.any(Object) });
    });
    
    it('detects win and emits event', () => {
      const state = createGame('room1', 'p1', 'p2');
      state.board = [
        ['X', 'X', ''],
        ['O', 'O', ''],
        ['', '', '']
      ];
      state.currentTurn = 'X';
      
      const result = gameEngine.applyMove(state, 'X', [0, 2]);
      
      expect(result.newState.status).toBe('ended');
      expect(result.newState.result?.winner).toBe('X');
      expect(result.events).toContainEqual({ 
        type: 'GAME_WON', 
        winner: 'X', 
        line: expect.any(Object) 
      });
    });
  });
});
```

**Coverage Target:** 95%+ for game engine

### Integration Tests

**Target: WebSocket Protocol**

```typescript
// websocket/protocol.test.ts
describe('WebSocket Protocol', () => {
  let server: Server;
  let client1: WebSocket;
  let client2: WebSocket;
  
  beforeEach(async () => {
    server = await startTestServer();
    client1 = new WebSocket(`ws://localhost:${TEST_PORT}`);
    client2 = new WebSocket(`ws://localhost:${TEST_PORT}`);
    await Promise.all([
      waitForOpen(client1),
      waitForOpen(client2)
    ]);
  });
  
  afterEach(async () => {
    client1.close();
    client2.close();
    await server.close();
  });
  
  it('completes full game flow', async () => {
    // Create room
    const createResponse = await fetch(`http://localhost:${TEST_PORT}/api/rooms`, {
      method: 'POST'
    });
    const { roomId } = await createResponse.json();
    
    // Player 1 joins
    client1.send(JSON.stringify({
      type: 'JOIN_ROOM',
      roomId,
      version: 1,
      messageId: uuid(),
      timestamp: Date.now()
    }));
    
    const p1State = await waitForMessage(client1, 'ROOM_STATE');
    expect(p1State.playerSymbol).toBe('X');
    
    // Player 2 joins
    client2.send(JSON.stringify({
      type: 'JOIN_ROOM',
      roomId,
      version: 1,
      messageId: uuid(),
      timestamp: Date.now()
    }));
    
    const p2State = await waitForMessage(client2, 'ROOM_STATE');
    expect(p2State.playerSymbol).toBe('O');
    
    // Player 1 makes move
    client1.send(JSON.stringify({
      type: 'MAKE_MOVE',
      roomId,
      playerId: p1State.playerId,
      move: { row: 0, col: 0 },
      version: 1,
      messageId: uuid(),
      timestamp: Date.now(),
      sequenceNumber: 1
    }));
    
    // Both clients receive move
    const p1MoveAck = await waitForMessage(client1, 'MOVE_ACCEPTED');
    const p2MoveNotif = await waitForMessage(client2, 'MOVE_ACCEPTED');
    
    expect(p1MoveAck.newGameState.board[0][0]).toBe('X');
    expect(p2MoveNotif.newGameState.board[0][0]).toBe('X');
  });
  
  it('rejects move from wrong player', async () => {
    const { roomId, p1Id, p2Id } = await setupGame();
    
    // Player 2 tries to move when it's X's turn
    client2.send(JSON.stringify({
      type: 'MAKE_MOVE',
      roomId,
      playerId: p2Id,
      move: { row: 0, col: 0 },
      version: 1,
      messageId: uuid(),
      timestamp: Date.now(),
      sequenceNumber: 1
    }));
    
    const rejection = await waitForMessage(client2, 'MOVE_REJECTED');
    expect(rejection.reason).toBe('NOT_YOUR_TURN');
  });
  
  it('handles reconnection correctly', async () => {
    const { roomId, p1Id } = await setupGame();
    
    // Make a move
    await makeMove(client1, roomId, p1Id, [0, 0]);
    
    // Disconnect client1
    client1.close();
    await waitForClose(client1);
    
    // Client2 receives disconnect notification
    const disconnectMsg = await waitForMessage(client2, 'OPPONENT_DISCONNECTED');
    expect(disconnectMsg.opponentSymbol).toBe('X');
    
    // Reconnect client1
    const client1New = new WebSocket(`ws://localhost:${TEST_PORT}`);
    await waitForOpen(client1New);
    
    client1New.send(JSON.stringify({
      type: 'RECONNECT',
      roomId,
      playerId: p1Id,
      lastReceivedSequence: 1,
      version: 1,
      messageId: uuid(),
      timestamp: Date.now()
    }));
    
    // Receive full state
    const stateSync = await waitForMessage(client1New, 'ROOM_STATE');
    expect(stateSync.gameState.board[0][0]).toBe('X');
    
    // Client2 receives reconnect notification
    const reconnectMsg = await waitForMessage(client2, 'OPPONENT_CONNECTED');
    expect(reconnectMsg.opponentSymbol).toBe('X');
  });
});
```

### End-to-End Tests

**Target: Critical User Flows**

```typescript
// e2e/game.spec.ts (Playwright)
test.describe('Tic-Tac-Toe Game', () => {
  test('two players can complete a game', async ({ browser }) => {
    const context1 = await browser.newContext();
    const context2 = await browser.newContext();
    
    const page1 = await context1.newPage();
    const page2 = await context2.newPage();
    
    // Player 1 creates game
    await page1.goto('http://localhost:3000');
    await page1.click('text=Create Game');
    const roomLink = await page1.locator('[data-testid="room-link"]').textContent();
    
    // Player 2 joins via link
    await page2.goto(roomLink);
    await page2.waitForSelector('text=Waiting for your move');
    
    // Player 1 makes first move
    await page1.click('[data-testid="cell-0-0"]');
    await page1.waitForSelector('[data-testid="cell-0-0"]:has-text("X")');
    
    // Player 2 sees the move
    await page2.waitForSelector('[data-testid="cell-0-0"]:has-text("X")');
    
    // Player 2 makes move
    await page2.click('[data-testid="cell-1-1"]');
    
    // Continue game to completion
    await page1.click('[data-testid="cell-0-1"]');
    await page2.click('[data-testid="cell-1-0"]');
    await page1.click('[data-testid="cell-0-2"]');
    
    // Both see winner
    await page1.waitForSelector('text=You won!');
    await page2.waitForSelector('text=You lost');
    
    // Rematch flow
    await page1.click('text=Rematch');
    await page2.click('text=Accept');
    
    await page1.waitForSelector('[data-testid="cell-0-0"]:empty');
    await page2.waitForSelector('text=Your turn');  // O goes first in rematch
  });
  
  test('reconnection preserves game state', async ({ browser, page }) => {
    // Start game
    await page.goto('http://localhost:3000');
    await page.click('text=Create Game');
    const roomLink = await page.locator('[data-testid="room-link"]').textContent();
    
    // Make move
    await page.click('[data-testid="cell-0-0"]');
    
    // Simulate reconnection (refresh page)
    await page.reload();
    
    // Game state restored
    await page.waitForSelector('[data-testid="cell-0-0"]:has-text("X")');
    await page.waitForSelector('text=Waiting for opponent');
  });
});
```

### Performance Tests

```typescript
// performance/load.test.ts
describe('Performance Tests', () => {
  it('handles 1000 concurrent games', async () => {
    const numGames = 1000;
    const games = [];
    
    const startTime = Date.now();
    
    // Create 1000 games with 2 players each
    for (let i = 0; i < numGames; i++) {
      games.push(createAndPlayGame());
    }
    
    await Promise.all(games);
    
    const duration = Date.now() - startTime;
    const gamesPerSecond = (numGames / duration) * 1000;
    
    console.log(`Completed ${numGames} games in ${duration}ms`);
    console.log(`Throughput: ${gamesPerSecond.toFixed(2)} games/sec`);
    
    expect(gamesPerSecond).toBeGreaterThan(50);  // Target: 50 games/sec
  });
  
  it('maintains low latency under load', async () => {
    const latencies = [];
    
    for (let i = 0; i < 100; i++) {
      const startTime = Date.now();
      await makeMove(client, roomId, playerId, [0, 0]);
      const latency = Date.now() - startTime;
      latencies.push(latency);
    }
    
    const p95 = calculateP95(latencies);
    expect(p95).toBeLessThan(100);  // P95 < 100ms
  });
});
```

### Test Automation

```json
// package.json
{
  "scripts": {
    "test": "vitest",
    "test:unit": "vitest run --coverage",
    "test:integration": "vitest run tests/integration",
    "test:e2e": "playwright test",
    "test:all": "npm run test:unit && npm run test:integration && npm run test:e2e",
    "test:watch": "vitest watch"
  }
}
```

---

## 13. Performance Strategy

### Performance Targets

| Metric | Target | Measurement |
|--------|--------|-------------|
| Move latency (p95) | < 100ms | Server timestamp to broadcast |
| Initial page load | < 1s | First contentful paint |
| Reconnection time (p95) | < 2s | Disconnect to state restore |
| Memory per game | < 10KB | Process memory / active games |
| Concurrent games | 1000+ | Single instance capacity |
| WebSocket throughput | 10k msg/sec | Messages processed per second |

### Optimization Strategies

#### 1. In-Memory Game State

**Problem:** Database queries in hot path add latency.

**Solution:** Keep active game state in memory.

```typescript
class RoomManager {
  private rooms = new Map<string, Room>();  // In-memory
  
  getRoom(roomId: string): Room | null {
    return this.rooms.get(roomId) || null;
  }
  
  createRoom(roomId: string): Room {
    const room = new Room(roomId);
    this.rooms.set(roomId, room);
    return room;
  }
  
  // Periodic cleanup of inactive rooms
  cleanupInactiveRooms() {
    const now = Date.now();
    const timeout = 24 * 60 * 60 * 1000;  // 24 hours
    
    for (const [roomId, room] of this.rooms.entries()) {
      if (now - room.lastActivityAt > timeout) {
        this.rooms.delete(roomId);
      }
    }
  }
}
```

**Tradeoff:** State lost on server restart. Mitigation: persist on game end, implement state recovery from DB if needed.

#### 2. Efficient Broadcasting

**Problem:** Naive broadcast iterates all connections.

**Solution:** Maintain room → connections index.

```typescript
class ConnectionManager {
  private roomConnections = new Map<string, Set<string>>();
  
  addToRoom(connectionId: string, roomId: string) {
    if (!this.roomConnections.has(roomId)) {
      this.roomConnections.set(roomId, new Set());
    }
    this.roomConnections.get(roomId)!.add(connectionId);
  }
  
  broadcastToRoom(roomId: string, message: ServerMessage) {
    const connections = this.roomConnections.get(roomId);
    if (!connections) return;
    
    const serialized = JSON.stringify(message);  // Serialize once
    
    for (const connectionId of connections) {
      const ws = this.getConnection(connectionId);
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(serialized);  // Reuse serialized message
      }
    }
  }
}
```

**Optimization:** Serialize message once, send to multiple connections.

#### 3. Lazy Database Writes

**Problem:** Synchronous DB writes block move processing.

**Solution:** Async persistence after game end.

```typescript
async function handleGameEnd(room: Room) {
  // Broadcast immediately
  broadcastToRoom(room.id, {
    type: 'GAME_ENDED',
    result: room.game.result
  });
  
  // Persist asynchronously (non-blocking)
  setImmediate(async () => {
    try {
      await gameRepository.saveGame(room.game);
      logger.info('Game persisted', { gameId: room.game.id });
    } catch (err) {
      logger.error('Failed to persist game', { gameId: room.game.id, error: err });
      // Retry logic here
    }
  });
}
```

#### 4. WebSocket Message Batching (Optional)

For high-frequency updates, batch messages:

```typescript
class MessageBatcher {
  private queues = new Map<string, ServerMessage[]>();
  private flushInterval = 50;  // 50ms batch window
  
  enqueue(connectionId: string, message: ServerMessage) {
    if (!this.queues.has(connectionId)) {
      this.queues.set(connectionId, []);
      setTimeout(() => this.flush(connectionId), this.flushInterval);
    }
    this.queues.get(connectionId)!.push(message);
  }
  
  flush(connectionId: string) {
    const messages = this.queues.get(connectionId);
    if (!messages || messages.length === 0) return;
    
    const ws = connectionManager.getConnection(connectionId);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'BATCH', messages }));
    }
    
    this.queues.delete(connectionId);
  }
}
```

**Tradeoff:** Adds 50ms latency. Only use if message volume is extremely high.

#### 5. Client-Side Optimistic Updates

**Reduce perceived latency:**

```typescript
function makeMove(row: number, col: number) {
  // Optimistically update UI
  const optimisticBoard = [...board];
  optimisticBoard[row][col] = playerSymbol;
  setBoard(optimisticBoard);
  
  // Send to server
  websocket.send({
    type: 'MAKE_MOVE',
    move: { row, col }
  });
  
  // Rollback on rejection
  websocket.on('MOVE_REJECTED', () => {
    setBoard(previousBoard);
    showError('Invalid move');
  });
}
```

**Perceived latency:** 0ms (instant feedback)
**Actual latency:** Still measured, but hidden from user.

#### 6. Connection Pooling (Database)

```typescript
import { Pool } from 'pg';

const pool = new Pool({
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  max: 20,              // Max connections
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000
});
```

#### 7. Profiling and Monitoring

**Identify bottlenecks before optimizing:**

```typescript
function profileFunction(name: string, fn: Function) {
  return async (...args: any[]) => {
    const start = process.hrtime.bigint();
    const result = await fn(...args);
    const end = process.hrtime.bigint();
    const durationMs = Number(end - start) / 1e6;
    
    metrics.recordFunctionDuration(name, durationMs);
    
    if (durationMs > 100) {
      logger.warn('Slow function execution', { name, durationMs });
    }
    
    return result;
  };
}

// Wrap critical functions
const profiledApplyMove = profileFunction('applyMove', gameEngine.applyMove);
```

### Performance Checklist

Before claiming performance targets met:

- [ ] Load test with 1000 concurrent games
- [ ] Measure move latency under load (p50, p95, p99)
- [ ] Profile memory usage (heap snapshots)
- [ ] Test reconnection latency
- [ ] Measure database query times
- [ ] Check for memory leaks (run for 24 hours)
- [ ] Verify no N+1 queries
- [ ] Test on low-end devices / slow networks

---

## 14. Deployment Architecture

### Development Environment

```
Local Machine:
├── Node.js 20+ LTS
├── SQLite database (file-based)
├── Frontend dev server (Vite) :3000
├── Backend server (Node) :8080
└── WebSocket server :8080/ws
```

**Start Command:**
```bash
npm run dev          # Runs both frontend and backend concurrently
```

### Production Architecture (Phase 1 - Single Instance)

```
                    ┌─────────────────┐
                    │  Domain/DNS     │
                    │  yourdomain.com │
                    └────────┬────────┘
                             │
                    ┌────────▼────────┐
                    │  Reverse Proxy  │
                    │  (Nginx/Caddy)  │
                    │  - TLS term.    │
                    │  - WS upgrade   │
                    │  - Static serve │
                    └────────┬────────┘
                             │
                ┌────────────┴────────────┐
                │                         │
        ┌───────▼───────┐        ┌───────▼───────┐
        │   Static      │        │   Node.js     │
        │   Assets      │        │   Server      │
        │   (React)     │        │   :8080       │
        └───────────────┘        └───────┬───────┘
                                         │
                                 ┌───────▼───────┐
                                 │   SQLite      │
                                 │   (or Postgres)│
                                 └───────────────┘
```

**Infrastructure:**
- Single VPS/VM (e.g., DigitalOcean Droplet, AWS EC2 t3.small)
- 2GB RAM, 1 vCPU (sufficient for 1000 games)
- Ubuntu 22.04 LTS
- Nginx for reverse proxy
- PM2 for process management
- Let's Encrypt for TLS

**Nginx Config:**

```nginx
server {
    listen 80;
    server_name yourdomain.com;
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    server_name yourdomain.com;
    
    ssl_certificate /etc/letsencrypt/live/yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/yourdomain.com/privkey.pem;
    
    # Static assets
    location / {
        root /var/www/tictactoe/dist;
        try_files $uri $uri/ /index.html;
    }
    
    # API endpoints
    location /api/ {
        proxy_pass http://localhost:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
    
    # WebSocket
    location /ws {
        proxy_pass http://localhost:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
```

**PM2 Config:**

```json
// ecosystem.config.json
{
  "apps": [{
    "name": "tictactoe-server",
    "script": "dist/server/index.js",
    "instances": 1,
    "exec_mode": "cluster",
    "env": {
      "NODE_ENV": "production",
      "PORT": "8080",
      "DB_PATH": "/var/lib/tictactoe/game.db"
    },
    "error_file": "/var/log/tictactoe/error.log",
    "out_file": "/var/log/tictactoe/out.log",
    "log_date_format": "YYYY-MM-DD HH:mm:ss Z",
    "max_memory_restart": "500M"
  }]
}
```

### Production Architecture (Phase 2 - Scaled)

**When to scale:** > 5000 concurrent games, > 1000 requests/sec

```
                        ┌─────────────────┐
                        │   Load Balancer │
                        │   (ALB/HAProxy) │
                        └────────┬────────┘
                                 │
                ┌────────────────┼────────────────┐
                │                │                │
        ┌───────▼───────┐ ┌─────▼──────┐ ┌──────▼───────┐
        │   Node.js     │ │  Node.js   │ │   Node.js    │
        │   Instance 1  │ │  Instance 2│ │  Instance 3  │
        └───────┬───────┘ └─────┬──────┘ └──────┬───────┘
                │               │               │
                └───────────────┼───────────────┘
                                │
                        ┌───────▼───────┐
                        │   Redis       │
                        │   (Pub/Sub +  │
                        │   Session)    │
                        └───────┬───────┘
                                │
                        ┌───────▼───────┐
                        │   PostgreSQL  │
                        │   (Primary)   │
                        └───────────────┘
```

**Stateful Challenges:**
- WebSocket connections are stateful
- Need sticky sessions or service discovery
- Redis pub/sub for cross-instance messaging

**Load Balancer Config (sticky sessions):**
```nginx
upstream tictactoe_backend {
    ip_hash;  # Sticky sessions by IP
    server 10.0.1.10:8080;
    server 10.0.1.11:8080;
    server 10.0.1.12:8080;
}
```

### Deployment Process

**CI/CD Pipeline (GitHub Actions):**

```yaml
# .github/workflows/deploy.yml
name: Deploy

on:
  push:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: '20'
      - run: npm ci
      - run: npm run test:all
      - run: npm run build
  
  deploy:
    needs: test
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - name: Deploy to server
        uses: appleboy/ssh-action@master
        with:
          host: ${{ secrets.SERVER_HOST }}
          username: ${{ secrets.SERVER_USER }}
          key: ${{ secrets.SSH_KEY }}
          script: |
            cd /var/www/tictactoe
            git pull origin main
            npm ci
            npm run build
            pm2 restart tictactoe-server
```

**Rollback Strategy:**
```bash
# Tag releases
git tag v1.0.0
git push --tags

# Rollback to previous version
git checkout v0.9.9
pm2 restart tictactoe-server
```

### Environment Variables

```bash
# .env.production
NODE_ENV=production
PORT=8080
DB_PATH=/var/lib/tictactoe/game.db
# Current adapter: atomic JSON history file; replace with DB_PATH adapter later.
HISTORY_FILE=/var/lib/tictactoe/history.json
LOG_LEVEL=info
CORS_ORIGIN=https://yourdomain.com
WS_HEARTBEAT_INTERVAL=30000
ROOM_CLEANUP_INTERVAL=3600000
```

### Monitoring and Alerting

**Uptime Monitoring:** UptimeRobot, Pingdom
**APM:** Optional - New Relic, Datadog
**Log Aggregation:** Optional - Papertrail, Logtail

**Basic Monitoring:**
```bash
# Cron job to check health
*/5 * * * * curl -f https://yourdomain.com/health || echo "Server down" | mail -s "Alert" admin@yourdomain.com
```

---

## 15. Development Phases

### Phase 1: Foundation (Week 1)

**Goal:** Core game engine + protocol design

**Tasks:**
1. Project setup (TypeScript, build config)
2. Implement game engine (pure functions)
3. Unit tests for game engine (95%+ coverage)
4. Define protocol types (shared)
5. Basic HTTP server (room creation)
6. Database schema + migrations

**Deliverables:**
- Game engine fully tested
- Protocol specification documented
- HTTP API for room creation
- Database operational

**Exit Criteria:**
- All game engine tests pass
- Can create room via API
- Database stores rooms/games

---

### Phase 2: WebSocket Infrastructure (Week 2)

**Goal:** Real-time communication layer

**Tasks:**
1. WebSocket server setup
2. Connection manager (tracking, room mapping)
3. Message handler (routing, validation)
4. Broadcaster (efficient room-level sends)
5. Protocol implementation (join, move, leave)
6. Integration tests for protocol

**Deliverables:**
- WebSocket server operational
- Two clients can join room and exchange messages
- Protocol messages validated and routed correctly

**Exit Criteria:**
- Integration tests pass
- Two players can complete a game via WebSocket
- Invalid moves rejected appropriately

---

### Phase 3: Frontend Core (Week 3)

**Goal:** Playable UI

**Tasks:**
1. React app setup (Vite)
2. WebSocket client wrapper
3. Game board component
4. Room lobby component
5. Connection status indicator
6. Basic styling (responsive layout)
7. Client-side state management (useGameState hook)

**Deliverables:**
- Functional UI for creating/joining rooms
- Visual game board
- Real-time move updates
- Turn indicators

**Exit Criteria:**
- Two browsers can play a complete game
- UI updates in real-time
- Game rules enforced visually

---

### Phase 4: Reliability Features (Week 4)

**Goal:** Reconnection, error handling, persistence

**Tasks:**
1. Reconnection logic (client + server)
2. Sequence number tracking
3. State synchronization on reconnect
4. Game persistence (completed games to DB)
5. Error handling (graceful failures)
6. Observability (logging, metrics)
7. Health check endpoint

**Deliverables:**
- Reconnection works reliably
- Game state persisted after completion
- Structured logs for debugging
- Metrics endpoint operational

**Exit Criteria:**
- Browser refresh preserves game state
- Disconnection/reconnection tested successfully
- Completed games stored in database
- Logs readable and searchable

---

### Phase 5: Polish and Testing (Week 5)

**Goal:** Production readiness

**Tasks:**
1. Rematch functionality
2. Game history UI
3. Security hardening (rate limiting, validation)
4. Performance testing (1000 concurrent games)
5. E2E tests (Playwright)
6. UI polish (animations, transitions)
7. Mobile responsiveness
8. Documentation (README, API docs)

**Deliverables:**
- Rematch feature complete
- Game history viewable
- Security measures implemented
- Performance targets met
- E2E tests pass
- Professional UI/UX

**Exit Criteria:**
- All tests pass (unit, integration, E2E)
- Performance benchmarks met
- No known critical bugs
- Documentation complete

---

### Phase 6: Deployment (Week 6)

**Goal:** Live production system

**Tasks:**
1. Production server provisioning
2. Nginx configuration
3. TLS certificates (Let's Encrypt)
4. CI/CD pipeline (GitHub Actions)
5. Environment variable management
6. Database backup strategy
7. Monitoring setup
8. Load testing in production
9. Rollback procedure documented

**Deliverables:**
- Live production URL
- Automated deployments
- Monitoring and alerting active
- Backup/restore tested

**Exit Criteria:**
- Application accessible via HTTPS
- Health checks passing
- No errors in production logs after 24h
- Load test confirms capacity targets

---

## Risk Analysis and Mitigation

### High-Risk Areas

#### 1. WebSocket State Management

**Risk:** Connection state desyncs between client/server.

**Mitigation:**
- Sequence numbers for message ordering
- Full state sync on reconnect
- Heartbeat/ping to detect dead connections
- Extensive integration testing

**Contingency:** If state sync fails, force full page reload as escape hatch.

#### 2. Concurrent Game State Mutations

**Risk:** Race conditions in move processing.

**Mitigation:**
- Single-threaded event loop (Node.js)
- Immutable game state updates
- Server-side move queuing per room
- Unit tests for concurrent scenarios

**Contingency:** Add mutex locks if race conditions detected.

#### 3. Database Consistency

**Risk:** Game state lost on server crash before persistence.

**Mitigation:**
- Accept risk for Phase 1 (low stakes)
- Document limitation
- Phase 2: Write-ahead log or event sourcing

**Contingency:** Manual data recovery from logs if needed.

#### 4. Scalability Bottlenecks

**Risk:** Single instance can't handle load.

**Mitigation:**
- Design for horizontal scaling from start
- Measure performance early
- Document scaling path (Redis, load balancer)

**Contingency:** Vertical scaling (bigger instance) as temporary fix.

#### 5. Security Vulnerabilities

**Risk:** Move injection, room hijacking, XSS.

**Mitigation:**
- Server-authoritative design
- Exhaustive input validation
- Security audit before launch
- Rate limiting

**Contingency:** Quick patching process, ability to disable features.

---

## Open Questions

Before implementation, resolve:

1. **Player Names:**
   - Allow custom names or just "Player X" / "Player O"?
   - If custom, sanitization strategy?

2. **Room Expiration:**
   - 24 hours confirmed? Or shorter/longer?
   - Warn users before expiration?

3. **Rematch Roles:**
   - Swap starting player or keep same?
   - Randomize?

4. **Spectator Mode:**
   - Out of scope for Phase 1?
   - If added later, how to prevent room capacity issues?

5. **Mobile App:**
   - Web-only or native apps later?
   - Impacts authentication strategy.

6. **Styling Framework:**
   - Tailwind, CSS Modules, styled-components?
   - Team preference?

7. **Hosting Provider:**
   - AWS, DigitalOcean, Heroku, Vercel?
   - Budget constraints?

8. **Database Choice:**
   - SQLite for simplicity or PostgreSQL for production-readiness?
   - Migration path if starting with SQLite?

---

## Next Steps

1. **Review this design document** with team/stakeholders
2. **Resolve open questions**
3. **Approve architecture** before coding
4. **Set up development environment**
5. **Begin Phase 1 implementation**

---

## Appendix: Technology Justification

### Why Node.js?

**Pros:**
- JavaScript full-stack (shared types)
- Excellent WebSocket support
- High concurrency with event loop
- Rich ecosystem (npm)
- Fast enough for realtime games

**Cons:**
- Single-threaded (CPU-bound tasks block)
- Garbage collection pauses

**Alternatives Considered:**
- Go: Faster, but different language from frontend
- Rust: Overkill for this use case
- Python: Asyncio less mature than Node

**Decision:** Node.js for development speed and JavaScript consistency.

### Why WebSocket (ws library)?

**Pros:**
- Lightweight, no framework lock-in
- Low-level control over protocol
- Production-ready, battle-tested
- Minimal overhead

**Cons:**
- More boilerplate than Socket.io

**Alternatives Considered:**
- Socket.io: Abstraction helpful but adds magic
- Server-Sent Events: Unidirectional, not suitable

**Decision:** `ws` for maximum control and learning.

### Why SQLite (Phase 1)?

**Pros:**
- Zero configuration
- Single file, easy backups
- Sufficient for 1000s of games
- No separate DB server

**Cons:**
- No network access (single instance only)
- Limited concurrency

**Migration Path:** PostgreSQL when scaling horizontally.

**Decision:** SQLite for simplicity, document PostgreSQL migration.

### Why React?

**Pros:**
- Mature, huge ecosystem
- Excellent developer experience
- Built-in state management (hooks)
- Fast rendering

**Cons:**
- None significant for this use case

**Alternatives Considered:**
- Vue: Equally good, team preference
- Svelte: Less mature ecosystem

**Decision:** React for familiarity and resources.

---

**Document Version:** 1.0
**Last Updated:** 2026-09-02
**Status:** Draft - Awaiting Review
