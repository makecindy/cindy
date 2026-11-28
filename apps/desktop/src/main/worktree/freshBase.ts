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
import { gitExec, KILL_CLEANUP_BUDGET_MS, type GitExecOpts } from './gitExec';
import { createLogger } from '../logger';
import { readOriginDefaultBranch } from './branchSync';

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
  /** 建 worktree 用的 sourceBranch(commit-ish,如 `refs/remotes/upstream/main`
   * 完整远端引用,避免与同名本地分支歧义;回退时为 fallback)。 */
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
  /** 网络总预算覆盖(测试注入/调优用);≤0 表示不做任何网络操作,纯本地回退。 */
  totalBudgetMs: number = NET_TOTAL_BUDGET_MS,
): Promise<FreshSourceResolution> {
  let remote: 'upstream' | 'origin' | null = null;
  if ((await tryGit(['remote', 'get-url', 'upstream'], baseRepo)) !== null) {
    remote = 'upstream';
  } else if ((await tryGit(['remote', 'get-url', 'origin'], baseRepo)) !== null) {
    remote = 'origin';
  }
  if (!remote) return { sourceBranch: fallback, fetched: false, reason: 'no-remote' };

  // ls-remote 与 fetch 共享一个 deadline:任何一步耗掉的时间都从总预算里扣。
  // 每步的 timeoutMs 还要预留 gitExec 超时清理预算(SIGTERM/SIGKILL/退净确认,
  // KILL_CLEANUP_BUDGET_MS)——超时路径的清理墙钟也落在同一 deadline 内,
  // 不在总预算之外追加。
  const netDeadline = Date.now() + totalBudgetMs;
  const remainingBudgetMs = () => netDeadline - Date.now();
  const stepBudgetMs = (capMs: number) =>
    Math.min(capMs, remainingBudgetMs() - KILL_CLEANUP_BUDGET_MS);

  // 远端真值:`ls-remote --symref <remote> HEAD` 首行形如 `ref: refs/heads/main\tHEAD`。
  // 预算必须为正才发起网络操作——0/负数传给 gitExec 语义是「不超时」,恰好把
  // 总预算击穿成无界等待;预算耗尽直接走下面的本地元数据回退。
  let defaultBranch: string | null = null;
  const lsRemoteBudgetMs = stepBudgetMs(LS_REMOTE_TIMEOUT_MS);
  if (lsRemoteBudgetMs > 0) {
    defaultBranch =
      (
        await tryGit(
          ['ls-remote', '--symref', remote, 'HEAD'],
          baseRepo,
          boundedNetworkGitOpts(lsRemoteBudgetMs),
        )
      )?.match(/^ref:\s+refs\/heads\/(\S+)\s+HEAD$/m)?.[1] ?? null;
  }
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
      if (
        (await tryGit(
          ['rev-parse', '--verify', `refs/remotes/${remote}/${candidate}`],
          baseRepo,
        )) !== null
      ) {
        defaultBranch = candidate;
        break;
      }
    }
  }
  if (!defaultBranch)
    return { sourceBranch: fallback, fetched: false, reason: 'no-default-branch' };

  const fetched = await fetchRemoteDefaultBranch(
    baseRepo,
    remote,
    defaultBranch,
    stepBudgetMs(totalBudgetMs),
  );

  // 完整远端跟踪引用:本地若恰好存在名为 "origin/main" 的**分支**,短名会歧义
  // (git 会警告并可能解析到 refs/heads/origin/main),worktree 创建可能失败或
  // 切错基底;refs/remotes/ 全名无歧义,后续 rev-parse/merge-base/worktree add
  // 全部照常接受。
  const remoteRef = `refs/remotes/${remote}/${defaultBranch}`;
  if (
    (await tryGit(
      ['rev-parse', '--verify', `refs/remotes/${remote}/${defaultBranch}`],
      baseRepo,
    )) !== null
  ) {
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

export interface ExplicitSourceResolution {
  /** 建 worktree 用的 commit-ish。远端分支一律返回 `refs/remotes/<remote>/<分支>` 全名。 */
  sourceBranch: string;
  /**
   * true = 远端分支且刚 fetch 成功;false = 远端分支但没能刷新(本地副本可能落后或不存在);
   * 省略 = 不是远端分支(本地分支、tag、提交),没有可刷新的东西。
   */
  fetched?: boolean;
  /** fetched=false 的原因:`not-on-remote`(远端明确没有这条分支)或 `fetch-failed`。 */
  reason?: 'not-on-remote' | 'fetch-failed';
}

/**
 * 调用方点名的基线(`send_to_session` / `create_task_worktree` 的 `base_ref`)。
 *
 * 点名远端分支(`origin/x`、`refs/remotes/origin/x`)的调用方要的是远端此刻的 x:另一台电脑
 * 刚 push、本机还没 fetch 时,本地 tracking ref 要么不存在要么停在旧提交,从它切出的工作区
 * 一开工就得再 pull 一遍(大仓会再触发一轮整树检出)。所以这里先在同一份网络预算内 fetch
 * 这一条分支,失败时沿用本地已有 ref 并如实报告 fetched=false,由调用方转告。
 *
 * 只认「前缀是已配置 remote、且没有同名本地分支或 tag」的写法:本地分支与 tag 按 git 自身的
 * 解析顺序优先,原样返回、不联网。`origin/x~2` 这类表达式不是分支名,同样原样返回、按本机现状
 * 解析。引用是否存在不在这里判定——解析不了由 createWorktree 报错,不回退默认分支。
 */
export async function resolveExplicitSourceRef(
  baseRepo: string,
  ref: string,
  /** 网络总预算覆盖(测试注入/调优用);≤0 表示不联网。 */
  totalBudgetMs: number = NET_TOTAL_BUDGET_MS,
): Promise<ExplicitSourceResolution> {
  const deadline = Date.now() + totalBudgetMs;
  const explicitRemote = ref.startsWith('refs/remotes/');
  if (ref.startsWith('refs/') && !explicitRemote) return { sourceBranch: ref };
  const short = explicitRemote ? ref.slice('refs/remotes/'.length) : ref;
  // remote 名可以带 `/`:取能匹配上的最长一个。
  const remote = ((await tryGit(['remote'], baseRepo)) ?? '')
    .split('\n')
    .map((name) => name.trim())
    .filter((name) => name && short.startsWith(`${name}/`) && short.length > name.length + 1)
    .sort((a, b) => b.length - a.length)[0];
  if (!remote) return { sourceBranch: ref };
  const branch = short.slice(remote.length + 1);
  // `<remote>/HEAD` 是指向远端默认分支的符号引用,不是名叫 HEAD 的分支:原样交给 git 解析。
  if (branch === 'HEAD') return { sourceBranch: ref };
  if (!explicitRemote) {
    const shadowing = ((await tryGit(
      ['for-each-ref', '--format=%(refname)', `refs/heads/${short}`, `refs/tags/${short}`],
      baseRepo,
    )) ?? '').split('\n').map((line) => line.trim());
    if (shadowing.includes(`refs/heads/${short}`) || shadowing.includes(`refs/tags/${short}`)) {
      return { sourceBranch: ref };
    }
  }
  // 分支名要进 refspec:含通配符或 `:` 的写法会改变 fetch 的范围,交给 git 自己判合法性。
  if ((await tryGit(['check-ref-format', `refs/heads/${branch}`], baseRepo)) === null) {
    return { sourceBranch: ref };
  }
  const sourceBranch = `refs/remotes/${remote}/${branch}`;
  const outcome = await fetchRemoteBranch(
    baseRepo,
    remote,
    branch,
    deadline - Date.now() - KILL_CLEANUP_BUDGET_MS,
  );
  return outcome === 'fetched'
    ? { sourceBranch, fetched: true }
    : { sourceBranch, fetched: false, reason: outcome };
}

/** Shared bounded, fail-open fetch for automatic and explicitly selected default sources. */
async function fetchRemoteDefaultBranch(
  baseRepo: string,
  remote: string,
  defaultBranch: string,
  fetchBudgetMs: number,
): Promise<boolean> {
  return (await fetchRemoteBranch(baseRepo, remote, defaultBranch, fetchBudgetMs)) === 'fetched';
}

async function fetchRemoteBranch(
  baseRepo: string,
  remote: string,
  defaultBranch: string,
  fetchBudgetMs: number,
): Promise<'fetched' | 'not-on-remote' | 'fetch-failed'> {
  let outcome: 'fetched' | 'not-on-remote' | 'fetch-failed' = 'fetch-failed';
  if (fetchBudgetMs > 0) {
    try {
      // 显式目标 refspec:--single-branch 或收窄 remote.<name>.fetch 的 clone 里,
      // 裸 `fetch <remote> <branch>` 只更新 FETCH_HEAD 不建 remote-tracking ref,
      // 后续 rev-parse 查不到该 ref 就会退回陈旧基底(远端默认分支改名场景必踩)。
      // `+` 前缀允许非快进更新,与标准 clone refspec 语义一致。
      await gitExec(
        [
          'fetch',
          '--quiet',
          remote,
          `+refs/heads/${defaultBranch}:refs/remotes/${remote}/${defaultBranch}`,
        ],
        baseRepo,
        // LC_ALL=C:下面按 git 的英文报错识别「远端没有这条分支」。
        { ...boundedNetworkGitOpts(fetchBudgetMs), extraEnv: { GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' } },
      );
      outcome = 'fetched';
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // 远端可达但没有这条分支,与「没连上」是两回事:前者重试无益,调用方要换引用。
      if (/couldn't find remote ref/i.test(msg)) outcome = 'not-on-remote';
      // 「cleanup unconfirmed」(超时且残留进程未确认退净,见 gitExec)也走同一
      // 回退——这是**刻意的 fail-open 决策**,不是漏消费:本模块的行为契约是
      // 新鲜基底解析的任何失败都回退旧行为,自动 worktree 创建不因此失败;改成
      // fail-closed 会把降级环境(无 PowerShell、不可杀进程)变成必失败。残留
      // 进程若真持有 ref/index 锁,后续 git 写操作会以锁错误**显式失败**,git 的
      // 锁机制保证不会静默损坏。若产品决策改为 fail-closed,在此按 msg 含
      // "cleanup unconfirmed" 返回独立结果即可(错误已可区分)。
      log.warn(`[freshBase] fetch ${remote}/${defaultBranch} 失败,退用本地已有远端 ref:`, msg);
    }
  } else {
    // 预算耗尽时不能把 0 传给 gitExec（0 代表无限等待）。
    log.warn(
      `[freshBase] 网络总预算已耗尽,跳过 fetch ${remote}/${defaultBranch},退用本地已有远端 ref`,
    );
  }

  return outcome;
}

/** Refresh a selected full origin default ref. Other refs are left to the caller. */
export async function refreshSelectedDefaultSource(
  baseRepo: string,
  sourceBranch: string,
  totalBudgetMs = NET_TOTAL_BUDGET_MS,
): Promise<void> {
  if (!sourceBranch?.startsWith('refs/remotes/origin/')) return;
  const deadline = Date.now() + totalBudgetMs;
  try {
    if (sourceBranch !== (await readOriginDefaultBranch(baseRepo))) return;
    await fetchRemoteDefaultBranch(
      baseRepo,
      'origin',
      sourceBranch.slice('refs/remotes/origin/'.length),
      deadline - Date.now() - KILL_CLEANUP_BUDGET_MS,
    );
  } catch {
    log.warn('[freshBase] 默认源分支探测失败，使用本地已有 ref');
  }
}
