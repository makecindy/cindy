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
import { parseSessionPrUrl, prStatusKey, sessionPrUrl } from '@cindy/maker-shared';
import { schedulePrTriggers, type PrChange } from '@cindy/maker-scheduler';
import type { MrRunObservation, Schedule, ScheduleRunTrigger } from '@cindy/maker-scheduler';
import { runTaskActionRequest } from '../maker-ipc/taskActionAuthorization';

import type { PrStatusQuery } from './prStatusService';

export const PR_WATCH_SOURCE = 'pr-status';
/** Two host triggers of one schedule at least this far apart; the cron covers the rest. */
export const MIN_RETRIGGER_MS = 60_000;
/** Bounded fallback when GitHub metadata lacks updated_at across repeated overflow batches; preserves 30m human-wait backoff. */
export const RECONCILE_FALLBACK_MS = 30 * 60_000;
/** How many PR baselines are kept (LRU by insertion). */
const MAX_TRACKED = 500;

export interface PrFollowWatchDeps {
  /** Active schedules (CRUD view, bot routines excluded). */
  listActive(): Promise<Schedule[]>;
  /** Completed PR-triggered executions survive restarts and failed timed lookups. */
  hasSuccessfulPrRunSince?(id: string, since: number): Promise<boolean>;
  lastSuccessfulMrObservation?(id: string): Promise<MrRunObservation | null>;
  /** Runs of this schedule in flight right now. */
  inflight(id: string): number;
  /** False on a passive instance: automatic runs belong to another instance sharing the data. */
  autoRunAllowed(): boolean;
  /** The scheduler has a free concurrency slot right now. */
  hasCapacity(): boolean;
  runNow(id: string, trigger: ScheduleRunTrigger, expected: Schedule, observation?: MrRunObservation): Promise<{ runId: string; deferred?: boolean } | null>;
  now?: () => number;
  log?: { info?: (msg: string, meta?: unknown) => void; warn?: (msg: string, meta?: unknown) => void };
}

type OkStatus = Extract<PrStatusResult, { ok: true }>;

const ACTIONABLE_GITHUB_MERGE_STATES = new Set(['DIRTY', 'BEHIND']);

/** GitHub reports UNKNOWN while recomputing mergeability after a base push; treat it as absent. */
function normalizeMergeState(mergeState: string | null | undefined): string {
  if (!mergeState) return '';
  return mergeState.toUpperCase() === 'UNKNOWN' ? '' : mergeState;
}

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
    ok.provider === 'gitlab' ? (ok.mergeState ?? '') : normalizeMergeState(ok.mergeState),
    ok.conflicts ?? '',
    ok.reviewDecision ?? '',
    ...(ok.provider === 'gitlab' ? [
      ok.metadata?.user_notes_count ?? '', ok.metadata?.pipeline_status ?? '',
      ok.metadata?.blocking_discussions_resolved ?? '', ok.metadata?.pipeline_id ?? '',
      ok.metadata?.pipeline_finished_at ?? '',
    ] : []),
  ].join('|');
}

/** Optional GraphQL fields describe one MR head. A missing count is unknown, including when zero was last observed. */
function withKnownMrSummary(signature: string, fallback: string | undefined): string {
  if (!fallback) return signature;
  const [status, head, checks, threads, ...rest] = signature.split('|');
  const [, otherHead, otherChecks, otherThreads] = fallback.split('|');
  if (!head || head !== otherHead) return signature;
  return [status, head, checks || otherChecks, threads || otherThreads, ...rest].join('|');
}

/** On the same PR head, carry forward known GitHub mergeability and summary fields across transient UNKNOWN/null reads. */
function withKnownGithubSummary(signature: string, fallback: string | undefined): string {
  if (!fallback) return signature;
  const parts = signature.split('|');
  const other = fallback.split('|');
  if (!parts[1] || parts[1] !== other[1]) return signature;
  for (const idx of [2, 3, 4, 5, 6] as const) {
    if (!parts[idx] && other[idx]) parts[idx] = other[idx];
  }
  return parts.join('|');
}

