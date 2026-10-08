import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }));
vi.mock('../../logger.js', () => ({
  createLogger: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../localDb/client/current.js', () => ({ getDbClient: vi.fn() }));
vi.mock('../../localDb/ipc/sessions.js', () => ({ broadcastSessionPatched: vi.fn() }));
vi.mock('../../localDb/agentIslandSessionPatch.js', () => ({
  notifyAgentIslandSessionPatch: vi.fn(),
}));
vi.mock('../../session-title-settings-store.js', () => ({
  readSessionTitleSettings: vi.fn(() => ({ style: 'concise', language: 'auto' })),
  readSessionTitleSettingsState: vi.fn(),
  resetSessionTitleSettings: vi.fn(),
  writeSessionTitleSettings: vi.fn(),
  SESSION_TITLE_STYLES: ['concise', 'goal-summary', 'raw'],
  SESSION_TITLE_LANGUAGES: ['auto', 'zh-CN', 'zh-TW', 'en', 'ja', 'ko'],
}));
vi.mock('../../localDb/latestMessageText.js', () => ({ regenerateTitleMaterial: vi.fn() }));
vi.mock('../../security/trustedAppRenderer.js', () => ({
  assertTrustedAppRendererEvent: vi.fn(),
}));
vi.mock('../title.js', () => ({
  regenerateMakerSessionTitle: vi.fn(async () => 'generated title'),
}));

import {
  generateTitleWithSnapshot,
  retitleRecentSessions,
  writeTitleIfStillAuto,
  type RetitleRecentSessionsDeps,
} from '../retitleRecentSessions.js';
import { getDbClient } from '../../localDb/client/current.js';
import { broadcastSessionPatched } from '../../localDb/ipc/sessions.js';
import { notifyAgentIslandSessionPatch } from '../../localDb/agentIslandSessionPatch.js';
import {
  readSessionTitleSettings,
  type SessionTitleSettings,
} from '../../session-title-settings-store.js';
import { regenerateMakerSessionTitle } from '../title.js';

beforeEach(() => vi.clearAllMocks());

function makeDeps(overrides: Partial<RetitleRecentSessionsDeps> = {}): RetitleRecentSessionsDeps {
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
  it('passes the batch snapshot into the default smart generator', async () => {
    const snapshot = { style: 'goal-summary', language: 'zh-CN' } as const;

    await expect(generateTitleWithSnapshot('s1', snapshot)).resolves.toBe('generated title');

    expect(regenerateMakerSessionTitle).toHaveBeenCalledWith('s1', undefined, false, snapshot);
    expect(readSessionTitleSettings).not.toHaveBeenCalled();
  });

  it('keeps the same preferences for later workers after global settings change', async () => {
    let currentSettings: SessionTitleSettings = { style: 'goal-summary', language: 'zh-CN' };
    const snapshot = currentSettings;
    const deps = makeDeps({
      readSettings: vi.fn(() => currentSettings),
      listCandidates: vi.fn(async () => [
        { id: 's1', title: 'old 1' },
        { id: 's2', title: 'old 2' },
        { id: 's3', title: 'old 3' },
        { id: 's4', title: 'old 4' },
      ]),
      generateTitle: vi.fn(async () => {
        currentSettings = { style: 'raw', language: 'en' };
        return 'generated title';
      }),
    });

    await retitleRecentSessions(7, deps);

    expect(deps.readSettings).toHaveBeenCalledOnce();
    expect(deps.generateTitle).toHaveBeenCalledTimes(4);
    for (const candidate of ['s1', 's2', 's3', 's4']) {
      expect(deps.generateTitle).toHaveBeenCalledWith(candidate, snapshot);
    }
    expect(deps.collectRawMaterial).not.toHaveBeenCalled();
  });

  it.each([0, 1])(
    'notifies Agent Island and task lists only after a successful CAS (%i)',
    async (changes) => {
      const update = {
        set: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        run: vi.fn(async () => ({ changes })),
      };
      vi.mocked(getDbClient).mockReturnValue({
        drizzle: { update: vi.fn(() => update) },
      } as unknown as ReturnType<typeof getDbClient>);

      await expect(writeTitleIfStillAuto('s1', 'old title', 'new title')).resolves.toBe(
        changes === 1,
      );

      expect(update.set).toHaveBeenCalledWith({ title: 'new title', titleSource: 'auto' });
      const query = new SQLiteSyncDialect().sqlToQuery(update.where.mock.calls[0][0]);
      expect(query.params).toEqual(['s1', 'old title', 'active', 'desktop', 'auto']);
      if (changes === 1) {
        expect(notifyAgentIslandSessionPatch).toHaveBeenCalledWith('s1', { title: 'new title' });
        expect(broadcastSessionPatched).toHaveBeenCalledWith('s1', { title: 'new title' });
      } else {
        expect(notifyAgentIslandSessionPatch).not.toHaveBeenCalled();
        expect(broadcastSessionPatched).not.toHaveBeenCalled();
      }
    },
  );

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
