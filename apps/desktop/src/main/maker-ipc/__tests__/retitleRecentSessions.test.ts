import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }));
vi.mock('../../logger.js', () => ({
  createLogger: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../localDb/client/current.js', () => ({ getDbClient: vi.fn() }));
vi.mock('../../localDb/ipc/sessions.js', () => ({ broadcastSessionPatched: vi.fn() }));
vi.mock('../../localDb/latestMessageText.js', () => ({ regenerateTitleMaterial: vi.fn() }));
vi.mock('../../security/trustedAppRenderer.js', () => ({
  assertTrustedAppRendererEvent: vi.fn(),
}));
vi.mock('../title.js', () => ({
  regenerateMakerSessionTitle: vi.fn(async () => 'generated title'),
}));

import {
  retitleRecentSessions,
  type RetitleRecentSessionsDeps,
} from '../retitleRecentSessions.js';

function makeDeps(
  overrides: Partial<RetitleRecentSessionsDeps> = {},
): RetitleRecentSessionsDeps {
  return {
    now: () => 1_000_000,
    readSettings: () => ({ style: 'goal-summary', language: 'zh-CN' }),
    listCandidates: vi.fn(async () => [
      { id: 's1', title: 'old 1' },
      { id: 's2', title: 'old 2' },
      { id: 's3', title: 'old 3' },
    ]),
    collectRawMaterial: vi.fn(async (sessionId: string) => ({
      opening: { text: ` raw title ${sessionId} `, createdAt: 1, rowid: 1 },
      recent: [],
    })),
    generateTitle: vi.fn(async (sessionId: string) => `new ${sessionId}`),
    writeTitleIfStillAuto: vi.fn(async (sessionId: string) => sessionId !== 's2'),
    ...overrides,
  };
}

describe('retitleRecentSessions', () => {
  it('uses the selected window, generates titles, and treats CAS misses as skipped', async () => {
    const deps = makeDeps();

    await expect(retitleRecentSessions(7, deps)).resolves.toEqual({
      total: 3,
      renamed: 2,
      skipped: 1,
      failed: 0,
    });

    expect(deps.listCandidates).toHaveBeenCalledWith(1_000_000 - 7 * 24 * 60 * 60 * 1000);
    expect(deps.generateTitle).toHaveBeenCalledTimes(3);
    expect(deps.writeTitleIfStillAuto).toHaveBeenCalledWith('s1', 'old 1', 'new s1');
    expect(deps.writeTitleIfStillAuto).toHaveBeenCalledWith('s2', 'old 2', 'new s2');
  });

  it('raw style retitles from the opening text without calling the model path', async () => {
    const deps = makeDeps({
      readSettings: () => ({ style: 'raw', language: 'auto' }),
      listCandidates: vi.fn(async () => [{ id: 's1', title: 'old 1' }]),
    });

    await expect(retitleRecentSessions(30, deps)).resolves.toEqual({
      total: 1,
      renamed: 1,
      skipped: 0,
      failed: 0,
    });

    expect(deps.generateTitle).not.toHaveBeenCalled();
    expect(deps.collectRawMaterial).toHaveBeenCalledWith('s1');
    expect(deps.writeTitleIfStillAuto).toHaveBeenCalledWith('s1', 'old 1', 'raw title s1');
  });

  it('keeps going when one title generation fails', async () => {
    const deps = makeDeps({
      generateTitle: vi.fn(async (sessionId: string) => {
        if (sessionId === 's2') throw new Error('provider failed');
        return `new ${sessionId}`;
      }),
    });

    await expect(retitleRecentSessions(7, deps)).resolves.toEqual({
      total: 3,
      renamed: 2,
      skipped: 0,
      failed: 1,
    });
  });
});
