# Contributing

Thanks for taking a look. This document describes how to set up the project, the
quality gates every change must pass, and the conventions the codebase follows.

## Prerequisites

- **Node.js 20+** (an `.nvmrc` is provided — run `nvm use`)
- **npm 10+**

## Setup

```bash
npm install
cp .env.example .env   # optional; defaults work out of the box
```

## Everyday commands

| Command | Purpose |
|---|---|
| `npm run dev:client` | Vite dev server for the React client on :3000 |
| `npm run build:server && npm start` | Build and run the server on :8080 |
| `npm run typecheck` | Type-check server **and** client projects |
| `npm run lint` | ESLint over `src` and `tests` |
| `npm test` | Unit + integration tests (Vitest) |
| `npm run test:coverage` | Tests with a V8 coverage report |
| `npm run test:e2e` | Playwright end-to-end flow |
| `docker compose up --build` | Run the server in a container |

## Quality gates

Every pull request must be green on CI, which runs exactly what you can run
locally:

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

Please add or update tests for any behavioural change. The game engine and
protocol layers are pure and deterministic — prefer a focused unit test there
over an end-to-end test whenever the change can be exercised that way.

## Architecture conventions

- **Layer boundaries are load-bearing.** The game engine (`src/server/game`)
  must stay free of HTTP/WebSocket imports. The shared protocol
  (`src/shared/protocol`) is the single source of truth for the wire contract —
  change the types and their runtime guards together.
- **Commands are intent; events are confirmed state.** New client → server
  messages are commands with a stable `commandId` (idempotency key); new
  server → client messages are events carrying a `sessionSeq`.
- **Strict TypeScript, no exceptions.** `strict`, `noUncheckedIndexedAccess`,
  and `exactOptionalPropertyTypes` are on. Do not weaken the compiler config to
  make a change compile.
- **Protocol changes are documented.** Update [`PROTOCOL.md`](./PROTOCOL.md)
  (and [`DESIGN.md`](./DESIGN.md) where relevant) alongside code.

## Commit conventions

Commits follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(server): enforce DUPLICATE_SESSION on concurrent connections
fix(sync): scope replay buffer to the intended recipient
docs(readme): add container run instructions
```

## Reporting issues

When filing an issue, include the protocol version, reproduction steps, and —
for a server error — the `traceId` from the `INTERNAL_ERROR` event if one was
returned.
