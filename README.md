# Real-Time Multiplayer Tic-Tac-Toe

A production-oriented real-time multiplayer Tic-Tac-Toe application built with **React, TypeScript, Node.js, Express, and WebSockets**.

The project is designed to demonstrate senior-level engineering practices around authoritative server state, real-time communication, protocol design, reconnect handling, idempotent commands, deterministic game logic, validation, observability, and automated testing.

> **Project status:** Production-oriented reference implementation. The architecture intentionally models production concerns, while some infrastructure concerns such as horizontally scalable persistence and distributed coordination are outside the current scope.

## Highlights

- Server-authoritative game state
- Real-time gameplay over WebSockets
- Versioned JSON protocol with explicit commands and events
- Per-session sequence numbers for event ordering and gap detection
- Idempotent commands using stable `commandId` values
- Reconnection and state synchronization support
- Optimistic client updates with server validation
- Deterministic, networking-independent game engine
- Runtime protocol guards and strict TypeScript configuration
- Room lifecycle and completed-game history
- Rematch flow with timeout handling
- Health and metrics endpoints
- Unit, integration, and end-to-end test coverage
- ESLint + TypeScript type checking
- Graceful server shutdown

## Tech Stack

| Area | Technology |
|---|---|
| Client | React 18 + TypeScript |
| Server | Node.js 20+ + Express |
| Realtime | WebSocket via `ws` |
| Build | Vite + TypeScript project references |
| Testing | Vitest + Playwright |
| Validation | TypeScript strict mode + protocol guards |
| Persistence | JSON history repository for the current implementation |
| IDs | UUID-based identifiers |

## Architecture

```text
                         Browser
                            │
                    React UI / Game Store
                            │
                     WebSocket Client
                            │
                            ▼
                  ┌─────────────────────┐
                  │   Node.js Server    │
                  ├─────────────────────┤
                  │ Express HTTP API    │
                  │ WebSocket Server    │
                  │ Message Router      │
                  │ Connection Manager  │
                  └──────────┬──────────┘
                             │
                  ┌──────────▼──────────┐
                  │ Application Layer   │
                  │ Room / Session      │
                  │ Command Handling    │
                  └──────────┬──────────┘
                             │
                  ┌──────────▼──────────┐
                  │ Pure Game Engine    │
                  │ State Transitions   │
                  │ Move Validation     │
                  │ Win / Draw Logic    │
                  └─────────────────────┘
                             │
                  ┌──────────▼──────────┐
                  │ History Repository  │
                  │ JSON persistence    │
                  └─────────────────────┘
```

### Layer boundaries

**Client**
- Renders the current game projection.
- Sends commands rather than directly changing authoritative server state.
- Maintains WebSocket lifecycle and reconnect behavior.
- Supports optimistic move rendering and rollback/reconciliation.

**Shared protocol**
- Defines command, event, error, and state types shared by client and server.
- Provides runtime guards at the wire boundary.
- Keeps the transport contract explicit and versioned.

**Server application layer**
- Owns rooms, sessions, command processing, reconnect windows, rematches, and history coordination.
- Converts domain results into protocol events.

**Game engine**
- Contains the core Tic-Tac-Toe rules as deterministic state transitions.
- Has no HTTP or WebSocket dependencies.
- Can be tested independently of the transport layer.

## Realtime Protocol

The WebSocket contract is documented in [`PROTOCOL.md`](./PROTOCOL.md).

The protocol follows a command/event model:

```text
Client                         Server
  │                              │
  │  MAKE_MOVE + commandId       │
  ├─────────────────────────────►│
  │                              │ validate
  │                              │ apply state transition
  │  MOVE_ACK                    │
  │◄─────────────────────────────┤
  │                              │
  │  MOVE_BROADCAST              │
  │◄─────────────────────────────┤
```

Important protocol properties include:

- **Server authority:** the server is the canonical owner of game state.
- **Sequencing:** server events carry session sequence numbers.
- **Idempotency:** retries reuse the same `commandId`.
- **Explicit failures:** invalid commands produce explicit protocol errors/rejections.
- **Versioning:** the protocol uses `ttt-v1` and an in-message protocol version.
- **Reconnect synchronization:** clients can recover missed state after connection loss.

See [`PROTOCOL.md`](./PROTOCOL.md) for the complete message catalog and state machines.

## Project Structure

