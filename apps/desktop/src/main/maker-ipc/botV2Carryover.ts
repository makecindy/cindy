/**
 * V1 → V2 upgrade, the parts that decide what is carried over (pure, no I/O).
 *
 * - A routine becomes an ordinary project automation in the teammate's project, with the same
 *   schedule, check script, quiet-when-idle and model, and the same paused / running state.
 * - Unfinished V1-only state (open todos, unfinished workbench items, the working ledger) is
 *   written once into one project document. Finished and deleted items are not carried: they stay
 *   in the archived V1 files.
 */
import type { Routine } from '@cindy/maker-scheduler';

import type { BotModelRoute } from '../../shared/botModelChain.js';
import type { ProjectScheduleConfig } from '../scheduler-host/project-automation-loader.js';

export const BOT_V2_CARRYOVER_FILE = 'CARRYOVER.md';

export interface MigratedAutomation {
  config: ProjectScheduleConfig;
  /** false: created paused (the routine was paused, or it lost a check it relied on). */
  enabled: boolean;
}

export interface RoutineConversion {
  automations: MigratedAutomation[];
  /** Set when part of the routine could not become an automation; listed in the carryover file. */
  note: string | null;
}

/**
 * The cron an interval automation also stores (shown if the owner switches it to a schedule):
 * the same rhythm where a five-field cron has it, hourly otherwise. The interval decides runs.
 */
function intervalCron(intervalMs: number): string {
  const minutes = intervalMs / 60_000;
  if (Number.isInteger(minutes) && minutes > 0 && minutes < 60 && 60 % minutes === 0) return `*/${minutes} * * * *`;
  const hours = minutes / 60;
  if (Number.isInteger(hours) && hours > 0 && hours < 24 && 24 % hours === 0) return `0 */${hours} * * *`;
  return '0 * * * *';
}

function localParts(at: number, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23',
  }).formatToParts(new Date(at));
  const get = (type: string) => parts.find((part) => part.type === type)?.value;
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday') ?? '');
  return { minute: Number(get('minute')), hour: Number(get('hour')), weekday };
}

/**
 * The V1 interval as a cron on the same beat: V1 ran every N from a fixed point (its anchor, or the
 * time it was due next), while an interval automation counts from when the previous run finished.
 * `at` is any time on that beat; without one the phase is unknown and only sub-day steps are kept.
 * null: a cron cannot express this interval exactly.
 */
function beatCron(intervalMs: number, at: number | undefined, timezone: string): string | null {
  const minutes = intervalMs / 60_000;
  if (!Number.isInteger(minutes) || minutes <= 0) return null;
  const local = at === undefined ? null : localParts(at, timezone);
  if (local && (!Number.isInteger(local.minute) || !Number.isInteger(local.hour))) return null;
  const steps = (period: number, step: number, phase: number) =>
    Array.from({ length: period / step }, (_, index) => phase + index * step).join(',');
  if (minutes < 60) return 60 % minutes === 0 ? `${steps(60, minutes, (local?.minute ?? 0) % minutes)} * * * *` : null;
  const hours = minutes / 60;
  if (!Number.isInteger(hours)) return null;
  const minute = local?.minute ?? 0;
  if (hours < 24) {
    if (24 % hours !== 0) return null;
    return `${minute} ${hours === 1 ? '*' : steps(24, hours, (local?.hour ?? 0) % hours)} * * *`;
  }
  if (!local) return null;
  if (hours === 24) return `${minute} ${local.hour} * * *`;
  if (hours === 168 && local.weekday >= 0) return `${minute} ${local.hour} * * ${local.weekday}`;
  return null;
}

function onceCron(at: number, timezone: string): string | null {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hourCycle: 'h23',
  }).formatToParts(new Date(at));
  const get = (type: string) => parts.find((part) => part.type === type)?.value;
  const [minute, hour, day, month] = [get('minute'), get('hour'), get('day'), get('month')];
  return minute && hour && day && month ? `${Number(minute)} ${Number(hour)} ${day} ${month} *` : null;
}

