import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type {
  BoardSnapshot,
  GameResult,
  GameSummary,
  MoveRecord,
} from '../../shared/protocol/types.js';
import type { RoomId } from '../../shared/protocol/types.js';

export type CompletedGameRecord = GameSummary & {
  readonly finalBoard: BoardSnapshot;
  readonly result: GameResult;
  readonly moveHistory: ReadonlyArray<MoveRecord>;
};

export interface HistoryRepository {
  loadCompletedGames(roomId: RoomId): ReadonlyArray<CompletedGameRecord>;
  saveCompletedGame(roomId: RoomId, game: CompletedGameRecord): void;
}

type PersistedHistory = Record<string, CompletedGameRecord[]>;

/** Durable single-process history storage used until a database adapter is added. */
export class JsonHistoryRepository implements HistoryRepository {
  private readonly history = new Map<string, CompletedGameRecord[]>();

  constructor(private readonly filePath: string) {
    if (filePath !== ':memory:') {
      this.loadFromDisk();
    }
  }

  loadCompletedGames(roomId: RoomId): ReadonlyArray<CompletedGameRecord> {
    return this.history.get(roomId) ?? [];
  }

  saveCompletedGame(roomId: RoomId, game: CompletedGameRecord): void {
    const games = this.history.get(roomId) ?? [];
    if (games.some((existing) => existing.gameId === game.gameId)) return;

    games.unshift(game);
    this.history.set(roomId, games);
    this.flushToDisk();
  }

  private loadFromDisk(): void {
    try {
      const raw = readFileSync(this.filePath, 'utf8');
      const persisted = JSON.parse(raw) as PersistedHistory;
      for (const [roomId, games] of Object.entries(persisted)) {
        if (Array.isArray(games)) this.history.set(roomId, games);
      }
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error
        ? (error as { code?: string }).code
        : undefined;
      if (code !== 'ENOENT') throw error;
    }
  }

  private flushToDisk(): void {
    if (this.filePath === ':memory:') return;

    mkdirSync(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp`;
    const persisted = Object.fromEntries(this.history);
    writeFileSync(temporaryPath, JSON.stringify(persisted), 'utf8');
    renameSync(temporaryPath, this.filePath);
  }
}

export function createEmptyHistoryRepository(): HistoryRepository {
  return new JsonHistoryRepository(':memory:');
}
