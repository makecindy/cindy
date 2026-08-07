import { describe, expect, it, vi } from 'vitest';
import type { CreateScheduleInput, Schedule } from '@cindy/maker-scheduler';

import type { CodexAutomationDetail, CodexAutomationReader } from '../codex-automation-reader.js';
import {
  createCodexAutomationMigrationService,
  findDuplicateSchedule,
  type CodexAutomationMigrationConverter,
  type CodexAutomationMigrationScheduler,
} from '../codex-automation-migration.js';

function detail(id: string, overrides: Partial<CodexAutomationDetail> = {}): CodexAutomationDetail {
  return {
    id,
    name: `Task ${id}`,
    prompt: `prompt ${id}`,
    status: 'ACTIVE',
    rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=30',
    cwds: ['C:\\work'],
    sourcePath: `C:\\codex\\${id}\\automation.toml`,
    diagnostics: [],
    ...overrides,
  };
}

function inputFor(item: CodexAutomationDetail) {
  return {
    name: item.name,
    prompt: item.prompt,
    kind: 'cron' as const,
    cronExpr: '30 9 * * *',
    timezone: 'Asia/Shanghai',
    recurring: true,
    agentKind: 'codex' as const,
    model: item.model,
    effort: item.reasoningEffort,
    workspaceKind: 'project' as const,
    workingDir: item.cwds[0],
    useWorktree: false,
    notify: { desktop: true, feishu: false },
  };
}

function setup(items: CodexAutomationDetail[]) {
  const schedules: Schedule[] = [];
  const scheduler = {
    list: vi.fn(async () => schedules),
    create: vi.fn(async (input: CreateScheduleInput) => {
      const created = {
        id: `schedule-${schedules.length + 1}`,
        status: 'active' as const,
        ...input,
      } as Schedule;
      schedules.push(created);
      return created;
    }),
    update: vi.fn(async (id: string, patch: Partial<CreateScheduleInput>) => {
      const schedule = schedules.find((item) => item.id === id);
      if (!schedule) throw new Error(`schedule ${id} not found`);
      Object.assign(schedule, patch);
      return schedule;
    }),
    pause: vi.fn(async (id: string) => {
      const schedule = schedules.find((item) => item.id === id);
      if (!schedule) throw new Error(`schedule ${id} not found`);
      schedule.status = 'paused';
      return schedule;
    }),
    delete: vi.fn(async (id: string) => {
      const index = schedules.findIndex((item) => item.id === id);
      if (index >= 0) schedules.splice(index, 1);
    }),
  };
  const reader: CodexAutomationReader = {
    list: vi.fn(async () => items),
    get: vi.fn(async (id: string) => items.find((item) => item.id === id) ?? null),
  };
  const converter: CodexAutomationMigrationConverter = (item) => ({
    canImport: true,
    input: inputFor(item),
    diagnostics: [],
    status: item.status === 'ACTIVE' ? 'active' : 'paused',
  });
  return {
    service: createCodexAutomationMigrationService({ reader, scheduler, converter }),
    scheduler,
    reader,
  };
}

