import { randomUUID } from 'node:crypto';
import type { DbClient } from '../localDb/client/DbClient.js';
import { runAsBackgroundDbRpc } from '../localDb/client/rpcAdmission.js';
import type {
  PluginUsageHandle,
  PluginUsageIdentity,
  PluginUsageOutcome,
  PluginUsageSummary,
  PluginUsageTransaction,
  PluginUsageReportRow,
  PluginUsageEntryKind,
} from '../../shared/pluginUsage.js';
import { PluginUsageReporter, type PluginUsageReporting } from './reporter.js';

export interface PluginUsageServiceDeps {
  client: DbClient;
  /** Must recheck the owner AND client epoch before every database operation. */
  isCurrent(): boolean;
  deviceName: string;
  now?: () => number;
  reporting?: PluginUsageReporting;
  warn(): void;
}

/** One short write queue per owner/database epoch; it never waits for tool or HTTP results. */
export class PluginUsageService {
  private tail: Promise<unknown> = Promise.resolve();
  private stopped = false;
  private readonly handles = new Map<string, PluginUsageHandle>();
  private readonly paused = new Set<string>();
  private readonly now: () => number;
  private readonly reporter?: PluginUsageReporter;

  constructor(private readonly deps: PluginUsageServiceDeps) {
    this.now = deps.now ?? Date.now;
    if (deps.reporting) {
      this.reporter = new PluginUsageReporter({
        reporting: deps.reporting,
        isCurrent: () => !this.stopped && deps.isCurrent(),
        now: this.now,
        select: () =>
          this.enqueue(() =>
            runAsBackgroundDbRpc(async () => {
              const first = await deps.client.queryOne<{ target: string; nextAttemptAt: number }>(
                `SELECT e.report_target AS target,COALESCE(e.next_attempt_at,0) AS nextAttemptAt
             FROM plugin_usage_events e JOIN plugin_usage_subjects s ON s.id=e.subject_id AND s.history_generation=e.history_generation
             WHERE e.report_state='pending' ORDER BY e.next_attempt_at,e.occurred_at LIMIT 1`,
              );
              this.assertCurrent();
              if (!first) return null;
              const rows = await deps.client.query<PluginUsageReportRow>(
                `SELECT e.call_id AS callId,e.subject_id AS subjectId,e.history_generation AS historyGeneration,
              e.release_id AS releaseId,e.occurred_at AS occurredAt,e.report_target AS reportTarget,e.attempt_count AS attemptCount
             FROM plugin_usage_events e JOIN plugin_usage_subjects s ON s.id=e.subject_id AND s.history_generation=e.history_generation
             WHERE e.report_state='pending' AND e.report_target=? AND COALESCE(e.next_attempt_at,0)<=?
             ORDER BY e.occurred_at,e.call_id LIMIT 100`,
                [first.target, this.now()],
              );
              return { rows, nextAttemptAt: first.nextAttemptAt };
            }),
          ),
        revalidate: (rows) =>
          this.enqueue(() =>
            runAsBackgroundDbRpc(async () => {
              if (!rows.length) return [];
              const live = await deps.client.query<{
                callId: string;
                subjectId: string;
                historyGeneration: number;
                reportTarget: string;
              }>(
                `SELECT e.call_id AS callId,e.subject_id AS subjectId,e.history_generation AS historyGeneration,e.report_target AS reportTarget
             FROM plugin_usage_events e JOIN plugin_usage_subjects s ON s.id=e.subject_id AND s.history_generation=e.history_generation
             WHERE e.report_state='pending' AND e.call_id IN (${rows.map(() => '?').join(',')})`,
                rows.map((row) => row.callId),
              );
              return rows.filter((row) =>
                live.some(
                  (found) =>
                    found.callId === row.callId &&
                    found.subjectId === row.subjectId &&
                    found.historyGeneration === row.historyGeneration &&
                    found.reportTarget === row.reportTarget,
                ),
              );
            }),
          ),
        update: (updates, valid) =>
          this.enqueue(async () => {
            if (valid()) await this.tx({ action: 'report', updates });
          }),
        warn: deps.warn,
      });
      this.reporter.wake();
    }
  }

  private assertCurrent(): void {
    if (!this.deps.isCurrent()) throw new Error('[HOST_NOT_READY] Plugin usage owner changed');
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    if (this.stopped) return Promise.reject(new Error('[HOST_NOT_READY] Plugin usage closed'));
    const result = this.tail.then(async () => {
      this.assertCurrent();
      const value = await fn();
      this.assertCurrent();
      return value;
    });
    this.tail = result.catch(() => this.deps.warn());
    return result;
  }

  private tx(body: PluginUsageTransaction) {
    this.assertCurrent();
    return this.deps.client.tx('pluginUsage.execute', body);
  }

  bind(identity: PluginUsageIdentity, previousRevision?: string): Promise<void> {
    return this.enqueue(async () => {
      const handle = await this.tx({
        action: 'bind',
        identity,
        previousRevision,
        newId: randomUUID(),
        now: this.now(),
      });
      this.assertCurrent();
      if (handle) this.handles.set(identity.ghostId, handle);
    });
  }

  /** Freeze the generation/version before dispatch. An unready binding is never replayed. */
  capture(identity: PluginUsageIdentity): PluginUsageHandle | null {
    if (this.stopped || !this.deps.isCurrent() || this.paused.has(identity.ghostId)) return null;
    const handle = this.handles.get(identity.ghostId);
    if (
      !handle ||
      handle.identity.revision !== identity.revision ||
      handle.identity.stableKey !== identity.stableKey
    ) {
      void this.bind(identity).catch(() => undefined);
      return null;
    }
    return this.freeze(handle, identity);
  }

