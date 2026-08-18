import type { ScheduleFireSource, ScheduleWorkspaceKind } from './types.js';

export const SESSION_TITLE_TEMPLATE_MAX_CODE_POINTS = 240;
export const SESSION_TITLE_MAX_CODE_POINTS = 120;

export type SessionTitleTemplateErrorCode =
  'too-long' | 'unclosed-token' | 'unexpected-brace' | 'unknown-token';

export interface SessionTitleTemplateError {
  code: SessionTitleTemplateErrorCode;
  index?: number;
  token?: string;
  message: string;
}

export type SessionTitleTemplateValidation =
  { valid: true; template?: string } | { valid: false; error: SessionTitleTemplateError };

export interface SessionTitleTemplateContext {
  scheduleName: string;
  timezone: string;
  scheduledFor: number;
  source: ScheduleFireSource;
  workspaceKind?: ScheduleWorkspaceKind;
  workingDir?: string;
  runId: string;
  locale?: string | string[];
}

type TemplatePart = { kind: 'text'; value: string } | { kind: 'token'; value: string };

export const SESSION_TITLE_TEMPLATE_TOKENS = [
  { token: '{scheduleName}', id: 'scheduleName' },
  { token: '{date}', id: 'date' },
  { token: '{date:yyyy-MM-dd}', id: 'dateIso' },
  { token: '{date:yyyyMMdd}', id: 'dateCompact' },
  { token: '{date:yyyy年MM月dd日}', id: 'dateCjkLong' },
  { token: '{date:MM-dd}', id: 'dateMonthDay' },
  { token: '{date:MM月dd日}', id: 'dateCjkMonthDay' },
  { token: '{time}', id: 'time' },
  { token: '{time:HH:mm}', id: 'timeColon' },
  { token: '{time:HHmm}', id: 'timeCompact' },
  { token: '{weekday}', id: 'weekday' },
  { token: '{isoWeek}', id: 'isoWeek' },
  { token: '{month}', id: 'month' },
  { token: '{quarter}', id: 'quarter' },
  { token: '{trigger}', id: 'trigger' },
  { token: '{projectName}', id: 'projectName' },
  { token: '{runId:short}', id: 'runIdShort' },
] as const;

const TOKENS: ReadonlySet<string> = new Set(
  SESSION_TITLE_TEMPLATE_TOKENS.map(({ token }) => token.slice(1, -1)),
);

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function parseSessionTitleTemplate(
  template: string,
): { valid: true; parts: TemplatePart[] } | { valid: false; error: SessionTitleTemplateError } {
  const parts: TemplatePart[] = [];
  let text = '';
  const flushText = () => {
    if (!text) return;
    parts.push({ kind: 'text', value: text });
    text = '';
  };

  for (let i = 0; i < template.length;) {
    if (template.startsWith('{{', i)) {
      text += '{';
      i += 2;
      continue;
    }
    if (template.startsWith('}}', i)) {
      text += '}';
      i += 2;
      continue;
    }
    if (template[i] === '}') {
      return {
        valid: false,
        error: {
          code: 'unexpected-brace',
          index: i,
          message: 'Unexpected closing brace',
        },
      };
    }
    if (template[i] !== '{') {
      text += template[i];
      i += 1;
      continue;
    }

    const end = template.indexOf('}', i + 1);
    if (end < 0) {
      return {
        valid: false,
        error: {
          code: 'unclosed-token',
          index: i,
          message: 'Unclosed template token',
        },
      };
    }
    const token = template.slice(i + 1, end);
    if (token.includes('{') || !TOKENS.has(token)) {
      return {
        valid: false,
        error: {
          code: 'unknown-token',
          index: i,
          token,
          message: `Unknown template token: {${token}}`,
        },
      };
    }
    flushText();
    parts.push({ kind: 'token', value: token });
    i = end + 1;
  }
  flushText();
  return { valid: true, parts };
}

