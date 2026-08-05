import path from 'node:path';

import type {
  CreateWorktreeReq,
  CreateWorktreeResp,
  DetectCwdResp,
  ListBranchesResp,
  WorktreeMeta,
} from '../worktree/types.js';

/**
 * send_to_session create 分支的 worktree 准备逻辑(use_worktree=true 时)。
 *
 * 职责:从 dispatcher session 的 workingDir 解析出 base repo,然后为「即将创建的
 * 新 session」预建一个正规的 session worktree(与 UI 新会话勾选 worktree 产出的
 * 完全同类:.cindy-worktrees/<name> + cindy/<name> 分支、worktreeStore 绑定、关闭时
 * auto-stash 清理)。调用方拿到 worktree 路径后以其为 workingDir 创建 session。
 *
 * base repo 解析的三种情况(按序):
 *  1. dispatcher 自己就是 worktree session(store 里有绑定)→ 直接用绑定的 baseRepo,
 *     避免 detectCwd 把 worktree 根当 repo 根(git rev-parse --show-toplevel 在
 *     linked worktree 里返回的是 worktree 根,不是主仓库根)。
 *  2. workingDir 是普通 git 仓库 → repoRoot 即 baseRepo。
 *  3. workingDir 在某个 worktree 内但 dispatcher 没绑定(如 scheduler ephemeral
 *     worktree 场景)→ 按路径前缀在 store 全量登记里反查所属 worktree 的 baseRepo。
 *
 * 依赖全部注入(WorktreeManager 的函数 + id 生成器),便于内存 harness 直接单测,
 * 不需要 Electron / 真 git(见 __tests__/handoffWorktree.test.ts)。
 */
export interface HandoffWorktreeDeps {
  getForSession: (sessionId: string) => WorktreeMeta | null;
  listAll: () => WorktreeMeta[];
  detectCwd: (cwd: string) => Promise<DetectCwdResp>;
  suggestName: (baseRepo: string) => Promise<string>;
  /** 列分支 + 当前检出分支;repoDir 可以是主仓根,也可以是 linked worktree 路径。 */
  listBranches: (repoDir: string) => Promise<ListBranchesResp>;
  /** 把 ref(如 HEAD)解析为 commit SHA,失败返回 null(WorktreeManager.revParseCommit)。 */
  resolveCommit?: (repoDir: string, ref: string) => Promise<string | null>;
  createWorktree: (req: CreateWorktreeReq) => Promise<CreateWorktreeResp>;
  createId: () => string;
  /**
   * 新任务基底解析(worktree/freshBase.ts 的 resolveFreshSourceBranch):fetch 基准
   * remote 默认分支并返回 `<remote>/<默认分支>`,失败回退 fallback。不注入时保持
   * 旧行为(直接用 baseRepo 当前分支)——仅用于测试或明确要跟随本地状态的调用方。
   */
  resolveFreshSource?: (baseRepo: string, fallback: string) => Promise<{ sourceBranch: string }>;
}

export type PrepareHandoffWorktreeResult =
  { ok: true; sessionId: string; meta: WorktreeMeta } | { ok: false; message: string };

/** a 是否等于 b 或位于 b 目录之下(大小写按 Windows 习惯不敏感比较,POSIX 敏感)。 */
function isSamePathOrUnder(a: string, b: string): boolean {
  const norm = (p: string) => {
    const r = path.resolve(p);
    return process.platform === 'win32' ? r.toLowerCase() : r;
  };
  const na = norm(a);
  const nb = norm(b);
  return na === nb || na.startsWith(nb + path.sep);
}

/** 解析 dispatcher workingDir 对应的 base repo;解析不出时返回 null + 原因。 */
export async function resolveHandoffBaseRepo(
  deps: Pick<HandoffWorktreeDeps, 'getForSession' | 'listAll' | 'detectCwd'>,
  dispatcherSessionId: string | undefined,
  workingDir: string,
): Promise<{ baseRepo: string } | { baseRepo: null; message: string }> {
  // 情况 1:dispatcher 自己是 worktree session,且 workingDir 确实还在那个 worktree 下
  //(防 workingDir 后来被改走后误用旧绑定)。
  if (dispatcherSessionId) {
    const own = deps.getForSession(dispatcherSessionId);
    if (own && isSamePathOrUnder(workingDir, own.path)) {
      return { baseRepo: own.baseRepo };
    }
  }

  const det = await deps.detectCwd(workingDir);
  if (!det.gitInstalled) {
    return { baseRepo: null, message: 'git 未安装,无法创建 worktree' };
  }
  if (!det.isGitRepo || !det.repoRoot) {
    return { baseRepo: null, message: `workingDir 不是 git 仓库,无法创建 worktree: ${workingDir}` };
  }
  // 情况 2:普通 git 仓库。
  if (!det.isInsideWorktree) {
    return { baseRepo: det.repoRoot };
  }
  // 情况 3:在别人的 worktree 里 → 按路径反查登记表。
  const owner = deps.listAll().find((m) => isSamePathOrUnder(workingDir, m.path));
  if (owner) return { baseRepo: owner.baseRepo };
  return {
    baseRepo: null,
    message: `workingDir 位于一个未登记的 git worktree 内,无法定位 base repo: ${workingDir}`,
  };
}

