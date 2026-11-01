/** session 关联的一条 PR 引用(session_pr_refs 行)。 */
export interface SessionPrRef {
  id: string;
  sessionId: string;
  owner: string;
  repo: string;
  prNumber: number;
  url: string;
  firstSeenAt: number;
  lastSeenAt: number;
  /** Explicit user choices; absent on older hosts. */
  pinned?: boolean;
  priority?: number;
  manuallyAdded?: boolean;
  removedAt?: number | null;
}

/** Counts for the current PR head, across check runs and commit statuses. */
export interface PrChecksSummary {
  total: number;
  failed: number;
  passed: number;
  pending: number;
  /** Neutral/skipped checks are complete, but are not reported as passing. */
  skipped: number;
}

export type SessionPrRefAction =
  | { action: 'add'; url: string }
  | { action: 'reorder'; ids: string[] }
  | {
      action: 'remove' | 'restore' | 'pin' | 'unpin';
      id: string;
    };

export type PrStatusKind = 'open' | 'draft' | 'merged' | 'closed';

/** git-context:pr-status 单条结果。 */
export type PrStatusResult =
  | {
      ok: true;
      owner: string;
      repo: string;
      prNumber: number;
      status: PrStatusKind;
      title: string;
      htmlUrl: string;
      /** PR 源分支名(GitHub `head.ref`);徽标拿不到本地工作目录时兜底显示分支。 */
      branch: string;
      /** 未解决 review thread 数;null = 查询失败 / token 不支持 GraphQL。 */
      unresolvedCount: number | null;
      /** Missing on older hosts; null means unavailable, not zero. */
      checks?: PrChecksSummary | null;
      /** GitHub mergeStateStatus (CLEAN / DIRTY / BEHIND / BLOCKED …). Missing on older hosts. */
      mergeState?: string | null;
      /** GitHub reviewDecision (APPROVED / CHANGES_REQUESTED / REVIEW_REQUIRED). Missing on older hosts. */
      reviewDecision?: string | null;
    }
  | {
      ok: false;
      owner: string;
      repo: string;
      prNumber: number;
      reason: PrStatusFailureReason;
    };

/**
 * 镜像 main/git-context/prStatusService.ts 的 PrStatusFailureReason:
 *   gh-missing / gh-not-logged-in = 本机 gh 缺失 / 未登录,徽标点击引导 Agent 处理
 *   no-token  = 拿不到 token 且不给原因(device-link 远端结果、gh 子进程超时)
 *   not-found = 404;fetch-failed = 网络等其它错误
 */
export type PrStatusFailureReason =
  'gh-missing' | 'gh-not-logged-in' | 'no-token' | 'not-found' | 'fetch-failed';

export type PrStatusItemTone = 'good' | 'bad' | 'wait';
export type PrStatusItemKey =
  | 'ciPassed' | 'ciFailed' | 'ciRunning' | 'threadsOpen' | 'threadsNone'
  | 'merged' | 'closed' | 'draft'
  | 'mergeConflict' | 'mergeBehind' | 'mergeReady' | 'mergeChanges' | 'mergeApproval' | 'mergeWaiting';

/**
 * 插件卡片 PR 状态位的条目(CI、未解决意见、能否合并),桌面与手机共用同一套取舍;
 * 文案由各端按 key 翻译。旧版宿主不带合并字段时省掉合并一项,不猜。
 */
export function prStatusItemKeys(
  status: Extract<PrStatusResult, { ok: true }>,
): Array<{ tone: PrStatusItemTone; key: PrStatusItemKey; count?: number }> {
  const items: Array<{ tone: PrStatusItemTone; key: PrStatusItemKey; count?: number }> = [];
  const checks = status.checks;
  if (checks && checks.total > 0) {
    if (checks.failed > 0) items.push({ tone: 'bad', key: 'ciFailed' });
    else if (checks.pending > 0) items.push({ tone: 'wait', key: 'ciRunning' });
    else items.push({ tone: 'good', key: 'ciPassed' });
  }
  if (status.unresolvedCount !== null) {
    items.push(status.unresolvedCount > 0
      ? { tone: 'wait', key: 'threadsOpen', count: status.unresolvedCount }
      : { tone: 'good', key: 'threadsNone' });
  }
  if (status.status === 'merged') items.push({ tone: 'good', key: 'merged' });
  else if (status.status === 'closed') items.push({ tone: 'wait', key: 'closed' });
  else if (status.status === 'draft') items.push({ tone: 'wait', key: 'draft' });
  else if (status.mergeState !== undefined || status.reviewDecision !== undefined) {
    if (status.mergeState === 'DIRTY') items.push({ tone: 'bad', key: 'mergeConflict' });
    else if (status.mergeState === 'BEHIND') items.push({ tone: 'wait', key: 'mergeBehind' });
    else if (status.mergeState === 'CLEAN') items.push({ tone: 'good', key: 'mergeReady' });
    else if (status.reviewDecision === 'CHANGES_REQUESTED') items.push({ tone: 'wait', key: 'mergeChanges' });
    else if (status.reviewDecision === 'REVIEW_REQUIRED') items.push({ tone: 'wait', key: 'mergeApproval' });
    else items.push({ tone: 'wait', key: 'mergeWaiting' });
  }
  return items;
}

/** 只对最近的几条 PR 引用查状态(徽标也只展示这几条)。 */
export const MAX_STATUS_QUERIES = 3;

/**
 * PR 状态的兜底刷新周期——聊天顶栏与侧栏徽标(PrRefsContext)共用同一节拍。
 * GitHub 侧 open→merged / review 评论 resolve 这类变化不会产生本地
 * pr-refs-changed 事件,只靠初次加载会一直显示旧状态。取值刻意 > main 侧
 * 60s TTL,保证每次 tick 都真的打到远端。
 */
export const PR_STATUS_REFRESH_INTERVAL_MS = 90_000;

/** statuses 缓存的 key:`owner/repo#N`(小写 owner/repo)。 */
export function prStatusKey(ref: { owner: string; repo: string; prNumber: number }): string {
  return `${ref.owner.toLowerCase()}/${ref.repo.toLowerCase()}#${ref.prNumber}`;
}

/** Navigation is derived from the associated PR identity, never an arbitrary URL. */
export function sessionPrUrl(ref: Pick<SessionPrRef, 'owner' | 'repo' | 'prNumber'>): string {
  return `https://github.com/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}/pull/${ref.prNumber}`;
}
