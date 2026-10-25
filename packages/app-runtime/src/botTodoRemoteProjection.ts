import { createHash } from 'node:crypto';
import type { TeammateTodo, TodoDeadline } from '@cindy/maker-shared/teammate-todo';

const opaque = (id: string) => createHash('sha256').update(id).digest('hex');
const publicRef = (ref?: string) => ref?.startsWith('https://') ? { ref } : {};
const deadline = (value: TodoDeadline | null): TodoDeadline | null =>
  value ? { ...value, ...(value.sourceId ? { sourceId: opaque(value.sourceId) } : {}) } : null;

/** User-visible resource fields only; never send host paths, dedupe keys or model instructions. */
export function botTodoRemoteProjection(t: TeammateTodo): TeammateTodo {
  return {
    id: t.id, revision: t.revision, key: t.id,
    origin: t.origin, title: t.title, progress: t.progress, outcome: t.outcome, value: t.value,
    next: t.next ? { label: t.next.label, kind: t.next.kind, instruction: '' } : null,
    sources: t.sources.map(s => ({
      kind: s.kind, id: opaque(s.id), label: s.label, ...publicRef(s.ref),
      ...(s.version !== undefined ? { version: s.version } : {}),
      ...(s.observedAt ? { observedAt: s.observedAt } : {}),
    })),
    associations: t.associations.map(a => ({ kind: a.kind, id: opaque(a.id), label: a.label })),
    status: t.status, createdAt: t.createdAt, updatedAt: t.updatedAt,
    sourceDeadline: deadline(t.sourceDeadline),
    ...(t.deadlineOverride ? { deadlineOverride: { value: deadline(t.deadlineOverride.value) } } : {}),
    deadlineCandidate: t.deadlineCandidate
      ? { value: deadline(t.deadlineCandidate.value)!, reason: t.deadlineCandidate.reason } : null,
    suggestedDate: t.suggestedDate, decision: t.decision,
    history: t.history.map(h => ({ summary: h.summary, at: h.at, ...publicRef(h.ref) })),
    action: t.action ? { requestId: t.action.requestId, revision: t.action.revision, state: t.action.state } : null,
    // A presentation marker localizes the legacy Continue label without forwarding its host ID.
    ...(t.legacyId ? { legacyId: 'legacy' } : {}),
  };
}
