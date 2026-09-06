import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  EMPTY_BOARD,
  brand,
} from '../../shared/protocol/types.js';
import type { GameId, RoomId } from '../../shared/protocol/types.js';
import {
  JsonHistoryRepository,
} from './historyRepository.js';
import type { CompletedGameRecord } from './historyRepository.js';

const temporaryDirectories: string[] = [];

function makeRecord(): CompletedGameRecord {
  return {
    gameId: brand<GameId>('game-001'),
    outcome: 'WIN',
    winner: 'X',
    moveCount: 0,
    startedAt: 100,
    endedAt: 200,
    finalBoard: EMPTY_BOARD,
    result: {
      outcome: 'WIN',
      winner: 'X',
      winningLine: null,
      reason: 'THREE_IN_A_ROW',
      endedAt: 200,
    },
    moveHistory: [],
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('JsonHistoryRepository', () => {
  it('reloads completed games after a repository restart', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ttt-history-'));
    temporaryDirectories.push(directory);
    const filePath = join(directory, 'history.json');
    const roomId = brand<RoomId>('ROOM1234');
    const record = makeRecord();

    new JsonHistoryRepository(filePath).saveCompletedGame(roomId, record);

    const restartedRepository = new JsonHistoryRepository(filePath);
    expect(restartedRepository.loadCompletedGames(roomId)).toEqual([record]);
  });

  it('does not duplicate a game when saved twice', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ttt-history-'));
    temporaryDirectories.push(directory);
    const filePath = join(directory, 'history.json');
    const roomId = brand<RoomId>('ROOM1234');
    const record = makeRecord();
    const repository = new JsonHistoryRepository(filePath);

    repository.saveCompletedGame(roomId, record);
    repository.saveCompletedGame(roomId, record);

    expect(repository.loadCompletedGames(roomId)).toHaveLength(1);
  });
});
