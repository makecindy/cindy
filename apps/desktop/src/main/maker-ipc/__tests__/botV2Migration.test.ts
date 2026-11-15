import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Routine } from '@cindy/maker-scheduler';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  root: '', routines: [] as Routine[], runs: [] as Array<Record<string, unknown>>, bindings: {} as Record<string, unknown>,
  write: vi.fn(), remove: vi.fn(), moveMemory: vi.fn(async () => 0),
  projectMode: true, updateProfile: vi.fn(), repository: vi.fn(),
}));
vi.mock('electron', () => ({ app: { getPath: () => h.root } }));
vi.mock('../../logger.js', () => ({ createLogger: () => ({ warn: vi.fn(), info: vi.fn() }) }));
vi.mock('../../i18n.desktop.js', () => ({ t: (key: string) => key.split('.').at(-1) }));
vi.mock('../../appSessionState.js', () => ({ activeOwnerScopeKey: () => 'owner', ownerScopedUserDataPath: () => h.root }));
vi.mock('../../companion-cloud/homes.js', () => ({ companionHomes: { snapshot: () => ({ demotedBotIds: [] }) } }));
vi.mock('../../localDb/client/current.js', () => ({ getDbClient: vi.fn() }));
vi.mock('../../localDb/ipc/bots.js', () => ({
  readBotSettingsProfile: async () => ({ name: 'Ada', capabilities: { projectMode: h.projectMode } }),
  updateBotProfile: h.updateProfile,
  setNewTeammateSetup: vi.fn(),
}));
vi.mock('../../maker-host/bot-model-chain-settings-store.js', () => ({ readEffectiveBotModelChain: async () => [] }));
vi.mock('../botProfileFolder.js', () => ({
  botProfileDir: (root: string, botId: string) => path.join(root, 'bots', botId),
  ensureBotWorkspaceDir: async (root: string, botId: string) => {
    const dir = path.join(root, 'bots', botId, 'workspace'); await fs.mkdir(dir, { recursive: true }); return dir;
  },
}));
vi.mock('../botProjectMode.js', () => ({
  prepareBotProjectWorkspace: async () => ({ workingDir: path.join(h.root, 'bots', 'import_ada', 'workspace'), skippedSkillLinks: [] }),
  ensureBotProjectAutomations: vi.fn(async () => true),
  moveTeammateMemoryIntoProject: h.moveMemory,
  ensureTeammateTemplate: async () => false,
  ensureWorkspaceRepository: h.repository,
  nameBotProject: async () => {},
}));
vi.mock('../botV1Routines.js', () => ({
  readV1RoutineSlice: async (_root: string, botId: string) => {
    const routines = h.routines.filter(routine => routine.botId === botId);
    return { routines, runs: h.runs.filter(run => routines.some(item => item.id === run.routineId)), next: {}, unreadable: null };
  },
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

import { carryLegacyTodos, migrateTeammateToV2 } from '../botV2Migration.js';
import { todoCheckRoutineId } from '../../bot-autonomy/todoCheckRoutine.js';

const BOT = 'import_ada';
const routine = (id: string, patch: Partial<Routine> = {}): Routine => ({
  id, botId: BOT, name: id, prompt: 'p', enabled: true, revision: 1, createdAt: 0, updatedAt: 0,
  triggers: [{ id: 't', kind: 'cron', expression: '0 9 * * *', timezone: 'UTC' }], ...patch,
});

beforeEach(async () => {
  h.root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-v2-migration-'));
  h.write.mockReset(); h.remove.mockReset(); h.moveMemory.mockClear(); h.updateProfile.mockReset();
  h.projectMode = true; h.runs = [];
  h.repository.mockReset().mockResolvedValue('already-git');
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
  // The receipt makes a rerun a no-op, apart from the one-time move of its memory into the project.
  await expect(migrateTeammateToV2(BOT, h.root)).resolves.toBe('already');
  expect(h.write).toHaveBeenCalledTimes(3);
  expect(h.moveMemory).toHaveBeenCalledWith({ botId: BOT, ownerRoot: h.root, workspace: path.join(home, 'workspace') });
});

// PR #9314 review: a build that still had the project-mode switch could turn an upgraded teammate
// off, and the receipt then stopped every later start from correcting it, leaving it on removed V1 paths.
it('turns project mode back on for an upgraded teammate whose switch was turned off', async () => {
  await expect(migrateTeammateToV2(BOT, h.root)).resolves.toBe('migrated');
  h.updateProfile.mockReset();
  h.projectMode = false;
  await expect(migrateTeammateToV2(BOT, h.root)).resolves.toBe('already');
  expect(h.updateProfile).toHaveBeenCalledWith({ id: BOT, capabilities: { projectMode: true } });
});

// #10216 unit: the V2 receipt bypasses prepare, but must still retry a failed first
// commit on later starts. Git failure must not prevent this buddy from starting.
it('retries repository setup after the V2 receipt without blocking startup on Git failure', async () => {
  await expect(migrateTeammateToV2(BOT, h.root)).resolves.toBe('migrated');
  h.repository.mockRejectedValueOnce(new Error('Author identity unknown'));
  await expect(migrateTeammateToV2(BOT, h.root)).resolves.toBe('already');
  h.repository.mockResolvedValueOnce('initialized');
  await expect(migrateTeammateToV2(BOT, h.root)).resolves.toBe('already');
  expect(h.repository.mock.calls).toEqual([
    [path.join(h.root, 'bots', BOT, 'workspace')],
    [path.join(h.root, 'bots', BOT, 'workspace')],
  ]);
});

// PR #9314 review: a teammate taken over from a computer still on V1 arrived with its open todos
// in the cloud, and they were dropped: they now join the project's CARRYOVER.md, once.
it('carries the open todos a V1 computer uploaded into the project, once', async () => {
  const items = [{ title: 'Ship the fix', status: 'open', createdAt: '2026-11-01T00:00:00Z' }, { title: 'Done one', status: 'done' }];
  await carryLegacyTodos(BOT, h.root, items);
  await carryLegacyTodos(BOT, h.root, items);
  const carryover = await fs.readFile(path.join(h.root, 'bots', BOT, 'workspace', 'CARRYOVER.md'), 'utf8');
  expect(carryover.match(/Ship the fix/g)).toHaveLength(1);
  expect(carryover).not.toContain('Done one');
});

// QA 2026-11-10: the upgrade deleted a routine's runs (results, the events that started them,
// queued ones) without keeping them, counted an unreadable state file as "nothing open", and
// skipped its todos when the project already had a carryover file.
it('keeps routine runs, reports unreadable files and adds to an existing carryover', async () => {
  h.routines = [routine('own')];
  h.runs = [
    { id: 'r1', routineId: 'own', status: 'success', resultText: 'UNIQUE_OLD_RESULT', events: [], triggerIds: [], revision: 1, createdAt: 1 },
    { id: 'r2', routineId: 'own', status: 'queued', events: [{ sourceId: 'mail', event: { type: 'new', payload: 'QUEUED_EVENT_BODY' } }], triggerIds: [], revision: 1, createdAt: 2 },
  ];
  const home = path.join(h.root, 'bots', BOT);
  await fs.mkdir(path.join(home, 'workspace'), { recursive: true });
  // QA recheck: an existing file that already had one of the items got the whole list again.
  await fs.writeFile(path.join(home, 'workspace', 'CARRYOVER.md'), '# Earlier\n\n- from another computer\n- Already here\n');
  await fs.writeFile(path.join(home, 'todos.v1.json'), JSON.stringify({ items: [{ title: 'Ship it', status: 'open' }, { title: 'Already here', status: 'open' }] }));
  await fs.writeFile(path.join(home, 'working-memory.json'), '{"threads": [');
  await expect(migrateTeammateToV2(BOT, h.root)).resolves.toBe('migrated');
  const runs = await fs.readFile(path.join(home, 'v1-archive', 'routine-runs.json'), 'utf8');
  expect(runs).toContain('UNIQUE_OLD_RESULT');
  expect(runs).toContain('QUEUED_EVENT_BODY');
  const carryover = await fs.readFile(path.join(home, 'workspace', 'CARRYOVER.md'), 'utf8');
  expect(carryover).toContain('from another computer');
  expect(carryover).toContain('Ship it');
  expect(carryover.match(/Already here/g)).toHaveLength(1);
  expect(carryover).toContain('own: 1 run(s) were still waiting');
  expect(carryover).toContain('working-memory.json could not be read');
  expect(await fs.readFile(path.join(home, 'v1-archive', 'working-memory.json'), 'utf8')).toBe('{"threads": [');
});

it('retries instead of finishing when a state file cannot be read', async () => {
  const home = path.join(h.root, 'bots', BOT);
  await fs.mkdir(path.join(home, 'todos.v1.json'), { recursive: true });
  await expect(migrateTeammateToV2(BOT, h.root)).rejects.toThrow();
  await expect(fs.lstat(path.join(home, 'v2-migration.json'))).rejects.toThrow();
});
