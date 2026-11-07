import { beforeEach, describe, expect, it, vi } from 'vitest';

const loader = vi.hoisted(() => ({
  loadProjectSchedules: vi.fn<(dir: string) => Promise<Array<{ id: string }> | null>>(async () => null),
  upsertSchedule: vi.fn(async () => ({})),
  removeSchedule: vi.fn(async () => ({})),
}));
const aliases = vi.hoisted(() => ({
  rows: [] as Array<{ projectKey: string; alias: string }>,
  upsert: vi.fn(async (projectKey: string, alias: string) => ({ projectKey, alias })),
}));

vi.mock('electron', () => ({ app: { getPath: () => '/tmp' }, BrowserWindow: { getAllWindows: () => [] } }));
vi.mock('../../scheduler-host/index.js', () => ({ getProjectAutomationLoader: () => loader }));
vi.mock('../../i18n.js', () => ({ t: () => '{{name}} · Review memory' }));
vi.mock('../../localDb/ipc/projectAliases.js', () => ({
  listProjectAliases: async () => aliases.rows,
  upsertProjectAlias: aliases.upsert,
}));

import { BOT_PROJECT_MEMORY_REVIEW_ID, ensureBotProjectAutomations, nameBotProject } from '../botProjectMode.js';

// Teammate V2 (2026-11-06): the nightly review is the project's own automation,
// added once on the teammate's model; an owner's later edit or removal is kept.
describe('ensureBotProjectAutomations', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('adds the memory review to the teammate project on its own model, only once', async () => {
    const route = { harness: 'pi' as const, model: 'm1', providerId: 'p1', effort: 'medium', fastMode: false };
    await expect(ensureBotProjectAutomations({ botId: 'bot-1', displayName: 'Mimi', workingDir: '/w', route })).resolves.toBe(true);
    expect(loader.upsertSchedule).toHaveBeenCalledWith('/w', expect.objectContaining({
      id: BOT_PROJECT_MEMORY_REVIEW_ID, agentKind: 'pi', model: 'm1', providerId: 'p1',
      name: 'Mimi · Review memory', persistentSession: true, silentWhenIdle: true,
      prompt: expect.stringContaining('teammate id bot-1'),
    }));

    loader.loadProjectSchedules.mockResolvedValueOnce([{ id: BOT_PROJECT_MEMORY_REVIEW_ID }]);
    await expect(ensureBotProjectAutomations({ botId: 'bot-1', displayName: 'Mimi', workingDir: '/w', route })).resolves.toBe(false);
    expect(loader.upsertSchedule).toHaveBeenCalledOnce();
  });
});

// 2026-11-07: a teammate project named just "Cindy" sat next to the user's "cindy" repo.
// It now carries the standard name; a name the user gave the project is never replaced.
describe('nameBotProject', () => {
  beforeEach(() => { vi.clearAllMocks(); aliases.rows = []; });

  it('gives the standard name, follows renames, and keeps a name the user chose', async () => {
    await nameBotProject('bot-1', '/w', 'Cindy');
    expect(aliases.upsert).toHaveBeenLastCalledWith('local:/w', 'Teammate Cindy');

    aliases.rows = [{ projectKey: 'local:/w', alias: 'Cindy' }];
    await nameBotProject('bot-1', '/w', 'Cindy');
    expect(aliases.upsert).toHaveBeenLastCalledWith('local:/w', 'Teammate Cindy');

    aliases.rows = [{ projectKey: 'local:/w', alias: 'Teammate Cindy' }];
    await nameBotProject('bot-1', '/w', 'Mimi', 'Cindy');
    expect(aliases.upsert).toHaveBeenLastCalledWith('local:/w', 'Teammate Mimi');

    aliases.upsert.mockClear();
    aliases.rows = [{ projectKey: 'local:/w', alias: 'My notes' }];
    await nameBotProject('bot-1', '/w', 'Mimi', 'Cindy');
    expect(aliases.upsert).not.toHaveBeenCalled();
  });
});
