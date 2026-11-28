import { randomUUID } from 'node:crypto';
import type { DbClient } from '../localDb/client/DbClient.js';
import { runAsBackgroundDbRpc } from '../localDb/client/rpcAdmission.js';
import type {
  PluginUsageHandle,
  PluginUsageIdentity,
  PluginUsageOutcome,
  PluginUsageSummary,
  PluginUsageTransaction,
  PluginUsageEntryKind,
} from '../../shared/pluginUsage.js';
import { PluginUsageBuckets } from './buckets.js';
import type { PluginUsageReporting } from './reporting.js';

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
  private readonly bindingFlights = new Map<string, Promise<PluginUsageHandle | null>>();
  private readonly paused = new Set<string>();
  private readonly pendingClears = new Map<string | null, number>();
  private readonly now: () => number;
  private readonly reporter?: PluginUsageBuckets;

  constructor(private readonly deps: PluginUsageServiceDeps) {
    this.now = deps.now ?? Date.now;
    if (deps.reporting) {
      const reporting = deps.reporting;
      this.reporter = new PluginUsageBuckets({
        scope: () => !this.stopped && deps.isCurrent() ? reporting.scope() : null,
        send: reporting.send,
      });
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

  /** Bind once per installed revision; concurrent first calls share one write. */
  ensure(identity: PluginUsageIdentity): Promise<PluginUsageHandle | null> {
    if (this.stopped || !this.deps.isCurrent() || this.paused.has(identity.ghostId))
      return Promise.resolve(null);
    const existing = this.handles.get(identity.ghostId);
    if (
      existing &&
      existing.identity.revision === identity.revision &&
      existing.identity.stableKey === identity.stableKey
    )
      return Promise.resolve(this.freeze(existing, identity));
    const key = JSON.stringify([identity.ghostId, identity.revision, identity.stableKey]);
    const pending = this.bindingFlights.get(key);
    if (pending) return pending;
    const flight = this.bind(identity)
      .then(() => {
        const handle = this.handles.get(identity.ghostId);
        return handle &&
          handle.identity.revision === identity.revision &&
          handle.identity.stableKey === identity.stableKey
          ? this.freeze(handle, identity)
          : null;
      })
      .catch(() => null)
      .finally(() => {
        if (this.bindingFlights.get(key) === flight) this.bindingFlights.delete(key);
      });
    this.bindingFlights.set(key, flight);
    return flight;
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
    return { ...handle, identity: { ...identity }, reportTarget: null };
  }

  captureReporting(): number | null {
    return this.reporter?.admit() ?? null;
  }

  invalidateReporting(): void {
    this.reporter?.invalidate();
  }

  accept(
    handle: PluginUsageHandle,
    callId: string,
    toolName: string,
    sessionId: string | null,
    occurredAt: number,
    entryKind: PluginUsageEntryKind = 'tool',
    admission = this.captureReporting(),
  ): void {
    const target = admission === null ? null : this.deps.reporting?.target(handle.identity);
    void this.enqueue(async () => {
      const refreshed = await this.tx({
        action: 'accept',
        handle: {
          ...handle,
          reportTarget: null,
        },
        callId,
        toolName,
        sessionId,
        occurredAt,
        entryKind,
      });
      // Refresh only future captures after a cross-instance clear. Never replay this call.
      this.assertCurrent();
      if (
        refreshed?.recorded && target && handle.identity.releaseId &&
        !this.pendingClears.has(null) && !this.pendingClears.has(handle.subjectId)
      ) {
        this.reporter?.add(admission, handle.subjectId, target, handle.identity.releaseId, occurredAt);
      }
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
    // A detached installation can still have an accepted call awaiting its SQLite receipt.
    this.pendingClears.set(subjectId, (this.pendingClears.get(subjectId) ?? 0) + 1);
    if (subjectId === null) this.reporter?.invalidate();
    else this.reporter?.clearSubject(subjectId);
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
      const remaining = this.pendingClears.get(subjectId)! - 1;
      if (remaining === 0) this.pendingClears.delete(subjectId);
      else this.pendingClears.set(subjectId, remaining);
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
