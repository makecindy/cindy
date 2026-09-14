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
}

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