  /** Install/startup binding owns source verification; dispatch never rereads package files. */
  captureBound(ghostId: string, revision: string): PluginUsageHandle | null {
    if (this.stopped || !this.deps.isCurrent() || this.paused.has(ghostId)) return null;
    const handle = this.handles.get(ghostId);
    return handle?.identity.revision === revision ? this.freeze(handle, handle.identity) : null;
  }

  private freeze(handle: PluginUsageHandle, identity: PluginUsageIdentity): PluginUsageHandle {
    const reporting = this.deps.reporting;
    return {
      ...handle,
      identity: { ...identity },
      reportTarget: reporting?.allowed() ? reporting.target(identity) : null,
    };
  }

  accept(
    handle: PluginUsageHandle,
    callId: string,
    toolName: string,
    sessionId: string | null,
    occurredAt: number,
    entryKind: PluginUsageEntryKind = 'tool',
  ): void {
    void this.enqueue(async () => {
      const refreshed = await this.tx({
        action: 'accept',
        handle: {
          ...handle,
          reportTarget: this.deps.reporting?.allowed() ? handle.reportTarget : null,
        },
        callId,
        toolName,
        sessionId,
        occurredAt,
        entryKind,
      });
      // Refresh only future captures after a cross-instance clear. Never replay this call.
      this.assertCurrent();
      this.reporter?.wake();
      const current = this.handles.get(handle.identity.ghostId);
      if (
        refreshed &&
        current?.subjectId === handle.subjectId &&
        current.identity.revision === handle.identity.revision
      )
        this.handles.set(handle.identity.ghostId, refreshed);
    }).catch(() => undefined);
  }

  settle(handle: PluginUsageHandle, callId: string, outcome: PluginUsageOutcome): void {
    void this.enqueue(async () => {
      await this.tx({ action: 'settle', handle, callId, outcome });
    }).catch(() => undefined);
  }

  async detach(ghostId: string): Promise<void> {
    this.handles.delete(ghostId);
    await this.enqueue(async () => {
      await this.tx({ action: 'detach', ghostId });
    });
  }

  async clear(subjectId: string | null): Promise<void> {
    this.reporter?.invalidate();
    const affected = [...this.handles.values()].filter(
      (h) => subjectId === null || h.subjectId === subjectId,
    );
    for (const h of affected) this.paused.add(h.identity.ghostId);
    try {
      await this.enqueue(async () => {
        await this.tx({ action: 'clear', subjectId, now: this.now() });
        for (const h of affected) {
          this.assertCurrent();
          const row = await this.deps.client.queryOne<{ generation: number }>(
            'SELECT history_generation AS generation FROM plugin_usage_subjects WHERE id=?',
            [h.subjectId],
          );
          this.assertCurrent();
          const current = this.handles.get(h.identity.ghostId);
          if (
            row &&
            current?.subjectId === h.subjectId &&
            current.identity.revision === h.identity.revision
          )
            this.handles.set(h.identity.ghostId, { ...current, historyGeneration: row.generation });
        }
      });
    } finally {
      for (const h of affected) this.paused.delete(h.identity.ghostId);
    }
  }

  async summary(subjectId: string): Promise<PluginUsageSummary | null> {
    await this.tail;
    this.assertCurrent();
    const until = this.now();
    return runAsBackgroundDbRpc(async () => {
      this.assertCurrent();
      const row = await this.deps.client.queryOne<
        Pick<
          PluginUsageSummary,
          'recordingStartedAt' | 'lastUsedAt' | 'callsLast7Days' | 'totalCalls'
        >
      >(
        `
        SELECT s.recording_started_at AS recordingStartedAt,MAX(e.occurred_at) AS lastUsedAt,
          COUNT(e.call_id) AS totalCalls,
          COALESCE(SUM(CASE WHEN e.occurred_at>=? AND e.occurred_at<? THEN 1 ELSE 0 END),0) AS callsLast7Days
        FROM plugin_usage_subjects s LEFT JOIN plugin_usage_events e ON e.subject_id=s.id
        WHERE s.id=? GROUP BY s.id`,
        [until - 168 * 60 * 60 * 1000, until, subjectId],
      );
      this.assertCurrent();
      if (!row) return null;
      const recentTasks = await this.deps.client.query<PluginUsageSummary['recentTasks'][number]>(
        `
        SELECT t.id AS sessionId,t.title,MAX(e.occurred_at) AS lastUsedAt
        FROM plugin_usage_events e JOIN sessions t ON t.id=e.session_id
        WHERE e.subject_id=? AND t.status<>'deleted'
        GROUP BY t.id ORDER BY lastUsedAt DESC,t.id LIMIT 3`,
        [subjectId],
      );
      this.assertCurrent();
      return { ...row, subjectId, until, deviceName: this.deps.deviceName, recentTasks };
    });
  }

  async history(): Promise<
    { subjectId: string; ghostId: string; displayName: string; sourceKind: string }[]
  > {
    await this.tail;
    this.assertCurrent();
    const rows = await runAsBackgroundDbRpc(() =>
      this.deps.client.query<{
        subjectId: string;
        ghostId: string;
        displayName: string;
        sourceKind: string;
      }>(
        'SELECT id AS subjectId,ghost_id AS ghostId,display_name AS displayName,source_kind AS sourceKind FROM plugin_usage_subjects ORDER BY recording_started_at DESC,id',
      ),
    );
    this.assertCurrent();
    return rows;
  }

  /** Stop admission first; worker close is not a drain. No cross-owner retry on timeout. */
  async close(budgetMs = 2_000): Promise<void> {
    this.stopped = true;
    this.reporter?.stop();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.tail,
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            this.deps.warn();
            resolve();
          }, budgetMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    this.handles.clear();
  }
}
