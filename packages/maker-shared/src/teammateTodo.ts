/** Host-owned affairs, independent of Session lifecycle and project visibility. */
export interface TodoSource {
  kind: 'conversation' | 'mail' | 'feishu' | 'github' | 'community' | 'task';
  id: string;
  label: string;
  ref?: string;
  project?: string;
  version?: number;
  observedAt?: string;
}
export interface TodoDeadline {
  kind: 'date' | 'instant';
  date: string;
  timeZone: string;
  at?: string;
  sourceId?: string;
  sourceVersion?: number;
  quote?: string;
  observedAt?: string;
}
export interface TodoNext {
  label: string;
  instruction: string;
  kind: 'advance' | 'view' | 'decide';
}
export interface TodoCompletion {
  summary: string;
  ref?: string;
  at: string;
}
export interface TeammateTodo {
  id: string;
  revision: number;
  key: string;
  origin: 'assigned' | 'discovered';
  title: string;
  progress: string;
  outcome: string;
  value: string;
  next: TodoNext | null;
  sources: TodoSource[];
  associations: Array<{ kind: 'task' | 'pr'; id: string; label: string }>;
  status: 'open' | 'done';
  createdAt: string;
  updatedAt: string;
  sourceDeadline: TodoDeadline | null;
  deadlineOverride?: { value: TodoDeadline | null };
  deadlineCandidate: { value: TodoDeadline; reason: string } | null;
  suggestedDate: string | null;
  decision: { kind: 'deleted' | 'muted' | 'later'; until?: string } | null;
  history: TodoCompletion[];
  action: {
    requestId: string;
    revision: number;
    state: 'received' | 'accepted' | 'failed' | 'unknown';
    error?: string;
  } | null;
  legacyId?: string;
  legacyFingerprint?: string;
  legacyVerdict?: 'unfinished' | 'idea' | 'done';
}
export interface TodoPatch {
  id?: string;
  expectedRevision?: number;
  key?: string;
  origin?: TeammateTodo['origin'];
  title?: string;
  progress?: string;
  outcome?: string;
  value?: string;
  next?: TodoNext | null;
  sources?: TodoSource[];
  associations?: TeammateTodo['associations'];
  sourceDeadline?: TodoDeadline | null;
  deadlineOverride?: { value: TodoDeadline | null };
  deadlineCandidate?: TeammateTodo['deadlineCandidate'];
  suggestedDate?: string | null;
  operation?: 'complete' | 'reopen' | 'delete' | 'mute' | 'later' | 'restore' | 'confirm-deadline';
  until?: string;
  completion?: { summary: string; ref?: string };
  resolvedActionRequestId?: string;
}
export interface TodoState {
  version: 1;
  items: TeammateTodo[];
  cursors: Record<string, number>;
  receipts: Record<string, string>;
}
export const emptyTodoState = (): TodoState => ({
  version: 1,
  items: [],
  cursors: {},
  receipts: {},
});
export class TodoError extends Error {
  constructor(
    public code: string,
    message = code,
  ) {
    super(message);
  }
}
const text = (s: unknown, max: number, required = false): string => {
  if (typeof s !== 'string' || (required && !s.trim()) || s.length > max)
    throw new TodoError('INVALID_INPUT');
  return s.trim();
};
export function validateTodoTimestamp(s: unknown): string {
  if (
    typeof s !== 'string' ||
    s.length > 64 ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(s) ||
    !Number.isFinite(Date.parse(s))
  )
    throw new TodoError('INVALID_DATE');
  return s;
}
const iso = validateTodoTimestamp;
export function validateTodoDeadline(d: TodoDeadline | null): void {
  if (d === null) return;
  if (
    !d ||
    !['date', 'instant'].includes(d.kind) ||
    typeof d.date !== 'string' ||
    d.date.length !== 10 ||
    !/^\d{4}-\d{2}-\d{2}$/.test(d.date) ||
    !Number.isFinite(Date.parse(d.date)) ||
    new Date(d.date).toISOString().slice(0, 10) !== d.date
  )
    throw new TodoError('INVALID_DATE');
  if (typeof d.timeZone !== 'string' || !d.timeZone.trim() || d.timeZone.length > 100)
    throw new TodoError('INVALID_TIME_ZONE');
  try {
    new Intl.DateTimeFormat('en', { timeZone: d.timeZone }).format();
  } catch {
    throw new TodoError('INVALID_TIME_ZONE');
  }
  if (d.kind === 'instant') {
    iso(d.at);
    if (todoLocalDate(new Date(d.at!), d.timeZone) !== d.date) throw new TodoError('INVALID_DATE');
  } else if (d.at !== undefined) throw new TodoError('INVALID_DATE');
  if (
    d.sourceVersion !== undefined &&
    (!Number.isSafeInteger(d.sourceVersion) || d.sourceVersion < 0)
  )
    throw new TodoError('INVALID_INPUT');
  if (d.observedAt !== undefined) iso(d.observedAt);
  if (d.sourceId !== undefined) text(d.sourceId, 512, true);
  if (d.quote !== undefined) text(d.quote, 2000);
}
export function todoLocalDate(now: Date, zone: string): string {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  return ['year', 'month', 'day'].map((k) => parts.find((p) => p.type === k)!.value).join('-');
}
export function effectiveTodoDeadline(t: TeammateTodo): TodoDeadline | null {
  return t.deadlineOverride ? t.deadlineOverride.value : t.sourceDeadline;
}
/** Date-only items sort at the end of their source-local day, without inventing a stored time. */
export function createTodoDueComparator() {
  const values = new Map<string, number>();
  const value = (t: TeammateTodo) => {
    const d = effectiveTodoDeadline(t);
    if (!d) return Infinity;
    if (d.kind === 'instant') return Date.parse(d.at!);
    const key = d.date + '\0' + d.timeZone;
    const cached = values.get(key);
    if (cached !== undefined) return cached;
    // Locate the next local calendar day, including DST transitions and midnight gaps.
    const target = Number(d.date.replaceAll('-', ''));
    const nominal = Date.parse(d.date + 'T00:00:00Z') + 86_400_000;
    const format = new Intl.DateTimeFormat('en', {
      timeZone: d.timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    let lo = nominal - 36 * 3_600_000,
      hi = nominal + 36 * 3_600_000;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2),
        parts = format.formatToParts(new Date(mid));
      const date = Number(
        ['year', 'month', 'day'].map((k) => parts.find((p) => p.type === k)!.value).join(''),
      );
      if (date > target) hi = mid;
      else lo = mid + 1;
    }
    values.set(key, lo - 1);
    return lo - 1;
  };
  return (a: TeammateTodo, b: TeammateTodo) => {
    const left = value(a),
      right = value(b);
    return left === right ? 0 : left - right;
  };
}
export function todoOverdue(t: TeammateTodo, now = new Date()): boolean {
  const d = effectiveTodoDeadline(t);
  return (
    !!d &&
    (d.kind === 'instant'
      ? Date.parse(d.at!) < now.getTime()
      : d.date < todoLocalDate(now, d.timeZone))
  );
}
export function todoDateLabel(t: TeammateTodo, locale: string, now = new Date()): string {
  const d = effectiveTodoDeadline(t);
  const dateString = d?.date ?? t.deadlineCandidate?.value.date ?? t.suggestedDate;
  if (!dateString) return '';
  const date = new Intl.DateTimeFormat(locale, {
    timeZone: 'UTC',
    month: 'numeric',
    day: 'numeric',
  }).format(new Date(dateString + 'T12:00:00Z'));
  const day =
    d && d.date === todoLocalDate(now, d.timeZone)
      ? new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(0, 'day')
      : date;
  return d?.kind === 'instant'
    ? day +
        ' ' +
        new Intl.DateTimeFormat(locale, {
          timeZone: d.timeZone,
          hour: '2-digit',
          minute: '2-digit',
        }).format(new Date(d.at!))
    : day;
}
export function todoVisible(t: TeammateTodo, now = new Date()): boolean {
  return (
    !t.decision ||
    (t.decision.kind === 'later' &&
      !!t.decision.until &&
      Date.parse(t.decision.until) <= now.getTime())
  );
}
/** Deterministic host preflight: repeat events and decisions never wake a model. */
export function preflightTodoEvents(
  state: TodoState,
  events: Array<{
    source: string;
    sequence: number;
    key: string;
    project?: string;
  }>,
  projects: string[],
) {
  if (!Array.isArray(events) || events.length > 100) throw new TodoError('INVALID_EVENT');
  for (const e of events)
    if (
      !e ||
      !Number.isSafeInteger(e.sequence) ||
      e.sequence < 0 ||
      typeof e.key !== 'string' ||
      !e.key ||
      e.key.length > 512 ||
      typeof e.source !== 'string' ||
      !e.source ||
      e.source.length > 512
    )
      throw new TodoError('INVALID_EVENT');
  return events.map((e) => ({
    ...e,
    decision:
      e.project && !projects.includes(e.project)
        ? 'outside-scope'
        : e.sequence <= (Object.hasOwn(state.cursors, e.source) ? state.cursors[e.source] : -1) ||
            Object.hasOwn(state.receipts, e.source + ':' + e.sequence)
          ? 'duplicate'
          : state.items.some((t) => t.key === normalizeTodoKey(e.key) && !todoVisible(t))
            ? 'suppressed'
            : state.items.some((t) => t.key === normalizeTodoKey(e.key) && t.status === 'done')
              ? 'resolved'
              : ('review' as const),
  }));
}
export function normalizeTodoKey(key: unknown): string {
  return text(key, 512, true);
}
export function applyTodoPatch(
  state: TodoState,
  patch: TodoPatch,
  id: string,
  now = new Date(),
): TeammateTodo {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch))
    throw new TodoError('INVALID_INPUT');
  const key = patch.key === undefined ? undefined : normalizeTodoKey(patch.key);
  const old = patch.id
    ? state.items.find((t) => t.id === patch.id)
    : state.items.find((t) => t.key === key);
  if (patch.id && !old) throw new TodoError('NOT_FOUND');
  if (old && key !== undefined && key !== old.key) throw new TodoError('KEY_MISMATCH');
  if (old && patch.expectedRevision !== old.revision) throw new TodoError('CONFLICT');
  if (!old && patch.expectedRevision !== undefined) throw new TodoError('CONFLICT');
  if (!old && state.items.length >= 10000) throw new TodoError('CAPACITY_REACHED'); // reject, never evict history
  const t: TeammateTodo = old
    ? structuredClone(old)
    : {
        id,
        revision: 0,
        key: normalizeTodoKey(patch.key),
        origin: 'assigned',
        title: '',
        progress: '',
        outcome: '',
        value: '',
        next: null,
        sources: [],
        associations: [],
        status: 'open',
        createdAt: now.toISOString(),
        updatedAt: '',
        sourceDeadline: null,
        deadlineCandidate: null,
        suggestedDate: null,
        decision: null,
        history: [],
        action: null,
      };
  for (const field of ['title', 'progress', 'outcome', 'value'] as const)
    if (patch[field] !== undefined)
      t[field] = text(
        patch[field],
        field === 'title' ? 300 : 4000,
        field === 'title' || field === 'outcome',
      );
  if (!t.title || !t.outcome) throw new TodoError('INVALID_INPUT');
  if (patch.origin !== undefined) {
    if (!['assigned', 'discovered'].includes(patch.origin)) throw new TodoError('INVALID_INPUT');
    t.origin = patch.origin;
  }
  if (patch.next !== undefined) {
    if (patch.next !== null) {
      text(patch.next.label, 100, true);
      text(patch.next.instruction, 4000, true);
      if (!['advance', 'view', 'decide'].includes(patch.next.kind))
        throw new TodoError('INVALID_INPUT');
    }
    if (JSON.stringify(t.next) !== JSON.stringify(patch.next)) t.action = null;
    t.next = patch.next
      ? {
          label: text(patch.next.label, 100, true),
          instruction: text(patch.next.instruction, 4000, true),
          kind: patch.next.kind,
        }
      : null;
  }
  if (patch.sources !== undefined) {
    if (!Array.isArray(patch.sources) || patch.sources.length > 100)
      throw new TodoError('INVALID_INPUT');
    const merged = new Map(t.sources.map((s) => [s.kind + ':' + s.id, s]));
    for (const s of patch.sources) {
      if (!s || !['conversation', 'mail', 'feishu', 'github', 'community', 'task'].includes(s.kind))
        throw new TodoError('INVALID_INPUT');
      text(s.id, 512, true);
      text(s.label, 300, true);
      if (s.ref !== undefined) text(s.ref, 2000);
      if (s.ref && !/^https:\/\/[^\s]+$/.test(s.ref)) throw new TodoError('INVALID_REFERENCE');
      if (s.version !== undefined && (!Number.isSafeInteger(s.version) || s.version < 0))
        throw new TodoError('INVALID_INPUT');
      if (s.project !== undefined) text(s.project, 4096, true);
      if (s.observedAt !== undefined) iso(s.observedAt);
      const previous = merged.get(s.kind + ':' + s.id);
      if (!previous || (s.version ?? 0) >= (previous.version ?? 0))
        merged.set(s.kind + ':' + s.id, {
          ...previous,
          kind: s.kind,
          id: s.id,
          label: s.label,
          ...(s.ref ? { ref: s.ref } : {}),
          ...(s.project ? { project: s.project } : {}),
          ...(s.version !== undefined ? { version: s.version } : {}),
          ...(s.observedAt ? { observedAt: s.observedAt } : {}),
        });
    }
    t.sources = [...merged.values()];
  }
  if (patch.associations !== undefined) {
    if (!Array.isArray(patch.associations) || patch.associations.length > 100)
      throw new TodoError('INVALID_INPUT');
    const merged = new Map(t.associations.map((a) => [a.kind + ':' + a.id, a]));
    for (const a of patch.associations) {
      if (!['task', 'pr'].includes(a.kind)) throw new TodoError('INVALID_INPUT');
      text(a.id, 512, true);
      text(a.label, 300, true);
      merged.set(a.kind + ':' + a.id, {
        kind: a.kind,
        id: a.id,
        label: a.label,
      });
    }
    t.associations = [...merged.values()];
  }
  if (patch.sourceDeadline !== undefined) {
    validateTodoDeadline(patch.sourceDeadline);
    if (
      t.sourceDeadline &&
      patch.sourceDeadline &&
      // Versions are ordered only within one source. Two missing IDs are the legacy stream.
      t.sourceDeadline.sourceId === patch.sourceDeadline.sourceId &&
      (patch.sourceDeadline.sourceVersion ?? 0) < (t.sourceDeadline.sourceVersion ?? 0)
    )
      throw new TodoError('STALE_SOURCE');
    t.sourceDeadline = patch.sourceDeadline;
  }
  if (patch.deadlineOverride !== undefined) {
    if (!patch.deadlineOverride || typeof patch.deadlineOverride !== 'object')
      throw new TodoError('INVALID_INPUT');
    validateTodoDeadline(patch.deadlineOverride.value);
    t.deadlineOverride = { value: patch.deadlineOverride.value };
  }
  if (patch.deadlineCandidate !== undefined) {
    if (patch.deadlineCandidate !== null) {
      if (
        !patch.deadlineCandidate ||
        typeof patch.deadlineCandidate !== 'object' ||
        Array.isArray(patch.deadlineCandidate)
      )
        throw new TodoError('INVALID_INPUT');
      validateTodoDeadline(patch.deadlineCandidate.value);
      text(patch.deadlineCandidate.reason, 2000, true);
    }
    t.deadlineCandidate = patch.deadlineCandidate;
  }
  if (patch.suggestedDate !== undefined) {
    if (patch.suggestedDate !== null && typeof patch.suggestedDate !== 'string')
      throw new TodoError('INVALID_DATE');
    if (patch.suggestedDate)
      validateTodoDeadline({
        kind: 'date',
        date: patch.suggestedDate,
        timeZone: 'UTC',
      });
    t.suggestedDate = patch.suggestedDate;
  }
  if (patch.resolvedActionRequestId !== undefined) {
    if (!old?.action || old.action.requestId !== patch.resolvedActionRequestId)
      throw new TodoError('STALE_RECEIPT');
    if (!patch.progress?.trim()) throw new TodoError('RECEIPT_EVIDENCE_REQUIRED');
    t.action = null;
  }
  switch (patch.operation) {
    case 'complete': {
      if (!patch.completion) throw new TodoError('COMPLETION_EVIDENCE_REQUIRED');
      text(patch.completion.summary, 4000, true);
      if (patch.completion.ref !== undefined) text(patch.completion.ref, 2000);
      t.history.push({ ...patch.completion, at: now.toISOString() });
      t.status = 'done';
      t.decision = null;
      t.action = null;
      break;
    }
    case 'reopen':
      t.status = 'open';
      t.decision = null;
      t.action = null;
      break;
    case 'delete':
    case 'mute':
      t.decision = { kind: patch.operation === 'delete' ? 'deleted' : 'muted' };
      break;
    case 'later':
      if (!patch.until || Date.parse(iso(patch.until)) <= now.getTime())
        throw new TodoError('INVALID_DATE');
      t.decision = { kind: 'later', until: patch.until };
      break;
    case 'restore':
      t.decision = null;
      break;
    case 'confirm-deadline':
      if (!t.deadlineCandidate) throw new TodoError('INVALID_DATE');
      t.deadlineOverride = { value: t.deadlineCandidate.value };
      t.deadlineCandidate = null;
      break;
    case undefined:
      break;
    default:
      throw new TodoError('INVALID_INPUT');
  }
  t.revision++;
  t.updatedAt = now.toISOString();
  const at = state.items.findIndex((x) => x.id === t.id);
  if (at < 0) state.items.push(t);
  else state.items[at] = t;
  return t;
}

