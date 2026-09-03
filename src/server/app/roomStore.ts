/**
 * @file roomStore.ts
 * @description In-memory room registry.
 *
 * A RoomRecord is a lightweight metadata envelope around a GameSession.
 * The store owns room creation, lookup, expiry, and cleanup.
 */

import type { RoomId, PlayerId, PlayerSymbol, RoomStatus } from '../../shared/protocol/types.js';
import { ROOM_TTL_MS } from '../../shared/protocol/types.js';
import { generateRoomId } from '../utils/idGenerator.js';
import { logger } from '../utils/logger.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type PlayerSlot = {
  playerId: PlayerId;
  symbol: PlayerSymbol;
  name: string | null;
  /** True when the player has an active WebSocket connection. */
  connected: boolean;
  lastSeenAt: number;
};

export type RoomRecord = {
  readonly roomId: RoomId;
  /** Slot for X player — null until joined. */
  playerX: PlayerSlot | null;
  /** Slot for O player — null until joined. */
  playerO: PlayerSlot | null;
  /** Which symbols have declared readiness for the current game. */
  readySymbols: Set<PlayerSymbol>;
  readonly createdAt: number;
  lastActivityAt: number;
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers on RoomRecord
// ─────────────────────────────────────────────────────────────────────────────

export function roomStatus(room: RoomRecord): RoomStatus {
  if (room.playerX !== null && room.playerO !== null) return 'FULL';
  return 'OPEN';
}

export function playerCount(room: RoomRecord): number {
  return (room.playerX ? 1 : 0) + (room.playerO ? 1 : 0);
}

export function getSlot(room: RoomRecord, symbol: PlayerSymbol): PlayerSlot | null {
  return symbol === 'X' ? room.playerX : room.playerO;
}

export function getSlotByPlayerId(room: RoomRecord, playerId: PlayerId): PlayerSlot | null {
  if (room.playerX?.playerId === playerId) return room.playerX;
  if (room.playerO?.playerId === playerId) return room.playerO;
  return null;
}

export function getSymbolForPlayer(room: RoomRecord, playerId: PlayerId): PlayerSymbol | null {
  if (room.playerX?.playerId === playerId) return 'X';
  if (room.playerO?.playerId === playerId) return 'O';
  return null;
}

export function getOpponentSlot(room: RoomRecord, playerId: PlayerId): PlayerSlot | null {
  if (room.playerX?.playerId === playerId) return room.playerO;
  if (room.playerO?.playerId === playerId) return room.playerX;
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// RoomStore
// ─────────────────────────────────────────────────────────────────────────────

export class RoomStore {
  private readonly rooms = new Map<RoomId, RoomRecord>();

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  createRoom(): RoomRecord {
    const roomId = generateRoomId();
    const now    = Date.now();
    const room: RoomRecord = {
      roomId,
      playerX:        null,
      playerO:        null,
      readySymbols:   new Set(),
      createdAt:      now,
      lastActivityAt: now,
    };
    this.rooms.set(roomId, room);
    logger.info('Room created', { roomId });
    return room;
  }

  getRoom(roomId: RoomId): RoomRecord | null {
    const room = this.rooms.get(roomId);
    if (!room) return null;

    // Lazy expiry check
    if (Date.now() - room.lastActivityAt > ROOM_TTL_MS) {
      this.rooms.delete(roomId);
      logger.info('Room expired on access', { roomId });
      return null;
    }

    return room;
  }

  deleteRoom(roomId: RoomId): void {
    this.rooms.delete(roomId);
  }

  touch(roomId: RoomId): void {
    const r = this.rooms.get(roomId);
    if (r) r.lastActivityAt = Date.now();
  }

  // ── Player slot management ────────────────────────────────────────────────

  /**
   * Assign the next available symbol to the player.
   * Returns the assigned symbol, or null if the room is full.
   */
  addPlayer(
    room: RoomRecord,
    playerId: PlayerId,
    name: string | null,
  ): PlayerSymbol | null {
    const now = Date.now();

    if (room.playerX === null) {
      room.playerX = { playerId, symbol: 'X', name, connected: true, lastSeenAt: now };
      room.lastActivityAt = now;
      return 'X';
    }
    if (room.playerO === null) {
      room.playerO = { playerId, symbol: 'O', name, connected: true, lastSeenAt: now };
      room.lastActivityAt = now;
      return 'O';
    }
    return null; // full
  }

  removePlayer(room: RoomRecord, playerId: PlayerId): void {
    if (room.playerX?.playerId === playerId) {
      room.playerX = null;
      room.readySymbols.delete('X');
    } else if (room.playerO?.playerId === playerId) {
      room.playerO = null;
      room.readySymbols.delete('O');
    }
    room.lastActivityAt = Date.now();
  }

  setConnected(room: RoomRecord, playerId: PlayerId, connected: boolean): void {
    const slot = getSlotByPlayerId(room, playerId);
    if (slot) {
      slot.connected     = connected;
      slot.lastSeenAt    = Date.now();
      room.lastActivityAt = Date.now();
    }
  }

  // ── Ready state ───────────────────────────────────────────────────────────

  markReady(room: RoomRecord, symbol: PlayerSymbol): void {
    room.readySymbols.add(symbol);
  }

  bothReady(room: RoomRecord): boolean {
    return room.readySymbols.has('X') && room.readySymbols.has('O');
  }

  resetReady(room: RoomRecord): void {
    room.readySymbols.clear();
  }

  // ── Maintenance ───────────────────────────────────────────────────────────

  purgeExpired(): void {
    const now = Date.now();
    for (const [id, room] of this.rooms) {
      if (now - room.lastActivityAt > ROOM_TTL_MS) {
        this.rooms.delete(id);
        logger.info('Room purged by maintenance', { roomId: id });
      }
    }
  }

  get roomCount(): number { return this.rooms.size; }
}
