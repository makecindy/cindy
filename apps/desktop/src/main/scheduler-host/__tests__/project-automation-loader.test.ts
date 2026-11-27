import { describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { Scheduler, type CreateScheduleInput, type Schedule, type ScheduleStorage } from '@cindy/maker-scheduler';

import {
  __testing,
  ProjectAutomationLoader,
  schedulesDiffer,
  type ProjectScheduleConfig,
} from '../project-automation-loader';
import { scheduleCreateToRow, schedulePatchToRow, scheduleToCamel } from '../../localDb/mapper';
import { PROJECT_AUTOMATION_REL_SEGMENTS } from '../../../shared/projectAutomationPaths';

const workingDir = 'C:\\project';

// #11134 / unit: real loader + Scheduler updates + database mapper round trips.
// Existing coverage never changed a project definition after its first persistent
// run had bound a task. Cover both writers and an already-saved stale binding;
// a fresh declaration must clear it durably, without changing explicit heartbeats.
describe('project automation persistent task binding', () => {
  it.each(['reconcile', 'upsert', 'stale'] as const)('clears the old binding through %s', async (entry) => {
    const dir = await fs.mkdtemp(path.join(tmpdir(), 'cindy-project-binding-'));
    type Row = Parameters<typeof scheduleToCamel>[0];
    const rows = new Map<string, Row>();
    const storage = {
      list: async () => [...rows.values()].map(scheduleToCamel),
      get: async (id: string) => rows.has(id) ? scheduleToCamel(rows.get(id)!) : null,
      insert: async (schedule: Schedule) => {
        rows.set(schedule.id, scheduleCreateToRow(schedule) as Row);
        return scheduleToCamel(rows.get(schedule.id)!);
      },
      update: async (id: string, patch: Partial<Schedule>) => {
        if (!rows.has(id)) return null;
        rows.set(id, { ...rows.get(id)!, ...schedulePatchToRow(patch) });
        return scheduleToCamel(rows.get(id)!);
      },
    };
    const scheduler = new Scheduler({ storage: storage as ScheduleStorage, runner: { fire: vi.fn() } });
    const newLoader = () => new ProjectAutomationLoader({
      scheduler,
      storage: storage as ConstructorParameters<typeof ProjectAutomationLoader>[0]['storage'],
      getDb: () => ({
        select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
        insert: () => ({ values: () => ({ onConflictDoUpdate: async () => {} }) }),
      }) as unknown as ReturnType<ConstructorParameters<typeof ProjectAutomationLoader>[0]['getDb']>,
      logger: { warn: vi.fn() },
      getTeammateProjectState: async () => 'active',
    });
    try {
      const loader = newLoader();
      const persistent = projectConfig({ agentKind: 'codex', model: 'gpt-5.5', persistentSession: true });
      await loader.upsertSchedule(dir, persistent);
      const [created] = await storage.list();
      // The runner writes this after the first persistent run.
      await scheduler.update(created.id, { targetSessionId: 'old-codex-task' });
      await storage.update(created.id, { lastFiredAt: 123 });
      await loader.upsertSchedule(dir, { ...persistent, prompt: 'Updated checks' });
      expect((await storage.get(created.id))?.targetSessionId).toBe('old-codex-task');
      const heartbeat = await scheduler.create({ name: 'Heartbeat', prompt: 'Check', kind: 'cron',
        cronExpr: created.cronExpr, timezone: created.timezone, recurring: true,
        agentKind: 'codex', useWorktree: false, notify: { desktop: false, feishu: false },
        persistentSession: false, targetSessionId: 'explicit-task' });
      await scheduler.update(heartbeat.id, { name: 'Explicit heartbeat' });

      const fresh = projectConfig({ agentKind: 'claude-code', model: 'claude-opus-5-5',
        providerId: 'anthropic', persistentSession: false });
      if (entry === 'upsert') await loader.upsertSchedule(dir, fresh);
      else {
        if (entry === 'stale') {
          // Old releases already saved the new definition but retained its binding.
          await scheduler.update(created.id, __testing.scheduleConfigToUpdateInput(fresh, dir));
          await scheduler.update(created.id, { targetSessionId: 'old-codex-task' });
        }
        await fs.writeFile(path.join(dir, ...PROJECT_AUTOMATION_REL_SEGMENTS),
          JSON.stringify({ version: 1, schedules: [fresh] }));
        expect(await loader.reconcile(dir)).toMatchObject({ updated: 1 });
      }
      expect(rows.get(created.id)?.targetSessionId).toBeNull();
      expect(await storage.get(created.id)).toMatchObject({ agentKind: 'claude-code',
        model: 'claude-opus-5-5', providerId: 'anthropic', persistentSession: false,
        lastFiredAt: 123, targetSessionId: undefined });
      expect(await newLoader().reconcile(dir)).toMatchObject({ updated: 0, deleted: 0 });
      expect((await storage.get(created.id))?.targetSessionId).toBeUndefined();
      expect((await storage.get(heartbeat.id))?.targetSessionId).toBe('explicit-task');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

// #10520 / unit: real loader and Scheduler CRUD, with in-memory disk/storage so
// an event-loop turn drains all work except the explicitly held model validation.
// Existing tests only rejected saves; they never interleaved successful creates
// or permanent project deletion with an unfinished create.
async function withConcurrentProject(
  run: (h: {
    dir: string;
    loader: ProjectAutomationLoader;
    stored: Map<string, Schedule>;
    validate: ReturnType<typeof vi.fn<(schedule: Schedule) => Promise<void>>>;
    setDeleted: () => void;
    files: Map<string, string>;
    fileKey: (file: string) => string;
  }) => Promise<void>,
): Promise<void> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'cindy-project-concurrency-'));
  const fileKey = (file: string) => process.platform === 'win32'
    ? path.resolve(file).toLowerCase() : path.resolve(file);
  const files = new Map([[fileKey(path.join(dir, ...PROJECT_AUTOMATION_REL_SEGMENTS)),
    JSON.stringify({ version: 1, schedules: [projectConfig()] })]]);
  const stored = new Map<string, Schedule>();
  const validate = vi.fn<(schedule: Schedule) => Promise<void>>().mockResolvedValue();
  const storage = {
    list: async () => [...stored.values()].map((s) => ({ ...s })),
    get: async (id: string) => stored.has(id) ? { ...stored.get(id)! } : null,
    insert: async (schedule: Schedule) => { stored.set(schedule.id, { ...schedule }); return schedule; },
    update: async (id: string, patch: Partial<Schedule>) => {
      const current = stored.get(id);
      if (!current) return null;
      const updated = { ...current, ...patch };
      stored.set(id, updated);
      return updated;
    },
    delete: async (id: string) => { stored.delete(id); },
  };
  let id = 0;
  const scheduler = new Scheduler({
    storage: storage as ScheduleStorage,
    runner: { fire: vi.fn() },
    generateId: () => `schedule-${++id}`,
    validateModelSelection: validate,
  });
  let deleted = false;
  const loader = new ProjectAutomationLoader({
    scheduler,
    storage: storage as ConstructorParameters<typeof ProjectAutomationLoader>[0]['storage'],
    getDb: () => ({
      select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
      insert: () => ({ values: () => ({ onConflictDoUpdate: async () => {} }) }),
    }) as unknown as ReturnType<ConstructorParameters<typeof ProjectAutomationLoader>[0]['getDb']>,
    logger: { warn: vi.fn() },
    getTeammateProjectState: async (folder: string) => fileKey(folder) === fileKey(dir)
      ? deleted ? 'deleted' as const : 'active' as const : null,
  });
  try {
    vi.spyOn(fs, 'stat').mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }));
    vi.spyOn(fs, 'readFile').mockImplementation(async (file) => {
      const content = files.get(fileKey(String(file)));
      if (content === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return content;
    });
    vi.spyOn(fs, 'mkdir').mockResolvedValue(undefined);
    vi.spyOn(fs, 'writeFile').mockImplementation(async (file, content) => { files.set(fileKey(String(file)), String(content)); });
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      files.set(fileKey(String(to)), files.get(fileKey(String(from)))!);
      files.delete(fileKey(String(from)));
    });
    vi.spyOn(fs, 'rm').mockImplementation(async (file) => { files.delete(fileKey(String(file))); });
    await run({ dir, loader, stored, validate, setDeleted: () => { deleted = true; }, files, fileKey });
  } finally {
    vi.restoreAllMocks();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function deferredValidation() {
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const pending = new Promise<void>((resolve) => { release = resolve; });
  return { started, release, validate: async () => { entered(); await pending; } };
}

describe('project automation concurrent mutations', () => {
  it.each(['upsert', 'reconcile'].flatMap((first) =>
    ['upsert', 'reconcile'].map((second) => ({ first, second }))))(
    'creates one schedule for concurrent $first / $second', async ({ first, second }) => {
      await withConcurrentProject(async ({ dir, loader, stored, validate }) => {
        const gate = deferredValidation();
        validate.mockImplementationOnce(gate.validate);
        const invoke = (kind: string, folder: string) => kind === 'upsert'
          ? loader.upsertSchedule(folder, projectConfig()) : loader.reconcile(folder);
        const saving = invoke(first, dir);
        await gate.started;
        const alias = process.platform === 'win32' ? dir.toUpperCase() + path.sep : dir + path.sep;
        const concurrent = invoke(second, alias);
        await new Promise<void>((resolve) => setImmediate(resolve));
        gate.release();
        const results = await Promise.all([saving, concurrent]);
        expect([...stored.values()]).toHaveLength(1);
        expect([...stored.values()][0]).toMatchObject({ source: 'project', projectConfigId: 'daily', status: 'active' });
        expect(results.reduce((sum, result) => sum + result.inserted, 0)).toBe(1);
      });
    },
  );

  it.each(['upsert', 'reconcile'])('drains an in-flight %s before deleting only that project', async (kind) => {
    await withConcurrentProject(async ({ dir, loader, stored, validate, setDeleted, files, fileKey }) => {
      const gate = deferredValidation();
      validate.mockImplementationOnce(gate.validate);
      const saving = kind === 'upsert' ? loader.upsertSchedule(dir, projectConfig()) : loader.reconcile(dir);
      await gate.started;
      // Another project can progress while this one's model validation waits.
      const otherDir = path.join(dir, 'other-project');
      await loader.upsertSchedule(otherDir, projectConfig());
      stored.set('user-schedule', { ...projectSchedule({ desktop: false, feishu: false }), id: 'user-schedule', workingDir: dir, source: 'user' });
      const queuedDiscovery = loader.reconcile(dir);
      const queuedSave = expect(loader.upsertSchedule(dir, projectConfig({ id: 'late' })))
        .rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
      setDeleted(); // The lifecycle deletes the profile before calling this cleanup entry.
      const deleting = loader.deleteProjectSchedules(dir);
      await new Promise<void>((resolve) => setImmediate(resolve));
      gate.release();
      await saving;
      await queuedSave;
      expect(await queuedDiscovery).toMatchObject({ inserted: 0, updated: 0, deleted: 0 });
      expect(await deleting).toBe(1);
      expect([...stored.values()].map((s) => s.id)).toEqual(['schedule-2', 'user-schedule']);
      // Even if folder cleanup has not finished, late writers cannot recreate it.
      const alias = process.platform === 'win32' ? dir.toUpperCase() : dir;
      await expect(loader.upsertSchedule(alias, projectConfig())).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
      expect(await loader.reconcile(dir)).toMatchObject({ inserted: 0, updated: 0, deleted: 0 });
      expect(stored.size).toBe(2);
      expect(files.has(fileKey(path.join(otherDir, ...PROJECT_AUTOMATION_REL_SEGMENTS)))).toBe(true);
    });
  });

  it('keeps both concurrent file edits and allows an ordinary project to be imported again', async () => {
    await withConcurrentProject(async ({ dir, loader, stored, validate }) => {
      const ordinary = path.join(dir, 'ordinary');
      const gate = deferredValidation();
      validate.mockImplementationOnce(gate.validate);
      const first = loader.upsertSchedule(ordinary, projectConfig());
      await gate.started;
      const second = loader.upsertSchedule(ordinary, projectConfig({ id: 'second' }));
      await new Promise<void>((resolve) => setImmediate(resolve));
      gate.release();
      await Promise.all([first, second]);
      expect((await loader.loadProjectSchedules(ordinary))?.map((config) => config.id)).toEqual(['daily', 'second']);
      expect(await loader.deleteProjectSchedules(ordinary)).toBe(2);
      expect(stored.size).toBe(0);
      const preview = await loader.reconcile(ordinary);
      expect(preview.pendingImport?.schedules).toHaveLength(2);
      expect(stored.size).toBe(0);
      expect(await loader.reconcile(ordinary, preview.pendingImport!.configHash)).toMatchObject({ inserted: 2 });
      expect(stored.size).toBe(2);
    });
  });
});

// #8237, unit: actual disk -> loader -> scheduler inputs. Existing reconciliation
// tests did not distinguish repository discovery from an explicit editor save.
// A valid file, with or without a hook, must create nothing before confirmation.
describe('project automation import approval', () => {
  it.each([undefined, { command: 'node check.mjs' }])('requires the reviewed file snapshot before importing %j', async (preRunHook) => {
    const dir = await fs.mkdtemp(path.join(tmpdir(), 'cindy-import-approval-'));
    try {
      const stored: Schedule[] = [];
      const create = vi.fn(async (input: CreateScheduleInput) => {
        const saved = { ...projectSchedule({ desktop: true, feishu: false }), ...input,
          id: `schedule-${stored.length}` } as Schedule;
        stored.push(saved);
        return saved;
      });
      const update = vi.fn(async (id: string, patch: Partial<Schedule>) => {
        const current = stored.find((s) => s.id === id)!;
        Object.assign(current, patch);
        return current;
      });
      const remove = vi.fn(async (id: string) => {
        stored.splice(stored.findIndex((s) => s.id === id), 1);
      });
      const loader = new ProjectAutomationLoader({
        scheduler: { create, update, delete: remove } as unknown as ConstructorParameters<typeof ProjectAutomationLoader>[0]['scheduler'],
        storage: { list: async () => stored } as ConstructorParameters<typeof ProjectAutomationLoader>[0]['storage'],
        getDb: () => ({
          select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
          insert: () => ({ values: () => ({ onConflictDoUpdate: async () => {} }) }),
        }) as unknown as ReturnType<ConstructorParameters<typeof ProjectAutomationLoader>[0]['getDb']>,
        logger: { warn: vi.fn(), debug: vi.fn() },
      });
      const file = path.join(dir, ...PROJECT_AUTOMATION_REL_SEGMENTS);
      await fs.mkdir(path.dirname(file), { recursive: true });
      const write = (config: ProjectScheduleConfig) => fs.writeFile(file, JSON.stringify({ version: 1, schedules: [config] }));
      const config = projectConfig({ preRunHook });
      await write(config);
      const first = await loader.reconcile(dir);
      expect(first.pendingImport?.schedules).toEqual([config]);
      expect(create).not.toHaveBeenCalled();
      await write({ ...config, prompt: 'changed while the confirmation is open' });
      const stale = await loader.reconcile(dir, first.pendingImport!.configHash);
      expect(stale.pendingImport).toBeDefined();
      expect(create).not.toHaveBeenCalled();
      expect(await loader.reconcile(dir, stale.pendingImport!.configHash)).toMatchObject({ inserted: 1 });
      expect(stored[0].prompt).toBe('changed while the confirmation is open');
      expect(stored[0].preRunHook).toEqual(preRunHook);
      expect((await loader.reconcile(dir)).pendingImport).toBeUndefined();
      expect(create).toHaveBeenCalledTimes(1);

      // A direct editor save must not authorize a different file-defined change.
      await write({ ...config, prompt: 'unapproved repository update' });
      await loader.upsertSchedule(dir, projectConfig({ id: 'mine', prompt: 'explicit save', preRunHook }));
      expect(stored).toHaveLength(2);
      expect(stored[0].prompt).toBe('changed while the confirmation is open');
      expect(update).not.toHaveBeenCalled();
      expect((await loader.reconcile(dir)).pendingImport).toBeDefined();

      await loader.removeSchedule(dir, 'mine');
      expect(stored).toHaveLength(1);
      expect(update).not.toHaveBeenCalled();
      expect(stored[0].prompt).toBe('changed while the confirmation is open');

      // Missing or broken files cannot silently erase saved automations/history.
      await fs.writeFile(file, '{broken');
      expect(await loader.reconcile(dir)).toMatchObject({ skipped: 'parse-error', deleted: 0 });
      await fs.rm(file);
      expect(await loader.reconcile(dir)).toMatchObject({ skipped: 'no-file', deleted: 0 });
      expect(stored).toHaveLength(1);

      await fs.writeFile(file, JSON.stringify({ version: 1, schedules: [] }));
      const deletion = await loader.reconcile(dir);
      expect(deletion.pendingImport?.removedNames).toEqual(['Daily']);
      expect(stored).toHaveLength(1);
      expect(await loader.reconcile(dir, deletion.pendingImport!.configHash)).toMatchObject({ deleted: 1 });
      expect(stored).toHaveLength(0);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  // User decision (2026-11-08): a teammate's project is Cindy's own folder; its automations never ask for import.
  // PR #9314 review: only a real teammate project of this account; a repository whose path merely
  // looks like one (…/owners/x/bots/y/workspace) still asks.
  it('syncs a teammate project without asking, but asks for a folder that only looks like one', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'cindy-teammate-project-'));
    const dir = path.join(root, 'owners', 'ab12', 'bots', 'bot-1', 'workspace');
    const lookalike = path.join(root, 'repo', 'owners', 'fake', 'bots', 'fake', 'workspace');
    try {
      const stored: Schedule[] = [];
      const create = vi.fn(async (input: CreateScheduleInput) => {
        const saved = { ...projectSchedule({ desktop: true, feishu: false }), ...input, id: 'teammate-schedule' } as Schedule;
        stored.push(saved);
        return saved;
      });
      const loader = new ProjectAutomationLoader({
        scheduler: { create, update: vi.fn(), delete: vi.fn() } as unknown as ConstructorParameters<typeof ProjectAutomationLoader>[0]['scheduler'],
        storage: { list: async () => stored } as ConstructorParameters<typeof ProjectAutomationLoader>[0]['storage'],
        getDb: () => ({
          select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
          insert: () => ({ values: () => ({ onConflictDoUpdate: async () => {} }) }),
        }) as unknown as ReturnType<ConstructorParameters<typeof ProjectAutomationLoader>[0]['getDb']>,
        logger: { warn: vi.fn(), debug: vi.fn() },
        getTeammateProjectState: async (workingDir) => path.relative(workingDir, dir) === '' ? 'active' : null,
      });
      for (const folder of [dir, lookalike]) {
        const file = path.join(folder, ...PROJECT_AUTOMATION_REL_SEGMENTS);
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, JSON.stringify({ version: 1, schedules: [projectConfig()] }));
      }
      const result = await loader.reconcile(dir);
      expect(result.pendingImport).toBeUndefined();
      expect(result).toMatchObject({ inserted: 1 });
      expect((await loader.reconcile(lookalike)).pendingImport).toBeDefined();
      expect(create).toHaveBeenCalledTimes(1);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

function projectConfig(overrides: Partial<ProjectScheduleConfig> = {}): ProjectScheduleConfig {
  return {
    id: 'daily',
    name: 'Daily',
    prompt: 'Run checks',
    cronExpr: '0 9 * * *',
    notify: { desktop: true, feishu: false },
    ...overrides,
  };
}

function projectSchedule(notify: Schedule['notify']): Schedule {
  return {
    id: 'schedule-1',
    name: 'Daily',
    prompt: 'Run checks',
    source: 'project',
    projectConfigId: 'daily',
    kind: 'cron',
    cronExpr: '0 9 * * *',
    timezone: 'Asia/Shanghai',
    recurring: true,
    manual: false,
    agentKind: 'claude-code',
    workspaceKind: 'project',
    workingDir,
    useWorktree: false,
    persistentSession: false,
    silentWhenIdle: false,
    notify,
    status: 'active',
    createdAt: 1,
    updatedAt: 1,
  };
}

// #8886 / unit: a project editor writes config, not the regular scheduler input.
// Existing reconciliation coverage omitted deadlines and could silently lose them.
it('reconciles deadline additions, changes and removal from project configuration', () => {
  const expireAt = 1_800_000_000_000;
  const config = projectConfig({ expireAt });
  const input = __testing.scheduleConfigToUpdateInput(config, workingDir);
  expect(input.expireAt).toBe(expireAt);
  const saved = { ...input, id: 'deadline' } as Schedule;
  expect(schedulesDiffer(saved, config, workingDir)).toBe(false);
  expect(schedulesDiffer(saved, { ...config, expireAt: expireAt + 60_000 }, workingDir)).toBe(true);
  expect(schedulesDiffer(saved, { ...config, expireAt: undefined }, workingDir)).toBe(true);
  expect(__testing.scheduleConfigToUpdateInput({ ...config, expireAt: undefined }, workingDir))
    .toHaveProperty('expireAt', undefined);
});

describe('project automation WeCom group notification reconciliation', () => {
  it('emits an explicit false update when the project disables the channel', () => {
    const input = __testing.scheduleConfigToUpdateInput(
      projectConfig({ notify: { desktop: true, feishu: false, wecomGroup: false } }),
      workingDir,
    );

    expect(input.notify).toEqual({
      desktop: true,
      feishu: false,
      wecomGroup: false,
    });
  });

  it('updates a previously enabled channel and stays stable after it is disabled', () => {
    const config = projectConfig();

    expect(
      schedulesDiffer(
        projectSchedule({ desktop: true, feishu: false, wecomGroup: true }),
        config,
        workingDir,
      ),
    ).toBe(true);
    expect(
      schedulesDiffer(projectSchedule({ desktop: true, feishu: false }), config, workingDir),
    ).toBe(false);
  });
});

describe('project automation provider reconciliation', () => {
  // PR #6832, unit: real file upsert/reconcile plus DB mappers. Existing provider
  // coverage did not distinguish a device-only edit or removal from no change.
  it('persists, changes and clears the runtime location through project reconciliation', async () => {
    const dir = await fs.mkdtemp(path.join(tmpdir(), 'cindy-project-device-'));
    try {
      let saved: Schedule | undefined;
      const create = vi.fn(async (input: CreateScheduleInput) => {
        saved = scheduleToCamel(scheduleCreateToRow({
          ...projectSchedule({ desktop: true, feishu: false }), ...input,
        } as Schedule) as Parameters<typeof scheduleToCamel>[0]);
        return saved;
      });
      const update = vi.fn(async (_id: string, patch: Partial<Schedule>) => {
        saved = scheduleToCamel({
          ...scheduleCreateToRow(saved!), ...schedulePatchToRow(patch),
        } as Parameters<typeof scheduleToCamel>[0]);
        return saved;
      });
      const loader = new ProjectAutomationLoader({
        scheduler: { create, update, delete: async () => { saved = undefined; } } as unknown as ConstructorParameters<typeof ProjectAutomationLoader>[0]['scheduler'],
        storage: { list: async () => saved ? [saved] : [] } as ConstructorParameters<typeof ProjectAutomationLoader>[0]['storage'],
        getDb: () => ({
          select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
          insert: () => ({ values: () => ({ onConflictDoUpdate: async () => {} }) }),
        }) as unknown as ReturnType<ConstructorParameters<typeof ProjectAutomationLoader>[0]['getDb']>,
        logger: { warn: vi.fn(), debug: vi.fn() },
      });
      const config = { ...projectConfig({ model: 'remote-model', providerId: 'remote-provider' }), agentDeviceId: 'studio' };
      // PR #9314 hand-over acceptance: a teammate arriving on a new computer read "no file" just
      // before its first save, and that cached read hid the new file from the restore right after.
      expect(await loader.loadProjectSchedules(dir)).toBeNull();
      expect(await loader.upsertSchedule(dir, config)).toMatchObject({ inserted: 1, updated: 0 });
      expect((await loader.loadProjectSchedules(dir))?.map((item) => item.id)).toEqual([config.id]);
      expect(saved).toMatchObject({ agentDeviceId: 'studio', model: 'remote-model', providerId: 'remote-provider' });
      expect(await loader.reconcile(dir)).toMatchObject({ inserted: 0, updated: 0 });
      expect(await loader.upsertSchedule(dir, { ...config, agentDeviceId: 'shared-device' }))
        .toMatchObject({ updated: 1 });
      expect(saved?.agentDeviceId).toBe('shared-device');
      expect(await loader.upsertSchedule(dir, { ...config, agentDeviceId: undefined }))
        .toMatchObject({ updated: 1 });
      expect(saved?.agentDeviceId).toBeUndefined();
      expect(saved?.providerId).toBe('remote-provider');
      expect(await loader.reconcile(dir)).toMatchObject({ updated: 0 });
      expect(update).toHaveBeenCalledTimes(2);
      // 2026-11-16 / unit: disk opt-in survives editor reconstruction and a fresh loader read.
      const review = projectConfig({ id: 'future-default-task', followTeammateModel: true });
      await loader.upsertSchedule(dir, review);
      expect(await loader.followsTeammateModel(dir, review.id)).toBe(true);
      await loader.upsertSchedule(dir, projectConfig({ id: review.id, name: 'Renamed' }));
      expect(await loader.followsTeammateModel(dir, review.id)).toBe(true);
      const restarted = new ProjectAutomationLoader({} as never);
      expect(await restarted.followsTeammateModel(dir, review.id)).toBe(true);
      await loader.upsertSchedule(dir, { ...review, model: 'chosen-c' });
      expect(await loader.followsTeammateModel(dir, review.id)).toBe(false);
      expect((await restarted.loadProjectSchedules(dir))?.find(item => item.id === review.id))
        .toMatchObject({ name: review.name, model: 'chosen-c' });
      expect(await restarted.followsTeammateModel(dir, review.id)).toBe(false);
      await expect(loader.removeSchedule(dir, review.id)).resolves.toMatchObject({ deleted: 1 });
      await expect(restarted.followsTeammateModel(dir, review.id)).rejects.toThrow('automation was removed');
      // PR #9314 review: a teammate's own writes keep a file they cannot read instead of replacing it.
      const file = path.join(dir, ...PROJECT_AUTOMATION_REL_SEGMENTS);
      await fs.writeFile(file, '{"version":1,"schedules":[', 'utf8');
      await expect(loader.upsertSchedule(dir, config, { keepUnreadable: true })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
      expect(await fs.readFile(file, 'utf8')).toBe('{"version":1,"schedules":[');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  // PR #9904 review: a save rejected by model validation must not leave the rejected choice in schedules.json.
  it.each([false, true])('restores the unchanged project file when a save is rejected (update=%s)', async (existing) => {
    const dir = await fs.mkdtemp(path.join(tmpdir(), 'cindy-project-reject-'));
    try {
      const reject = vi.fn(async () => { throw new Error('model unavailable on that computer'); });
      const loader = new ProjectAutomationLoader({
        scheduler: { create: reject, update: reject } as unknown as ConstructorParameters<typeof ProjectAutomationLoader>[0]['scheduler'],
        storage: { list: async () => existing ? [{ ...projectSchedule({ desktop: true, feishu: false }), workingDir: dir }] : [] } as unknown as ConstructorParameters<typeof ProjectAutomationLoader>[0]['storage'],
        getDb: () => ({}) as unknown as ReturnType<ConstructorParameters<typeof ProjectAutomationLoader>[0]['getDb']>,
        logger: { warn: vi.fn(), debug: vi.fn() },
      });
      const file = path.join(dir, ...PROJECT_AUTOMATION_REL_SEGMENTS);
      const config = projectConfig({ model: 'remote-model', providerId: 'remote-provider' });
      await expect(loader.upsertSchedule(dir, config)).rejects.toThrow('model unavailable');
      await expect(fs.access(file)).rejects.toThrow();

      const before = JSON.stringify({ version: 1, schedules: [projectConfig({ id: 'other' })] });
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, before, 'utf8');
      await expect(loader.upsertSchedule(dir, config)).rejects.toThrow('model unavailable');
      expect(await fs.readFile(file, 'utf8')).toBe(before);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  // PR #9904 / unit: upsertSchedule must preserve later disk writes when validation rejects.
  // The previous test only covered immediate failures with no intervening writer.
  // Matrix: create/update x later save/remove/raw edit/file deletion; the original error
  // survives and neither rollback nor the read cache may resurrect the earlier snapshot.
  it.each([false, true].flatMap((existing) =>
    ['save', 'remove', 'edit', 'delete-file'].map((change) => ({ existing, change }))))(
    'keeps a later $change after a rejected save (update=$existing)', async ({ existing, change }) => {
      const dir = await fs.mkdtemp(path.join(tmpdir(), 'cindy-project-late-reject-'));
      try {
        const stored: Schedule[] = existing
          ? [{ ...projectSchedule({ desktop: true, feishu: false }), workingDir: dir }] : [];
        let entered!: () => void;
        const validating = new Promise<void>((resolve) => { entered = resolve; });
        let reject!: (err: Error) => void;
        const validation = new Promise<Schedule>((_resolve, rejectPromise) => { reject = rejectPromise; });
        const save = async (input: CreateScheduleInput & { projectConfigId?: string }) => {
          if (input.projectConfigId === 'daily') {
            entered();
            return validation;
          }
          const saved = { ...projectSchedule({ desktop: true, feishu: false }), ...input, id: 'other' } as Schedule;
          stored.push(saved);
          return saved;
        };
        const loader = new ProjectAutomationLoader({
          scheduler: { create: save, update: (_id: string, input: CreateScheduleInput) => save(input),
            delete: async (id: string) => { stored.splice(stored.findIndex((s) => s.id === id), 1); },
          } as unknown as ConstructorParameters<typeof ProjectAutomationLoader>[0]['scheduler'],
          storage: { list: async () => stored } as unknown as ConstructorParameters<typeof ProjectAutomationLoader>[0]['storage'],
          getDb: () => ({}) as unknown as ReturnType<ConstructorParameters<typeof ProjectAutomationLoader>[0]['getDb']>,
          logger: { warn: vi.fn(), debug: vi.fn() },
        });
        const file = path.join(dir, ...PROJECT_AUTOMATION_REL_SEGMENTS);
        if (existing) {
          await fs.mkdir(path.dirname(file), { recursive: true });
          await fs.writeFile(file, JSON.stringify({ version: 1, schedules: [projectConfig()] }));
        }
        const rejected = expect(loader.upsertSchedule(dir, projectConfig({ model: 'unavailable' })))
          .rejects.toThrow('model unavailable');
        await validating;
        // Cache the pending write too: a skipped restoration must invalidate this read.
        await loader.loadProjectSchedules(dir);
        // Loader writes now wait behind validation; raw disk edits remain external.
        let later: Promise<unknown> | undefined;
        if (change === 'save') later = loader.upsertSchedule(dir, projectConfig({ id: 'other' }));
        else if (change === 'remove') later = loader.removeSchedule(dir, 'daily');
        else if (change === 'edit') await fs.writeFile(file, '{editing in progress');
        else await fs.rm(file);
        const latest = change === 'delete-file' ? null : await fs.readFile(file, 'utf8');
        reject(new Error('model unavailable'));
        await rejected;
        await later;
        const expected = change === 'save'
          ? [...(existing ? [projectConfig()] : []), projectConfig({ id: 'other' })]
          : change === 'remove' ? existing ? [] : null : null;
        if (later) expect(await loader.loadProjectSchedules(dir)).toEqual(expected);
        else if (latest === null) await expect(fs.access(file)).rejects.toThrow();
        else expect(await fs.readFile(file, 'utf8')).toBe(latest);
        expect((await fs.readdir(path.dirname(file))).filter((name) => name.includes('.tmp.'))).toEqual([]);
        if (!later) expect(await loader.loadProjectSchedules(dir)).toBeNull();
        if (change === 'save') expect(stored.find((s) => s.projectConfigId === 'other')).toBeDefined();
        if (change === 'remove') expect(stored).toHaveLength(0);
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    },
  );

  it('passes an explicit provider through the loader input and detects changes', () => {
    const config = projectConfig({ providerId: 'openai' });
    const input = __testing.scheduleConfigToUpdateInput(config, workingDir);
    expect(input.providerId).toBe('openai');
    expect(
      schedulesDiffer(projectSchedule({ desktop: true, feishu: false }), config, workingDir),
    ).toBe(true);
  });
});

describe('project automation explicit Harness reconciliation', () => {
  it('detects marker-only changes, persists them, and clears them without losing the bound task', () => {
    const current: Schedule = { ...projectSchedule({ desktop: true, feishu: false }),
      agentKind: 'pi', model: 'test-model', persistentSession: true, targetSessionId: 'bound-codex' };
    const config = projectConfig({ agentKind: 'pi', modelAgentKind: 'pi', modelAgentDeviceId: 'shared:owner',
      providerId: 'shared-source', model: 'test-model', persistentSession: true });
    expect(schedulesDiffer(current, config, workingDir)).toBe(true);
    const input = __testing.scheduleConfigToUpdateInput(config, workingDir);
    expect(input.modelAgentKind).toBe('pi');
    expect(input.modelAgentDeviceId).toBe('shared:owner');
    const saved = scheduleToCamel({ ...scheduleCreateToRow(current),
      ...schedulePatchToRow({ modelAgentKind: input.modelAgentKind, modelAgentDeviceId: input.modelAgentDeviceId,
        providerId: input.providerId }),
    } as Parameters<typeof scheduleToCamel>[0]);
    expect(saved).toMatchObject({ modelAgentKind: 'pi', persistentSession: true, targetSessionId: 'bound-codex' });
    expect(schedulesDiffer(saved, config, workingDir)).toBe(false);

    const legacy = { ...config, modelAgentKind: undefined, modelAgentDeviceId: undefined };
    expect(schedulesDiffer(saved, legacy, workingDir)).toBe(true);
    const clearInput = __testing.scheduleConfigToUpdateInput(legacy, workingDir);
    expect(clearInput).toHaveProperty('modelAgentKind', undefined);
    const cleared = scheduleToCamel({ ...scheduleCreateToRow(saved),
      ...schedulePatchToRow({ modelAgentKind: clearInput.modelAgentKind, modelAgentDeviceId: clearInput.modelAgentDeviceId }),
    } as Parameters<typeof scheduleToCamel>[0]);
    expect(cleared.modelAgentKind).toBeUndefined();
    expect(cleared.targetSessionId).toBe('bound-codex');
    expect(schedulesDiffer(cleared, legacy, workingDir)).toBe(false);
  });

  it.each([
    { override: {}, valid: true },
    { override: { modelAgentKind: 'pi', model: 'test-model' }, valid: true },
    { override: { modelAgentKind: 'invalid', model: 'test-model' }, valid: false },
    { override: { modelAgentKind: 'pi' }, valid: false },
    { override: { agentDeviceId: 'studio', model: 'remote-model' }, valid: true },
    { override: { agentDeviceId: '../invalid', model: 'remote-model' }, valid: false },
    { override: { agentDeviceId: 42, model: 'remote-model' }, valid: false },
    { override: { agentDeviceId: 'studio' }, valid: false },
  ])('loads version 1 project files with compatible Harness validation: %j', async ({ override, valid }) => {
    const dir = await fs.mkdtemp(path.join(tmpdir(), 'cindy-project-harness-'));
    try {
      const file = path.join(dir, ...PROJECT_AUTOMATION_REL_SEGMENTS);
      await fs.mkdir(path.dirname(file), { recursive: true });
      const config = { ...projectConfig(), ...override };
      await fs.writeFile(file, JSON.stringify({ version: 1, schedules: [config] }));
      // File loading must not access the scheduler or database.
      const loader = new ProjectAutomationLoader({
        get scheduler(): never { throw new Error('file loading must not access the scheduler'); },
        get storage(): never { throw new Error('file loading must not access storage'); },
        getDb(): never { throw new Error('file loading must not access the database'); },
        logger: { warn: vi.fn(), debug: vi.fn() },
      });
      expect(await loader.loadProjectSchedules(dir)).toEqual(valid ? [config] : null);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
