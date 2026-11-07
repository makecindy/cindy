import { beforeEach, describe, expect, it, vi } from 'vitest';

const loader = vi.hoisted(() => ({
  loadProjectSchedules: vi.fn<(dir: string) => Promise<Array<{ id: string }> | null>>(async () => null),
  upsertSchedule: vi.fn(async () => ({})),
  removeSchedule: vi.fn(async () => ({})),
}));

vi.mock('electron', () => ({ app: { getPath: () => '/tmp' }, BrowserWindow: { getAllWindows: () => [] } }));
vi.mock('../../scheduler-host/index.js', () => ({ getProjectAutomationLoader: () => loader }));
vi.mock('../../i18n.js', () => ({ t: () => '{{name}} · Review memory' }));

import { BOT_PROJECT_MEMORY_REVIEW_ID, ensureBotProjectAutomations } from '../botProjectMode.js';

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