/**
 * The model an automation runs, including where it runs. A model on another computer needs its
 * provider to be named there; without one it cannot be kept (null), never silently run here.
 */
export function automationModelFields(choice: {
  agentKind: 'claude-code' | 'codex' | 'pi'; model: string; providerId?: string | null;
  effort?: string | null; fastMode?: boolean | 'ultrafast'; agentDeviceId?: string | null;
}): Partial<ProjectScheduleConfig> | null {
  const fields: Partial<ProjectScheduleConfig> = {
    agentKind: choice.agentKind,
    model: choice.model,
    ...(choice.providerId ? { providerId: choice.providerId } : {}),
    ...(choice.effort ? { effort: choice.effort } : {}),
    ...(choice.fastMode !== undefined ? { fastMode: choice.fastMode } : {}),
  };
  if (!choice.agentDeviceId) return fields;
  if (!choice.providerId) return null;
  // New runs start there (agentDeviceId); the automation's own task keeps running there too.
  return { ...fields, agentDeviceId: choice.agentDeviceId,
    modelAgentKind: choice.agentKind, modelAgentDeviceId: choice.agentDeviceId };
}

/** The teammate's model route as an automation model (null: a remote route that cannot be kept). */
export function routeModelFields(route: BotModelRoute): Partial<ProjectScheduleConfig> | null {
  return automationModelFields({
    agentKind: route.harness === 'claude' ? 'claude-code' : route.harness,
    model: route.model, providerId: route.providerId, effort: route.effort,
    fastMode: route.fastMode, agentDeviceId: route.agentDeviceId,
  });
}

function modelFields(routine: Routine, route: BotModelRoute | null): Partial<ProjectScheduleConfig> | null {
  const chosen = routine.modelOverride;
  if (chosen?.model) return automationModelFields(chosen);
  // A routine without its own model ran on the teammate's model; the automation keeps that.
  return route ? routeModelFields(route) : {};
}

/** Project automation ids are kebab-case ASCII; keep them stable so a rerun updates, not duplicates. */
export function migratedAutomationId(routineId: string, index: number): string {
  const base = `routine-${routineId.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 12) || 'x'}`;
  return index === 0 ? base : `${base}-${index + 1}`;
}

