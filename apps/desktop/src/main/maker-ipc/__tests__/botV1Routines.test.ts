import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RoutineState } from '@cindy/maker-scheduler';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ schedules: new Set<string>(), remove: vi.fn() }));
vi.mock('../../logger.js', () => ({ createLogger: () => ({ warn: vi.fn(), info: vi.fn() }) }));
vi.mock('../../scheduler-host/index.desktop.js', () => ({
  getScheduleStorage: () => ({ get: async (id: string) => (h.schedules.has(id) ? { id, source: 'bot' } : null) }),
  getScheduler: () => ({ delete: async (id: string, options: unknown) => { h.remove(id, options); h.schedules.delete(id); } }),
}));

import { readV1Routines, removeV1Routine, v1RoutinesFile } from '../botV1Routines.js';

let root = '';
const routine = (id: string, botId: string) => ({ id, botId, name: id, prompt: 'p', enabled: true, triggers: [], revision: 1, createdAt: 0, updatedAt: 0 });
const run = (routineId: string) => ({ id: `run-${routineId}`, routineId, revision: 1, triggerIds: [], events: [], status: 'success' as const, createdAt: 0 });

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-v1-routines-'));
  h.schedules.clear(); h.remove.mockReset();
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

// Teammate V2 (2026-11-08): the routine engine is gone; the upgrade reads the engine's own state
// file (`<account>/routines/routines.json`) and removes each routine with its hidden schedule.
it('reads one teammate\'s routines and removes one with its runs, timers and backing schedule', async () => {
  expect(await readV1Routines(root, 'bot-a')).toEqual([]);
  const state: RoutineState = {
    version: 1, routines: [routine('r1', 'bot-a'), routine('r2', 'bot-a'), routine('r3', 'bot-b')],
    runs: [run('r1'), run('r2')], receipts: {}, next: { 'r1:t': 1, 'r2:t': 2 }, pausedBotIds: ['bot-b'],
  };
  await fs.mkdir(path.dirname(v1RoutinesFile(root)), { recursive: true });
  await fs.writeFile(v1RoutinesFile(root), JSON.stringify(state));
  expect((await readV1Routines(root, 'bot-a')).map(row => row.id)).toEqual(['r1', 'r2']);
  h.schedules.add('routine-r1');

  // Two teammates upgrading at once must not drop each other's rewrite.
  await Promise.all([removeV1Routine(root, 'r1'), removeV1Routine(root, 'r3')]);
  expect(h.remove).toHaveBeenCalledExactlyOnceWith('routine-r1', { internalRoutine: true });
  const saved = JSON.parse(await fs.readFile(v1RoutinesFile(root), 'utf8')) as RoutineState;
  expect(saved).toEqual({ ...state, routines: [state.routines[1]], runs: [state.runs[1]], next: { 'r2:t': 2 } });
  if (process.platform !== 'win32') expect((await fs.stat(v1RoutinesFile(root))).mode & 0o777).toBe(0o600);
  // A rerun after a partial upgrade finds nothing left to remove.
  await removeV1Routine(root, 'r1');
  expect(await fs.readdir(path.dirname(v1RoutinesFile(root)))).toEqual(['routines.json']);
});
