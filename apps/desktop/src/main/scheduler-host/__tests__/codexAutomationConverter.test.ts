import { describe, expect, it } from 'vitest';

import type { CodexAutomationDetail } from '../codex-automation-reader.js';
import { convertCodexAutomation, codexRruleToCron } from '../codex-automation-converter.js';

function detail(overrides: Partial<CodexAutomationDetail> = {}): CodexAutomationDetail {
  return {
    id: 'ddl',
    name: 'DDL patrol',
    prompt: 'Read AGENTS.md and report upcoming deadlines.',
    status: 'ACTIVE',
    rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=11;BYMINUTE=20;BYSECOND=0',
    model: 'gpt-5.5',
    reasoningEffort: 'medium',
    executionEnvironment: 'local',
    cwds: ['C:\\newlife'],
    sourcePath: 'C:\\Users\\XD\\.codex\\automations\\ddl\\automation.toml',
    diagnostics: [],
    ...overrides,
  };
}

describe('codexRruleToCron', () => {
  it('converts a daily fixed-time rule to cron', () => {
    expect(codexRruleToCron('FREQ=DAILY;BYHOUR=8;BYMINUTE=30;BYSECOND=0')).toEqual({
      cronExpr: '30 8 * * *',
      diagnostics: [],
    });
  });

  it('accepts the optional RRULE prefix used by Codex automation files', () => {
    expect(codexRruleToCron('RRULE:FREQ=DAILY;BYHOUR=8;BYMINUTE=30;BYSECOND=0')).toEqual({
      cronExpr: '30 8 * * *',
      diagnostics: [],
    });
  });

  it('converts a weekly rule and maps RFC weekday names to cron numbers', () => {
    expect(codexRruleToCron('FREQ=WEEKLY;BYDAY=MO,FR;BYHOUR=16;BYMINUTE=0')).toEqual({
      cronExpr: '0 16 * * 1,5',
      diagnostics: [],
    });
  });

  it('converts a monthly day-of-month rule', () => {
    expect(codexRruleToCron('FREQ=MONTHLY;BYMONTHDAY=15;BYHOUR=9;BYMINUTE=5')).toEqual({
      cronExpr: '5 9 15 * *',
      diagnostics: [],
    });
  });

  it('converts monthly day-of-month lists exactly', () => {
    expect(codexRruleToCron('FREQ=MONTHLY;BYMONTHDAY=1,15;BYHOUR=9;BYMINUTE=5')).toEqual({
      cronExpr: '5 9 1,15 * *',
      diagnostics: [],
    });
  });

  it('rejects monthly days that Cindy clamps in short months', () => {
    const result = codexRruleToCron('FREQ=MONTHLY;BYMONTHDAY=31;BYHOUR=9;BYMINUTE=5');
    expect(result.cronExpr).toBeUndefined();
    expect(result.diagnostics.join(' ')).toContain('clamps short months');
  });

  it('keeps monthly high-day rules exact when hours are listed', () => {
    expect(codexRruleToCron('FREQ=MONTHLY;BYMONTHDAY=31;BYHOUR=8,9;BYMINUTE=5')).toEqual({
      cronExpr: '5 8,9 31 * *',
      diagnostics: [],
    });
  });

  it('rejects an every-other-week rule instead of changing its meaning', () => {
    const result = codexRruleToCron('FREQ=WEEKLY;INTERVAL=2;BYDAY=FR;BYHOUR=15;BYMINUTE=0');
    expect(result.cronExpr).toBeUndefined();
    expect(result.diagnostics.join(' ')).toContain('INTERVAL=2');
  });

  it('supports multiple fixed hours and minutes', () => {
    expect(codexRruleToCron('FREQ=DAILY;BYHOUR=8,9;BYMINUTE=0,30')).toEqual({
      cronExpr: '0,30 8,9 * * *',
      diagnostics: [],
    });
  });

  it('rejects unsupported recurrence fields', () => {
    const result = codexRruleToCron(
      'FREQ=WEEKLY;BYDAY=MO;BYHOUR=8,9;BYMINUTE=0;COUNT=3;BYSETPOS=1',
    );
    expect(result.cronExpr).toBeUndefined();
    expect(result.diagnostics.join(' ')).toContain('COUNT');
    expect(result.diagnostics.join(' ')).toContain('BYSETPOS');
  });

  it('rejects rules without a fixed hour and minute', () => {
    const result = codexRruleToCron('FREQ=DAILY;BYHOUR=8');
    expect(result.cronExpr).toBeUndefined();
    expect(result.diagnostics.join(' ')).toContain('BYMINUTE');
  });
});

