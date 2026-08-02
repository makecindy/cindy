/**
 * 自动 worktree 的新鲜基底解析。
 *
 * 背景:handoff(send_to_session use_worktree)与 schedule ephemeral worktree 此前直接取
 * baseRepo 当前检出分支为 sourceBranch,创建前从不 fetch。主仓 checkout 长期停在旧工作
 * 分支、本地 main ref 无人快进时,切出的工作区可落后上游默认分支上千 commit,agent 在
 * 其上开工的成果几乎必然整体返工。
 *
 * 策略(fail-open,任何一步失败都回退 fallback,绝不阻塞 worktree 创建):
 *   1. 基准 remote:存在 upstream 用 upstream(fork 工作流的真上游),否则 origin。
 *   2. 默认分支:优先 `ls-remote --symref <remote> HEAD` 向远端查当前真值——本地
 *      refs/remotes/<remote>/HEAD 只是 clone 时的快照,远端默认分支改名或 remote 刚
 *      添加还没 fetch 过时会过期/缺失;离线或超时再退本地 symbolic-ref → main → master。
 *   3. fetch <remote> <默认分支>。超时经 gitExec timeoutMs 真正终止子进程,不会留下
 *      后台 fetch 与紧随其后的 createWorktree/acquireWorktree 争抢仓库锁;ls-remote
 *      与 fetch 共享 NET_TOTAL_BUDGET_MS 一个总预算,离线最坏回退耗时以其为上限。
 *   4. 本地存在 <remote>/<默认分支> ref → 用它作 sourceBranch;fetch 未成功时先比较
 *      提交祖先关系,该 ref 已落后于 fallback(本地分支领先,如有未推送提交)则保留
 *      fallback,保证回退基底永远不比旧行为更旧;无该 ref 时回退 fallback。
 */
import { gitExec, type GitExecOpts } from './gitExec';
import { createLogger } from '../logger';

const log = createLogger('worktree');

/**
 * 网络操作总预算:ls-remote 与 fetch 共享同一个 deadline,合计不超过此值——worktree
 * 创建是交互路径,离线/弱网下的最坏回退耗时以此为上限,不允许每步各拿一份全新预算。
 */
export const NET_TOTAL_BUDGET_MS = 15_000;
/** ls-remote 单步上限(仍受总预算约束):挂满也要给 fetch 留出预算。 */
const LS_REMOTE_TIMEOUT_MS = 10_000;

/** worktree 网络类 git 操作的统一受限选项:真超时(到点 SIGTERM 杀子进程,不残留
 * 后台进程与后续 git 操作抢仓库锁)+ 禁终端凭证提问(main 进程无终端,等提问只会
 * 白耗满超时窗口;credential helper 不受影响)。 */
export function boundedNetworkGitOpts(timeoutMs: number): GitExecOpts {
  return { timeoutMs, extraEnv: { GIT_TERMINAL_PROMPT: '0' } };
}

export interface FreshSourceResolution {
  /** 建 worktree 用的 sourceBranch(commit-ish,如 `upstream/main`;回退时为 fallback)。 */
  sourceBranch: string;
  /** true = 基于刚 fetch 成功的远端默认分支。 */
  fetched: boolean;
  /** 非 fetched 时的原因,用于日志/排障。 */
  reason?: string;
}

async function tryGit(
  args: readonly string[],
  cwd: string,
  opts?: GitExecOpts,
): Promise<string | null> {
  try {
    return (await gitExec(args, cwd, opts)).stdout.trim();
  } catch {
    return null;
  }
}

export async function resolveFreshSourceBranch(
  baseRepo: string,
  fallback: string,
): Promise<FreshSourceResolution> {
  let remote: 'upstream' | 'origin' | null = null;
  if ((await tryGit(['remote', 'get-url', 'upstream'], baseRepo)) !== null) {
    remote = 'upstream';
  } else if ((await tryGit(['remote', 'get-url', 'origin'], baseRepo)) !== null) {
    remote = 'origin';
  }
  if (!remote) return { sourceBranch: fallback, fetched: false, reason: 'no-remote' };

  // ls-remote 与 fetch 共享一个 deadline:任何一步耗掉的时间都从总预算里扣。
  const netDeadline = Date.now() + NET_TOTAL_BUDGET_MS;
  const remainingBudgetMs = () => netDeadline - Date.now();

  // 远端真值:`ls-remote --symref <remote> HEAD` 首行形如 `ref: refs/heads/main\tHEAD`。
  let defaultBranch =
    (
      await tryGit(
        ['ls-remote', '--symref', remote, 'HEAD'],
        baseRepo,
        boundedNetworkGitOpts(Math.min(LS_REMOTE_TIMEOUT_MS, remainingBudgetMs())),
      )
    )?.match(/^ref:\s+refs\/heads\/(\S+)\s+HEAD$/m)?.[1] ?? null;
  // 离线/超时退本地元数据(可能过期,但仍好过本地工作分支)。
  if (!defaultBranch) {
    defaultBranch =
      (await tryGit(['symbolic-ref', '--short', `refs/remotes/${remote}/HEAD`], baseRepo))?.replace(
        `${remote}/`,
        '',
      ) ?? null;
  }
  if (!defaultBranch) {
    for (const candidate of ['main', 'master']) {
      if ((await tryGit(['rev-parse', '--verify', `refs/remotes/${remote}/${candidate}`], baseRepo)) !== null) {
        defaultBranch = candidate;
        break;
      }
    }
  }
  if (!defaultBranch) return { sourceBranch: fallback, fetched: false, reason: 'no-default-branch' };

  let fetched = false;
  const fetchBudgetMs = remainingBudgetMs();
  if (fetchBudgetMs > 0) {
    try {
      await gitExec(
        ['fetch', '--quiet', remote, defaultBranch],
        baseRepo,
        boundedNetworkGitOpts(fetchBudgetMs),
      );
      fetched = true;
    } catch (err) {
      log.warn(
        `[freshBase] fetch ${remote}/${defaultBranch} 失败,退用本地已有远端 ref:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  } else {
    // ls-remote 已把总预算耗尽(典型:离线挂满超时)——不再以新预算发起第二次网络操作。
    log.warn(`[freshBase] 网络总预算已耗尽,跳过 fetch ${remote}/${defaultBranch},退用本地已有远端 ref`);
  }

  const remoteRef = `${remote}/${defaultBranch}`;
  if ((await tryGit(['rev-parse', '--verify', `refs/remotes/${remote}/${defaultBranch}`], baseRepo)) !== null) {
    if (fetched) return { sourceBranch: remoteRef, fetched: true };
    // fetch 未成功时 remoteRef 可能陈旧:若它已是 fallback 的祖先(本地分支不落后于
    // 它,如本地 main 有未推送提交而 origin/main 较旧),用它会丢 fallback 上的提交,
    // 比旧行为还旧——此时保留 fallback。分叉或远端领先(非祖先)才值得用 stale ref。
    const staleRefBehindFallback =
      (await tryGit(['merge-base', '--is-ancestor', remoteRef, fallback], baseRepo)) !== null;
    if (staleRefBehindFallback) {
      return { sourceBranch: fallback, fetched: false, reason: 'stale-remote-ref-behind-fallback' };
    }
    return { sourceBranch: remoteRef, fetched: false, reason: 'stale-remote-ref' };
  }
  return { sourceBranch: fallback, fetched: false, reason: 'remote-ref-missing' };
}
