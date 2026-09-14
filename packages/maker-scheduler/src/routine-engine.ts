import { RoutineEventAdmission, addRoutineReceipt, compactRoutineReceipts, receiptIsLive } from './routine-event-admission.js';
import {
  matchesRoutineEvent,
  nextRoutineTriggerAt,
  parseRoutineEvent,
  parseRoutineInput,
} from "./routines.js";
import type {
  Routine,
  RoutineEvent,
  RoutineInput,
  RoutineSource,
} from "./routines.js";

/** Durable receipt and execution history share one identity across all trigger kinds. */
export interface RoutineRun {
  id: string;
  routineId: string;
  revision: number;
  triggerIds: string[];
  events: Array<{ sourceId: string; event: RoutineEvent }>;
  status:
    "queued" | "running" | "success" | "failed" | "interrupted" | "cancelled";
  createdAt: number;
  finishedAt?: number;
  error?: string;
  scheduleRunId?: string;
  resultText?: string;
}

/** One account-owned snapshot; the host commits each transition atomically. */
export interface RoutineState {
  version: 1;
  routines: Routine[];
  runs: RoutineRun[];
  receipts: Record<string, number>;
  next: Record<string, number>;
  /** Lifecycle suspension preserves each routine's own enabled preference. */
  pausedBotIds?: string[];
}

export interface RoutineEngineDeps {
  load(): Promise<RoutineState | null>;
  save(state: RoutineState): Promise<void>;
  execute(
    routine: Routine,
    run: RoutineRun,
    signal: AbortSignal,
    /** Recheck immediately before vendor dispatch, including after an internal queue wait. */
    canDispatch: () => boolean,
  ): Promise<{
    scheduleRunId?: string;
    error?: string;
    resultText?: string;
    deferred?: boolean;
  }>;
  id(): string;
  now(): number;
  changed(): void;
  onError(error: unknown): void;
}

/** Serial durable admission with one execution lane per routine; unrelated Bots stay independent. */
export class RoutineEngine {
  private state: RoutineState = {
    version: 1,
    routines: [],
    runs: [],
    receipts: {},
    next: {},
  };
  private readonly sources = new Map<string, RoutineSource>();
  private readonly eventAdmission = new RoutineEventAdmission();
  private readonly sourceAdmission = new RoutineEventAdmission();
  private readonly active = new Map<string, AbortController>();
  private readonly activeTasks = new Map<string, Promise<void>>();
  private readonly blockedBots = new Set<string>();
  private readonly removing = new Set<string>();
  private readonly retryAfter = new Map<string, number>();
  // Keep the outcome after execute returns: a failed save must retry persistence,
  // never execution. The durable running row also blocks dispatch until settled.
  private readonly pendingSettlements = new Map<
    string, { routineId: string; apply: (state: RoutineState) => void }
  >();
  private tail: Promise<unknown> = Promise.resolve();
  private stopped = true;

  constructor(private readonly deps: RoutineEngineDeps) {}