describe('convertCodexAutomation', () => {
  it('maps a valid Codex automation to a Cindy schedule input', () => {
    const result = convertCodexAutomation(detail(), { timezone: 'Asia/Shanghai' });

    expect(result).toMatchObject({ canImport: true, status: 'active', diagnostics: [] });
    expect(result.input).toEqual({
      name: 'DDL patrol',
      prompt: 'Read AGENTS.md and report upcoming deadlines.',
      kind: 'cron',
      cronExpr: '20 11 * * 1,2,3,4,5',
      timezone: 'Asia/Shanghai',
      recurring: true,
      manual: false,
      agentKind: 'codex',
      model: 'gpt-5.5',
      effort: 'medium',
      workspaceKind: 'project',
      workingDir: 'C:\\newlife',
      useWorktree: false,
      executionMode: 'agent',
      notify: { desktop: true, feishu: false },
    });
  });

  it('preserves a disabled Codex task as a paused Cindy schedule', () => {
    const result = convertCodexAutomation(detail({ status: 'PAUSED' }), {
      timezone: 'UTC',
    });

    expect(result.canImport).toBe(true);
    expect(result.status).toBe('paused');
    expect(result.input?.cronExpr).toBe('20 11 * * 1,2,3,4,5');
  });

  it('rejects an unknown Codex status instead of silently enabling it', () => {
    const result = convertCodexAutomation(detail({ status: 'MYSTERY' }), {
      timezone: 'UTC',
    });

    expect(result.canImport).toBe(false);
    expect(result.diagnostics.join(' ')).toContain('not recognized');
  });

  it('does not import a task with an unsupported environment or cwd', () => {
    const result = convertCodexAutomation(
      detail({ executionEnvironment: 'remote', cwds: ['relative/project'] }),
      { timezone: 'UTC' },
    );

    expect(result.canImport).toBe(false);
    expect(result.input).toBeUndefined();
    expect(result.diagnostics.join(' ')).toContain('execution_environment');
    expect(result.diagnostics.join(' ')).toContain('absolute');
  });

  it('explains that only the first cwd is imported when multiple are present', () => {
    const result = convertCodexAutomation(detail({ cwds: ['C:\\newlife', 'D:\\other-project'] }), {
      timezone: 'UTC',
    });

    expect(result.canImport).toBe(false);
    expect(result.diagnostics).toContain(
      'automation has multiple cwds; only the first cwd will be imported',
    );
  });

  it('carries reader diagnostics and rejects an empty prompt', () => {
    const result = convertCodexAutomation(detail({ prompt: '', diagnostics: ['malformed field'] }));

    expect(result.canImport).toBe(false);
    expect(result.diagnostics).toEqual(expect.arrayContaining(['malformed field']));
    expect(result.diagnostics.join(' ')).toContain('prompt');
  });

  it('keeps informational reader diagnostics without blocking a valid import', () => {
    const result = convertCodexAutomation(
      detail({ diagnostics: ['id does not match its automation directory'] }),
    );

    expect(result.canImport).toBe(true);
    expect(result.diagnostics).toContain('id does not match its automation directory');
  });

  it('rejects an automation without a display name', () => {
    const result = convertCodexAutomation(detail({ name: '   ' }), { timezone: 'UTC' });

    expect(result.canImport).toBe(false);
    expect(result.diagnostics.join(' ')).toContain('name');
  });

  it('rejects weekly rules that also contain a month day', () => {
    const result = convertCodexAutomation(
      detail({ rrule: 'FREQ=WEEKLY;BYDAY=FR;BYMONTHDAY=7;BYHOUR=15;BYMINUTE=0' }),
      { timezone: 'UTC' },
    );

    expect(result.canImport).toBe(false);
    expect(result.diagnostics.join(' ')).toContain('BYMONTHDAY');
  });

  it('rejects monthly rules that use unsupported BYDAY semantics', () => {
    const result = convertCodexAutomation(
      detail({ rrule: 'FREQ=MONTHLY;BYDAY=1FR;BYHOUR=15;BYMINUTE=0' }),
      { timezone: 'UTC' },
    );

    expect(result.canImport).toBe(false);
    expect(result.diagnostics.join(' ')).toContain('MONTHLY BYDAY');
  });
});