/**
 * create 失败路径上「该不该回收刚建的 worktree」的决策(register.ts 的 catch 消费):
 *  - session 未建成(bootstrapSession 前 / 中失败)→ 回收:worktree 无主,不删会留下
 *    孤儿目录与 store 绑定,且 skill 侧拿到 ok:false 不会记绑定,下轮重投会再建一套。
 *  - session 已建成(仅后续 send / 持久化失败)→ 绝不回收:session 的 workingDir 与
 *    DB worktree_path 都指着这个目录(removeWorktreeForSession 故意不清 DB 字段),
 *    删掉会让该会话变成指向不存在目录的孤儿——BUSY 分支甚至还有 turn 正在其中跑,
 *    强删等于抽走运行中的工作目录。它随 session 正常 close 生命周期回收即可。
 */
export function shouldRecycleHandoffWorktreeOnFailure(sessionCreated: boolean): boolean {
  return !sessionCreated;
}

/**
 * 为新 session 预建 worktree:解析 baseRepo → 生成不冲突的名字 → 选源分支建 worktree。
 * 返回预生成的 sessionId(调用方必须用它作为新 session 的 id,worktreeStore 绑定已按它登记)。
 *
 * 源分支语义(2026-08-02 起):
 *  - dispatcher 自己是 worktree session 且 workingDir 在其下 → 视为「派生子任务」:
 *    以 dispatcher worktree 当前检出的分支为源,跟随其在途工作。
 *  - 其它情况(从主仓 / 未绑定目录派发)→ 视为「新任务」:经 resolveFreshSource 取
 *    fetch 后的远端默认分支为源。主仓 checkout 常年停在旧工作分支时,旧行为切出的
 *    工作区可落后上游上千 commit(实踩),这是本分支语义的直接动因。
 */
export async function prepareHandoffWorktree(
  deps: HandoffWorktreeDeps,
  dispatcherSessionId: string | undefined,
  workingDir: string,
): Promise<PrepareHandoffWorktreeResult> {
  const resolved = await resolveHandoffBaseRepo(deps, dispatcherSessionId, workingDir);
  if (resolved.baseRepo === null) return { ok: false, message: resolved.message };
  const baseRepo = resolved.baseRepo;

  const name = await deps.suggestName(baseRepo);
  const dispatcherWorktree = dispatcherSessionId ? deps.getForSession(dispatcherSessionId) : null;
  const continuingDispatcherWork =
    !!dispatcherWorktree && isSamePathOrUnder(workingDir, dispatcherWorktree.path);
  let sourceBranch: string;
  if (continuingDispatcherWork) {
    // 派生子任务:源分支取 dispatcher worktree 里当前检出的分支——baseRepo 主 checkout
    // 的 current 可能是另一条分支,用它会丢 dispatcher 分支上的在途提交。
    const { current } = await deps.listBranches(dispatcherWorktree.path);
    if (current && current !== 'HEAD') {
      sourceBranch = current;
    } else {
      // detached HEAD(rev-parse --abbrev-ref 返回字面量 HEAD):跟随 dispatcher
      // 实际检出的提交(rev-parse HEAD 的 SHA)——创建时登记的分支可能早已落后
      // 实际工作位置,直接用会丢提交;解析失败才退登记分支。
      const headSha = (await deps.resolveCommit?.(dispatcherWorktree.path, 'HEAD')) ?? null;
      sourceBranch = headSha ?? dispatcherWorktree.branch;
    }
  } else {
    const { current } = await deps.listBranches(baseRepo);
    const fallback = current || 'HEAD';
    sourceBranch = deps.resolveFreshSource
      ? (await deps.resolveFreshSource(baseRepo, fallback)).sourceBranch
      : fallback;
  }
  const sessionId = deps.createId();
  const resp = await deps.createWorktree({ sessionId, baseRepo, name, sourceBranch });
  if (!resp.ok) {
    return { ok: false, message: resp.error.message || resp.error.kind };
  }
  return { ok: true, sessionId, meta: resp.meta };
}