  async start(botStates?: ReadonlyMap<string, "active" | "paused" | "deleted">): Promise<void> {
    const saved = await this.deps.load();
    if (saved) {
      if (
        saved.version !== 1 ||
        !Array.isArray(saved.routines) ||
        !Array.isArray(saved.runs)
      ) {
        throw new Error("Unsupported routine storage");
      }
      for (const routine of saved.routines) parseRoutineInput(routine);
      this.state = saved;
    }
    this.state.receipts = compactRoutineReceipts(this.state.receipts, this.deps.now());
    for (const [botId, status] of botStates ?? []) this.applyBotState(this.state, botId, status);
    for (const botId of this.state.pausedBotIds ?? []) this.blockedBots.add(botId);
    // Older versions retained timer cursors for disabled rules. Remove them in
    // the existing startup save so an idle tick cannot keep rewriting history.
    for (const routine of this.state.routines) {
      if (routine.enabled) continue;
      for (const key of Object.keys(this.state.next))
        if (key.startsWith(`${routine.id}:`)) delete this.state.next[key];
    }
    // Removed rules have no history entry point; do not retain their event payloads.
    const retainedIds = new Set(this.state.routines.map((routine) => routine.id));
    this.state.runs = this.state.runs.filter((run) => retainedIds.has(run.routineId));
    // A crash may follow an external side effect: never automatically replay an ambiguous run.
    for (const run of this.state.runs) {
      if (run.status === "running") {
        run.status = "interrupted";
        run.finishedAt = this.deps.now();
      }
    }
    await this.deps.save(this.state);
    this.stopped = false;
    this.pump();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const controller of this.active.values()) controller.abort();
    // Admission persistence does not include asynchronous execution or cancellation.
    await Promise.all([...this.activeTasks.values()]);
    await this.tail;
  }

  list(botId?: string): Routine[] {
    return structuredClone(
      this.state.routines
        .filter((routine) => !botId || routine.botId === botId)
        .map((routine) => {
          const running = this.state.runs.find(
            (run) => run.routineId === routine.id && run.status === "running",
          );
          const queued = this.state.runs.find(
            (run) => run.routineId === routine.id && run.status === "queued",
          );
          return {
            ...routine,
            ...(running
              ? { activity: "running" as const }
              : queued
                ? { activity: "queued" as const }
                : {}),
          };
        }),
    );
  }

  history(routineId: string): RoutineRun[] {
    return structuredClone(
      this.state.runs.filter((run) => run.routineId === routineId).reverse(),
    );
  }

  listSources(): RoutineSource[] {
    return structuredClone([...this.sources.values()]);
  }

  registerSource(source: RoutineSource): void {
    // A separate quota prevents status chatter from exhausting event publication capacity.
    const release = this.sourceAdmission.acquire(source.id, this.deps.now());
    try {
      const existing = this.sources.get(source.id);
      if (
        existing?.name === source.name && existing.status === source.status &&
        JSON.stringify(existing.events) === JSON.stringify(source.events)
      ) return;
      const next = structuredClone(source);
      // Status reports do not own the runtime's last successful event timestamp.
      if (existing?.lastEventAt !== undefined) next.lastEventAt = existing.lastEventAt;
      this.sources.set(source.id, next);
      this.notifyChanged();
    } finally {
      release();
    }
  }

  removeSource(sourceId: string): void {
    const source = this.sources.get(sourceId);
    if (!source || source.status === "disconnected") return;
    // Host-observed disconnects must still take effect when a plugin has exhausted its quota.
    source.status = "disconnected";
    this.notifyChanged();
  }

  async put(botId: string, raw: RoutineInput, id?: string): Promise<Routine> {
    const input = parseRoutineInput(raw);
    return this.change((state) => {
      if (this.blockedBots.has(botId)) throw new Error("The teammate is paused");
      if (id && this.removing.has(id)) throw new Error("Routine is being removed");
      const existing = id
        ? state.routines.find(
            (routine) => routine.id === id && routine.botId === botId,
          )
        : undefined;
      if (id && !existing) throw new Error("Routine not found");
      if (
        existing &&
        JSON.stringify(parseRoutineInput(existing)) === JSON.stringify(input)
      )
        return structuredClone(existing);
      const previousNext = { ...state.next };
      const now = this.deps.now();
      const routine: Routine = {
        ...input,
        id: existing?.id ?? this.deps.id(),
        botId,
        revision: (existing?.revision ?? 0) + 1,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      state.routines = [
        ...state.routines.filter((row) => row.id !== routine.id),
        routine,
      ];
      for (const key of Object.keys(state.next))
        if (key.startsWith(`${routine.id}:`)) delete state.next[key];
      for (const trigger of routine.enabled ? routine.triggers : []) {
        const oldTrigger = existing?.triggers.find(
          (item) => item.id === trigger.id,
        );
        const unchanged =
          existing?.enabled === routine.enabled &&
          JSON.stringify(oldTrigger) === JSON.stringify(trigger);
        const next = unchanged
          ? (previousNext[`${routine.id}:${trigger.id}`] ??
            nextRoutineTriggerAt(trigger, now))
          : nextRoutineTriggerAt(trigger, now);
        if (next !== undefined)
          state.next[`${routine.id}:${trigger.id}`] = next;
      }
      if (existing) this.cancelQueued(state, routine.id);
      return structuredClone(routine);
    }).then((routine) => {
      if (!routine.enabled) this.active.get(routine.id)?.abort();
      return routine;
    });
  }

  /** Quiesce execution before host cleanup; failed cleanup leaves a disabled, retryable rule. */
  async remove(botId: string, id: string, cleanup?: () => Promise<void>): Promise<void> {
    if (!this.state.routines.some((routine) => routine.id === id && routine.botId === botId))
      throw new Error("Routine not found");
    if (this.removing.has(id)) throw new Error("Routine is being removed");
    this.removing.add(id);
    this.active.get(id)?.abort();
    try {
      await this.change((state) => {
        const routine = state.routines.find((row) => row.id === id && row.botId === botId);
        if (!routine) throw new Error("Routine not found");
        routine.enabled = false;
        routine.revision += 1;
        routine.updatedAt = this.deps.now();
        this.cancelQueued(state, id);
        for (const key of Object.keys(state.next))
          if (key.startsWith(`${id}:`)) delete state.next[key];
      });
      // An aborted executor may still be finishing an asynchronous backing write.
      await this.activeTasks.get(id);
      await cleanup?.();
      await this.change((state) => {
        state.routines = state.routines.filter((routine) => routine.id !== id);
        state.runs = state.runs.filter((run) => run.routineId !== id);
        for (const key of Object.keys(state.next))
          if (key.startsWith(`${id}:`)) delete state.next[key];
      });
      this.retryAfter.delete(id);
      for (const [runId, pending] of this.pendingSettlements)
        if (pending.routineId === id) this.pendingSettlements.delete(runId);
    } finally {
      this.removing.delete(id);
    }
  }

  private applyBotState(state: RoutineState, botId: string, status: "active" | "paused" | "deleted"): void {
    const paused = new Set(state.pausedBotIds ?? []);
    const wasPaused = paused.has(botId);
    if (status === "paused") paused.add(botId);
    else paused.delete(botId);
    state.pausedBotIds = [...paused];
    const routines = state.routines.filter((routine) => routine.botId === botId);
    const ids = new Set(routines.map((routine) => routine.id));
    if (status === "deleted") {
      state.routines = state.routines.filter((routine) => !ids.has(routine.id));
      state.runs = state.runs.filter((run) => !ids.has(run.routineId));
    }
    if (status !== "active" || wasPaused) {
      for (const key of Object.keys(state.next))
        if (routines.some((routine) => key.startsWith(`${routine.id}:`))) delete state.next[key];
      for (const routine of routines) {
        this.cancelQueued(state, routine.id);
        if (status === "active" && routine.enabled) {
          for (const trigger of routine.triggers) {
            const next = nextRoutineTriggerAt(trigger, this.deps.now());
            if (next !== undefined) state.next[`${routine.id}:${trigger.id}`] = next;
          }
        }
      }
    }
  }

  async setBotPaused(botId: string, paused: boolean): Promise<void> {
    const ids = this.state.routines.filter((routine) => routine.botId === botId).map((routine) => routine.id);
    if (paused) {
      // Block immediately, including when the durable pause write itself fails.
      this.blockedBots.add(botId);
      for (const id of ids) this.active.get(id)?.abort();
    }
    try {
      await this.change((state) => this.applyBotState(state, botId, paused ? "paused" : "active"));
      if (!paused) this.blockedBots.delete(botId);
    } finally {
      if (paused) await Promise.all(ids.map((id) => this.activeTasks.get(id)));
    }
  }

  /** Called only after host-owned backing schedules have been stopped and removed. */
  async removeBot(botId: string): Promise<void> {
    await this.setBotPaused(botId, true);
    const ids = new Set(this.state.routines.filter((routine) => routine.botId === botId).map((routine) => routine.id));
    await this.change((state) => this.applyBotState(state, botId, "deleted"));
    for (const id of ids) this.retryAfter.delete(id);
    for (const [id, pending] of this.pendingSettlements)
      if (ids.has(pending.routineId)) this.pendingSettlements.delete(id);
  }

  async publish(
    sourceId: string,
    raw: unknown,
    isCurrent: () => boolean = () => true,
  ): Promise<{ accepted: number; duplicate: boolean }> {
    if (this.stopped) throw new Error("Routine service is stopped");
    const source = this.sources.get(sourceId);
    if (!source || source.status !== "listening") throw new Error("Event source is not listening");
    const release = this.eventAdmission.acquire(sourceId, this.deps.now());
    try {
      const event = parseRoutineEvent(raw);
      if (!source.events.some((item) => item.type === event.type))
        throw new Error("Event type is undeclared");
      if (!isCurrent()) throw new Error("Event publisher is no longer active");
      const receipt = JSON.stringify([sourceId, event.id]);
      // A committed duplicate needs no clone or disk write. The queued check below handles races.
      if (receiptIsLive(this.state.receipts[receipt], this.deps.now()))
        return { accepted: 0, duplicate: true };
      const result = await this.change((state) => {
        if (!isCurrent()) throw new Error("Event publisher is no longer active");
        const now = this.deps.now();
        if (receiptIsLive(state.receipts[receipt], now))
          return { accepted: 0, duplicate: true };
        addRoutineReceipt(state.receipts, sourceId, receipt, now);
        const matches = state.routines
          .filter((routine) => !this.blockedBots.has(routine.botId) && !this.removing.has(routine.id))
          .map((routine) => ({ routine, ids: matchesRoutineEvent(routine, sourceId, event) }))
          .filter((match) => match.ids.length > 0);
        for (const { routine, ids } of matches)
          this.enqueue(state, routine, ids, { sourceId, event });
        return { accepted: matches.length, duplicate: false };
      });
      source.lastEventAt = this.deps.now();
      this.pump();
      return result;
    } finally {
      release();
    }
  }

  async runNow(botId: string, id: string): Promise<void> {
    await this.change((state) => {
      if (this.blockedBots.has(botId)) throw new Error("The teammate is paused");
      const routine = state.routines.find(
        (row) => row.id === id && row.botId === botId,
      );
      if (!routine) throw new Error("Routine not found");
      if (this.removing.has(id)) throw new Error("Routine is being removed");
      this.enqueue(state, routine, ["manual"]);
    });
    this.pump();
  }

  async tick(): Promise<void> {
    if (this.stopped) return;
    await this.retrySettlements();
    this.pump();
    const now = this.deps.now();
    if (!Object.values(this.state.next).some((time) => time <= now)) return;
    await this.change((state) => {
      for (const routine of state.routines) {
        if (!routine.enabled || this.blockedBots.has(routine.botId) || this.removing.has(routine.id)) continue;
        for (const trigger of routine.triggers) {
          const key = `${routine.id}:${trigger.id}`;
          if (state.next[key] === undefined || state.next[key] > now) continue;
          this.enqueue(state, routine, [trigger.id]);
          const next = nextRoutineTriggerAt(trigger, now);
          if (next !== undefined) state.next[key] = next;
        }
      }
    });
    this.pump();
  }

  private cancelQueued(state: RoutineState, id: string): void {
    for (const run of state.runs)
      if (run.routineId === id && run.status === "queued") {
        run.status = "cancelled";
        run.finishedAt = this.deps.now();
      }
  }

  private enqueue(
    state: RoutineState,
    routine: Routine,
    triggerIds: string[],
    event?: RoutineRun["events"][number],
  ): void {
    const pending = state.runs.find(
      (run) => run.routineId === routine.id && run.status === "queued",
    );
    if (pending) {
      if (event && pending.events.length >= 100)
        throw new Error("Routine queue is full; retry this event later");
      pending.triggerIds = [...new Set([...pending.triggerIds, ...triggerIds])];
      if (event) pending.events.push(event);
      return;
    }
    state.runs.push({
      id: this.deps.id(),
      routineId: routine.id,
      revision: routine.revision,
      triggerIds,
      events: event ? [event] : [],
      status: "queued",
      createdAt: this.deps.now(),
    });
  }

  private notifyChanged(): void {
    try {
      this.deps.changed();
    } catch (error) {
      this.deps.onError(error);
    }
  }

  private change<T>(mutate: (state: RoutineState) => T): Promise<T> {
    const operation = this.tail.then(async () => {
      if (this.stopped) throw new Error("Routine service is stopped");
      const next = structuredClone(this.state);
      const result = mutate(next);
      await this.deps.save(next);
      this.state = next;
      this.notifyChanged();
      return result;
    });
    this.tail = operation.catch(() => {});
    return operation;
  }

  private pump(): void {
    if (this.stopped) return;
    for (const pending of this.state.runs.filter(
      (run) => run.status === "queued",
    )) {
      const owner = this.state.routines.find((routine) => routine.id === pending.routineId)?.botId;
      if (
        (owner !== undefined && this.blockedBots.has(owner)) ||
        this.removing.has(pending.routineId) ||
        this.active.has(pending.routineId) ||
        this.state.runs.some(
          (run) => run.routineId === pending.routineId && run.status === "running",
        ) ||
        (this.retryAfter.get(pending.routineId) ?? 0) > this.deps.now()
      )
        continue;
      const controller = new AbortController();
      this.active.set(pending.routineId, controller);
      let succeeded = false;
      const task = this.dispatch(pending.id, controller)
        .then(() => {
          succeeded = true;
        })
        .catch((error) => {
          this.retryAfter.set(pending.routineId, this.deps.now() + 30_000);
          this.deps.onError(error);
        })
        .finally(() => {
          this.active.delete(pending.routineId);
          this.activeTasks.delete(pending.routineId);
          if (succeeded) this.pump();
        });
      this.activeTasks.set(pending.routineId, task);
    }
  }

  private async retrySettlements(): Promise<void> {
    for (const [id, settlement] of this.pendingSettlements) {
      if (
        this.active.has(settlement.routineId) ||
        (this.retryAfter.get(settlement.routineId) ?? 0) > this.deps.now()
      ) continue;
      try {
        await this.change(settlement.apply);
        this.pendingSettlements.delete(id);
      } catch (error) {
        this.retryAfter.set(settlement.routineId, this.deps.now() + 30_000);
        this.deps.onError(error);
      }
    }
  }

  private async dispatch(
    id: string,
    controller: AbortController,
  ): Promise<void> {
    const claimed = await this.change((state) => {
      const run = state.runs.find((row) => row.id === id);
      if (!run || run.status !== "queued") return null;
      const routine = state.routines.find((row) => row.id === run.routineId);
      if (!routine || this.blockedBots.has(routine.botId) || this.removing.has(routine.id) || controller.signal.aborted) {
        run.status = "cancelled";
        run.finishedAt = this.deps.now();
        return null;
      }
      run.status = "running";
      run.revision = routine.revision;
      return { routine: structuredClone(routine), run: structuredClone(run) };
    });
    if (!claimed || this.stopped) return;
    let result: {
      scheduleRunId?: string;
      error?: string;
      resultText?: string;
      deferred?: boolean;
    } = {};
    try {
      result = await this.deps.execute(
        claimed.routine,
        claimed.run,
        controller.signal,
        () => !this.stopped && !controller.signal.aborted && this.state.routines.some(
          // A disabled routine may still be run manually. Disabling/editing an
          // existing attempt changes its revision (and disabling also aborts it).
          (routine) => routine.id === claimed.routine.id && routine.revision === claimed.routine.revision,
        ),
      );
    } catch (error) {
      result.error = error instanceof Error ? error.message : String(error);
    }
    if (this.stopped) return;
    const aborted = controller.signal.aborted;
    const finishedAt = this.deps.now();
    const settle = (state: RoutineState) => {
      const run = state.runs.find((row) => row.id === id);
      if (!run) return;
      if (result.deferred && !aborted) {
        if (
          !state.routines.some(
            (routine) =>
              routine.id === run.routineId &&
              routine.revision === claimed.routine.revision,
          )
        ) {
          run.status = "cancelled";
          run.finishedAt = finishedAt;
          return;
        }
        run.status = "queued";
        this.retryAfter.set(run.routineId, this.deps.now() + 30_000);
        return;
      }
      const completed = { ...result };
      delete completed.deferred;
      Object.assign(run, completed, {
        status: aborted
          ? "cancelled"
          : result.error
            ? "failed"
            : "success",
        finishedAt,
      });
    };
    this.pendingSettlements.set(id, { routineId: claimed.routine.id, apply: settle });
    await this.change(settle);
    this.pendingSettlements.delete(id);
  }
}
