import { describe, expect, it } from 'vitest';

import type { BotAutomation } from '../../../../shared/botAutomation';
import { DEFAULT_BOT_AUTOMATION_EXECUTION_POLICY } from '../../../../shared/botAutomation';
import {
  automationFormValueFrom,
  automationSubmission,
  canSubmitAutomationForm,
  defaultDurableNoteNamespace,
  describeAutomationSchedule,
  emptyAutomationFormValue,
  suggestAutomationName,
} from '../automationForm';

function automation(overrides: Partial<BotAutomation> = {}): BotAutomation {
  return {
    id: 'automation-1',
    botId: 'bot-1',
    name: 'Morning digest',
    prompt: 'Summarise yesterday.',
    cronExpr: '0 9 * * *',
    timezone: 'Asia/Shanghai',
    recurring: true,
    manual: false,
    executionPolicy: DEFAULT_BOT_AUTOMATION_EXECUTION_POLICY,
    createdWithProfileVersion: 1,
    status: 'active',
    createdAt: 0,
    updatedAt: 0,
    activeRunCount: 0,
    ...overrides,
  };
}

describe('describeAutomationSchedule', () => {
  it('says "manual only" for a manual routine', () => {
    expect(describeAutomationSchedule(automation({ manual: true, recurring: false }))).toEqual({
      key: 'bots.automations.scheduleSummary.manual',
    });
  });

  it('reads a daily cron back as a wall-clock time', () => {
    expect(describeAutomationSchedule(automation({ cronExpr: '5 7 * * *' }))).toEqual({
      key: 'bots.automations.scheduleSummary.daily',
      params: { time: '07:05' },
    });
  });

  it('states the interval in minutes', () => {
    expect(
      describeAutomationSchedule(automation({ intervalMs: 30 * 60_000, cronExpr: '0 * * * *' })),
    ).toEqual({
      key: 'bots.automations.scheduleSummary.interval',
      params: { count: 30 },
    });
  });

  it('falls back to the raw expression for a custom cron', () => {
    expect(describeAutomationSchedule(automation({ cronExpr: '0 17 * * 5' }))).toEqual({
      key: 'bots.automations.scheduleSummary.cron',
      params: { expr: '0 17 * * 5' },
    });
  });

  it('prefers the manual and interval shapes over the cron kept on the record', () => {
    // A manual routine still carries a cron expression; it must not surface.
    expect(
      describeAutomationSchedule(automation({ manual: true, cronExpr: '0 9 * * *' })).key,
    ).toBe('bots.automations.scheduleSummary.manual');
    expect(
      describeAutomationSchedule(automation({ intervalMs: 60_000, cronExpr: '0 9 * * *' })).key,
    ).toBe('bots.automations.scheduleSummary.interval');
  });
});

describe('suggestAutomationName', () => {
  it('uses a short instruction verbatim', () => {
    expect(suggestAutomationName('Triage the inbox')).toBe('Triage the inbox');
  });

  it('clips a long instruction to a row-sized label', () => {
    expect(suggestAutomationName('Summarise everything that happened yesterday')).toBe(
      'Summarise everything…',
    );
  });

  it('counts CJK by character, not by byte', () => {
    expect(suggestAutomationName('汇总昨天完成的工作，写一份简短的进展摘要发给我')).toBe(
      '汇总昨天完成的工作，写一份简短的进展摘要…',
    );
  });

  it('takes the first non-empty line and collapses whitespace', () => {
    expect(suggestAutomationName('\n\n  check   the inbox  \nthen report')).toBe('check the inbox');
  });

  it('returns an empty string for an empty instruction', () => {
    expect(suggestAutomationName('   \n  ')).toBe('');
  });
});

describe('defaultDurableNoteNamespace', () => {
  it('slugifies a name', () => {
    expect(defaultDurableNoteNamespace('Morning digest')).toBe('morning-digest');
  });

  it('collapses punctuation runs and trims the edges', () => {
    expect(defaultDurableNoteNamespace('Daily 09:00 · Progress!')).toBe('daily-09-00-progress');
  });

  it('keeps CJK characters, which the storage contract allows', () => {
    expect(defaultDurableNoteNamespace('每天汇总 进展')).toBe('每天汇总-进展');
  });

  it('returns null when nothing usable is left', () => {
    expect(defaultDurableNoteNamespace('  ···  ')).toBeNull();
  });
});

