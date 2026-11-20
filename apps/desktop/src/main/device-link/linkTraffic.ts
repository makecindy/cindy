import type { LinkTrafficBytes, LinkTrafficSnapshot, LinkTrafficTotals } from '../../shared/deviceLinkIpc';

/** Fifteen-second buckets bound the 24-hour history to 5,760 rows, including on a busy relay. */
const BUCKET_MS = 15_000;
export const TICKS_PER_HOUR = 3_600_000 / BUCKET_MS;
const DAY = 24 * TICKS_PER_HOUR;
const nowTick = () => Math.floor(Date.now() / BUCKET_MS);
type Protocol = keyof LinkTrafficTotals;
export type TrafficBucket = [tick: number, linkSent: number, linkReceived: number, netSent: number, netReceived: number];

export interface LinkTrafficHistory {
  read(): Promise<TrafficBucket[]>;
  mergeHour(hour: number, deltas: TrafficBucket[]): Promise<TrafficBucket[]>;
  onError(error: unknown): void;
  onActivity?(meter: LinkTrafficMeter, active: boolean): void;
}

function recent(tick: number, now: number): boolean { return tick > now - DAY && tick <= now; }

export function readTrafficBuckets(value: unknown): TrafficBucket[] {
  if (!Array.isArray(value) || value.length > TICKS_PER_HOUR) return [];
  const now = nowTick();
  return value.filter((row): row is TrafficBucket => Array.isArray(row) && row.length === 5
    && row.every(n => Number.isSafeInteger(n) && n >= 0) && recent(row[0], now));
}

function addBucket(rows: Map<number, TrafficBucket>, row: TrafficBucket): void {
  const slot = row[0] % DAY, previous = rows.get(slot);
  if (previous?.[0] === row[0]) {
    for (let i = 1; i < row.length; i++) previous[i] += row[i];
  } else if (!previous || previous[0] < row[0]) rows.set(slot, [...row]);
}

export function mergeTrafficBuckets(saved: TrafficBucket[], deltas: TrafficBucket[]): TrafficBucket[] {
  const now = nowTick(), rows = new Map<number, TrafficBucket>();
  for (const group of [saved, deltas]) for (const row of group) {
    if (recent(row[0], now)) addBucket(rows, row);
  }
  return [...rows.values()];
}

function totals(): LinkTrafficTotals {
  return { 'device-link': { sent: 0, received: 0 }, 'agent-net': { sent: 0, received: 0 } };
}

function sum(total: LinkTrafficTotals, row: TrafficBucket): void {
  total['device-link'].sent += row[1];
  total['device-link'].received += row[2];
  total['agent-net'].sent += row[3];
  total['agent-net'].received += row[4];
}

/** Per-owner, local transport counters. Snapshots remain entirely in memory while a checkpoint is being written. */
export class LinkTrafficMeter {
  private saved: TrafficBucket[];
  private readonly pending = new Map<number, TrafficBucket>();
  private readonly saving = new Map<number, TrafficBucket[]>();
  private loading?: Promise<void>;
  private initialized = false;
  private nextRefresh = 0;
  private writing?: Promise<void>;
  private checkpoint?: ReturnType<typeof setTimeout>;
  private readonly sources = new Set<() => void>();
  private timer?: ReturnType<typeof setInterval>;

  constructor(private readonly history?: LinkTrafficHistory) {
    this.saved = [];
    if (history) this.refresh();
  }

  private refresh(): void {
    if (!this.history || this.loading || this.writing || Date.now() < this.nextRefresh) return;
    this.nextRefresh = Date.now() + 60_000;
    this.loading = this.history.read().then(rows => { this.saved = rows; }, this.history.onError)
      .finally(() => { this.initialized = true; this.loading = undefined; });
  }

  private updateActivity(): void {
    this.history?.onActivity?.(this, Boolean(this.sources.size || this.pending.size || this.saving.size));
  }

  record(protocol: Protocol, sent: number, received: number): void {
    if (!(sent || received) || !Number.isSafeInteger(sent) || sent < 0 || !Number.isSafeInteger(received) || received < 0) return;
    const tick = nowTick();
    addBucket(this.pending, protocol === 'device-link' ? [tick, sent, received, 0, 0] : [tick, 0, 0, sent, received]);
    this.scheduleCheckpoint();
  }

  private scheduleCheckpoint(): void {
    if (!this.history || this.checkpoint) return;
    this.updateActivity();
    this.checkpoint = setTimeout(() => { void this.flush(); }, 60_000).unref();
  }

  async flush(): Promise<void> {
    clearTimeout(this.checkpoint);
    this.checkpoint = undefined;
    this.sample();
    while (this.loading || this.writing) await (this.loading ?? this.writing);
    if (!this.history || !this.pending.size) return;
    for (const row of this.pending.values()) {
      const hour = Math.floor(row[0] / TICKS_PER_HOUR);
      const group = this.saving.get(hour);
      if (group) group.push(row);
      else this.saving.set(hour, [row]);
    }
    this.pending.clear();
    this.writing = this.saveHours(this.history).finally(() => { this.writing = undefined; });
    await this.writing;
    this.updateActivity();
  }

  private async saveHours(history: LinkTrafficHistory): Promise<void> {
    for (const [hour, deltas] of this.saving) {
      try {
        const committed = await history.mergeHour(hour, deltas);
        const now = nowTick();
        this.saved = this.saved.filter(row => recent(row[0], now) && Math.floor(row[0] / TICKS_PER_HOUR) !== hour).concat(committed);
      } catch (error) {
        for (const row of deltas) addBucket(this.pending, row);
        history.onError(error);
        this.scheduleCheckpoint();
      }
      this.saving.delete(hour);
    }
  }

  /** The socket/worker owns a cumulative counter. On close, take its final reading before removing it. */
  track(protocol: Protocol, read: () => LinkTrafficBytes): () => void {
    let last = { sent: 0, received: 0 };
    const sample = () => {
      const next = read();
      this.record(protocol, next.sent - last.sent, next.received - last.received);
      last = next;
    };
    this.sources.add(sample);
    this.updateActivity();
    this.timer ??= setInterval(() => this.sample(), 2_000).unref();
    return () => {
      if (!this.sources.delete(sample)) return;
      sample();
      this.updateActivity();
      if (!this.sources.size) {
        clearInterval(this.timer);
        this.timer = undefined;
      }
    };
  }

  private sample(): void {
    for (const read of this.sources) read();
  }

  snapshot(): LinkTrafficSnapshot | undefined {
    this.refresh();
    if (this.history && !this.initialized) return undefined;
    const now = nowTick();
    const snapshot = { last5m: totals(), lastHour: totals(), lastDay: totals() };
    for (const rows of [this.saved, ...this.saving.values(), this.pending.values()]) for (const row of rows) {
      if (!recent(row[0], now)) continue;
      sum(snapshot.lastDay, row);
      if (row[0] > now - TICKS_PER_HOUR) sum(snapshot.lastHour, row);
      if (row[0] > now - 300_000 / BUCKET_MS) sum(snapshot.last5m, row);
    }
    return snapshot;
  }
}
