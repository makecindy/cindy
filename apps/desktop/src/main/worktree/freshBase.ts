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
 *      后台 fetch 与紧随其后的 createWorktree/acquireWorktree 争抢仓库锁。
 *   4. 本地存在 <remote>/<默认分支> ref → 用它作 sourceBranch(即便 fetch 失败,该 ref
 *      也不会比本地分支更旧);否则回退 fallback。
 */
import { gitExec, type GitExecOpts } from './gitExec';
import { createLogger } from '../logger';

const log = createLogger('worktree');

/** ls-remote 查远端默认分支的超时:只读小请求,到点杀进程退本地元数据。 */
const LS_REMOTE_TIMEOUT_MS = 10_000;
/** fetch 超时:worktree 创建是交互路径,网络不好时宁可用本地已有远端 ref 也不卡创建。 */
const FETCH_TIMEOUT_MS = 15_000;

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

  // 网络类命令统一:真超时 + 禁终端凭证提问(main 进程无终端,等提问只会白耗满超时窗口;
  // credential helper 不受影响)。
  const netOpts = (timeoutMs: number): GitExecOpts => ({
    timeoutMs,
    extraEnv: { GIT_TERMINAL_PROMPT: '0' },
  });

  // 远端真值:`ls-remote --symref <remote> HEAD` 首行形如 `ref: refs/heads/main\tHEAD`。
  let defaultBranch =
    (
      await tryGit(['ls-remote', '--symref', remote, 'HEAD'], baseRepo, netOpts(LS_REMOTE_TIMEOUT_MS))
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
  try {
    await gitExec(['fetch', '--quiet', remote, defaultBranch], baseRepo, netOpts(FETCH_TIMEOUT_MS));
    fetched = true;
  } catch (err) {
    log.warn(
      `[freshBase] fetch ${remote}/${defaultBranch} 失败,退用本地已有远端 ref:`,
      err instanceof Error ? err.message : String(err),
    );
  }

  const remoteRef = `${remote}/${defaultBranch}`;
  if ((await tryGit(['rev-parse', '--verify', `refs/remotes/${remote}/${defaultBranch}`], baseRepo)) !== null) {
    return { sourceBranch: remoteRef, fetched, reason: fetched ? undefined : 'stale-remote-ref' };
  }
  return { sourceBranch: fallback, fetched: false, reason: 'remote-ref-missing' };
}
