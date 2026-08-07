import path from 'node:path';

import type { CreateScheduleInput, ScheduleStatus } from '@cindy/maker-scheduler';

import type { CodexAutomationDetail } from './codex-automation-reader.js';

export interface CodexRruleConversion {
  cronExpr?: string;
  diagnostics: string[];
}

export interface CodexAutomationConversion {
  canImport: boolean;
  diagnostics: string[];
  input?: CreateScheduleInput;
  status: ScheduleStatus;
}

/** Compatibility name used by the migration service and IPC DTOs. */
export type CodexAutomationConversionResult = CodexAutomationConversion;

export interface CodexAutomationConversionOptions {
  timezone?: string;
}

const WEEKDAY_TO_CRON: Record<string, string> = {
  SU: '0',
  MO: '1',
  TU: '2',
  WE: '3',
  TH: '4',
  FR: '5',
  SA: '6',
};

const SUPPORTED_KEYS = new Set([
  'FREQ',
  'INTERVAL',
  'BYDAY',
  'BYHOUR',
  'BYMINUTE',
  'BYSECOND',
  'BYMONTHDAY',
]);

function parseRrule(rrule: string): { values: Map<string, string>; diagnostics: string[] } {
  const diagnostics: string[] = [];
  const values = new Map<string, string>();
  if (!rrule.trim()) return { values, diagnostics: ['RRULE is empty'] };

  for (const rawPart of rrule.split(';')) {
    const part = rawPart.trim();
    if (!part) {
      diagnostics.push('RRULE contains an empty component');
      continue;
    }
    const separator = part.indexOf('=');
    if (separator <= 0) {
      diagnostics.push(`RRULE component ${part} must be KEY=VALUE`);
      continue;
    }
    const key = part.slice(0, separator).trim().toUpperCase();
    const value = part.slice(separator + 1).trim();
    if (!value) {
      diagnostics.push(`RRULE ${key} must not be empty`);
      continue;
    }
    if (!SUPPORTED_KEYS.has(key)) {
      diagnostics.push(`RRULE field ${key} is not supported by Cindy cron`);
      continue;
    }
    if (values.has(key)) {
      diagnostics.push(`RRULE field ${key} must appear at most once`);
      continue;
    }
    values.set(key, value);
  }
  return { values, diagnostics };
}

function integerList(
  values: Map<string, string>,
  key: string,
  min: number,
  max: number,
  diagnostics: string[],
): number[] | undefined {
  const value = values.get(key);
  if (value === undefined) {
    diagnostics.push(`RRULE is missing a fixed ${key}`);
    return undefined;
  }
  const parts = value.split(',').map((part) => part.trim());
  if (parts.length === 0 || parts.some((part) => !/^\d+$/.test(part))) {
    diagnostics.push(`RRULE ${key} must contain one or more integers`);
    return undefined;
  }
  const parsed = parts.map(Number);
  if (parsed.some((item) => !Number.isInteger(item) || item < min || item > max)) {
    diagnostics.push(`RRULE ${key} values must be between ${min} and ${max}`);
    return undefined;
  }
  return [...new Set(parsed)].sort((a, b) => a - b);
}

function isAbsoluteWorkdir(value: string): boolean {
  return path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value);
}

