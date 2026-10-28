/** Host coordination only: native startup/close and capability discovery stay in
 * their existing owners. A receipt is valid for one runtime and one revision. */
export interface CapabilityRefreshSession {
  readonly id: string;
  readonly instanceId: string;
}

export type CapabilityRefreshPhase = import('../../shared/sessionCapabilityRefresh.js').SessionCapabilityRefreshPhase;

export interface CapabilityRefreshState {
  readonly sessionId: string;
  readonly instanceId: string;
  readonly revision: number;
  readonly appliedRevision: number;
  readonly phase: CapabilityRefreshPhase;
}

export type CapabilityRefreshOutcome<T> =
  | { kind: 'unchanged' | 'superseded' }
  | { kind: 'deferred' }
  | { kind: 'refreshed'; session: T }
  | { kind: 'failed'; error: unknown };

export interface SessionCapabilityRefreshDeps<T extends CapabilityRefreshSession> {
  /** Must check both runtime identity and the captured account/device owner. */
  isCurrent(session: T): boolean;
  /** Includes running turns, background work and pending interactions. */
  isIdle(session: T): boolean;
  /** Preflight before close; check isCurrent immediately before closing the old
   * runtime. After close, the host's existing owner fence guards bootstrap.
   * Return only after the replacement's actual loading has been verified. */
  refresh(session: T, isCurrent: () => boolean): Promise<T>;
  /** Deadline reports failure but never releases ownership of unfinished native work. */
  timeoutMs?: number;
  onStateChanged?(session: T): void;
}

interface RefreshEntry<T> {
  session: T;
  revision: number;
  appliedRevision: number;
  phase: CapabilityRefreshPhase;
  operation?: Promise<CapabilityRefreshOutcome<T>>;
}

/**
 * One coordinator per execution owner. Call markChanged only after a complete
 * config/credential commit (or a consistent filesystem snapshot), for affected
 * live runtimes only. Historical tasks load current resources on normal resume.
 *
 * The host supplies its existing send lock around attempt and dispatch. This
 * module joins duplicate refreshes; it does not introduce a parallel send lock
 * or restart native processes while work is running.
 */
export function createSessionCapabilityRefreshCoordinator<T extends CapabilityRefreshSession>(
  deps: SessionCapabilityRefreshDeps<T>,
) {
  const entries = new Map<string, RefreshEntry<T>>();
  let revision = 0;

  function currentEntry(session: T): RefreshEntry<T> | undefined {
    const entry = entries.get(session.id);
    return entry?.session === session && entry.session.instanceId === session.instanceId
      ? entry : undefined;
  }

  function markChanged(session: T): void {
    if (!deps.isCurrent(session)) return;
    let entry = currentEntry(session);
    if (!entry) {
      entry = { session, revision: 0, appliedRevision: 0, phase: 'pending' };
      entries.set(session.id, entry);
    }
    entry.revision = ++revision;
    // A later change must not turn an in-flight operation into a second one.
    if (!entry.operation) entry.phase = 'pending';
  }

  function markFailed(session: T): void {
    markChanged(session);
    const entry = currentEntry(session);
    if (entry && !entry.operation) entry.phase = 'failed';
  }

  async function attempt(session: T): Promise<CapabilityRefreshOutcome<T>> {
    const entry = currentEntry(session);
    if (!entry) return { kind: 'unchanged' };
    // Join first: the old runtime can already have closed during its own swap.
    if (entry.operation) return entry.operation;
    if (!deps.isCurrent(session)) return { kind: 'superseded' };
    if (entry.appliedRevision === entry.revision) return { kind: 'unchanged' };
    if (!deps.isIdle(session)) return { kind: 'deferred' };

    const targetRevision = entry.revision;
    const ownsEntry = () => entries.get(session.id) === entry;
    const isCurrent = () => ownsEntry() && deps.isCurrent(session) && deps.isIdle(session);
    entry.phase = 'refreshing';
    // Schedule after operation is installed, including synchronous throws and
    // reentrant change notifications from native startup.
    const operation = Promise.resolve().then(async (): Promise<CapabilityRefreshOutcome<T>> => {
      if (!ownsEntry() || !deps.isCurrent(session)) return { kind: 'superseded' };
      if (!deps.isIdle(session)) return { kind: 'deferred' };
      let timedOut = false;
      const timeoutError = new Error('Capability reload timed out');
      const timer = setTimeout(() => {
        if (!ownsEntry()) return;
        timedOut = true;
        entry.phase = 'failed';
        deps.onStateChanged?.(entry.session);
      }, deps.timeoutMs ?? 120_000);
      try {
        const replacement = await deps.refresh(session, isCurrent);
        if (!ownsEntry() || replacement.id !== session.id || !deps.isCurrent(replacement)) {
          return { kind: 'superseded' };
        }
        entry.session = replacement;
        if (timedOut) {
          entry.phase = 'failed';
          return { kind: 'failed', error: timeoutError };
        }
        entry.appliedRevision = targetRevision;
        entry.phase = entry.revision === targetRevision ? 'loaded' : 'pending';
        return { kind: 'refreshed', session: replacement };
      } catch (error) {
        if (!ownsEntry()) return { kind: 'superseded' };
        entry.phase = 'failed';
        return { kind: 'failed', error: timedOut ? timeoutError : error };
      } finally {
        clearTimeout(timer);
      }
    }).finally(() => {
      if (entry.operation === operation) {
        entry.operation = undefined;
        if (entry.phase === 'refreshing') entry.phase = 'pending';
      }
    });
    entry.operation = operation;
    return operation;
  }

  /** One stale close/settle event must never clear a replacement's state. */
  function forget(session: T): void {
    if (currentEntry(session)) entries.delete(session.id);
  }

  function state(session: T): CapabilityRefreshState | undefined {
    const entry = currentEntry(session);
    if (!entry) return undefined;
    // Status is safe to project: no configuration, URL, token or raw exception.
    return {
      sessionId: entry.session.id,
      instanceId: entry.session.instanceId,
      revision: entry.revision,
      appliedRevision: entry.appliedRevision,
      phase: entry.phase,
    };
  }

  /** Called under the host's existing send lease. A change received while the
   * native loader was starting must be applied before the waiting input runs. */
  async function beforeSend(session: T): Promise<CapabilityRefreshOutcome<T>> {
    let current = session;
    let outcome: CapabilityRefreshOutcome<T> = { kind: 'unchanged' };
    for (;;) {
      const next = await attempt(current);
      if (next.kind !== 'refreshed') return next.kind === 'unchanged' ? outcome : next;
      current = next.session;
      outcome = next;
      const pending = state(current);
      if (!pending || pending.appliedRevision === pending.revision) return outcome;
    }
  }

  return { markChanged, markFailed, attempt, beforeSend, forget, state, clear: () => entries.clear() };
}
