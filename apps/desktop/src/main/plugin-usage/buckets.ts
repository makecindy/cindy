import { randomUUID } from 'node:crypto';
import {
  PLUGIN_USAGE_BATCH_MAX_BYTES, PLUGIN_USAGE_BATCH_MAX_ITEMS, PLUGIN_USAGE_BUCKET_FORMAT,
  PLUGIN_USAGE_BUCKET_MAX_COUNT, PLUGIN_USAGE_BUCKET_MS, PLUGIN_USAGE_REJECTION_CODES,
  type PluginUsageBucket, type PluginUsageBucketAck,
} from '@cindy/plugin-protocol';
import type { PluginUsageReportTarget } from '../../shared/pluginUsage.js';

const ENVELOPE_BYTES = Buffer.byteLength(JSON.stringify({ format: PLUGIN_USAGE_BUCKET_FORMAT, buckets: [] }));
const DRAIN_INTERVAL_MS = 1_000;
const MAX_BACKOFF_MS = PLUGIN_USAGE_BUCKET_MS;

interface Lane {
  subjectId: string;
  target: PluginUsageReportTarget;
  open: Map<string, PluginUsageBucket>;
  sealed: Map<string, PluginUsageBucket>;
}

/** One schedule per owner. Retry entries retain their original wire identity and value. */
export class PluginUsageBuckets {
  private readonly lanes = new Map<string, Lane>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private flight: { lane: Lane; controller: AbortController } | undefined;
  private generation = 0;
  private currentScope: string | null = null;
  private flushAt = Infinity;
  private nextSendAt = 0;
  private failures = 0;
  private stopped = false;

  constructor(private readonly deps: {
    scope(): string | null;
    send(target: PluginUsageReportTarget, rows: PluginUsageBucket[], signal: AbortSignal, guard: () => void): Promise<PluginUsageBucketAck>;
    jitter?: () => number;
  }) {}

  admit(): number | null {
    const scope = this.stopped ? null : this.deps.scope();
    if (scope !== this.currentScope) {
      this.invalidate();
      this.currentScope = scope;
    }
    return scope === null ? null : this.generation;
  }

  add(admission: number | null, subjectId: string, target: PluginUsageReportTarget, releaseId: string, occurredAt: number): void {
    if (admission === null || this.admit() !== admission) return;
    const laneKey = JSON.stringify([subjectId, target]);
    let lane = this.lanes.get(laneKey);
    if (!lane) {
      lane = { subjectId, target, open: new Map(), sealed: new Map() };
      this.lanes.set(laneKey, lane);
    }
    const bucketStart = new Date(Math.floor(occurredAt / PLUGIN_USAGE_BUCKET_MS) * PLUGIN_USAGE_BUCKET_MS).toISOString();
    const key = JSON.stringify([releaseId, bucketStart]);
    const pending = lane.open.get(key);
    if (pending?.count === PLUGIN_USAGE_BUCKET_MAX_COUNT) lane.sealed.set(pending.eventId, pending);
    if (pending && pending.count < PLUGIN_USAGE_BUCKET_MAX_COUNT) pending.count++;
    else lane.open.set(key, { eventId: randomUUID(), releaseId, bucketStart, count: 1 });
    if (this.flushAt === Infinity) {
      this.flushAt = performance.now() + PLUGIN_USAGE_BUCKET_MS + (this.deps.jitter?.() ?? Math.floor(Math.random() * 30_000));
    }
    this.schedule();
  }

  invalidate(): void {
    this.generation++;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.flight?.controller.abort();
    this.lanes.clear();
    this.flushAt = Infinity;
    this.nextSendAt = 0;
    this.failures = 0;
  }

  clearSubject(subjectId: string): void {
    for (const [key, lane] of this.lanes) {
      if (lane.subjectId === subjectId) this.lanes.delete(key);
    }
    if (this.flight?.lane.subjectId === subjectId) this.flight.controller.abort();
    if (!this.lanes.size) {
      clearTimeout(this.timer);
      this.timer = undefined;
      this.flushAt = Infinity;
    }
  }

  stop(): void {
    this.stopped = true;
    this.invalidate();
  }

  private schedule(): void {
    if (this.flight || this.timer || !this.lanes.size) return;
    const hasSealed = [...this.lanes.values()].some(lane => lane.sealed.size);
    const runAt = Math.max(this.nextSendAt, hasSealed ? 0 : this.flushAt);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.drain();
    }, Math.max(0, Math.min(runAt - performance.now(), 2_147_483_647)));
    this.timer.unref?.();
  }

  private async drain(): Promise<void> {
    const admission = this.admit();
    if (admission === null) return;
    const now = performance.now();
    if (now >= this.flushAt) {
      for (const lane of this.lanes.values()) {
        for (const row of lane.open.values()) lane.sealed.set(row.eventId, row);
        lane.open.clear();
      }
      this.flushAt = Infinity;
    }
    if (now < this.nextSendAt) { this.schedule(); return; }
    const lane = [...this.lanes.values()].find(item => item.sealed.size);
    if (!lane) { this.schedule(); return; }
    const rows: PluginUsageBucket[] = [];
    let bytes = ENVELOPE_BYTES;
    for (const row of lane.sealed.values()) {
      const addedBytes = Buffer.byteLength(JSON.stringify(row)) + (rows.length ? 1 : 0);
      if (rows.length === PLUGIN_USAGE_BATCH_MAX_ITEMS || bytes + addedBytes > PLUGIN_USAGE_BATCH_MAX_BYTES) break;
      rows.push(row);
      bytes += addedBytes;
    }
    // Market release identifiers are bounded by the installed-release parser.
    if (!rows.length) {
      this.nextSendAt = now + MAX_BACKOFF_MS;
      this.schedule();
      return;
    }
    const controller = new AbortController();
    const key = JSON.stringify([lane.subjectId, lane.target]);
    this.flight = { lane, controller };
    const guard = () => {
      if (this.admit() !== admission) throw new Error('Plugin usage reporting scope changed');
      controller.signal.throwIfAborted();
    };
    let retryAt = 0;
    let retry = false;
    try {
      const ack = await this.deps.send(lane.target, rows, controller.signal, guard);
      guard();
      const confirmed = new Set([...ack.accepted, ...ack.duplicate].map(row => row.eventId));
      for (const row of ack.rejected) {
        if ((PLUGIN_USAGE_REJECTION_CODES as readonly string[]).includes(row.code)) confirmed.add(row.eventId);
      }
      for (const id of confirmed) lane.sealed.delete(id);
      retry = confirmed.size < rows.length;
    } catch (error) {
      retry = true;
      const deadline = (error as { retryAt?: unknown } | null)?.retryAt;
      if (typeof deadline === 'number' && Number.isFinite(deadline)) retryAt = deadline;
    } finally {
      this.flight = undefined;
      if (this.admit() === admission && this.lanes.get(key) === lane) {
        this.lanes.delete(key);
        if (lane.open.size || lane.sealed.size) this.lanes.set(key, lane);
        this.failures = retry ? Math.min(this.failures + 1, 5) : 0;
        const pause = retry ? Math.min(30_000 * 2 ** this.failures, MAX_BACKOFF_MS) : DRAIN_INTERVAL_MS;
        this.nextSendAt = performance.now() + Math.max(pause, retryAt - Date.now());
      }
      this.schedule();
    }
  }
}