describe('CodexAutomationMigrationService', () => {
  it('previews all records and defaults only eligible non-duplicates to selected', async () => {
    const first = detail('one');
    const unsupported = detail('two');
    const { service, scheduler } = setup([first, unsupported]);
    const result = await service.preview();
    expect(result.items).toHaveLength(2);
    expect(result.items[0].selectedByDefault).toBe(true);
    expect(scheduler.list).toHaveBeenCalledTimes(1);
  });

  it('skips duplicate schedules and creates each selected source only once', async () => {
    const first = detail('one');
    const { service, scheduler } = setup([first]);
    await service.import(['one']);
    await service.import(['one']);
    expect(scheduler.create).toHaveBeenCalledTimes(1);
    const second = await service.import(['missing']);
    expect(second.failed[0]?.sourceId).toBe('missing');
  });

  it('serializes concurrent imports to avoid duplicate creation', async () => {
    const first = detail('one');
    const { service, scheduler, reader } = setup([first]);
    const second = createCodexAutomationMigrationService({ reader, scheduler });

    const [left, right] = await Promise.all([service.import(['one']), second.import(['one'])]);

    expect(scheduler.create).toHaveBeenCalledTimes(1);
    expect([left.created.length, right.created.length].sort()).toEqual([0, 1]);
  });

  it('continues importing other records when one record is unsupported', async () => {
    const good = detail('good');
    const bad = detail('bad');
    const { scheduler, reader } = setup([good, bad]);
    const converter: CodexAutomationMigrationConverter = (item) =>
      item.id === 'bad'
        ? { canImport: false, diagnostics: ['unsupported recurrence'], status: 'active' }
        : { canImport: true, input: inputFor(item), diagnostics: [], status: 'active' };
    const custom = createCodexAutomationMigrationService({
      reader,
      scheduler,
      converter,
    });
    const result = await custom.import(['bad', 'good']);
    expect(result.created).toHaveLength(1);
    expect(result.skipped[0]).toMatchObject({ sourceId: 'bad' });
  });

  it('does not treat a schedule with different execution semantics as a duplicate', async () => {
    const first = detail('one');
    const { service, scheduler } = setup([first]);
    scheduler.list.mockResolvedValueOnce([
      {
        id: 'existing',
        ...inputFor(first),
        status: 'active',
        executionMode: 'script',
        notify: { desktop: false, feishu: false },
      } as Schedule,
    ]);

    const result = await service.preview();
    expect(result.items[0]?.duplicate).toBe(false);
    expect(result.items[0]?.selectedByDefault).toBe(true);
  });

  it('does not treat hook configuration changes as duplicates', async () => {
    const first = detail('one');
    const { service, scheduler } = setup([first]);
    scheduler.list.mockResolvedValueOnce([
      {
        id: 'existing',
        ...inputFor(first),
        status: 'active',
        preRunHook: { command: 'node check.mjs' },
      } as Schedule,
    ]);

    const result = await service.preview();

    expect(result.items[0]?.duplicate).toBe(false);
  });

  it('does not treat expiration changes as duplicates', async () => {
    const first = detail('one');
    const { service, scheduler } = setup([first]);
    scheduler.list.mockResolvedValueOnce([
      {
        id: 'existing',
        ...inputFor(first),
        status: 'active',
        expireAt: Date.now() + 60_000,
      } as Schedule,
    ]);

    const result = await service.preview();

    expect(result.items[0]?.duplicate).toBe(false);
  });

  it('does not treat a schedule with a different status as a duplicate', async () => {
    const first = detail('one');
    const { service, scheduler } = setup([first]);
    scheduler.list.mockResolvedValueOnce([
      {
        id: 'existing',
        ...inputFor(first),
        status: 'paused',
      } as Schedule,
    ]);

    const result = await service.preview();

    expect(result.items[0]?.duplicate).toBe(false);
  });

  it('does not treat a schedule bound to another session as a duplicate', () => {
    const first = detail('one');
    const input = inputFor(first);
    const existing = {
      id: 'existing',
      ...input,
      status: 'active',
      targetSessionId: 'session-1',
    } as Schedule;

    expect(findDuplicateSchedule([existing], input)).toBeUndefined();
  });

  it('does not treat script configuration changes as duplicates', () => {
    const first = detail('one');
    const input: CreateScheduleInput = {
      ...inputFor(first),
      executionMode: 'script',
      scriptConfig: { command: 'node import.mjs', capabilities: ['jira.read'] },
    };
    const existing = {
      id: 'existing',
      ...input,
      status: 'active',
      scriptConfig: { command: 'node other.mjs', capabilities: ['jira.read'] },
    } as Schedule;

    expect(findDuplicateSchedule([existing], input)).toBeUndefined();
  });

  it('deduplicates diagnostics in skipped import results', async () => {
    const item = detail('bad', { diagnostics: ['unsupported recurrence'] });
    const { scheduler } = setup([item]);
    const custom = createCodexAutomationMigrationService({
      reader: {
        list: vi.fn(async () => [item]),
        get: vi.fn(async () => item),
      },
      scheduler,
      converter: () => ({
        canImport: false,
        diagnostics: ['unsupported recurrence'],
        status: 'active',
      }),
    });

    const result = await custom.import(['bad']);
    expect(result.skipped[0]?.reason).toBe('unsupported recurrence');
  });

  it('deletes a newly created schedule when pausing a disabled task fails', async () => {
    const item = detail('paused', { status: 'PAUSED' });
    const { service, scheduler } = setup([item]);
    scheduler.pause.mockRejectedValueOnce(new Error('pause failed'));

    const result = await service.import(['paused']);

    expect(result.created).toHaveLength(0);
    expect(result.failed[0]?.error).toContain('pause failed');
    expect(scheduler.create).toHaveBeenCalledWith(expect.objectContaining({ manual: true }));
    expect(scheduler.delete).toHaveBeenCalledWith('schedule-1');
  });

  it('leaves a non-auto-running manual schedule when pause and cleanup both fail', async () => {
    const item = detail('paused', { status: 'PAUSED' });
    const { service, scheduler } = setup([item]);
    scheduler.pause.mockRejectedValueOnce(new Error('pause failed'));
    scheduler.delete.mockRejectedValueOnce(new Error('delete failed'));

    const result = await service.import(['paused']);
    const [leftover] = await scheduler.list();

    expect(result.created).toHaveLength(0);
    expect(result.failed[0]?.error).toContain('remains manual and will not auto-run');
    expect(leftover).toMatchObject({ status: 'active', manual: true });
    expect(leftover?.nextFireAt).toBeUndefined();
  });

  it('does not create another schedule when retrying a fail-closed paused import', async () => {
    const item = detail('paused', { status: 'PAUSED' });
    const { service, scheduler } = setup([item]);
    scheduler.update.mockRejectedValueOnce(new Error('restore manual failed'));
    scheduler.delete.mockRejectedValueOnce(new Error('delete failed'));

    const first = await service.import(['paused']);
    const second = await service.import(['paused']);

    expect(first.failed[0]?.error).toContain('remains manual and will not auto-run');
    expect(scheduler.create).toHaveBeenCalledTimes(1);
    expect(scheduler.update).toHaveBeenCalledTimes(2);
    expect(second.created[0]).toMatchObject({
      sourceId: 'paused',
      scheduleId: 'schedule-1',
    });
    expect(second.skipped).toEqual([]);
    expect(await scheduler.list()).toEqual([
      expect.objectContaining({ id: 'schedule-1', status: 'paused', manual: false }),
    ]);
  });

  it('recovers a persisted staging schedule after the scheduler service is recreated', async () => {
    const item = detail('paused', { status: 'PAUSED' });
    const { service, scheduler, reader } = setup([item]);
    scheduler.update.mockRejectedValueOnce(new Error('restore manual failed'));
    scheduler.delete.mockRejectedValueOnce(new Error('delete failed'));

    await service.import(['paused']);
    const [leftover] = await scheduler.list();
    expect(leftover).toMatchObject({
      originKind: 'codex-automation',
      originId: 'paused',
    });

    const freshScheduler: CodexAutomationMigrationScheduler = {
      list: scheduler.list,
      create: scheduler.create,
      update: scheduler.update,
      pause: scheduler.pause,
      delete: scheduler.delete,
    };
    const freshService = createCodexAutomationMigrationService({
      reader,
      scheduler: freshScheduler,
    });

    const result = await freshService.import(['paused']);

    expect(scheduler.create).toHaveBeenCalledTimes(1);
    expect(result.created[0]).toMatchObject({ sourceId: 'paused', scheduleId: 'schedule-1' });
    expect(await scheduler.list()).toEqual([
      expect.objectContaining({ id: 'schedule-1', status: 'paused', manual: false }),
    ]);
  });

  it('recovers the schedule won by another process after an origin uniqueness conflict', async () => {
    const item = detail('one');
    const { service, scheduler } = setup([item]);
    const concurrent = {
      id: 'schedule-other-process',
      ...inputFor(item),
      originKind: 'codex-automation' as const,
      originId: 'one',
      status: 'active' as const,
    } as Schedule;
    scheduler.create.mockRejectedValueOnce(
      new Error('UNIQUE constraint failed: schedules.origin_kind, schedules.origin_id'),
    );
    scheduler.list.mockResolvedValueOnce([]).mockResolvedValueOnce([concurrent]);

    const result = await service.import(['one']);

    expect(result.failed).toEqual([]);
    expect(result.skipped[0]).toMatchObject({
      sourceId: 'one',
      scheduleId: 'schedule-other-process',
    });
    expect(scheduler.create).toHaveBeenCalledTimes(1);
  });

  it('restores the intended automatic cadence only after a paused task is safely paused', async () => {
    const item = detail('paused', { status: 'PAUSED' });
    const { service, scheduler } = setup([item]);

    const result = await service.import(['paused']);

    expect(result.created).toHaveLength(1);
    expect(scheduler.create).toHaveBeenCalledWith(expect.objectContaining({ manual: true }));
    expect(scheduler.pause).toHaveBeenCalledWith('schedule-1');
    expect(scheduler.update).toHaveBeenCalledWith('schedule-1', { manual: false });
    expect((await scheduler.list())[0]).toMatchObject({ status: 'paused', manual: false });
  });
});
