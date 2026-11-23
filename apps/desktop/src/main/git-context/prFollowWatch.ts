/**
 * Match verified PR changes to active automations. Explicit conditions apply to
 * event-only and recurring tasks. Older recurring pre-run checks may identify
 * their PR in the command. Script bodies never authorize an event.
 *
 * The first successful read establishes a baseline. A verified merge timestamp
 * can recover a merge since the automation last ran. Busy or throttled tasks
 * retain one local wakeup, subject to their current rule and account.
 */
import type { PrStatusResult } from '@cindy/maker-shared';
import { prStatusKey, sessionPrUrl } from '@cindy/maker-shared';
import { schedulePrTriggers, type PrChange } from '@cindy/maker-scheduler';
import type { Schedule, ScheduleRunTrigger } from '@cindy/maker-scheduler';
import { runTaskActionRequest } from '../maker-ipc/taskActionAuthorization';

import type { PrStatusQuery } from './prStatusService';

export const PR_WATCH_SOURCE = 'pr-status';
/** Two host triggers of one schedule at least this far apart; the cron covers the rest. */
export const MIN_RETRIGGER_MS = 60_000;
/** How many PR baselines are kept (LRU by insertion). */
const MAX_TRACKED = 500;

export interface PrFollowWatchDeps {
  /** Active schedules (CRUD view, bot routines excluded). */
  listActive(): Promise<Schedule[]>;
  /** Completed PR-triggered executions survive restarts and failed timed lookups. */
  hasSuccessfulPrRunSince?(id: string, since: number): Promise<boolean>;
  /** Runs of this schedule in flight right now. */
  inflight(id: string): number;
  /** False on a passive instance: automatic runs belong to another instance sharing the data. */
  autoRunAllowed(): boolean;
  /** The scheduler has a free concurrency slot right now. */
  hasCapacity(): boolean;
  runNow(id: string, trigger: ScheduleRunTrigger, expected: Schedule): Promise<{ runId: string; deferred?: boolean } | null>;
  now?: () => number;
  log?: { info?: (msg: string, meta?: unknown) => void; warn?: (msg: string, meta?: unknown) => void };
}

type OkStatus = Extract<PrStatusResult, { ok: true }>;

/** What a follow-up cares about; volatile fields (revision, observedAt) stay out. */
export function prStatusSignature(result: PrStatusResult): string | null {
  if (!result.ok) return null;
  const ok = result as OkStatus;
  const checks = ok.checks
    ? [ok.checks.total, ok.checks.failed, ok.checks.passed, ok.checks.pending, ok.checks.skipped].join(',')
    : '';
  return [
    ok.status,
    ok.headSha ?? '',
    checks,
    ok.unresolvedCount ?? '',
    ok.mergeState ?? '',
    ok.conflicts ?? '',
    ok.reviewDecision ?? '',
  ].join('|');
}

