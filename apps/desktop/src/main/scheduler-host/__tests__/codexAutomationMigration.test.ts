import { describe, expect, it, vi } from 'vitest';

import type { CodexAutomationDetail, CodexAutomationReader } from '../codex-automation-reader.js';
import {
  createCodexAutomationMigrationService,
  type CodexAutomationMigrationConverter,
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
  const schedules: any[] = [];
  const scheduler = {
    list: vi.fn(async () => schedules),
    create: vi.fn(async (input: any) => {
      const created = { id: `schedule-${schedules.length + 1}`, status: 'active', ...input };
      schedules.push(created);
      return created;
    }),
    pause: vi.fn(async (id: string) => schedules.find((item) => item.id === id)),
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

  it('continues importing other records when one record is unsupported', async () => {
    const good = detail('good');
    const bad = detail('bad');
    const { service, scheduler, reader } = setup([good, bad]);
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
});
