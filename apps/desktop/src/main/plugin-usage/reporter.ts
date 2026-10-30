import {
  PLUGIN_USAGE_REJECTION_CODES,
  type PluginUsageAck,
  type PluginUsageEventInput,
} from '@cindy/plugin-protocol';
import type {
  PluginUsageIdentity,
  PluginUsageReportRow,
  PluginUsageReportTarget,
} from '../../shared/pluginUsage.js';

export interface PluginUsageReporting {
  allowed(): boolean;
  target(identity: PluginUsageIdentity): PluginUsageReportTarget | null;
  canSend(target: PluginUsageReportTarget): boolean;
  send(
    target: PluginUsageReportTarget,
    events: PluginUsageEventInput[],
    assertCurrent: () => void,
  ): Promise<PluginUsageAck>;
}

export interface UsageReportUpdate {
  row: PluginUsageReportRow;
  state: 'pending' | 'sent' | 'rejected';
  nextAttemptAt: number | null;
}

/** One bounded background chain per active owner; network work never holds the DB write queue. */
export class PluginUsageReporter {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private stopped = false;
  private revision = 0;
  private wakeRequested = false;
  private wakeAt = 0;
  private batchLimit = 100;

  constructor(
    private readonly deps: {
      reporting: PluginUsageReporting;
      isCurrent(): boolean;
      now(): number;
      select(): Promise<{ rows: PluginUsageReportRow[]; nextAttemptAt: number } | null>;
      revalidate(rows: PluginUsageReportRow[]): Promise<PluginUsageReportRow[]>;
      update(updates: UsageReportUpdate[], valid: () => boolean): Promise<void>;
      warn(): void;
    },
  ) {}

  wake(delayMs = 2_500): void {
    if (this.stopped || !this.deps.isCurrent()) return;
    if (this.running) {
      this.wakeRequested = true;
      return;
    }
    const wakeAt = this.deps.now() + delayMs;
    if (this.timer && this.wakeAt <= wakeAt) return;
    if (this.timer) clearTimeout(this.timer);
    this.wakeAt = wakeAt;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.run();
    }, delayMs);
    this.timer.unref?.();
  }

  invalidate(): void {
    this.revision += 1;
    this.wake();
  }

  stop(): void {
    this.stopped = true;
    this.revision += 1;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private async run(): Promise<void> {
    if (this.stopped || !this.deps.isCurrent()) return;
    if (!this.deps.reporting.allowed()) {
      this.wake(60_000);
      return;
    }
    this.running = true;
    this.wakeRequested = false;
    const revision = this.revision;
    const valid = () =>
      !this.stopped &&
      this.revision === revision &&
      this.deps.isCurrent() &&
      this.deps.reporting.allowed();
    let nextDelay: number | null = null;
    try {
      const batch = await this.deps.select();
      if (!batch || !valid()) return;
      if (batch.nextAttemptAt > this.deps.now()) {
        nextDelay = Math.min(batch.nextAttemptAt - this.deps.now(), 60_000);
        return;
      }
      const rows = await this.deps.revalidate(batch.rows.slice(0, this.batchLimit));
      if (!rows.length || !valid()) {
        nextDelay = 1_000;
        return;
      }
      let target: PluginUsageReportTarget | null;
      try {
        target = JSON.parse(rows[0].reportTarget) as PluginUsageReportTarget;
      } catch {
        target = null;
      }
      if (!target || !this.deps.reporting.canSend(target)) {
        await this.deps.update(
          rows.map((row) => ({ row, state: 'pending', nextAttemptAt: this.deps.now() + 300_000 })),
          valid,
        );
        nextDelay = 1_000;
        return;
      }
      const assertCurrent = () => {
        if (!valid() || !this.deps.reporting.canSend(target))
          throw new Error('Plugin usage reporting context changed');
      };
      const events = rows.map((row) => ({
        eventId: row.callId,
        releaseId: row.releaseId,
        occurredAt: new Date(row.occurredAt).toISOString(),
      }));
      let updates: UsageReportUpdate[];
      try {
        assertCurrent();
        const ack = await this.deps.reporting.send(target, events, assertCurrent);
        if (!valid()) return;
        const confirmed = new Set([...ack.accepted, ...ack.duplicate]);
        const rejected = new Set(
          ack.rejected
            .filter((row) => (PLUGIN_USAGE_REJECTION_CODES as readonly string[]).includes(row.code))
            .map((row) => row.eventId),
        );
        updates = rows.map((row) => ({
          row,
          state: confirmed.has(row.callId)
            ? 'sent'
            : rejected.has(row.callId)
              ? 'rejected'
              : 'pending',
          nextAttemptAt:
            confirmed.has(row.callId) || rejected.has(row.callId) ? null : this.deps.now() + 60_000,
        }));
      } catch (error) {
        if (!valid()) return;
        const status =
          error && typeof error === 'object' && 'statusCode' in error ? error.statusCode : null;
        const reduceBatch = status === 413 && rows.length > 1;
        if (reduceBatch) this.batchLimit = Math.max(1, Math.floor(rows.length / 2));
        const minimum =
          status === 401 || status === 403 || status === 404 || status === 405 ? 300_000 : 60_000;
        updates = rows.map((row) => ({
          row,
          state: 'pending',
          nextAttemptAt:
            this.deps.now() +
            (reduceBatch
              ? 2_500
              : Math.min(3_600_000, minimum * 2 ** Math.min(row.attemptCount, 6))),
        }));
      }
      await this.deps.update(updates, valid);
      nextDelay = 2_500;
    } catch {
      if (valid()) {
        this.deps.warn();
        nextDelay = 60_000;
      }
    } finally {
      this.running = false;
      if (!this.stopped && this.deps.isCurrent()) {
        if (this.wakeRequested || revision !== this.revision) this.wake();
        else if (nextDelay !== null) this.wake(nextDelay);
        else if (!this.deps.reporting.allowed()) this.wake(60_000);
      }
    }
  }
}