export function validateSessionTitleTemplate(
  value: string | null | undefined,
): SessionTitleTemplateValidation {
  const template = value?.trim();
  if (!template) return { valid: true, template: undefined };
  if (codePointLength(template) > SESSION_TITLE_TEMPLATE_MAX_CODE_POINTS) {
    return {
      valid: false,
      error: {
        code: 'too-long',
        message: `Session title template must be at most ${SESSION_TITLE_TEMPLATE_MAX_CODE_POINTS} characters`,
      },
    };
  }
  const parsed = parseSessionTitleTemplate(template);
  if (!parsed.valid) return parsed;
  return { valid: true, template };
}

function dateParts(timestamp: number, timezone: string): Record<string, string> {
  const parts = new Intl.DateTimeFormat('en-US-u-nu-latn', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(timestamp));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  if (values.hour === '24') values.hour = '00';
  return values;
}

function formatDateToken(token: string, values: Record<string, string>): string {
  const format = token === 'date' ? 'yyyy-MM-dd' : token.slice('date:'.length);
  return format
    .replaceAll('yyyy', values.year)
    .replaceAll('MM', values.month)
    .replaceAll('dd', values.day);
}

function formatTimeToken(token: string, values: Record<string, string>): string {
  const format = token === 'time' ? 'HH:mm' : token.slice('time:'.length);
  return format.replaceAll('HH', values.hour).replaceAll('mm', values.minute);
}

function isoWeek(year: number, month: number, day: number): string {
  const date = new Date(Date.UTC(year, month - 1, day));
  const weekday = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - weekday);
  const weekYear = date.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(weekYear, 0, 4));
  const firstWeekday = firstThursday.getUTCDay() || 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() + 4 - firstWeekday);
  const week = 1 + Math.round((date.getTime() - firstThursday.getTime()) / 604_800_000);
  return `${weekYear}-W${String(week).padStart(2, '0')}`;
}

export function sessionTitleProjectName(
  workspaceKind: ScheduleWorkspaceKind | undefined,
  workingDir: string | undefined,
): string {
  if (workspaceKind === 'dialogue') return 'dialogue';
  const normalized = (workingDir ?? '').replace(/[\\/]+$/, '');
  return normalized.split(/[\\/]/).filter(Boolean).at(-1) ?? '';
}

function renderToken(
  token: string,
  context: SessionTitleTemplateContext,
  values: Record<string, string>,
): string {
  if (token === 'scheduleName') return context.scheduleName;
  if (token === 'date' || token.startsWith('date:')) return formatDateToken(token, values);
  if (token === 'time' || token.startsWith('time:')) return formatTimeToken(token, values);
  if (token === 'weekday') {
    return new Intl.DateTimeFormat(context.locale, {
      timeZone: context.timezone,
      weekday: 'short',
    }).format(new Date(context.scheduledFor));
  }
  if (token === 'isoWeek') {
    return isoWeek(Number(values.year), Number(values.month), Number(values.day));
  }
  if (token === 'month') return `${values.year}-${values.month}`;
  if (token === 'quarter')
    return `${values.year}-Q${Math.floor((Number(values.month) - 1) / 3) + 1}`;
  if (token === 'trigger') return context.source === 'run-now' ? 'manual' : 'scheduled';
  if (token === 'projectName') {
    return sessionTitleProjectName(context.workspaceKind, context.workingDir);
  }
  if (token === 'runId:short') return Array.from(context.runId).slice(0, 8).join('');
  throw new Error(`Unknown template token: {${token}}`);
}

export function renderSessionTitleTemplate(
  value: string,
  context: SessionTitleTemplateContext,
): string {
  const validation = validateSessionTitleTemplate(value);
  if (!validation.valid) throw new Error(validation.error.message);
  if (!validation.template) return '';
  const parsed = parseSessionTitleTemplate(validation.template);
  if (!parsed.valid) throw new Error(parsed.error.message);
  const values = dateParts(context.scheduledFor, context.timezone);
  const rendered = parsed.parts
    .map((part) => (part.kind === 'text' ? part.value : renderToken(part.value, context, values)))
    .join('')
    .trim();
  const codePoints = Array.from(rendered);
  return codePoints.length > SESSION_TITLE_MAX_CODE_POINTS
    ? `${codePoints.slice(0, SESSION_TITLE_MAX_CODE_POINTS - 1).join('')}…`
    : rendered;
}