/** Convert the supported subset of RFC 5545 RRULE into Cindy's five-field cron. */
export function codexRruleToCron(rrule: string): CodexRruleConversion {
  const { values, diagnostics } = parseRrule(rrule);
  const frequency = values.get('FREQ')?.toUpperCase();
  if (!frequency) diagnostics.push('RRULE is missing FREQ');
  if (frequency && !['DAILY', 'WEEKLY', 'MONTHLY'].includes(frequency)) {
    diagnostics.push(`RRULE FREQ=${frequency} is not supported by Cindy cron`);
  }

  const interval = values.get('INTERVAL');
  if (interval !== undefined && interval !== '1') {
    diagnostics.push(
      `RRULE INTERVAL=${interval} cannot be represented exactly by Cindy cron; manual adjustment required`,
    );
  }

  const hours = integerList(values, 'BYHOUR', 0, 23, diagnostics);
  const minutes = integerList(values, 'BYMINUTE', 0, 59, diagnostics);

  const second = values.get('BYSECOND');
  if (second !== undefined && second !== '0') {
    diagnostics.push('RRULE BYSECOND must be 0 because Cindy cron has minute precision');
  }

  let dayOfMonth = '*';
  let dayOfWeek = '*';
  if (frequency === 'WEEKLY') {
    if (values.has('BYMONTHDAY')) {
      diagnostics.push(
        'RRULE WEEKLY cannot combine BYDAY with BYMONTHDAY for Cindy cron conversion',
      );
    }
    const byDay = values.get('BYDAY');
    if (!byDay) {
      diagnostics.push('RRULE WEEKLY is missing BYDAY');
    } else {
      const days = byDay.split(',').map((day) => day.trim().toUpperCase());
      if (days.some((day) => !WEEKDAY_TO_CRON[day])) {
        diagnostics.push('RRULE BYDAY must contain weekday names without ordinal prefixes');
      } else {
        dayOfWeek = days.map((day) => WEEKDAY_TO_CRON[day]).join(',');
      }
    }
  } else if (frequency === 'MONTHLY') {
    if (values.has('BYDAY')) {
      diagnostics.push(
        'RRULE MONTHLY BYDAY is not supported; use BYMONTHDAY for Cindy cron conversion',
      );
    }
    const monthDays = integerList(values, 'BYMONTHDAY', 1, 31, diagnostics);
    if (monthDays !== undefined) {
      // Cindy clamps monthly day 29/30/31 to short-month ends, while RFC 5545
      // BYMONTHDAY skips dates that do not exist in the current month. The
      // clamp applies only to Cindy's single-day monthly preset; day lists
      // use standard cron semantics and remain exact.
      if (monthDays.length === 1 && monthDays[0] > 28) {
        diagnostics.push(
          `RRULE MONTHLY BYMONTHDAY=${monthDays[0]} cannot be represented exactly; Cindy clamps short months`,
        );
      } else {
        dayOfMonth = monthDays.join(',');
      }
    }
  } else if (values.has('BYDAY') || values.has('BYMONTHDAY')) {
    diagnostics.push('RRULE BYDAY/BYMONTHDAY is not valid for DAILY cron conversion');
  }

  if (hours === undefined || minutes === undefined || diagnostics.length > 0) {
    return { diagnostics };
  }
  return {
    cronExpr: `${minutes.join(',')} ${hours.join(',')} ${dayOfMonth} * ${dayOfWeek}`,
    diagnostics,
  };
}

function statusForCodex(status: string, diagnostics: string[]): ScheduleStatus {
  switch (status.toUpperCase()) {
    case 'ACTIVE':
      return 'active';
    case 'PAUSED':
    case 'DISABLED':
    case 'INACTIVE':
      diagnostics.push(`Codex status ${status} will be imported as paused`);
      return 'paused';
    default:
      diagnostics.push(`Codex status ${status || '(empty)'} is not recognized`);
      return 'paused';
  }
}

export function convertCodexAutomation(
  detail: CodexAutomationDetail,
  options: CodexAutomationConversionOptions = {},
): CodexAutomationConversion {
  const diagnostics = [...detail.diagnostics];
  const blockingDiagnostics = [...detail.diagnostics];
  const status = statusForCodex(detail.status, diagnostics);
  if (!['ACTIVE', 'PAUSED', 'DISABLED', 'INACTIVE'].includes(detail.status.toUpperCase())) {
    blockingDiagnostics.push(`Codex status ${detail.status || '(empty)'} is not recognized`);
  }
  if (!detail.name.trim()) {
    const message = 'name must not be empty';
    diagnostics.push(message);
    blockingDiagnostics.push(message);
  }
  if (!detail.prompt.trim()) {
    const message = 'prompt must not be empty';
    diagnostics.push(message);
    blockingDiagnostics.push(message);
  }

  if (detail.executionEnvironment && detail.executionEnvironment.toLowerCase() !== 'local') {
    const message = `execution_environment=${detail.executionEnvironment} is not supported; only local automations can be imported`;
    diagnostics.push(message);
    blockingDiagnostics.push(message);
  }
  if (detail.cwds.length === 0) {
    const message = 'automation must have one absolute cwd';
    diagnostics.push(message);
    blockingDiagnostics.push(message);
  } else if (!isAbsoluteWorkdir(detail.cwds[0])) {
    const message = `cwd ${detail.cwds[0]} must be an absolute path`;
    diagnostics.push(message);
    blockingDiagnostics.push(message);
  }
  if (detail.cwds.length > 1) {
    const message = 'automation has multiple cwds; Cindy can import only the first cwd';
    diagnostics.push(message);
    blockingDiagnostics.push(message);
  }

  const recurrence = codexRruleToCron(detail.rrule);
  diagnostics.push(...recurrence.diagnostics);
  blockingDiagnostics.push(...recurrence.diagnostics);
  if (!recurrence.cronExpr || blockingDiagnostics.length > 0 || !detail.cwds[0]) {
    return { canImport: false, diagnostics, status };
  }

  const input: CreateScheduleInput = {
    name: detail.name,
    prompt: detail.prompt,
    kind: 'cron',
    cronExpr: recurrence.cronExpr,
    timezone: options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC',
    recurring: true,
    manual: false,
    agentKind: 'codex',
    model: detail.model,
    effort: detail.reasoningEffort,
    executionMode: 'agent',
    workspaceKind: 'project',
    workingDir: detail.cwds[0],
    useWorktree: false,
    notify: { desktop: true, feishu: false },
  };
  return { canImport: true, diagnostics, input, status };
}