```text
src/
├── client/
│   ├── components/       # React UI components
│   ├── hooks/            # WebSocket and game hooks
│   ├── lib/              # Client protocol/optimistic-update helpers
│   └── store/            # Client game state
│
├── server/
│   ├── app/              # Rooms, sessions, commands, history
│   ├── game/             # Deterministic game engine
│   ├── http/             # Express routes
│   ├── security/         # Origin/security policies
│   ├── utils/            # IDs, logging, metrics, event factories
│   └── ws/               # WebSocket server and connection handling
│
└── shared/
    └── protocol/         # Shared commands, events, errors, types, guards

tests/
└── e2e/                  # Playwright end-to-end scenarios

DESIGN.md                 # Architecture and engineering design document
PROTOCOL.md               # Authoritative WebSocket protocol specification
```

## Getting Started

### Prerequisites

- **Node.js 20+**
- npm 10+ recommended

Check your versions:

```bash
node --version
npm --version
```

### Install

```bash
npm install
```

### Development

Run the client:

```bash
npm run dev:client
```

The server can be built and started with:

```bash
npm run build:server
npm start
```

The default server port is `8080`.

### Configuration

The server supports these environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | HTTP/WebSocket server port |
| `SERVER_VERSION` | `0.1.0` | Server version reported by the application |
| `CORS_ORIGIN` | `http://localhost:3000` | Allowed browser origin |
| `HISTORY_FILE` | `data/history.json` | Completed-game history file |

For production deployments, use `wss://` and configure an explicit trusted origin rather than relying on permissive development settings.

## HTTP API

### Create a room

```http
POST /api/rooms
```

Returns a generated room ID and join URL.

### Get room state

```http
GET /api/rooms/:id
```

Returns room status, player count, and the current game summary.

### Get game history

```http
GET /api/rooms/:id/history
```

Returns completed games recorded for the room.

### Health

```http
GET /health
```

Returns a basic health/status response.

### Metrics

```http
GET /metrics
```

Returns connection, room, session, memory, protocol, and uptime metrics. In a production deployment, this endpoint should normally be protected or exposed only to internal monitoring infrastructure.

## Testing

The repository uses multiple testing levels.

### Type checking

```bash
npm run typecheck
```

### Linting

```bash
npm run lint
```

### Unit and integration tests

```bash
npm test
```

### End-to-end tests

```bash
npm run test:e2e
```

### Coverage

```bash
npm run test:coverage
```

The test suite includes game-engine rules, persistence, session/room behavior, origin policy, metrics, WebSocket integration, and an end-to-end multiplayer flow.

## Design Decisions

### Server-authoritative state

Clients are treated as projections of server state. A client may optimistically render a move for responsiveness, but the server remains responsible for validating and committing the actual transition.

### Deterministic game engine

The game engine is isolated from WebSockets, Express, and persistence. This makes the most important business rules easy to test and reason about and reduces the risk of transport concerns leaking into domain logic.

### Commands vs. events

Commands represent client intent. Events represent server-confirmed state transitions. This separation makes retries, validation, ordering, and observability easier to reason about.

### Reconnection

The server keeps the active game state during the configured reconnect window. Sequence numbers and synchronization mechanisms allow a reconnecting client to recover from missed events.

### Strict TypeScript

The project uses strict compiler settings, including `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitReturns`, and other safety-focused options.

## Production Considerations

This repository intentionally demonstrates production-oriented engineering patterns without claiming to be a complete large-scale production service.

For a multi-instance production deployment, the next infrastructure steps would include:

- External durable storage instead of process-local game state.
- Redis or another shared coordination layer for rooms and WebSocket instances.
- Distributed rate limiting.
- Protected/internal metrics and operational endpoints.
- Centralized structured logging and tracing.
- Persistent session/reconnect state where required.
- Horizontal scaling and load-balancer/WebSocket configuration.
- Automated dependency/security scanning in CI.
- CI pipelines for lint, typecheck, tests, E2E, and build.

These are deployment-scale concerns rather than prerequisites for understanding the current architecture.

## Engineering Documentation

- [`DESIGN.md`](./DESIGN.md) — product requirements, architecture, security, observability, testing, performance, and deployment design.
- [`PROTOCOL.md`](./PROTOCOL.md) — authoritative WebSocket protocol, message catalog, sequencing, idempotency, and state machines.

## License

No open-source license has been selected yet. If this repository is intended for public reuse, add an appropriate `LICENSE` file before publishing.
