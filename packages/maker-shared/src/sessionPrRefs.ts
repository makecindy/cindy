export type PrProvider = 'github' | 'gitlab';

/** Missing identity fields are legacy public GitHub. GitLab owner is the full namespace. */
export interface PrIdentity {
  provider?: PrProvider;
  host?: string;
  owner: string;
  repo: string;
  prNumber: number;
}

export function prStatusQuery(ref: PrIdentity): PrIdentity {
  return {
    owner: ref.owner,
    repo: ref.repo,
    prNumber: ref.prNumber,
    ...(ref.provider === 'gitlab' ? { provider: ref.provider, host: ref.host } : {}),
  };
}

export function prNumberLabel(ref: PrIdentity): string {
  return `${ref.provider === 'gitlab' ? '!' : '#'}${ref.prNumber}`;
}

export function prKindLabel(ref: PrIdentity): 'PR' | 'MR' {
  return ref.provider === 'gitlab' ? 'MR' : 'PR';
}

/** A separate channel prevents older hosts from interpreting MR queries as GitHub. */
export async function remotePrStatuses(
  queries: PrIdentity[],
  sessionId: string,
  invoke: (channel: string, args: unknown[]) => Promise<unknown>,
  reportError?: (error: unknown) => void,
): Promise<PrStatusResult[]> {
  const results: PrStatusResult[] = [];
  for (const provider of ['github', 'gitlab'] as const) {
    const selected = queries.filter((q) => (q.provider ?? 'github') === provider);
    if (!selected.length) continue;
    try {
      const value = await invoke(
        provider === 'gitlab' ? 'git-context:mr-status' : 'git-context:pr-status',
        [{ sessionId, queries: selected }],
      );
      if (Array.isArray(value)) results.push(...(value as PrStatusResult[]));
    } catch (error) {
      if (provider === 'github') throw error;
      // Keep diagnostics separate from UI results; never retry an MR as a GitHub PR.
      reportError?.(error);
      const structuredCode =
        error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      const message =
        error instanceof Error ? error.message : typeof error === 'string' ? error : '';
      const code =
        typeof structuredCode === 'string'
          ? structuredCode
          : (/(?:^|: Error: )\[([A-Z0-9_]+)\]/.exec(message)?.[1] ??
            /^([A-Z0-9_]+)(?=:|$)/.exec(message)?.[1]);
      const reason =
        code === 'DEVICE_LINK_CHANNEL_NOT_ALLOWED' ||
        code === 'CHANNEL_NOT_ALLOWED' ||
        code === 'UNSUPPORTED_CAPABILITY'
          ? ('unsupported' as const)
          : ('fetch-failed' as const);
      results.push(...selected.map((q) => ({ ...q, ok: false as const, reason })));
    }
  }
  return results;
}

/** session 关联的一条 PR 引用(session_pr_refs 行)。 */
export interface SessionPrRef extends PrIdentity {
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
  /** Absent on older hosts. Active message references use explicit with origin=message. */
  associationSource?: string;
  associationOrigin?: string | null;
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
      provider?: PrProvider;
      host?: string;
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
      /** Merge conflict; missing on older hosts or while the provider is still calculating. */
      conflicts?: boolean | null;
      /** GitHub reviewDecision (APPROVED / CHANGES_REQUESTED / REVIEW_REQUIRED). Missing on older hosts. */
      reviewDecision?: string | null;
      headSha?: string;
      baseBranch?: string;
      observedAt?: number;
      revision?: string;
      metadata?: Record<string, unknown>;
    }
  | {
      ok: false;
      provider?: PrProvider;
      host?: string;
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
  | 'gh-missing'
  | 'gh-not-logged-in'
  | 'glab-missing'
  | 'glab-not-logged-in'
  | 'unsupported'
  | 'no-token'
  | 'not-found'
  | 'fetch-failed';

export type PrStatusItemTone = 'good' | 'bad' | 'wait' | 'neutral';
export type PrStatusItemKey =
  | 'checksFailed' | 'checksPending' | 'checksPassed' | 'checksSkipped' | 'threadsOpen' | 'threadsNone'
  | 'merged' | 'closed' | 'draft'
  | 'mergeConflict' | 'mergeBehind' | 'mergeReady' | 'mergeChanges' | 'mergeApproval' | 'mergeWaiting';

/**
 * 插件卡片 PR 状态位的条目(检查、未解决意见、能否合并),桌面与手机共用同一套取舍;
 * 文案由各端按 key 翻译。检查按标题栏 PR 汇总的分类逐项给出数量(失败、进行中、通过、
 * 跳过或中立,只列非零项),卡片与标题栏读法一致。旧版宿主不带合并字段时省掉合并一项,不猜。
 */
export function prStatusItemKeys(
  status: Extract<PrStatusResult, { ok: true }>,
): Array<{ tone: PrStatusItemTone; key: PrStatusItemKey; count?: number }> {
  const items: Array<{ tone: PrStatusItemTone; key: PrStatusItemKey; count?: number }> = [];
  const checks = status.checks;
  if (checks && checks.total > 0) {
    if (checks.failed > 0) items.push({ tone: 'bad', key: 'checksFailed', count: checks.failed });
    if (checks.pending > 0) items.push({ tone: 'wait', key: 'checksPending', count: checks.pending });
    if (checks.passed > 0) items.push({ tone: 'good', key: 'checksPassed', count: checks.passed });
    if (checks.skipped > 0) items.push({ tone: 'neutral', key: 'checksSkipped', count: checks.skipped });
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

/** Host-qualified identity prevents collisions across providers and GitLab instances. */
export function prStatusKey(ref: PrIdentity): string {
  return `${ref.provider ?? 'github'}:${(ref.host ?? 'github.com').toLowerCase()}/${ref.owner.toLowerCase()}/${ref.repo.toLowerCase()}#${ref.prNumber}`;
}

/** Navigation is derived from the associated identity, never an arbitrary response URL. */
export function sessionPrUrl(ref: PrIdentity): string {
  const project = `${ref.owner}/${ref.repo}`.split('/').map(encodeURIComponent).join('/');
  if (ref.provider === 'gitlab') {
    if (!isPrHost(ref.host)) return '';
    return `https://${ref.host.toLowerCase()}/${project}/-/merge_requests/${ref.prNumber}`;
  }
  return `https://github.com/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}/pull/${ref.prNumber}`;
}

/** Host only: no credentials, path, port, query or fragment. */
export function isPrHost(host: unknown): host is string {
  if (typeof host !== 'string' || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(host)) return false;
  try {
    return new URL(`https://${host}`).hostname === host.toLowerCase();
  } catch {
    return false;
  }
}
