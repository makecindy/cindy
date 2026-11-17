/**
 * prFollowWatch — 标题栏 PR 状态一变,立刻触发关注这个 PR 的定时任务。
 *
 * PR 跟进(GitHub 插件 /pr 技能)由定时任务的前置检查判断要不要叫醒 Agent,它按自己的节奏
 * 查 GitHub。宿主这边本来就为标题栏、侧栏、卡片状态位定时刷新 PR 状态(PrStatusService);
 * 这一份刷新看到某个 PR 变了(提交、检查、评论线程、合并状态、审批、合并/关闭)时,
 * 把引用这个 PR 的定时任务马上跑一轮,前置检查 stdin 里带 `trigger`,检查据此跳过自己的
 * 节奏与探测直接完整读取。宿主只识别前置检查中的 PR 链接,不把脚本正文当作事件授权,
 * GitLab MR 同样适用。
 *
 * 约束:
 * - 第一次看到某个 PR 只记基线,不触发(启动后的首轮刷新不该把所有跟进都叫一遍);
 * - 只触发 active、按计划重复且此刻没有在跑的任务(提前跑会用掉一次性任务,手动任务不该被别人启动);
 *   同一任务两次触发至少间隔 MIN_RETRIGGER_MS;
 * - 被动调度实例(与另一实例共库,自动触发让位给对方)不触发;
 * - 没有空闲名额或任务仍在运行时保留该任务的门铃,每 5 秒检查本地容量,计划本身也会兜底;
 * - 只看确定的结果(ok),失败或查不到不算变化,也不清掉基线;
 * - 全部是尽力而为:出错只记日志,不影响状态查询本身。
 */
import type { PrStatusResult } from '@cindy/maker-shared';
import { prStatusKey, sessionPrUrl } from '@cindy/maker-shared';
import type { Schedule, ScheduleRunTrigger } from '@cindy/maker-scheduler';

import type { PrStatusQuery } from './prStatusService';

export const PR_WATCH_SOURCE = 'pr-status';
/** Two host triggers of one schedule at least this far apart; the cron covers the rest. */
export const MIN_RETRIGGER_MS = 60_000;
/** How many PR baselines are kept (LRU by insertion). */
const MAX_TRACKED = 500;

export interface PrFollowWatchDeps {
  /** Active schedules (CRUD view, bot routines excluded). */
  listActive(): Promise<Schedule[]>;
  /** Runs of this schedule in flight right now. */
  inflight(id: string): number;
  /** False on a passive instance: automatic runs belong to another instance sharing the data. */
  autoRunAllowed(): boolean;
  /** The scheduler has a free concurrency slot right now. */
  hasCapacity(): boolean;
  runNow(id: string, trigger: ScheduleRunTrigger): Promise<unknown>;
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

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A schedule watches the PR when its pre-run check names the PR's URL (not a longer number). */
export function watchesPr(schedule: Schedule, url: string): boolean {
  const command = prFollowCommand(schedule);
  if (!command || !url) return false;
  return new RegExp(`${escapeRegExp(url)}(?![0-9])`, 'i').test(command);
}

/** Only a configured pre-run check opts into implicit PR follow-up; script bodies are not consent. */
export function prFollowCommand(schedule: Schedule): string {
  return schedule.preRunHook?.command ?? '';
}

export class PrFollowWatch {
  private readonly signatures = new Map<string, string>();
  private readonly lastTriggered = new Map<string, number>();
  /** Keep one doorbell per schedule, so retrying a busy follower cannot rerun its siblings. */
  private readonly pending = new Map<string, { url: string; isCurrent: () => boolean }>();
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly now: () => number;

  constructor(private readonly deps: PrFollowWatchDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** Record a fresh status; trigger the watching schedules when it changed. Never throws. */
  observe(query: PrStatusQuery, result: PrStatusResult): void {
    const signature = prStatusSignature(result);
    if (signature === null) return;
    const key = prStatusKey(query);
    const previous = this.signatures.get(key);
    this.signatures.delete(key);
    this.signatures.set(key, signature);
    if (this.signatures.size > MAX_TRACKED) this.signatures.delete(this.signatures.keys().next().value!);
    if (previous === undefined || previous === signature) { this.retryPending(); return; }
    const url = sessionPrUrl(query);
    for (const [id, pending] of this.pending) if (pending.url === url) this.pending.delete(id);
    this.retryPending();
    void this.trigger(url).catch((error) => {
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
    await this.trigger(url, isCurrent);
  }

  private retryPending(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    for (const [id, { url, isCurrent }] of Array.from(this.pending)) {
      this.pending.delete(id);
      void this.trigger(url, isCurrent, id).catch(() => undefined);
    }
  }

  private defer(id: string, url: string, isCurrent: () => boolean): void {
    this.pending.set(id, { url, isCurrent });
    // This only checks local scheduler capacity; it makes no GitHub API requests.
    // A comment must not depend on another status change to be noticed after a busy run.
    if (!this.retryTimer) {
      this.retryTimer = setTimeout(() => this.retryPending(), 5_000);
      this.retryTimer.unref?.();
    }
  }

  private async trigger(url: string, isCurrent: () => boolean = () => true, onlyScheduleId?: string): Promise<void> {
    if (!url || !isCurrent() || !this.deps.autoRunAllowed()) return;
    const schedules = (await this.deps.listActive()).filter((schedule) =>
      (!onlyScheduleId || schedule.id === onlyScheduleId) && watchesPr(schedule, url));
    const now = this.now();
    for (const schedule of schedules) {
      if (!isCurrent()) return;
      if (schedule.status !== 'active' || !schedule.recurring || schedule.manual) continue;
      // Explicit App triggers own the event filter and durable queue. Do not run
      // the same task again through the implicit PR-follow wakeup path.
      if (schedule.webhookTrigger?.source?.preset === 'github-app') continue;
      if (this.deps.inflight(schedule.id) > 0) { this.defer(schedule.id, url, isCurrent); continue; }
      const last = this.lastTriggered.get(schedule.id);
      if (last !== undefined && now - last < MIN_RETRIGGER_MS) { this.defer(schedule.id, url, isCurrent); continue; }
      if (!this.deps.hasCapacity()) {
        this.defer(schedule.id, url, isCurrent);
        continue;
      }
      this.pending.delete(schedule.id);
      this.lastTriggered.set(schedule.id, now);
      this.deps.log?.info?.('pr follow watch: status changed, running schedule now', { scheduleId: schedule.id, url });
      void this.deps
        .runNow(schedule.id, { kind: 'watch', source: PR_WATCH_SOURCE, detail: url })
        .catch((error) => {
          this.deps.log?.warn?.('pr follow watch runNow failed', {
            scheduleId: schedule.id,
            error: error instanceof Error ? error.message : String(error),
          });
        });
    }
  }
}
