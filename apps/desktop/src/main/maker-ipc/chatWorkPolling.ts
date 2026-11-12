/** Discovery may be batched. Lease acquisition stays an independent operation per actor. */
export interface WorkActor { id: string; busy: boolean; ready: boolean }
export interface WorkAvailability { botId: string; pending: boolean; enabled: boolean }
export interface WorkError { status?: number; retryAt?: number }

export class WorkRequestDeferred extends Error {
  constructor(readonly retryAt: number) { super('CHAT_WORK_DEFERRED'); }
}

/** Account/endpoint-wide admission. Observed restrictions take effect immediately. */
export function createWorkRequestGate(errorInfo: (error: unknown) => WorkError) {
  let until = 0, holds = 0;
  // A refresh is an in-flight auth barrier, not a failed request. Keep a finite
  // wake deadline while held; the regular tick resumes promptly after release.
  const deadline = () => holds ? Math.max(until, Date.now() + 60_000) : until;
  return {
    get until() { return deadline(); },
    hold() {
      holds++;
      let held = true;
      return () => { if (held) { held = false; holds--; } };
    },
    observe(error: unknown) {
      const info = errorInfo(error);
      if (info.status === 401 || info.status === 429)
        until = Math.max(until, Date.now() + 60_000, info.retryAt ?? 0);
    },
    check() { const at = deadline(); if (Date.now() < at) throw new WorkRequestDeferred(at); },
  };
}

type State = { revision: number; direct: boolean; wakeAt: number; next: number; misses: number;
  actionAfter: number; actionFailures: number; probeAfter: number; probeFailures: number };

