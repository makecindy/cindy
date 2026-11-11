/**
 * prFollowWatch — 标题栏 PR 状态一变,立刻触发关注这个 PR 的定时任务。
 *
 * PR 跟进(GitHub 插件 /pr 技能)由定时任务的前置检查判断要不要叫醒 Agent,它按自己的节奏
 * 查 GitHub。宿主这边本来就为标题栏、侧栏、卡片状态位定时刷新 PR 状态(PrStatusService);
 * 这一份刷新看到某个 PR 变了(提交、检查、评论线程、合并状态、审批、合并/关闭)时,
 * 把引用这个 PR 的定时任务马上跑一轮,前置检查 stdin 里带 `trigger`,检查据此跳过自己的
 * 节奏与探测直接完整读取。宿主只认「定时任务的前置检查命令里写着这个 PR 的链接」,不懂跟进规则,
 * GitLab MR 同样适用。
 *
 * 约束:
 * - 第一次看到某个 PR 只记基线,不触发(启动后的首轮刷新不该把所有跟进都叫一遍);
 * - 只触发 active、按计划重复且此刻没有在跑的任务(提前跑会用掉一次性任务,手动任务不该被别人启动);
 *   同一任务两次触发至少间隔 MIN_RETRIGGER_MS;
 * - 被动调度实例(与另一实例共库,自动触发让位给对方)不触发;
 * - 没有空闲的并发名额时不抢(run-now 本身不排队):这个 PR 记为待触发,下一次状态刷新再试,计划本身也会兜底;
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
  const command = schedule.preRunHook?.command;
  if (!command || !url) return false;
  return new RegExp(`${escapeRegExp(url)}(?![0-9])`, 'i').test(command);
}

export class PrFollowWatch {
  private readonly signatures = new Map<string, string>();
  private readonly lastTriggered = new Map<string, number>();
  /** PR URLs whose trigger found no free slot; retried on the next observation. */
  private readonly pending = new Set<string>();
  private readonly now: () => number;

  constructor(private readonly deps: PrFollowWatchDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** Record a fresh status; trigger the watching schedules when it changed. Never throws. */
  observe(query: PrStatusQuery, result: PrStatusResult): void {
    const signature = prStatusSignature(result);
    if (signature === null) return;
    this.retryPending();
    const key = prStatusKey(query);
    const previous = this.signatures.get(key);
    this.signatures.delete(key);
    this.signatures.set(key, signature);
    if (this.signatures.size > MAX_TRACKED) this.signatures.delete(this.signatures.keys().next().value!);
    if (previous === undefined || previous === signature) return;
    void this.trigger(sessionPrUrl(query)).catch((error) => {
      this.deps.log?.warn?.('pr follow watch trigger failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  private retryPending(): void {
    for (const url of Array.from(this.pending)) {
      this.pending.delete(url);
      void this.trigger(url).catch(() => undefined);
    }
  }

  private async trigger(url: string): Promise<void> {
    if (!url || !this.deps.autoRunAllowed()) return;
    const schedules = (await this.deps.listActive()).filter((schedule) => watchesPr(schedule, url));
    const now = this.now();
    for (const schedule of schedules) {
      if (schedule.status !== 'active' || !schedule.recurring || schedule.manual) continue;
      if (this.deps.inflight(schedule.id) > 0) continue;
      const last = this.lastTriggered.get(schedule.id);
      if (last !== undefined && now - last < MIN_RETRIGGER_MS) continue;
      if (!this.deps.hasCapacity()) {
        this.pending.add(url);
        break;
      }
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
