import { beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  existing: new Set<string>(),
  prepare: vi.fn(async () => ({ workingDir: '/project', route: null })),
  write: vi.fn<(dir: string, routine: { id: string }, options: unknown) => Promise<{ configIds: string[]; note: null }>>(
    async () => ({ configIds: [], note: null })),
}));
vi.mock('../../maker-ipc/botRoutineAutomations.js', () => ({
  prepareTeammateRoutineProject: h.prepare,
  findRoutineAutomations: async (_dir: string, id: string) => (h.existing.has(id) ? [{ id }] : []),
  writeRoutineAutomations: h.write,
}));

import { applyCompanionRoutines } from '../routines.js';

const row = (id: string, input: Record<string, unknown> = {}, originDeviceId: string | null = 'laptop') =>
  ({ id, originDeviceId, input: { name: id, prompt: 'p', enabled: true, triggers: [{ id: 't', kind: 'cron', expression: '0 9 * * *', timezone: 'UTC' }], ...input } });

beforeEach(() => { h.existing.clear(); h.prepare.mockClear(); h.write.mockClear(); });

// Teammate V2 (2026-11-08): routines uploaded by a computer still on V1 become the teammate's
// project automations on arrival, once per routine id, with the old arrival rules.
it('turns arriving V1 routines into project automations once, pausing a check command from another computer', async () => {
  const assertCurrent = vi.fn();
  h.existing.add('kept');
  await applyCompanionRoutines({ botId: 'bot', ownerRoot: '/account', selfDeviceId: 'desktop', assertCurrent, rows: [
    row('local-check', { preRunHook: { command: 'node check.mjs' } }, 'desktop'),
    row('foreign-check', { preRunHook: { command: 'node check.mjs' } }),
    row('kept'),
    row('builtin-follow-up-bot'), row('builtin-nightly-learning-bot'), row('builtin-todo-check-bot'),
    row('broken', { triggers: 'not a list' }),
    null,
  ] });
  expect(h.prepare).toHaveBeenCalledExactlyOnceWith('bot', '/account', assertCurrent);
  expect(h.write.mock.calls.map(([dir, routine, options]) => [dir, routine.id, options])).toEqual([
    ['/project', 'local-check', { route: null, paused: false }],
    ['/project', 'foreign-check', { route: null, paused: true }],
  ]);
  expect(h.write.mock.calls[0]![1]).toMatchObject({ botId: 'bot', name: 'local-check', enabled: true });

  // Nothing applicable: the teammate is not touched.
  await applyCompanionRoutines({ botId: 'bot', ownerRoot: '/account', selfDeviceId: 'desktop', assertCurrent, rows: [row('builtin-follow-up-bot')] });
  expect(h.prepare).toHaveBeenCalledOnce();
});
