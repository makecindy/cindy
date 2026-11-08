import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Routine } from '@cindy/maker-scheduler';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  root: '', routines: [] as Routine[], bindings: {} as Record<string, unknown>,
  write: vi.fn(), remove: vi.fn(),
}));
vi.mock('electron', () => ({ app: { getPath: () => h.root } }));
vi.mock('../../logger.js', () => ({ createLogger: () => ({ warn: vi.fn(), info: vi.fn() }) }));
vi.mock('../../i18n.js', () => ({ t: (key: string) => key.split('.').at(-1) }));
vi.mock('../../appSessionState.js', () => ({ activeOwnerScopeKey: () => 'owner', ownerScopedUserDataPath: () => h.root }));
vi.mock('../../companion-cloud/homes.js', () => ({ companionHomes: { snapshot: () => ({ demotedBotIds: [] }) } }));
vi.mock('../../localDb/client/current.js', () => ({ getDbClient: vi.fn() }));
vi.mock('../../localDb/ipc/bots.js', () => ({
  readBotSettingsProfile: async () => ({ name: 'Ada', capabilities: { projectMode: true } }),
  updateBotProfile: vi.fn(),
}));
vi.mock('../../maker-host/bot-model-chain-settings-store.js', () => ({ readEffectiveBotModelChain: async () => [] }));
vi.mock('../botProfileFolder.js', () => ({
  botProfileDir: (root: string, botId: string) => path.join(root, 'bots', botId),
  ensureBotWorkspaceDir: async (root: string, botId: string) => {
    const dir = path.join(root, 'bots', botId, 'workspace'); await fs.mkdir(dir, { recursive: true }); return dir;
  },
}));
vi.mock('../botProjectMode.js', () => ({
  prepareBotProjectWorkspace: async () => ({ workingDir: path.join(h.root, 'bots', 'import_ada', 'workspace') }),
  ensureBotProjectAutomations: vi.fn(async () => true),
}));
vi.mock('../botV1Routines.js', () => ({
  readV1Routines: async (_root: string, botId: string) => h.routines.filter(routine => routine.botId === botId),
  removeV1Routine: async (_root: string, id: string) => { h.remove(id); h.routines = h.routines.filter(routine => routine.id !== id); },
}));
vi.mock('../botRoutineAutomations.js', () => ({
  writeRoutineAutomations: async (_dir: string, routine: Routine, options: { paused?: boolean }) => {
    h.write(routine.id, options.paused === true);
    return { configIds: [], note: null };
  },
}));
vi.mock('../../bot-import/runtime.js', () => ({
  companionEnvironmentStore: { read: async () => ({ automations: h.bindings }) },
}));

import { migrateTeammateToV2 } from '../botV2Migration.js';
import { todoCheckRoutineId } from '../../bot-autonomy/todoCheckRoutine.js';

const BOT = 'import_ada';
const routine = (id: string, patch: Partial<Routine> = {}): Routine => ({
  id, botId: BOT, name: id, prompt: 'p', enabled: true, revision: 1, createdAt: 0, updatedAt: 0,
  triggers: [{ id: 't', kind: 'cron', expression: '0 9 * * *', timezone: 'UTC' }], ...patch,
});

beforeEach(async () => {
  h.root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-v2-migration-'));
  h.write.mockReset(); h.remove.mockReset();
});
afterEach(async () => { await fs.rm(h.root, { recursive: true, force: true }); });

// Teammate V2 (2026-11-08): without the routine engine, the upgrade reads the V1 routines itself.
// Retired built-ins are removed, not carried; an imported job runs again only if its handover
// finished and it needs nothing but its prompt.
it('carries the teammate\'s own routines, drops retired built-ins and holds imported jobs that cannot run alone', async () => {
  h.routines = [
    routine('own'),
    routine('handover-pending'),
    routine('command-job'),
    routine('nightly', { builtin: 'nightly-learning' }),
    routine('follow', { builtin: 'follow-up' }),
    routine(todoCheckRoutineId(BOT)),
  ];
  h.bindings = {
    'handover-pending': { kind: 'hermes', original: { prompt: 'p' }, handover: 'pending' },
    'command-job': { kind: 'openclaw', original: { payload: { kind: 'command', argv: ['node', 'report.js'] } }, handover: 'ready' },
  };
  await expect(migrateTeammateToV2(BOT, h.root)).resolves.toBe('migrated');
  expect(h.write.mock.calls).toEqual([['own', false], ['handover-pending', true], ['command-job', true]]);
  expect(h.remove.mock.calls.map(([id]) => id)).toEqual(['own', 'handover-pending', 'command-job', 'nightly', 'follow', todoCheckRoutineId(BOT)]);
  const home = path.join(h.root, 'bots', BOT);
  // The exact definitions are archived before anything is removed.
  const archived = JSON.parse(await fs.readFile(path.join(home, 'v1-archive', 'routines.json'), 'utf8')) as Routine[];
  expect(archived.map(row => row.id)).toHaveLength(6);
  const carryover = await fs.readFile(path.join(home, 'workspace', 'CARRYOVER.md'), 'utf8');
  expect(carryover).toContain('command-job: needs the script, command or monitor it ran at its source; created paused');
  // The receipt makes a rerun a no-op.
  await expect(migrateTeammateToV2(BOT, h.root)).resolves.toBe('already');
  expect(h.write).toHaveBeenCalledTimes(3);
});