/** Earliest visibility boundary; independent of pagination, with no reminder or execution side effect. */
export function nextTodoDeferralAt(items: TeammateTodo[], now = new Date()): string | null {
  let next: string | null = null;
  for (const t of items) {
    const until = t.decision?.kind === 'later' ? t.decision.until : undefined;
    if (
      until &&
      Date.parse(until) > now.getTime() &&
      (!next || Date.parse(until) < Date.parse(next))
    )
      next = until;
  }
  return next;
}

/** One mounted-view refresh; long waits are chunked locally without reading or running work. */
export function scheduleTodoDeferralRefresh(until: string, refresh: () => void): () => void {
  const at = Date.parse(until);
  if (!Number.isFinite(at)) return () => {};
  let timer: ReturnType<typeof setTimeout>;
  const arm = () => {
    const remaining = at - Date.now();
    timer =
      remaining > 2_147_483_647
        ? setTimeout(arm, 2_147_483_647)
        : setTimeout(refresh, Math.max(0, remaining));
  };
  arm();
  return () => clearTimeout(timer);
}

export interface TodoListQuery {
  query?: string;
  view?: 'open' | 'done' | 'hidden';
  origin?: 'all' | 'assigned' | 'discovered';
  order?: 'due' | 'created';
  offset?: number;
  limit?: number;
}
export function queryTodoItems(items: TeammateTodo[], q: TodoListQuery = {}, now = new Date()) {
  if (
    !q ||
    typeof q !== 'object' ||
    Array.isArray(q) ||
    (q.query !== undefined && typeof q.query !== 'string') ||
    (q.view !== undefined && !['open', 'done', 'hidden'].includes(q.view)) ||
    (q.origin !== undefined && !['all', 'assigned', 'discovered'].includes(q.origin)) ||
    (q.order !== undefined && !['due', 'created'].includes(q.order))
  )
    throw new TodoError('INVALID_INPUT');
  const search = (q.query ?? '').trim().toLocaleLowerCase();
  if (search.length > 300) throw new TodoError('INVALID_INPUT');
  const compareDue = createTodoDueComparator();
  const filtered = items
    .filter(
      (t) =>
        (q.view === 'done'
          ? t.status === 'done' && todoVisible(t, now)
          : q.view === 'hidden'
            ? !todoVisible(t, now)
            : t.status === 'open' && todoVisible(t, now)) &&
        (!q.origin || q.origin === 'all' || t.origin === q.origin) &&
        (!search ||
          [t.title, t.progress, ...t.sources.map((s) => s.label)]
            .join(' ')
            .toLocaleLowerCase()
            .includes(search)),
    )
    .sort(
      (a, b) =>
        (q.order !== 'created' ? compareDue(a, b) : 0) ||
        a.createdAt.localeCompare(b.createdAt) ||
        a.id.localeCompare(b.id),
    );
  const requestedOffset = Number.isSafeInteger(q.offset) && q.offset! >= 0 ? q.offset! : 0;
  const limit = Math.min(25, Math.max(1, Number.isSafeInteger(q.limit) ? q.limit! : 25));
  const offset = Math.min(
    requestedOffset,
    Math.max(0, Math.ceil(filtered.length / limit) - 1) * limit,
  );
  return {
    items: filtered.slice(offset, offset + limit),
    total: filtered.length,
    offset,
    limit,
    nextDeferredAt: nextTodoDeferralAt(items, now),
    completedTotal: items.filter((t) => t.status === 'done' && todoVisible(t, now)).length,
  };
}

/** Public transcript copy; the model-only delivery carries the stable affair id separately. */
export function todoActionText(title: string, step: string, locale = 'en'): string {
  const prefix = locale.startsWith('zh-TW')
    ? '繼續'
    : locale.startsWith('zh')
      ? '继续'
      : locale.startsWith('ja')
        ? '続ける'
        : locale.startsWith('ko')
          ? '계속'
          : 'Continue';
  return `${prefix} “${title}”: ${step}`;
}
