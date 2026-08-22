/**
 * Automation form model — the pure half of the Bot Automation tab.
 *
 * The tab is list-first: existing routines read like a system cron list, and
 * creating one only asks two things ("what" + "when"). Everything the engine
 * also needs (project, delivery, run limits, notes space, time zone) has a
 * working default here, so a routine can be created without opening Advanced.
 *
 * Keeping the schedule/name/namespace derivation in this module (instead of
 * inline in the component) is what makes those defaults testable: the IPC
 * payload shape is unchanged from the previous form, only the UI that fills it.
 */

import {
  DEFAULT_BOT_AUTOMATION_EXECUTION_POLICY,
  normalizeBotDurableNoteNamespace,
  type BotAutomation,
  type BotAutomationExecutionPolicy,
} from '../../../shared/botAutomation';

export type ScheduleMode = 'manual' | 'daily' | 'interval' | 'cron';

export const SCHEDULE_MODES: readonly ScheduleMode[] = ['manual', 'daily', 'interval', 'cron'];

/** Name suggestions stay short enough to read as a list row label. */
export const AUTOMATION_NAME_SUGGESTION_MAX_CHARS = 20;

const DEFAULT_DAILY_TIME = '09:00';
const DEFAULT_INTERVAL_MINUTES = 60;
const DEFAULT_CRON_EXPR = '0 9 * * *';
/** Cron kept on the record while a routine is manual-only or interval-driven. */
const MANUAL_PLACEHOLDER_CRON = '0 0 * * *';
const INTERVAL_PLACEHOLDER_CRON = '0 * * * *';

export interface AutomationPolicyDraft {
  timeoutMinutes: number;
  budgetTokens: string;
  maxDelegationDepth: number;
  delegateTargetMode: BotAutomationExecutionPolicy['delegateTargetMode'];
  allowedDelegateBotIds: string[];
}

export interface AutomationFormValue {
  name: string;
  prompt: string;
  mode: ScheduleMode;
  dailyTime: string;
  intervalMinutes: number;
  cronExpr: string;
  timezone: string;
  projectBindingId: string;
  targetRouteId: string;
  /** Empty means "derive a slug from the name" — see `automationSubmission`. */
  durableNoteNamespace: string;
  policy: AutomationPolicyDraft;
}

/** Cadence + settings payload shared by the create and update IPC calls. */
export interface AutomationSubmission {
  name: string;
  prompt: string;
  timezone: string;
  cronExpr: string;
  recurring: boolean;
  manual: boolean;
  intervalMs: number | undefined;
  projectBindingId: string | null;
  targetRouteId: string | null;
  durableNoteNamespace: string | null;
  executionPolicy: BotAutomationExecutionPolicy;
}

export interface ScheduleDescription {
  key: string;
  params?: Record<string, string | number>;
}

export function localTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

export function policyDraft(policy: BotAutomationExecutionPolicy): AutomationPolicyDraft {
  return {
    timeoutMinutes: Math.max(1, Math.round(policy.timeoutMs / 60_000)),
    budgetTokens: policy.budgetTokens === null ? '' : String(policy.budgetTokens),
    maxDelegationDepth: policy.maxDelegationDepth,
    delegateTargetMode: policy.delegateTargetMode,
    allowedDelegateBotIds: policy.allowedDelegateBotIds,
  };
}

export function executionPolicyFromDraft(
  draft: AutomationPolicyDraft,
): BotAutomationExecutionPolicy {
  const parsedBudget = Number(draft.budgetTokens);
  return {
    timeoutMs: Math.max(1, Math.floor(draft.timeoutMinutes)) * 60_000,
    budgetTokens:
      draft.budgetTokens.trim() && Number.isSafeInteger(parsedBudget) && parsedBudget > 0
        ? parsedBudget
        : null,
    maxDelegationDepth: Math.max(1, Math.min(5, Math.floor(draft.maxDelegationDepth))),
    delegateTargetMode: draft.delegateTargetMode,
    allowedDelegateBotIds:
      draft.delegateTargetMode === 'allowlist' ? draft.allowedDelegateBotIds : [],
  };
}

export function scheduleModeForAutomation(automation: BotAutomation): ScheduleMode {
  if (automation.manual) return 'manual';
  if (automation.intervalMs) return 'interval';
  return /^\d{1,2} \d{1,2} \* \* \*$/.test(automation.cronExpr) ? 'daily' : 'cron';
}

export function dailyTimeForAutomation(automation: BotAutomation): string {
  const match = /^(\d{1,2}) (\d{1,2}) \* \* \*$/.exec(automation.cronExpr);
  if (!match) return DEFAULT_DAILY_TIME;
  return `${match[2]!.padStart(2, '0')}:${match[1]!.padStart(2, '0')}`;
}

/**
 * Plain-language schedule line for a list row ("Every day at 09:00"), returned
 * as an i18n key + params so the caller owns the wording.
 */
export function describeAutomationSchedule(automation: BotAutomation): ScheduleDescription {
  const mode = scheduleModeForAutomation(automation);
  if (mode === 'manual') return { key: 'bots.automations.scheduleSummary.manual' };
  if (mode === 'interval') {
    return {
      key: 'bots.automations.scheduleSummary.interval',
      params: { count: Math.max(1, Math.round((automation.intervalMs ?? 60_000) / 60_000)) },
    };
  }
  if (mode === 'daily') {
    return {
      key: 'bots.automations.scheduleSummary.daily',
      params: { time: dailyTimeForAutomation(automation) },
    };
  }
  return {
    key: 'bots.automations.scheduleSummary.cron',
    params: { expr: automation.cronExpr },
  };
}