/** When mergeability first resolves on the same head to a non-actionable state, establish baseline without waking. */
function withBenignGithubBaseline(previous: string, current: string): string {
  const parts = previous.split('|');
  const next = current.split('|');
  if (!parts[1] || parts[1] !== next[1]) return previous;
  if (!parts[4] && next[4] && !ACTIONABLE_GITHUB_MERGE_STATES.has(next[4].toUpperCase())) {
    parts[4] = next[4];
  }
  if (!parts[5] && next[5] === 'false') {
    parts[5] = next[5];
  }
  return parts.join('|');
}

export function changesBetween(previous: string | undefined, current: string | undefined, provider?: PrStatusQuery['provider']): PrChange[] {
  if (!previous || !current || previous === current) return [];
  // When detail first becomes available, establish its baseline without treating it as a change.
  if (provider === 'gitlab') {
    current = withKnownMrSummary(current, previous);
    previous = withKnownMrSummary(previous, current);
    if (previous === current) return [];
  } else {
    current = withKnownGithubSummary(current, previous);
    previous = withBenignGithubBaseline(previous, current);
    if (previous === current) return [];
  }
  const changes: PrChange[] = ['any'];
  const [oldStatus, , oldChecks, oldThreads, , , oldReview, oldNotes, oldPipeline, oldBlocking, oldPipelineId, oldFinishedAt] = previous.split('|');
  const [status, , checks, threads, , , review, notes, pipeline, blocking, pipelineId, finishedAt] = current.split('|');
  if (oldStatus !== status && status === 'merged') changes.push('merged');
  if ((checks && checks !== oldChecks) || (pipeline && pipeline !== oldPipeline) ||
      (pipelineId && pipelineId !== oldPipelineId) || (finishedAt && finishedAt !== oldFinishedAt)) changes.push('ci');
  if ((review && review !== oldReview) || (threads && threads !== oldThreads) || (notes && notes !== oldNotes) || (blocking && blocking !== oldBlocking)) changes.push('review');
  return changes;
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

type WatchChange = PrChange | 'reconcile';

interface MrRecovery {
  signature: string;
  actionable: boolean;
}

// A REST-only read may first learn about failed jobs or open discussions after
// GraphQL recovers. Known healthy details alone do not require a model run.
function hasNewMrWork(previous: string, current: string): boolean {
  if (changesBetween(previous, current, 'gitlab').length) return true;
  const [, , oldChecks, oldThreads] = previous.split('|');
  const [, , checks, threads] = current.split('|');
  return (!oldChecks && Number(checks?.split(',')[1]) > 0) || (!oldThreads && Number(threads) > 0);
}

function watchesChange(schedule: Schedule, url: string, changes: readonly WatchChange[]): boolean {
  if (schedulePrTriggers(schedule).some(rule => rule.url.toLowerCase() === url.toLowerCase() && (changes.includes(rule.change)
    || (changes.includes('reconcile') && rule.change === 'any' && !!schedule.preRunHook?.command)))) return true;
  // Preserve existing non-GitHub (GitLab MR) pre-run checks.
  return !url.toLowerCase().startsWith('https://github.com/') && schedule.prTrigger === undefined
    && !!schedule.preRunHook && new RegExp(`${escapeRegExp(url)}(?![0-9])`, 'i').test(schedule.preRunHook.command);
}

export class PrFollowWatch {
  private readonly signatures = new Map<string, string>();
  private readonly reconciledUpdatedAt = new Map<string, string>();
  private readonly lastReconciledAt = new Map<string, number>();
  private readonly lastTriggered = new Map<string, number>();
  /** Keep one doorbell per schedule, so retrying a busy follower cannot rerun its siblings. */
  private readonly pending = new Map<string, () => Promise<void>>();
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly now: () => number;

  constructor(private readonly deps: PrFollowWatchDeps) {
    this.now = deps.now ?? Date.now;
  }

  reset(): void {
    this.signatures.clear();
    this.reconciledUpdatedAt.clear();
    this.lastReconciledAt.clear();
    this.lastTriggered.clear();
    this.pending.clear();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.generation++;
  }

  private generation = 0;

  /** Record a fresh status; trigger the watching schedules when it changed. Never throws. */
  observe(query: PrStatusQuery, result: PrStatusResult): void {
    const fresh = prStatusSignature(result);
    if (fresh === null) return;
    const key = prStatusKey(query);
    const previous = this.signatures.get(key);
    const signature = query.provider === 'gitlab'
      ? withKnownMrSummary(fresh, previous)
      : withKnownGithubSummary(fresh, previous);
    this.signatures.delete(key);
    this.signatures.set(key, signature);
    if (this.signatures.size > MAX_TRACKED) this.signatures.delete(this.signatures.keys().next().value!);
    const changes = changesBetween(previous, signature, query.provider);
    if (!changes.length) {
      // Seed reconciledUpdatedAt on the initial baseline read so later overflow sweeps
      // do not emit redundant `reconcile` triggers for PRs whose updated_at never moved.
      if (
        previous === undefined &&
        this.deps.autoRunAllowed() &&
        result.ok &&
        typeof result.metadata?.updated_at === 'string' &&
        result.metadata.updated_at
      ) {
        this.markCommentReconciled(query, result.metadata.updated_at);
      }
      this.retryPending();
      if (previous === undefined && result.ok && (result.status === 'merged' || (query.provider === 'gitlab' && result.status === 'closed'))) {
        const mergedAt = Date.parse(String((result.status === 'merged' ? result.metadata?.merged_at : result.metadata?.closed_at) ?? ''));
        if (Number.isFinite(mergedAt)) {
          const changes: PrChange[] = query.provider !== 'gitlab' ? ['merged'] : result.status === 'merged' ? ['merged', 'any'] : ['any'];
          void this.trigger(sessionPrUrl(query), changes, undefined, undefined, mergedAt).catch(error =>
            this.deps.log?.warn?.('PR merge reconciliation failed', { error: String(error) }));
        }
      }
      return;
    }
    const url = sessionPrUrl(query);
    if (this.deps.autoRunAllowed() && result.ok && typeof result.metadata?.updated_at === 'string' && result.metadata.updated_at) {
      this.markCommentReconciled(query, result.metadata.updated_at);
    }
    void this.trigger(url, changes).catch((error) => {
      this.deps.log?.warn?.('pr follow watch trigger failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  /** Following may start after CI failed or review arrived. Process existing work once, even if the status never changes. */
  async reconcileInitialMrWork(schedule: Schedule, result: OkStatus): Promise<void> {
    const rule = schedule.prTrigger;
    if (result.provider !== 'gitlab' || result.status !== 'open' || rule?.change !== 'any' ||
        sessionPrUrl(result).toLowerCase() !== rule.url.toLowerCase()) return;
    const observed = this.observedSignature(result);
    const signature = observed ?? prStatusSignature(result)!;
    const actionable = Boolean(result.conflicts || result.checks?.failed || result.unresolvedCount ||
      result.metadata?.pipeline_status === 'failed' || result.metadata?.blocking_discussions_resolved === false);
    const generation = this.generation;
    const isCurrent = () => generation === this.generation && this.observedSignature(result) === observed;
    await this.trigger(rule.url, ['any'], isCurrent, schedule.id, undefined, { signature, actionable });
  }

  /** Snapshot the observer baseline before refreshing an explicit event. */
  observedSignature(query: PrStatusQuery): string | undefined {
    return this.signatures.get(prStatusKey(query));
  }

  /**
   * Overflow / reconnect reconciliation wakes the PR check when `updated_at` advanced
   * (or was never reconciled); if `updated_at` is absent, falls back once per bounded window
   * rather than looping every minute.
   */
  needsCommentReconcile(query: PrStatusQuery, updatedAt: string | undefined): boolean {
    const key = prStatusKey(query);
    if (updatedAt) {
      return this.reconciledUpdatedAt.get(key) !== updatedAt;
    }
    const lastAt = this.lastReconciledAt.get(key);
    return lastAt === undefined || this.now() - lastAt >= RECONCILE_FALLBACK_MS;
  }

  markCommentReconciled(query: PrStatusQuery, updatedAt: string | undefined): void {
    const key = prStatusKey(query);
    this.lastReconciledAt.delete(key);
    this.lastReconciledAt.set(key, this.now());
    if (this.lastReconciledAt.size > MAX_TRACKED) {
      this.lastReconciledAt.delete(this.lastReconciledAt.keys().next().value!);
    }
    if (!updatedAt) return;
    this.reconciledUpdatedAt.delete(key);
    this.reconciledUpdatedAt.set(key, updatedAt);
    if (this.reconciledUpdatedAt.size > MAX_TRACKED) {
      this.reconciledUpdatedAt.delete(this.reconciledUpdatedAt.keys().next().value!);
    }
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
    for (const [id, retry] of Array.from(this.pending)) {
      this.pending.delete(id);
      void retry().catch(() => undefined);
    }
  }

  private defer(id: string, retry: () => Promise<void>): void {
    this.pending.set(id, retry);
    // This only checks local scheduler capacity; it makes no GitHub API requests.
    // A comment must not depend on another status change to be noticed after a busy run.
    if (!this.retryTimer) {
      this.retryTimer = setTimeout(() => this.retryPending(), 5_000);
      this.retryTimer.unref?.();
    }
  }

  private async trigger(url: string, changes: readonly WatchChange[], isCurrent: () => boolean = () => true, onlyScheduleId?: string, mergedAt?: number, mrRecovery?: MrRecovery): Promise<void> {
    if (!url || !isCurrent() || !this.deps.autoRunAllowed()) return;
    const ref = parseSessionPrUrl(url);
    const signature = mrRecovery?.signature ?? (ref?.provider === 'gitlab' ? this.observedSignature(ref) : undefined);
    const generation = this.generation;
    const observation = signature ? { url: url.toLowerCase(), signature } : undefined;
    if (mrRecovery && onlyScheduleId && observation) {
      const last = await this.deps.lastSuccessfulMrObservation?.(onlyScheduleId);
      if (!isCurrent() || this.generation !== generation) return;
      if (last?.url === observation.url) {
        if (!hasNewMrWork(last.signature, observation.signature)) return;
        observation.signature = withKnownMrSummary(observation.signature, last.signature);
      } else if (!mrRecovery.actionable) return;
    }
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
      const retry = () => this.trigger(url, changes, isCurrent, schedule.id, mergedAt, mrRecovery);
      const last = this.lastTriggered.get(schedule.id);
      if (this.deps.inflight(schedule.id) > 0 || (last !== undefined && now - last < MIN_RETRIGGER_MS) || !this.deps.hasCapacity()) {
        this.defer(schedule.id, retry);
        continue;
      }
      this.pending.delete(schedule.id);
      this.lastTriggered.set(schedule.id, now);
      const isReconcileOnly = changes.length === 1 && changes[0] === 'reconcile';
      this.deps.log?.info?.('pr follow watch: status changed, running schedule now', { scheduleId: schedule.id, url });
      // This run belongs to the configured schedule, even if the observing tool call expired.
      void runTaskActionRequest(() =>
        this.deps.runNow(
          schedule.id,
          {
            kind: 'watch',
            source: PR_WATCH_SOURCE,
            detail: url,
            ...(isReconcileOnly ? { reason: 'reconcile' as const } : {}),
          },
          schedule,
          observation,
        ))
        .then(result => {
          // The next cron tick only checks status. Keep the event after a runner defers its work.
          if (result?.deferred && isCurrent() && this.generation === generation && !this.pending.has(schedule.id)) {
            this.defer(schedule.id, retry);
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
