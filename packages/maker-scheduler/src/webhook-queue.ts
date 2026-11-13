import type { Schedule, ScheduleWebhookEvent } from './types.js';

/** Host policy, not user-configurable: bursts from one push collapse and wake at most once per gap. */
export const SCHEDULE_WEBHOOK_LIMITS = {
  debounceMs: 15_000,
  minGapMs: 5 * 60_000,
  retryMs: 30_000,
  batchEvents: 20,
  receiptsPerSchedule: 2_000,
  receiptTtlMs: 24 * 60 * 60_000,
} as const;

export interface ScheduleWebhookEndpointState {
  /** Local trigger identity; optional for queue files from earlier versions. */
  endpointId?: string;
  pending: ScheduleWebhookEvent[];
  /** Still recoverable until the durable run hands off to actual execution. */
  preparing?: { events: ScheduleWebhookEvent[]; omitted: number; firstPendingAt?: number };
  /** Events merged into the pending batch but dropped from its detail list. */
  omitted: number;
  firstPendingAt?: number;
  lastStartedAt?: number;
  lastReceivedAt?: number;
  received: number;
  ignored: number;
  receipts: Record<string, number>;
}

export interface ScheduleWebhookQueueState {
  port?: number;
  endpoints: Record<string, ScheduleWebhookEndpointState>;
}

type RetryBatch = NonNullable<ScheduleWebhookEndpointState['preparing']> & { endpointId?: string; previousStartedAt?: number };

export interface ScheduleWebhookQueueDeps {
  load(): Promise<ScheduleWebhookQueueState>;
  /** Must be durable before it resolves: delivery is acknowledged after this. */
  save(state: ScheduleWebhookQueueState): Promise<void>;
  getSchedule(id: string): Promise<Schedule | null>;
  isBusy(id: string): boolean;
  /** Await onRunCreated after persisting the run and before dispatch. A rejected
   * handoff must prevent dispatch. `deferred` means no effects and permits retry. */
  fire(id: string, batch: { events: ScheduleWebhookEvent[]; omitted: number }, onRunCreated: () => Promise<void>): Promise<{ deferred?: boolean }>;
  now(): number;
  onError?(message: string, detail: Record<string, unknown>): void;
}

export type ScheduleWebhookAcceptResult = 'queued' | 'duplicate' | 'ignored' | 'filtered';

const emptyEndpoint = (): ScheduleWebhookEndpointState => ({ pending: [], omitted: 0, received: 0, ignored: 0, receipts: {} });

/** The configured name of an event, either `event` or `event.action`. */
export function scheduleWebhookEventMatches(allowed: readonly string[] | undefined, event: Pick<ScheduleWebhookEvent, 'event' | 'action'>): boolean {
  if (!allowed?.length) return true;
  return allowed.includes(event.event) || (event.action !== undefined && allowed.includes(`${event.event}.${event.action}`));
}

function matchesTrigger(trigger: Schedule['webhookTrigger'], event: ScheduleWebhookEvent): boolean {
  const source = trigger?.source;
  return scheduleWebhookEventMatches(trigger?.events, event)
    && (source?.preset !== 'github-app' || source.repositories.some(repo => repo.toLowerCase() === event.repository?.toLowerCase()));
}

function canReceive(schedule: Schedule | null, now: number): schedule is Schedule {
  return Boolean(schedule?.webhookTrigger) && schedule?.status === 'active' && !(schedule.expireAt !== undefined && schedule.expireAt <= now);
}

/**
 * Durable per-schedule doorbell. An accepted event survives restart until its run starts; a started
 * run is not replayed, because the host cannot prove it produced no external side effects.
 */
export class ScheduleWebhookQueue {
  private state: ScheduleWebhookQueueState = { endpoints: {} };
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly running = new Set<string>();
  private readonly cancelled = new Set<string>();
  // A known no-effects deferral may outlive a failed restore write. Retain it
  // until the next successful transaction, without replaying started runs on restart.
  private readonly retries = new Map<string, RetryBatch>();
  private writes: Promise<unknown> = Promise.resolve();
  private stopped = true;

