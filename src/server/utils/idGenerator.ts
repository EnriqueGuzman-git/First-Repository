/**
 * @file idGenerator.ts
 * @description Cryptographically secure ID generation utilities.
 *
 * All identifiers in the system come from this module so entropy and
 * format rules are enforced in one place.
 */

import { randomUUID, getRandomValues } from 'node:crypto';
import type { RoomId, GameId, PlayerId, SessionToken, MessageId, CommandId } from '../../shared/protocol/types.js';
import { brand } from '../../shared/protocol/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Room ID
// 8-character Base32 string — alphabet excludes ambiguous chars (0, 1, I, O).
// Entropy: 32^8 ≈ 1.1 trillion combinations.
// ─────────────────────────────────────────────────────────────────────────────

const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function generateRoomId(): RoomId {
  const bytes = new Uint8Array(8);
  getRandomValues(bytes);
  let id = '';
  for (const b of bytes) {
    id += ROOM_ALPHABET[b % 32];
  }
  return brand<RoomId>(id);
}

// ─────────────────────────────────────────────────────────────────────────────
// UUID v4 wrappers — typed so the compiler catches accidental swaps
// ─────────────────────────────────────────────────────────────────────────────

export function generateGameId(): GameId {
  return brand<GameId>(randomUUID());
}

export function generatePlayerId(): PlayerId {
  return brand<PlayerId>(randomUUID());
}

export function generateSessionToken(): SessionToken {
  return brand<SessionToken>(randomUUID());
}

export function generateMessageId(): MessageId {
  return brand<MessageId>(randomUUID());
}

export function generateCommandId(): CommandId {
  return brand<CommandId>(randomUUID());
}