export function changesBetween(previous: string | undefined, current: string | undefined): PrChange[] {
  if (!previous || !current || previous === current) return [];
  const changes: PrChange[] = ['any'];
  const [oldStatus, , oldChecks, oldThreads, , , oldReview] = previous.split('|');
  const [status, , checks, threads, , , review] = current.split('|');
  if (oldStatus !== status && status === 'merged') changes.push('merged');
  if (checks && checks !== oldChecks) changes.push('ci');
  if ((review && review !== oldReview) || (threads && threads !== oldThreads)) changes.push('review');
  return changes;
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

type WatchChange = PrChange | 'reconcile';

function watchesChange(schedule: Schedule, url: string, changes: readonly WatchChange[]): boolean {
  if (schedulePrTriggers(schedule).some(rule => rule.url.toLowerCase() === url.toLowerCase() && (changes.includes(rule.change)
    || (changes.includes('reconcile') && rule.change === 'any' && !!schedule.preRunHook?.command)))) return true;
  // Preserve existing non-GitHub (GitLab MR) pre-run checks.
  return !url.toLowerCase().startsWith('https://github.com/') && schedule.prTrigger === undefined
    && !!schedule.preRunHook && new RegExp(`${escapeRegExp(url)}(?![0-9])`, 'i').test(schedule.preRunHook.command);
}

export class PrFollowWatch {
  private readonly signatures = new Map<string, string>();
  private readonly lastTriggered = new Map<string, number>();
  /** Keep one doorbell per schedule, so retrying a busy follower cannot rerun its siblings. */
  private readonly pending = new Map<string, { url: string; changes: readonly WatchChange[]; isCurrent: () => boolean; mergedAt?: number }>();
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly now: () => number;

  constructor(private readonly deps: PrFollowWatchDeps) {
    this.now = deps.now ?? Date.now;
  }

  reset(): void {
    this.signatures.clear();
    this.lastTriggered.clear();
    this.pending.clear();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.generation++;
  }

  private generation = 0;

  /** Record a fresh status; trigger the watching schedules when it changed. Never throws. */
  observe(query: PrStatusQuery, result: PrStatusResult): void {
    const signature = prStatusSignature(result);
    if (signature === null) return;
    const key = prStatusKey(query);
    const previous = this.signatures.get(key);
    this.signatures.delete(key);
    this.signatures.set(key, signature);
    if (this.signatures.size > MAX_TRACKED) this.signatures.delete(this.signatures.keys().next().value!);
    if (previous === undefined || previous === signature) {
      this.retryPending();
      if (previous === undefined && result.ok && result.status === 'merged') {
        const mergedAt = Date.parse(String(result.metadata?.merged_at ?? ''));
        if (Number.isFinite(mergedAt)) {
          void this.trigger(sessionPrUrl(query), ['merged'], undefined, undefined, mergedAt).catch(error =>
            this.deps.log?.warn?.('PR merge reconciliation failed', { error: String(error) }));
        }
      }
      return;
    }
    const url = sessionPrUrl(query);
    const changes = changesBetween(previous, signature);
    void this.trigger(url, changes).catch((error) => {
      this.deps.log?.warn?.('pr follow watch trigger failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  /** Snapshot the observer baseline before refreshing an explicit event. */
  observedSignature(query: PrStatusQuery): string | undefined {
    return this.signatures.get(prStatusKey(query));
  }

  /** An authenticated doorbell may represent a new comment without changing status counts. */
  async notify(url: string, isCurrent: () => boolean = () => true): Promise<void> {
    await this.trigger(url, ['any'], isCurrent);
  }

  async notifyChange(url: string, change: WatchChange, isCurrent: () => boolean): Promise<void> {
    await this.trigger(url, [change], isCurrent);
  }

  private retryPending(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    for (const [id, { url, changes, isCurrent, mergedAt }] of Array.from(this.pending)) {
      this.pending.delete(id);
      void this.trigger(url, changes, isCurrent, id, mergedAt).catch(() => undefined);
    }
  }

  private defer(id: string, url: string, changes: readonly WatchChange[], isCurrent: () => boolean, mergedAt?: number): void {
    this.pending.set(id, { url, changes, isCurrent, mergedAt });
    // This only checks local scheduler capacity; it makes no GitHub API requests.
    // A comment must not depend on another status change to be noticed after a busy run.
    if (!this.retryTimer) {
      this.retryTimer = setTimeout(() => this.retryPending(), 5_000);
      this.retryTimer.unref?.();
    }
  }

  private async trigger(url: string, changes: readonly WatchChange[], isCurrent: () => boolean = () => true, onlyScheduleId?: string, mergedAt?: number): Promise<void> {
    if (!url || !isCurrent() || !this.deps.autoRunAllowed()) return;
    const generation = this.generation;
    const schedules = (await this.deps.listActive()).filter((schedule) =>
      (!onlyScheduleId || schedule.id === onlyScheduleId) && watchesChange(schedule, url, changes));
    const now = this.now();
    for (const schedule of schedules) {
      if (!isCurrent() || this.generation !== generation) return;
      if (schedule.status !== 'active' || (schedule.expireAt !== undefined && schedule.expireAt <= now) || (!schedule.prTrigger && (!schedule.recurring || schedule.manual))) continue;
      if (mergedAt !== undefined) {
        if (schedule.createdAt >= mergedAt || await this.deps.hasSuccessfulPrRunSince?.(schedule.id, mergedAt)) continue;
        if (!isCurrent() || this.generation !== generation) return;
      }
      // Explicit App triggers own the event filter and durable queue. Do not run
      // the same task again through the implicit PR-follow wakeup path.
      if (schedule.webhookTrigger?.source?.preset === 'github-app') continue;
      if (this.deps.inflight(schedule.id) > 0) { this.defer(schedule.id, url, changes, isCurrent, mergedAt); continue; }
      const last = this.lastTriggered.get(schedule.id);
      if (last !== undefined && now - last < MIN_RETRIGGER_MS) { this.defer(schedule.id, url, changes, isCurrent, mergedAt); continue; }
      if (!this.deps.hasCapacity()) {
        this.defer(schedule.id, url, changes, isCurrent, mergedAt);
        continue;
      }
      this.pending.delete(schedule.id);
      this.lastTriggered.set(schedule.id, now);
      this.deps.log?.info?.('pr follow watch: status changed, running schedule now', { scheduleId: schedule.id, url });
      // This run belongs to the configured schedule, even if the observing tool call expired.
      void runTaskActionRequest(() =>
        this.deps.runNow(schedule.id, { kind: 'watch', source: PR_WATCH_SOURCE, detail: url }, schedule))
        .then(result => {
          // The next cron tick only checks status. Keep the event after a runner defers its work.
          if (schedule.prTrigger && result?.deferred && isCurrent() && this.generation === generation && !this.pending.has(schedule.id)) {
            this.defer(schedule.id, url, changes, isCurrent, mergedAt);
          }
        })
        .catch((error) => {
          this.deps.log?.warn?.('pr follow watch runNow failed', {
            scheduleId: schedule.id,
            error: error instanceof Error ? error.message : String(error),
          });
        });
    }
  }
}
