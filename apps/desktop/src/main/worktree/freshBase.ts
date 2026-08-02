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
 *   2. 默认分支:refs/remotes/<remote>/HEAD → 退 main → 退 master。
 *   3. fetch <remote> <默认分支>(带超时;超时/失败不致命)。
 *   4. 本地存在 <remote>/<默认分支> ref → 用它作 sourceBranch(即便 fetch 失败,该 ref
 *      也不会比本地分支更旧);否则回退 fallback。
 */
import { gitExec } from './gitExec';
import { createLogger } from '../logger';

const log = createLogger('worktree');

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

async function tryGit(args: readonly string[], cwd: string): Promise<string | null> {
  try {
    return (await gitExec(args, cwd)).stdout.trim();
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

  let defaultBranch =
    (await tryGit(['symbolic-ref', '--short', `refs/remotes/${remote}/HEAD`], baseRepo))?.replace(
      `${remote}/`,
      '',
    ) ?? null;
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
    await Promise.race([
      gitExec(['fetch', '--quiet', remote, defaultBranch], baseRepo).then(() => {
        fetched = true;
      }),
      new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error(`fetch timeout after ${FETCH_TIMEOUT_MS}ms`)), FETCH_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
  } catch (err) {
    // 超时路径下 fetch 子进程可能仍在后台完成,只会更新 ref,无副作用。
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