describe('automationSubmission', () => {
  it('builds a runnable daily routine from the instruction alone', () => {
    const value = emptyAutomationFormValue({ timezone: 'Asia/Shanghai' });
    value.prompt = '  Summarise yesterday.  ';

    expect(automationSubmission(value)).toEqual({
      name: 'Summarise yesterday.',
      prompt: 'Summarise yesterday.',
      timezone: 'Asia/Shanghai',
      cronExpr: '0 9 * * *',
      recurring: true,
      manual: false,
      intervalMs: undefined,
      projectBindingId: null,
      targetRouteId: null,
      durableNoteNamespace: 'summarise-yesterday',
      executionPolicy: DEFAULT_BOT_AUTOMATION_EXECUTION_POLICY,
    });
  });

  it('refuses to submit without an instruction', () => {
    const value = emptyAutomationFormValue();
    expect(canSubmitAutomationForm(value)).toBe(false);
    expect(automationSubmission(value)).toBeNull();
    value.prompt = 'do it';
    expect(canSubmitAutomationForm(value)).toBe(true);
  });

  it('keeps the existing cron while a routine is manual-only', () => {
    const value = emptyAutomationFormValue({ mode: 'manual', prompt: 'On demand only' });
    expect(automationSubmission(value, { fallbackCronExpr: '30 8 * * *' })).toMatchObject({
      cronExpr: '30 8 * * *',
      recurring: false,
      manual: true,
      intervalMs: undefined,
    });
    expect(automationSubmission(value)).toMatchObject({ cronExpr: '0 0 * * *' });
  });

  it('turns the daily time into a cron expression', () => {
    const value = emptyAutomationFormValue({ prompt: 'x', mode: 'daily', dailyTime: '07:05' });
    expect(automationSubmission(value)).toMatchObject({
      cronExpr: '5 7 * * *',
      recurring: true,
      manual: false,
      intervalMs: undefined,
    });
  });

  it('sends minutes as an interval and keeps the placeholder cron', () => {
    const value = emptyAutomationFormValue({ prompt: 'x', mode: 'interval', intervalMinutes: 30 });
    expect(automationSubmission(value)).toMatchObject({
      cronExpr: '0 * * * *',
      recurring: true,
      manual: false,
      intervalMs: 30 * 60_000,
    });
  });

  it('passes a custom cron through and falls back when it is blank', () => {
    const value = emptyAutomationFormValue({ prompt: 'x', mode: 'cron', cronExpr: ' 0 17 * * 5 ' });
    expect(automationSubmission(value)).toMatchObject({ cronExpr: '0 17 * * 5', manual: false });
    expect(automationSubmission({ ...value, cronExpr: '  ' })).toMatchObject({
      cronExpr: '0 9 * * *',
    });
  });

  it('respects everything the user typed in Advanced', () => {
    const value = emptyAutomationFormValue({
      prompt: 'x',
      name: '  Custom name  ',
      timezone: '  UTC  ',
      projectBindingId: 'project-1',
      targetRouteId: 'route-1',
      durableNoteNamespace: '  my-notes  ',
      policy: {
        timeoutMinutes: 45,
        budgetTokens: '120000',
        maxDelegationDepth: 9,
        delegateTargetMode: 'allowlist',
        allowedDelegateBotIds: ['bot-2'],
      },
    });

    expect(automationSubmission(value)).toMatchObject({
      name: 'Custom name',
      timezone: 'UTC',
      projectBindingId: 'project-1',
      targetRouteId: 'route-1',
      durableNoteNamespace: 'my-notes',
      executionPolicy: {
        timeoutMs: 45 * 60_000,
        budgetTokens: 120_000,
        maxDelegationDepth: 5,
        delegateTargetMode: 'allowlist',
        allowedDelegateBotIds: ['bot-2'],
      },
    });
  });

  it('treats an empty timezone as UTC and an empty budget as unlimited', () => {
    const value = emptyAutomationFormValue({ prompt: 'x', timezone: '   ' });
    expect(automationSubmission(value)).toMatchObject({
      timezone: 'UTC',
      executionPolicy: { budgetTokens: null },
    });
  });
});

describe('automationFormValueFrom', () => {
  it('reopens a daily routine on the daily tab with its time', () => {
    expect(automationFormValueFrom(automation({ cronExpr: '30 6 * * *' }))).toMatchObject({
      mode: 'daily',
      dailyTime: '06:30',
      timezone: 'Asia/Shanghai',
    });
  });

  it('reopens an interval routine with its minutes', () => {
    expect(automationFormValueFrom(automation({ intervalMs: 15 * 60_000 }))).toMatchObject({
      mode: 'interval',
      intervalMinutes: 15,
    });
  });

  it('round-trips a stored routine without changing its payload', () => {
    const stored = automation({
      cronExpr: '0 17 * * 5',
      durableNoteNamespace: 'weekly',
      projectBindingId: 'project-1',
    });
    expect(
      automationSubmission(automationFormValueFrom(stored), { fallbackCronExpr: stored.cronExpr }),
    ).toMatchObject({
      name: 'Morning digest',
      prompt: 'Summarise yesterday.',
      cronExpr: '0 17 * * 5',
      recurring: true,
      manual: false,
      projectBindingId: 'project-1',
      durableNoteNamespace: 'weekly',
    });
  });
});
