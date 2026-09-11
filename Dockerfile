# syntax=docker/dockerfile:1
#
# Multi-stage build for the Tic-Tac-Toe realtime server.
# The image contains the compiled server (HTTP API + WebSocket) only; the React
# client is a static bundle built separately (`npm run build:client`) and hosted
# on any static host / CDN.

# ── Stage 1: build ───────────────────────────────────────────────────────────
FROM node:20-alpine AS build
WORKDIR /app

# Install dependencies against the lockfile for reproducible builds.
COPY package.json package-lock.json ./
RUN npm ci

# Compile the server (TypeScript → dist/server, dist/shared).
COPY . .
RUN npm run build:server

# Drop devDependencies so only production modules are carried into the runtime.
RUN npm prune --omit=dev

# ── Stage 2: runtime ─────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080
ENV HISTORY_FILE=/app/data/history.json

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json

# Durable history location — owned by the unprivileged runtime user.
RUN mkdir -p /app/data && chown -R node:node /app
USER node

EXPOSE 8080

# Liveness probe against the built-in /health endpoint (Node 20 global fetch).
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server/index.js"]