export function createChatWorkPolling<E>(deps: {
  current(): boolean;
  actors(): WorkActor[];
  gate: ReturnType<typeof createWorkRequestGate>;
  errorInfo(error: unknown): WorkError;
  canProbe(): boolean;
  longIdle(): boolean;
  probe(ids: string[]): Promise<WorkAvailability[]>;
  claim(id: string): Promise<E | null>;
  scan(id: string): Promise<void>;
  accept(execution: E): void;
  empty(id: string): void;
  disabled(id: string): void;
  failed(error: unknown, phase: 'probe' | 'claim' | 'scan'): void;
}) {
  const states = new Map<string, State>();
  // A read-only probe does not reserve an actor: a new wake may claim immediately.
  const probing = new Set<string>();
  // Claim and busy scan are mutually exclusive for one actor, never across actors.
  const acting = new Set<string>();
  let probes = 0, closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timerAt = Infinity;
  const current = () => !closed && deps.current();
  const state = (id: string) => {
    let value = states.get(id);
    if (!value) {
      value = { revision: 0, direct: false, wakeAt: 0, next: 0, misses: 0,
        actionAfter: 0, actionFailures: 0, probeAfter: 0, probeFailures: 0 };
      states.set(id, value);
    }
    return value;
  };
  function schedule(at = Date.now()) {
    if (!current() || (timer && timerAt <= at)) return;
    clearTimeout(timer);
    timerAt = at;
    timer = setTimeout(() => { timer = undefined; timerAt = Infinity; pump(); }, Math.max(0, at - Date.now()));
  }
  function idle(id: string, revision: number, provenEmpty: boolean) {
    const value = state(id);
    if (value.revision !== revision) return;
    value.misses = Math.min(value.misses + 1, 6);
    value.next = Date.now() + Math.min(2_000 * 2 ** (value.misses - 1), provenEmpty && deps.longIdle() ? 60_000 : 15_000) + Math.random() * 1000;
    if (provenEmpty) deps.empty(id);
  }
  function failed(id: string, error: unknown, phase: 'probe' | 'claim' | 'scan') {
    deps.gate.observe(error);
    const value = state(id);
    if (error instanceof WorkRequestDeferred) return;
    const count = phase === 'probe' ? ++value.probeFailures : ++value.actionFailures;
    const after = Date.now() + Math.min(60_000, 2_000 * 2 ** Math.min(count - 1, 5));
    if (phase === 'probe') value.probeAfter = after;
    else value.actionAfter = after;
    deps.failed(error, phase);
  }
  function act(actor: WorkActor) {
    if (!current() || acting.has(actor.id) || Date.now() < deps.gate.until) return;
    const value = state(actor.id), revision = value.revision;
    const phase = actor.busy ? 'scan' : 'claim';
    acting.add(actor.id); value.direct = false;
    void (async () => {
      deps.gate.check();
      if (actor.busy) {
        await deps.scan(actor.id);
        if (current() && value.revision === revision) value.next = Date.now() + 2_000;
      } else {
        const execution = await deps.claim(actor.id);
        if (!current()) return;
        if (execution) {
          value.misses = 0; value.next = 0;
          deps.accept(execution); // independent response; no sibling barrier
        } else idle(actor.id, revision, false);
      }
      if (current()) { value.actionFailures = 0; value.actionAfter = 0; }
    })().catch(error => { if (current()) failed(actor.id, error, phase); })
      .finally(() => { acting.delete(actor.id); schedule(); });
  }
  function probe(ids: string[]) {
    probes++;
    const revisions = new Map(ids.map(id => { probing.add(id); return [id, state(id).revision]; }));
    void (async () => {
      deps.gate.check();
      const items = await deps.probe(ids);
      if (!current()) return;
      for (const item of items) {
        const actor = deps.actors().find(actor => actor.id === item.botId);
        const value = state(item.botId);
        if (!actor || actor.busy || !actor.ready || acting.has(actor.id) || value.revision !== revisions.get(actor.id)) continue;
        value.probeFailures = 0; value.probeAfter = 0;
        if (!item.enabled) { value.next = Date.now() + 2_000; deps.disabled(actor.id); }
        else if (!item.pending) idle(actor.id, value.revision, true);
        else if (Date.now() >= value.actionAfter) act(actor);
      }
    })().catch(error => {
      if (!current()) return;
      // A missing read-only endpoint has no ambiguous mutations. Legacy claims
      // can proceed after the adapter disables probing.
      if (!deps.canProbe()) return;
      for (const id of ids) if (state(id).revision === revisions.get(id) && !acting.has(id)) failed(id, error, 'probe');
    }).finally(() => { probes--; ids.forEach(id => probing.delete(id)); schedule(); });
  }
  function pump() {
    if (!current()) return;
    if (Date.now() < deps.gate.until) { schedule(deps.gate.until); return; }
    const candidates: string[] = [];
    let nextWake = Infinity;
    for (const actor of deps.actors()) {
      const value = state(actor.id);
      if (!actor.ready || acting.has(actor.id)) continue;
      if (value.direct && Date.now() < Math.max(value.wakeAt, value.actionAfter)) {
        nextWake = Math.min(nextWake, Math.max(value.wakeAt, value.actionAfter)); continue;
      }
      if (Date.now() < value.actionAfter || (!value.direct && Date.now() < value.next)) continue;
      if (actor.busy || value.direct || !deps.canProbe()) act(actor);
      else if (!probing.has(actor.id) && Date.now() >= value.probeAfter) candidates.push(actor.id);
    }
    for (let offset = 0; probes < 4 && offset < candidates.length; offset += 128) probe(candidates.slice(offset, offset + 128));
    if (Number.isFinite(nextWake)) schedule(nextWake);
  }
  return {
    tick: () => pump(),
    /** A work hint bypasses idle delay, but never request failure/auth backoff. */
    wake(ids?: string[]) {
      for (const id of ids ?? deps.actors().map(actor => actor.id)) {
        const value = state(id);
        value.revision++; value.next = 0;
        if (!value.direct) value.wakeAt = Date.now() + 250;
        value.direct = true;
      }
      schedule(Date.now() + 250);
    },
    /** Registry/connection changes invalidate stale probes without inventing work. */
    reset() {
      for (const value of states.values()) {
        value.revision++; value.misses = 0;
        value.next = deps.canProbe() ? 0 : Date.now() + 250;
      }
      if (deps.canProbe()) schedule();
    },
    shortenIdle() {
      for (const value of states.values()) value.next = Math.min(value.next, Date.now() + 15_000);
    },
    dispose() { closed = true; clearTimeout(timer); },
  };
}