  constructor(private readonly deps: ScheduleWebhookQueueDeps) {}

  async start(): Promise<void> {
    this.state = await this.deps.load();
    this.stopped = false;
    for (const id of Object.keys(this.state.endpoints)) this.arm(id);
  }

  stop(): void {
    this.stopped = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  ids(): string[] {
    return Object.keys(this.state.endpoints);
  }

  get port(): number | undefined {
    return this.state.port;
  }

  async setPort(port: number): Promise<void> {
    if (this.state.port === port) return;
    await this.mutate(state => { state.port = port; });
  }

  snapshot(id: string): Pick<ScheduleWebhookEndpointState, 'lastReceivedAt' | 'received' | 'ignored'> {
    const { lastReceivedAt, received = 0, ignored = 0 } = this.state.endpoints[id] ?? {};
    return { lastReceivedAt, received, ignored };
  }

  /** Reachability only (ping, or an event outside the filter); kept in memory until the next save. */
  touch(id: string): void {
    (this.state.endpoints[id] ??= emptyEndpoint()).lastReceivedAt = this.deps.now();
  }

  async accept(id: string, event: ScheduleWebhookEvent): Promise<ScheduleWebhookAcceptResult> {
    return (await this.acceptBatch(id, [event]))[0]!;
  }

  /** Details, receipts and upstream omitted counts form one durable admission. */
  async acceptBatch(id: string, events: ScheduleWebhookEvent[], omitted = 0, expectedEndpointId?: string): Promise<ScheduleWebhookAcceptResult[]> {
    if (this.stopped) throw new Error('schedule webhook queue is stopped');
    const results = await this.mutate(async state => {
      // Read after earlier writes finish, not from the host's asynchronous cache.
      const schedule = await this.deps.getSchedule(id);
      const now = this.deps.now();
      const endpointId = schedule?.webhookTrigger?.endpointId;
      if (expectedEndpointId && endpointId !== expectedEndpointId) return events.map(() => 'ignored' as const);
      const endpoint = state.endpoints[id] ??= emptyEndpoint();
      if (endpointId && endpoint.endpointId && endpoint.endpointId !== endpointId) {
        this.discardPending(endpoint);
        endpoint.receipts = {};
      }
      if (endpointId) endpoint.endpointId = endpointId;
      endpoint.lastReceivedAt = now;
      const results = events.map((event): ScheduleWebhookAcceptResult => {
        if (endpoint.receipts[event.deliveryId] !== undefined && now - endpoint.receipts[event.deliveryId] < SCHEDULE_WEBHOOK_LIMITS.receiptTtlMs) return 'duplicate';
        if (!matchesTrigger(schedule?.webhookTrigger, event)) return 'filtered';
        const result = canReceive(schedule, now) ? 'queued' : 'ignored';
        if (result === 'queued') {
          endpoint.received += 1;
          endpoint.pending.push(event);
          endpoint.firstPendingAt ??= now;
          this.capPending(endpoint);
        } else {
          endpoint.ignored += 1;
        }
        endpoint.receipts[event.deliveryId] = now;
        return result;
      });
      if (results.includes('queued') && omitted > 0) endpoint.omitted += omitted;
      this.pruneReceipts(endpoint, now);
      return results;
    });
    if (results.includes('queued')) this.arm(id);
    return results;
  }

  /** Called when a schedule was deleted or its trigger removed. */
  async forget(id: string): Promise<void> {
    if (this.running.has(id)) this.cancelled.add(id);
    if (!this.state.endpoints[id]) return;
    const timer = this.timers.get(id);
    if (timer) clearTimeout(timer);
    this.timers.delete(id);
    await this.mutate(state => { delete state.endpoints[id]; });
    this.retries.delete(id);
  }

  private capPending(endpoint: ScheduleWebhookEndpointState): void {
    const excess = endpoint.pending.length - SCHEDULE_WEBHOOK_LIMITS.batchEvents;
    if (excess <= 0) return;
    endpoint.pending.splice(0, excess);
    endpoint.omitted += excess;
  }

  /** Eviction instead of rejection: a forgotten receipt costs at most one extra coalesced wake. */
  private pruneReceipts(endpoint: ScheduleWebhookEndpointState, now: number): void {
    const live = Object.entries(endpoint.receipts).filter(([, at]) => now - at < SCHEDULE_WEBHOOK_LIMITS.receiptTtlMs);
    const kept = live.length > SCHEDULE_WEBHOOK_LIMITS.receiptsPerSchedule
      ? live.sort((a, b) => a[1] - b[1]).slice(live.length - SCHEDULE_WEBHOOK_LIMITS.receiptsPerSchedule)
      : live;
    endpoint.receipts = Object.fromEntries(kept);
  }

  private mutate<T>(change: (state: ScheduleWebhookQueueState) => T | Promise<T>): Promise<T> {
    // Serialize read/modify/save, not just writes: failures must leave both the
    // committed state and later arrivals intact, without rollback over a newer event.
    const write = this.writes.catch(() => undefined).then(async () => {
      const snapshot = structuredClone(this.state);
      const retries = [...this.retries];
      for (const [id, batch] of retries) {
        const endpoint = snapshot.endpoints[id];
        if (!endpoint || endpoint.endpointId !== batch.endpointId) continue;
        endpoint.preparing ??= batch;
        this.restorePreparing(endpoint);
        endpoint.lastStartedAt = batch.previousStartedAt;
      }
      const result = await change(snapshot);
      await this.deps.save(snapshot);
      this.state = snapshot;
      for (const [id, batch] of retries) {
        if (this.retries.get(id) === batch) this.retries.delete(id);
      }
      return result;
    });
    this.writes = write;
    return write;
  }

  private arm(id: string, atLeastMs = 0): void {
    const endpoint = this.state.endpoints[id];
    if (this.stopped || !endpoint || (!endpoint.pending.length && !endpoint.preparing && !this.retries.has(id)) || this.running.has(id)) return;
    const now = this.deps.now();
    const retry = this.retries.get(id);
    const dueAt = Math.max(
      (retry?.firstPendingAt ?? endpoint.preparing?.firstPendingAt ?? endpoint.firstPendingAt ?? now) + SCHEDULE_WEBHOOK_LIMITS.debounceMs,
      ((retry ? retry.previousStartedAt : endpoint.lastStartedAt) ?? 0) + SCHEDULE_WEBHOOK_LIMITS.minGapMs,
      now + atLeastMs,
    );
    const previous = this.timers.get(id);
    if (previous) clearTimeout(previous);
    const timer = setTimeout(() => {
      this.timers.delete(id);
      void this.pump(id).catch((error) => {
        this.deps.onError?.('schedule webhook pump failed', { scheduleId: id, error: String(error) });
        this.arm(id, SCHEDULE_WEBHOOK_LIMITS.retryMs);
      });
    }, Math.max(0, dueAt - now));
    timer.unref?.();
    this.timers.set(id, timer);
  }

  private async pump(id: string): Promise<void> {
    if (this.stopped || this.running.has(id)) return;
    this.running.add(id);
    let retry = true;
    try {
      const schedule = await this.deps.getSchedule(id);
      if (this.stopped || this.deps.isBusy(id)) return;
      const batch = await this.mutate(state => {
        const endpoint = state.endpoints[id];
        if (!endpoint) return;
        // Earlier queue files have no identity; retain their existing recovery
        // behavior. Newly accepted batches always retain their own route id.
        endpoint.endpointId ??= schedule?.webhookTrigger?.endpointId;
        // A previous preparation failed, or the process exited before handoff.
        this.restorePreparing(endpoint);
        if (!canReceive(schedule, this.deps.now()) || endpoint.endpointId !== schedule.webhookTrigger?.endpointId) {
          this.discardPending(endpoint);
          return;
        }
        if (schedule.webhookTrigger?.source?.preset === 'github-app') {
          // Recheck restored data too: earlier test builds persisted unscoped
          // github.reconcile markers that must never bypass selected filters.
          const retained = endpoint.pending.filter(event => matchesTrigger(schedule.webhookTrigger, event));
          endpoint.ignored += endpoint.pending.length - retained.length;
          endpoint.pending = retained;
          if (!retained.length) {
            endpoint.omitted = 0;
            endpoint.firstPendingAt = undefined;
          }
        }
        if (!endpoint.pending.length) return;
        const preparing = { events: endpoint.pending, omitted: endpoint.omitted, firstPendingAt: endpoint.firstPendingAt };
        endpoint.preparing = preparing;
        endpoint.pending = [];
        endpoint.omitted = 0;
        endpoint.firstPendingAt = undefined;
        return { ...preparing, endpointId: endpoint.endpointId, previousStartedAt: endpoint.lastStartedAt };
      });
      if (!batch || this.stopped || this.cancelled.has(id)) return;
      let handedOff = false;
      let discarded = false;
      try {
        const result = await this.deps.fire(id, { events: batch.events, omitted: batch.omitted }, async () => {
          // Remote refresh and run persistence may outlive the earlier check.
          // Re-read at the durable handoff, before the caller can dispatch.
          const latest = await this.deps.getSchedule(id);
          const accepted = await this.mutate(state => {
            const current = state.endpoints[id];
            if (this.stopped) throw new Error('webhook batch cancelled before dispatch');
            if (this.cancelled.has(id) || !current?.preparing || current.endpointId !== batch.endpointId) return false;
            if (!canReceive(latest, this.deps.now()) || latest.webhookTrigger?.endpointId !== batch.endpointId) {
              current.ignored += current.preparing.events.length + current.preparing.omitted;
              current.preparing = undefined;
              return false;
            }
            current.preparing = undefined;
            current.lastStartedAt = this.deps.now();
            return true;
          });
          discarded = !accepted || this.cancelled.has(id);
          if (discarded) throw new Error('schedule webhook no longer active before dispatch');
          handedOff = true;
        });
        retry = !discarded && !this.cancelled.has(id) && (Boolean(result.deferred) || !handedOff);
      } catch (error) {
        retry = !discarded && !this.cancelled.has(id) && !handedOff;
        if (!discarded) this.deps.onError?.('schedule webhook run failed', { scheduleId: id, error: String(error) });
      }
      if (retry && !this.stopped) {
        this.retries.set(id, batch);
        await this.mutate(() => undefined);
      }
    } finally {
      this.running.delete(id);
      this.cancelled.delete(id);
      this.arm(id, retry ? SCHEDULE_WEBHOOK_LIMITS.retryMs : 0);
    }
  }

  private discardPending(endpoint: ScheduleWebhookEndpointState): void {
    endpoint.ignored += endpoint.pending.length + endpoint.omitted
      + (endpoint.preparing?.events.length ?? 0) + (endpoint.preparing?.omitted ?? 0);
    endpoint.pending = [];
    endpoint.omitted = 0;
    endpoint.firstPendingAt = undefined;
    endpoint.preparing = undefined;
  }

  private restorePreparing(endpoint: ScheduleWebhookEndpointState): void {
    const batch = endpoint.preparing;
    if (!batch) return;
    endpoint.pending = [...batch.events, ...endpoint.pending];
    endpoint.omitted += batch.omitted;
    endpoint.firstPendingAt = batch.firstPendingAt ?? endpoint.firstPendingAt;
    endpoint.preparing = undefined;
    this.capPending(endpoint);
  }
}