export function convertRoutine(
  routine: Routine,
  route: BotModelRoute | null,
  options: { now: number; timezone: string; next?: Record<string, number> },
): RoutineConversion {
  const skipped: string[] = [];
  const schedules: Array<{ cronExpr: string; timezone: string; recurring: boolean; intervalMs?: number }> = [];
  const ran: string[] = [];
  const drifted: string[] = [];
  for (const trigger of routine.triggers) {
    if (trigger.kind === 'cron') {
      schedules.push({ cronExpr: trigger.expression, timezone: trigger.timezone || options.timezone, recurring: true });
    } else if (trigger.kind === 'interval') {
      // On the same beat when a cron can say it (V1 counted from a fixed point; review on PR #9314).
      const at = options.next?.[`${routine.id}:${trigger.id}`] ?? trigger.anchorMs;
      const beat = Number.isFinite(trigger.intervalMs) ? beatCron(trigger.intervalMs, at, options.timezone) : null;
      if (beat) schedules.push({ cronExpr: beat, timezone: options.timezone, recurring: true });
      else if (Number.isFinite(trigger.intervalMs) && trigger.intervalMs >= 60_000) {
        // Same rate, counted from the end of the previous run: said in the note.
        schedules.push({ cronExpr: intervalCron(trigger.intervalMs), timezone: options.timezone, recurring: true, intervalMs: trigger.intervalMs });
        drifted.push(`every ${Math.round(trigger.intervalMs / 60_000)} min`);
      } else skipped.push(`every ${Math.round(trigger.intervalMs / 1000)} s`);
    } else if (trigger.kind === 'once') {
      const cronExpr = trigger.at > options.now ? onceCron(trigger.at, options.timezone) : null;
      if (cronExpr) schedules.push({ cronExpr, timezone: options.timezone, recurring: false });
      else if (trigger.at > options.now) skipped.push(`once at ${new Date(trigger.at).toISOString()}`);
      // A one-off time already in the past has nothing left to run; it is still listed.
      else ran.push(`once at ${new Date(trigger.at).toISOString()}`);
    } else {
      skipped.push(`event ${trigger.sourceId}/${trigger.eventType}`);
    }
  }
  // A plugin check decided when this ran; without it the automation would run more often, so it
  // waits paused for the owner instead of starting on its own.
  const lostCheck = !!routine.preRunPlugin;
  const model = modelFields(routine, route);
  const lostModel = model === null;
  const shared: Omit<ProjectScheduleConfig, 'id' | 'cronExpr' | 'timezone' | 'recurring'> = {
    name: routine.name,
    prompt: routine.prompt,
    persistentSession: routine.sessionMode !== 'fresh',
    // Legacy routines without the flag stayed silent; keep that.
    silentWhenIdle: routine.silentWhenIdle ?? true,
    ...(routine.preRunHook?.command
      ? { preRunHook: { command: routine.preRunHook.command, ...(routine.preRunHook.timeoutMs ? { timeoutMs: routine.preRunHook.timeoutMs } : {}) } }
      : {}),
    ...(model ?? {}),
  };
  const automations = schedules.map((schedule, index) => ({
    config: { id: migratedAutomationId(routine.id, index), ...shared, ...schedule },
    // Any part of it that cannot come along (a trigger, its plugin check, its model, its chat
    // destination) makes it a different job: it waits paused for the owner instead.
    enabled: routine.enabled && !lostCheck && !lostModel && skipped.length === 0 && routine.delivery?.kind !== 'im',
  }));
  // A draft without triggers, or triggers that cannot be carried: nothing can start it on its own
  // any more, so it is kept as a manual automation, paused. A finished one-off is not recreated.
  const draft = routine.triggers.length === 0;
  if (automations.length === 0 && (skipped.length > 0 || draft)) {
    automations.push({
      config: {
        id: migratedAutomationId(routine.id, 0), ...shared,
        cronExpr: '0 9 * * *', timezone: options.timezone, recurring: true, manual: true,
      },
      enabled: false,
    });
  }
  const reasons = [
    ...(skipped.length > 0 ? [`trigger not carried: ${skipped.join(', ')}, created paused`] : []),
    ...(draft ? ['it had no trigger; kept as a manual automation, paused'] : []),
    ...(drifted.length ? [`${drifted.join(', ')} now counts from the end of the previous run, not a fixed beat`] : []),
    ...(automations.length === 0 && ran.length > 0 ? [`its one-off run (${ran.join(', ')}) is past; not recreated, its definition is in v1-archive/routines.json`] : []),
    ...(lostCheck ? ['plugin check not carried, created paused'] : []),
    // Running it here on another model would not be the same job: it waits for the owner.
    ...(lostModel ? ['its model on another computer could not be carried, created paused'] : []),
    // Results now stay in the automation's own task; a chat destination needs setting up again.
    ...(routine.delivery?.kind === 'im' ? [`results were sent to a chat (${routine.delivery.targetId}); they now stay in the automation's task, created paused`] : []),
  ];
  return { automations, note: reasons.length > 0 ? `${routine.name}: ${reasons.join('; ')}` : null };
}

// ── Carryover document ───────────────────────────────────────────────────────────────────

interface LegacyTodo {
  title?: unknown; status?: unknown; progress?: unknown; next?: unknown; createdAt?: unknown;
  decision?: unknown;
}

interface LegacyWorkbenchTask { title?: unknown; verdict?: unknown; next?: unknown; ref?: unknown }

interface LegacyLedgerItem { text?: unknown; status?: unknown; next?: unknown; trigger?: unknown; on?: unknown }

export interface CarryoverInput {
  todos?: { items?: LegacyTodo[] } | null;
  workbench?: { tasks?: Record<string, LegacyWorkbenchTask> } | null;
  workingMemory?: {
    threads?: LegacyLedgerItem[]; commitments?: LegacyLedgerItem[];
    waiting?: LegacyLedgerItem[]; corrections?: LegacyLedgerItem[];
  } | null;
  routineNotes?: string[];
  /** What the upgrade could not bring over itself (unreadable files, Skill links leading outside). */
  upgradeNotes?: string[];
}

