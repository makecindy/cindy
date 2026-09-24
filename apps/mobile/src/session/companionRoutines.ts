import type { RemoteResource } from '@cindy/device-link';

export function getRoutineActionId(resource: RemoteResource | null, operation: string): string | null {
  const block = resource?.blocks?.find((item) => item.primitive === 'routine-list' || item.primitive === 'routine-detail');
  const id = record(record(block?.data)?.operationActions)?.[operation];
  return bounded(id, 512) && id.length > 0 && resource?.actions?.some((action) => action.id === id && !action.disabled) ? id : null;
}

export type RoutineTrigger =
  | { id: string; kind: 'cron'; expression: string; timezone: string }
  | { id: string; kind: 'interval'; intervalMs: number }
  | { id: string; kind: 'event'; sourceId: string; eventType: string; filters: { field: string; operator: 'equals' | 'contains' | 'not-equals'; value: string }[] };
export interface RoutineDefinition { name: string; prompt: string; enabled: boolean; triggers: RoutineTrigger[]; silentWhenIdle?: boolean; preRunHook?: { command: string; timeoutMs?: number } | null }
export interface RoutineSummary { id: string; name: string; enabled: boolean; revision: number; activity?: 'queued' | 'running'; triggers: Array<Record<string, unknown>> }
export interface RoutineDetail {
  supportsPreRunCheck?: boolean;
  id: string | null; revision: number; editable: boolean; input: RoutineDefinition | null;
  sources: { id: string; name: string; status: string; events: { type: string; name: string; fields: string[] }[] }[];
  history: { id: string; status: string; createdAt: number; finishedAt?: number; resultText?: string; error?: string }[];
}
function record(raw: unknown): Record<string, unknown> | null { return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null; }
function bounded(raw: unknown, max = 200): raw is string { return typeof raw === 'string' && raw.length <= max; }
export function parseRoutineDefinition(raw: unknown): RoutineDefinition | null {
  const v = record(raw);
  if (!v || !bounded(v.name) || !bounded(v.prompt, 45_000) || typeof v.enabled !== 'boolean' || !Array.isArray(v.triggers) || v.triggers.length > 32) return null;
  const triggers: RoutineTrigger[] = [];
  for (const rawTrigger of v.triggers) {
    const r = record(rawTrigger);
    if (!r || !bounded(r.id, 128)) return null;
    if (r.kind === 'cron' && bounded(r.expression, 128) && bounded(r.timezone, 128)) triggers.push({ id: r.id, kind: 'cron', expression: r.expression, timezone: r.timezone });
    else if (r.kind === 'interval' && Number.isSafeInteger(r.intervalMs) && Number(r.intervalMs) >= 60_000) triggers.push({ id: r.id, kind: 'interval', intervalMs: Number(r.intervalMs) });
    else if (r.kind === 'event' && bounded(r.sourceId) && bounded(r.eventType) && Array.isArray(r.filters) && r.filters.length <= 16) {
      const filters: Extract<RoutineTrigger, { kind: 'event' }>['filters'] = [];
      for (const rawFilter of r.filters) {
        const f = record(rawFilter);
        if (!f || !bounded(f.field, 128) || !bounded(f.value, 2000) || !['equals', 'contains', 'not-equals'].includes(String(f.operator))) return null;
        filters.push({ field: f.field, value: f.value, operator: f.operator as typeof filters[number]['operator'] });
      }
      triggers.push({ id: r.id, kind: 'event', sourceId: r.sourceId, eventType: r.eventType, filters });
    } else return null;
  }
  if (v.silentWhenIdle !== undefined && typeof v.silentWhenIdle !== 'boolean') return null;
  let preRunHook: RoutineDefinition['preRunHook'];
  if (v.preRunHook === null) preRunHook = null;
  else if (v.preRunHook !== undefined) {
    const hook = record(v.preRunHook);
    if (!hook || !bounded(hook.command, 32000) || !hook.command.trim()
      || (hook.timeoutMs !== undefined && (!Number.isSafeInteger(hook.timeoutMs) || Number(hook.timeoutMs) <= 0))) return null;
    preRunHook = { command: hook.command, ...(hook.timeoutMs === undefined ? {} : { timeoutMs: Number(hook.timeoutMs) }) };
  }
  return { name: v.name, prompt: v.prompt, enabled: v.enabled, triggers,
    ...(v.silentWhenIdle === undefined ? {} : { silentWhenIdle: v.silentWhenIdle as boolean }),
    ...(preRunHook === undefined ? {} : { preRunHook }) };
}
export function parseRoutineSummaries(raw: unknown): RoutineSummary[] {
  const items = record(raw)?.items;
  if (!Array.isArray(items)) throw new Error('Invalid automation list');
  return items.slice(0, 100).map((raw) => {
    const r = record(raw);
    if (!r || !bounded(r.id, 128) || !bounded(r.name) || typeof r.enabled !== 'boolean' || !Number.isSafeInteger(r.revision) || !Array.isArray(r.triggers)) throw new Error('Invalid automation');
    return { id: r.id, name: r.name, enabled: r.enabled, revision: Number(r.revision),
      ...(r.activity === 'queued' || r.activity === 'running' ? { activity: r.activity } : {}),
      triggers: r.triggers.slice(0, 32).map((value) => record(value) ?? {}) };
  });
}
export function parseRoutineDetail(raw: unknown): RoutineDetail {
  const r = record(raw);
  if (!r || (r.id !== null && !bounded(r.id, 128)) || !Number.isSafeInteger(r.revision) || typeof r.editable !== 'boolean' || !Array.isArray(r.sources) || !Array.isArray(r.history)) throw new Error('Invalid automation detail');
  const input = r.input === null ? null : parseRoutineDefinition(r.input);
  if (r.input !== null && input === null) throw new Error('Unsupported automation definition');
  return { supportsPreRunCheck: r.supportsPreRunCheck === true, id: r.id as string | null, revision: Number(r.revision), editable: r.editable,
    // Older saved routines were quiet when this field was absent. Keep their
    // visible choice while blank new forms continue to start with false.
    input: input && r.id !== null && r.supportsPreRunCheck === true
      ? { ...input, silentWhenIdle: input.silentWhenIdle ?? true } : input,
    sources: r.sources.slice(0, 64).flatMap((raw) => {
      const s = record(raw);
      if (!s || !bounded(s.id) || !bounded(s.name) || !bounded(s.status) || !Array.isArray(s.events)) return [];
      return [{ id: s.id, name: s.name, status: s.status, events: s.events.slice(0, 32).flatMap((raw) => {
        const e = record(raw); return e && bounded(e.type) && bounded(e.name) && Array.isArray(e.fields)
          ? [{ type: e.type, name: e.name, fields: e.fields.filter((f): f is string => bounded(f, 128)).slice(0, 64) }] : [];
      }) }];
    }),
    history: r.history.slice(0, 20).flatMap((raw) => {
      const h = record(raw);
      if (!h || !bounded(h.id, 128) || !bounded(h.status) || typeof h.createdAt !== 'number' || !Number.isFinite(h.createdAt)) return [];
      return [{ id: h.id, status: ['queued', 'running', 'success', 'failed', 'interrupted', 'cancelled', 'skipped'].includes(h.status) ? h.status : 'unknown', createdAt: h.createdAt,
        ...(typeof h.finishedAt === 'number' ? { finishedAt: h.finishedAt } : {}),
        ...(bounded(h.resultText, 2000) ? { resultText: h.resultText } : {}),
        ...(bounded(h.error, 1000) ? { error: h.error } : {}) }];
    }) };
}
export function emptyRoutineDefinition(): RoutineDefinition {
  return { name: '', prompt: '', enabled: true, silentWhenIdle: false, triggers: [{ id: 'daily', kind: 'cron', expression: '0 9 * * *', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' }] };
}
export function routineDraftValid(draft: RoutineDefinition): boolean {
  return Boolean(draft.name.trim() && draft.prompt.trim() && draft.triggers.length && parseRoutineDefinition(draft)
    && draft.triggers.every((t) => t.kind !== 'cron' || routineCronFieldsValid(t))
    && draft.triggers.every((t) => t.kind !== 'event' || (t.sourceId && t.eventType && t.filters.every((f) => f.field && f.value))));
}

/** Catch incomplete presets and literal field bounds; full cron semantics remain host-owned. */
function routineCronFieldsValid(trigger: Extract<RoutineTrigger, { kind: 'cron' }>): boolean {
  const fields = trigger.expression.trim().split(/\s+/);
  const ranges = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]] as const;
  return Boolean(trigger.timezone.trim()) && fields.length === ranges.length && fields.every((field, index) => {
    if (!/^[+-]?\d+(?:\.\d+)?$/.test(field)) return true;
    const value = Number(field);
    const [min, max] = ranges[index]!;
    return Number.isSafeInteger(value) && value >= min && value <= max;
  });
}