/** First line of the instruction, clipped to a row-sized label. */
export function suggestAutomationName(prompt: string): string {
  const firstLine = prompt
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? '';
  const collapsed = firstLine.replace(/\s+/g, ' ');
  const graphemes = [...collapsed];
  if (graphemes.length <= AUTOMATION_NAME_SUGGESTION_MAX_CHARS) return collapsed;
  return `${graphemes.slice(0, AUTOMATION_NAME_SUGGESTION_MAX_CHARS).join('').trimEnd()}…`;
}

/**
 * Slug used when the user never opens Advanced: each routine gets its own notes
 * scope derived from its name, instead of the old misleading `daily-report`
 * placeholder that suggested a value was required.
 */
export function defaultDurableNoteNamespace(source: string): string | null {
  const slug = [...source.trim().toLowerCase()]
    .map((char) => (/[\p{L}\p{N}]/u.test(char) ? char : '-'))
    .join('')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 128);
  return normalizeBotDurableNoteNamespace(slug);
}

export function emptyAutomationFormValue(
  overrides: Partial<AutomationFormValue> = {},
): AutomationFormValue {
  return {
    name: '',
    prompt: '',
    mode: 'daily',
    dailyTime: DEFAULT_DAILY_TIME,
    intervalMinutes: DEFAULT_INTERVAL_MINUTES,
    cronExpr: DEFAULT_CRON_EXPR,
    timezone: localTimezone(),
    projectBindingId: '',
    targetRouteId: '',
    durableNoteNamespace: '',
    policy: policyDraft(DEFAULT_BOT_AUTOMATION_EXECUTION_POLICY),
    ...overrides,
  };
}

export function automationFormValueFrom(automation: BotAutomation): AutomationFormValue {
  return {
    name: automation.name,
    prompt: automation.prompt,
    mode: scheduleModeForAutomation(automation),
    dailyTime: dailyTimeForAutomation(automation),
    intervalMinutes: Math.max(1, Math.round((automation.intervalMs ?? 60 * 60_000) / 60_000)),
    cronExpr: automation.cronExpr || DEFAULT_CRON_EXPR,
    timezone: automation.timezone,
    projectBindingId: automation.projectBindingId ?? '',
    targetRouteId: automation.targetRouteId ?? '',
    durableNoteNamespace: automation.durableNoteNamespace ?? '',
    policy: policyDraft(automation.executionPolicy),
  };
}

/** The instruction is the only required field; everything else has a default. */
export function canSubmitAutomationForm(value: AutomationFormValue): boolean {
  return value.prompt.trim().length > 0;
}

/**
 * Build the IPC payload. `fallbackCronExpr` keeps whatever cron a record
 * already carries while it is manual-only or interval-driven, matching the
 * previous form's behaviour.
 */
export function automationSubmission(
  value: AutomationFormValue,
  options: { fallbackCronExpr?: string } = {},
): AutomationSubmission | null {
  const prompt = value.prompt.trim();
  if (!prompt) return null;
  const name = value.name.trim() || suggestAutomationName(prompt);

  let cronExpr: string;
  let recurring: boolean;
  let manual: boolean;
  let intervalMs: number | undefined;
  if (value.mode === 'manual') {
    cronExpr = options.fallbackCronExpr || MANUAL_PLACEHOLDER_CRON;
    recurring = false;
    manual = true;
    intervalMs = undefined;
  } else if (value.mode === 'daily') {
    const [hour, minute] = value.dailyTime.split(':').map(Number);
    cronExpr = `${minute || 0} ${hour || 0} * * *`;
    recurring = true;
    manual = false;
    intervalMs = undefined;
  } else if (value.mode === 'interval') {
    cronExpr = options.fallbackCronExpr || INTERVAL_PLACEHOLDER_CRON;
    recurring = true;
    manual = false;
    intervalMs = Math.max(1, Math.floor(value.intervalMinutes || 1)) * 60_000;
  } else {
    cronExpr = value.cronExpr.trim() || DEFAULT_CRON_EXPR;
    recurring = true;
    manual = false;
    intervalMs = undefined;
  }

  return {
    name,
    prompt,
    timezone: value.timezone.trim() || 'UTC',
    cronExpr,
    recurring,
    manual,
    intervalMs,
    projectBindingId: value.projectBindingId || null,
    targetRouteId: value.targetRouteId || null,
    durableNoteNamespace:
      normalizeBotDurableNoteNamespace(value.durableNoteNamespace)
      ?? defaultDurableNoteNamespace(name),
    executionPolicy: executionPolicyFromDraft(value.policy),
  };
}

export interface AutomationTemplate {
  id: string;
  /** i18n key suffixes under `bots.automations.templates.<id>`. */
  value: Partial<AutomationFormValue>;
}

/**
 * Empty-state examples. Each one covers a different cadence so the segmented
 * control is self-explanatory after a single click.
 */
export const AUTOMATION_TEMPLATES: readonly AutomationTemplate[] = [
  { id: 'dailyDigest', value: { mode: 'daily', dailyTime: '09:00' } },
  { id: 'inboxTriage', value: { mode: 'interval', intervalMinutes: 60 } },
  { id: 'weeklyReport', value: { mode: 'cron', cronExpr: '0 17 * * 5' } },
];