export type CarryoverLabel =
  | 'title' | 'intro' | 'todos' | 'work' | 'threads' | 'commitments' | 'waiting' | 'corrections' | 'routines' | 'upgrade';

// Carried in full: a shortened item could lose the part that matters (and two items that only
// differ at the end would merge).
const text = (value: unknown): string =>
  typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';

const day = (value: unknown): string => {
  const ms = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : '';
};

function line(title: string, detail: string, date = ''): string {
  return `- ${date ? `${date} · ` : ''}${title}${detail && detail !== title ? ` — ${detail}` : ''}`;
}

/** Returns null when there is nothing unfinished to carry. */
export function buildCarryover(input: CarryoverInput, label: (key: CarryoverLabel) => string): string | null {
  const sections: Array<[CarryoverLabel, string[]]> = [];
  const todos = (input.todos?.items ?? [])
    .filter((item) => item.status === 'open')
    // Deleted by the owner but never closed: not carried.
    .filter((item) => !(item.decision && typeof item.decision === 'object' && (item.decision as { kind?: unknown }).kind === 'deleted'))
    .sort((a, b) => day(b.createdAt).localeCompare(day(a.createdAt)))
    .map((item) => {
      const next = item.next && typeof item.next === 'object' ? text((item.next as { label?: unknown }).label) : '';
      return line(text(item.title), next || text(item.progress), day(item.createdAt));
    })
    .filter((row) => row !== '- ');
  sections.push(['todos', todos]);
  const work = Object.values(input.workbench?.tasks ?? {})
    .filter((task) => task.verdict !== 'done')
    .map((task) => {
      const ref = text(task.ref);
      return line(text(task.title), [text(task.next), ref].filter(Boolean).join(' '));
    });
  sections.push(['work', work]);
  const ledger = input.workingMemory ?? {};
  sections.push(['threads', (ledger.threads ?? []).filter((item) => item.status !== 'done')
    .map((item) => line(text(item.text), text(item.next)))]);
  sections.push(['commitments', (ledger.commitments ?? []).map((item) => line(text(item.text), text(item.trigger)))]);
  sections.push(['waiting', (ledger.waiting ?? []).map((item) => line(text(item.text), ''))]);
  sections.push(['corrections', (ledger.corrections ?? []).map((item) => line(text(item.text), ''))]);
  sections.push(['routines', (input.routineNotes ?? []).map((note) => `- ${note}`)]);
  sections.push(['upgrade', (input.upgradeNotes ?? []).map((note) => `- ${note}`)]);
  const filled = sections
    .map(([key, rows]) => [key, [...new Set(rows.filter((row) => row.length > 2))]] as const)
    .filter(([, rows]) => rows.length > 0);
  if (filled.length === 0) return null;
  return [
    `# ${label('title')}`, '', label('intro'), '',
    ...filled.flatMap(([key, rows]) => [`## ${label(key)}`, '', ...rows, '']),
  ].join('\n');
}

/**
 * The part of `content` (a carryover document) that `current` does not have yet: its items not
 * already there, under their headings. null when nothing is missing.
 */
export function missingCarryover(content: string, current: string): string | null {
  const have = new Set(current.split('\n').map((row) => row.trim()).filter((row) => row.startsWith('- ')));
  const lines = content.split('\n');
  const out: string[] = [];
  let heading: string[] = [];
  let added = false;
  for (const row of lines) {
    if (row.startsWith('#')) { heading = [row, '']; continue; }
    if (!row.startsWith('- ') || have.has(row.trim())) continue;
    if (heading.length) { out.push(...(out.length ? [''] : []), ...heading); heading = []; }
    out.push(row);
    added = true;
  }
  return added ? `${out.join('\n')}\n` : null;
}

/** One line in the project rules so every task in the project can find the carried items. */
export function carryoverPointer(): string {
  return `- Unfinished items carried over from before the upgrade are in \`${BOT_V2_CARRYOVER_FILE}\`. Work through them when relevant and remove what is done.`;
}
