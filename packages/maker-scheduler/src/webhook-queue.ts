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
  pending: ScheduleWebhookEvent[];
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

export interface ScheduleWebhookQueueDeps {
  load(): Promise<ScheduleWebhookQueueState>;
  /** Must be durable before it resolves: delivery is acknowledged after this. */
  save(state: ScheduleWebhookQueueState): Promise<void>;
  getSchedule(id: string): Promise<Schedule | null>;
  isBusy(id: string): boolean;
  /** Resolves when the run ends. `deferred` means it never ran and the batch must be kept. */
  fire(id: string, batch: { events: ScheduleWebhookEvent[]; omitted: number }): Promise<{ deferred?: boolean }>;
  now(): number;
  onError?(message: string, detail: Record<string, unknown>): void;
}

export type ScheduleWebhookAcceptResult = 'queued' | 'duplicate' | 'ignored';

const emptyEndpoint = (): ScheduleWebhookEndpointState => ({ pending: [], omitted: 0, received: 0, ignored: 0, receipts: {} });

/** The configured name of an event, either `event` or `event.action`. */
export function scheduleWebhookEventMatches(allowed: readonly string[] | undefined, event: Pick<ScheduleWebhookEvent, 'event' | 'action'>): boolean {
  if (!allowed?.length) return true;
  return allowed.includes(event.event) || (event.action !== undefined && allowed.includes(`${event.event}.${event.action}`));
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
    this.state.port = port;
    await this.persist();
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
    if (this.stopped) throw new Error('schedule webhook queue is stopped');
    const now = this.deps.now();
    const schedule = await this.deps.getSchedule(id);
    const previous = this.state.endpoints[id];
    const endpoint: ScheduleWebhookEndpointState = previous
      ? { ...previous, pending: [...previous.pending], receipts: { ...previous.receipts } }
      : emptyEndpoint();
    endpoint.lastReceivedAt = now;
    if (endpoint.receipts[event.deliveryId] !== undefined && now - endpoint.receipts[event.deliveryId] < SCHEDULE_WEBHOOK_LIMITS.receiptTtlMs) return 'duplicate';
    const result: ScheduleWebhookAcceptResult = canReceive(schedule, now) ? 'queued' : 'ignored';
    if (result === 'queued') {
      endpoint.received += 1;
      endpoint.pending.push(event);
      endpoint.firstPendingAt ??= now;
      this.capPending(endpoint);
    } else {
      endpoint.ignored += 1;
    }
    endpoint.receipts[event.deliveryId] = now;
    this.pruneReceipts(endpoint, now);
    this.state.endpoints[id] = endpoint;
    try {
      await this.persist();
    } catch (error) {
      // Not acknowledged, so a redelivery must still be accepted.
      if (previous) this.state.endpoints[id] = previous;
      else delete this.state.endpoints[id];
      throw error;
    }
    if (result === 'queued') this.arm(id);
    return result;
  }

  /** Events merged upstream whose details were already dropped; they count towards the next batch only. */
  async addOmitted(id: string, count: number): Promise<void> {
    const endpoint = this.state.endpoints[id];
    if (count <= 0 || this.stopped || !endpoint) return;
    endpoint.omitted += count;
    await this.persist();
  }

  /** Called when a schedule was deleted or its trigger removed. */
  async forget(id: string): Promise<void> {
    if (!this.state.endpoints[id]) return;
    const timer = this.timers.get(id);
    if (timer) clearTimeout(timer);
    this.timers.delete(id);
    delete this.state.endpoints[id];
    await this.persist();
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

  private persist(): Promise<void> {
    const snapshot = structuredClone(this.state);
    const write = this.writes.catch(() => undefined).then(() => this.deps.save(snapshot));
    this.writes = write;
    return write;
  }

  private arm(id: string, atLeastMs = 0): void {
    const endpoint = this.state.endpoints[id];
    if (this.stopped || !endpoint?.pending.length || this.running.has(id)) return;
    const now = this.deps.now();
    const dueAt = Math.max(
      (endpoint.firstPendingAt ?? now) + SCHEDULE_WEBHOOK_LIMITS.debounceMs,
      (endpoint.lastStartedAt ?? 0) + SCHEDULE_WEBHOOK_LIMITS.minGapMs,
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
    const schedule = await this.deps.getSchedule(id);
    // accept() replaces the endpoint object, so read it only after the await.
    const endpoint = this.state.endpoints[id];
    if (this.stopped || !endpoint?.pending.length) return;
    const now = this.deps.now();
    if (!canReceive(schedule, now)) {
      endpoint.ignored += endpoint.pending.length + endpoint.omitted;
      endpoint.pending = [];
      endpoint.omitted = 0;
      endpoint.firstPendingAt = undefined;
      await this.persist();
      return;
    }
    // A cron run already in flight has no overlap guard against runNow; wait for it instead.
    if (this.deps.isBusy(id)) {
      this.arm(id, SCHEDULE_WEBHOOK_LIMITS.retryMs);
      return;
    }
    const batch = { events: endpoint.pending, omitted: endpoint.omitted };
    const previousStartedAt = endpoint.lastStartedAt;
    endpoint.pending = [];
    endpoint.omitted = 0;
    endpoint.firstPendingAt = undefined;
    endpoint.lastStartedAt = now;
    await this.persist();
    this.running.add(id);
    let retry = false;
    try {
      const { deferred } = await this.deps.fire(id, batch);
      // Events may have arrived during the run; forget() may have removed the endpoint.
      const current = this.state.endpoints[id];
      if (deferred && current) {
        // The target was busy and nothing ran: put the batch back ahead of anything newer.
        current.pending = [...batch.events, ...current.pending];
        current.omitted += batch.omitted;
        current.firstPendingAt = now;
        current.lastStartedAt = previousStartedAt;
        this.capPending(current);
        await this.persist();
        retry = true;
      }
    } catch (error) {
      // The failed run is visible in history; never re-execute it automatically.
      this.deps.onError?.('schedule webhook run failed', { scheduleId: id, error: String(error) });
    } finally {
      this.running.delete(id);
      this.arm(id, retry ? SCHEDULE_WEBHOOK_LIMITS.retryMs : 0);
    }
  }
}
