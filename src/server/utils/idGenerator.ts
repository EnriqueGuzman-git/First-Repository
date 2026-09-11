/**
 * Cryptographically secure ID generation. Centralised so entropy and format
 * rules are enforced in one place.
 */

import { randomUUID, getRandomValues } from 'node:crypto';
import type { RoomId, GameId, PlayerId, SessionToken } from '../../shared/protocol/types.js';
import { brand } from '../../shared/protocol/types.js';

// 8-char Base32 room ID; alphabet excludes ambiguous chars (0, 1, I, O). Entropy 32^8 ≈ 1.1e12.
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

// UUID v4 wrappers — typed so the compiler catches accidental swaps.
export function generateGameId(): GameId {
  return brand<GameId>(randomUUID());
}

export function generatePlayerId(): PlayerId {
  return brand<PlayerId>(randomUUID());
}

export function generateSessionToken(): SessionToken {
  return brand<SessionToken>(randomUUID());
}
