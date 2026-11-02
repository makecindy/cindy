import { describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import type { CreateScheduleInput, Schedule } from '@cindy/maker-scheduler';

import {
  __testing,
  ProjectAutomationLoader,
  schedulesDiffer,
  type ProjectScheduleConfig,
} from '../project-automation-loader';
import { scheduleCreateToRow, schedulePatchToRow, scheduleToCamel } from '../../localDb/mapper';
import { PROJECT_AUTOMATION_REL_SEGMENTS } from '../../../shared/projectAutomationPaths';

const workingDir = 'C:\\project';

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
        scheduler: { create, update } as unknown as ConstructorParameters<typeof ProjectAutomationLoader>[0]['scheduler'],
        storage: { list: async () => saved ? [saved] : [] } as ConstructorParameters<typeof ProjectAutomationLoader>[0]['storage'],
        getDb: () => ({
          select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
          insert: () => ({ values: () => ({ onConflictDoUpdate: async () => {} }) }),
        }) as unknown as ReturnType<ConstructorParameters<typeof ProjectAutomationLoader>[0]['getDb']>,
        logger: { warn: vi.fn(), debug: vi.fn() },
      });
      const config = { ...projectConfig({ model: 'remote-model', providerId: 'remote-provider' }), agentDeviceId: 'studio' };
      expect(await loader.upsertSchedule(dir, config)).toMatchObject({ inserted: 1, updated: 0 });
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
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

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
