/**
 * session-git-pr-context — renderer 侧消费的 git 上下文类型。
 * 与 main 的 src/main/git-context/* 输出形状 1:1(IPC 边界手写镜像,
 * 与 worktree.types.ts 的做法一致:renderer 不直接 import main 模块)。
 */

/** 当前 HEAD 指向(main/git-context/headReader.ts 的 GitHeadInfo 镜像)。 */
export interface GitHeadInfo {
  kind: 'branch' | 'detached';
  branch: string | null;
  shortSha: string | null;
}

/** git-context:get / git-context:changed 的 payload。head=null 表示非 git 目录。 */
export interface GitContextSnapshot {
  workdir: string;
  head: GitHeadInfo | null;
}

/**
 * 「对话有效工作目录」的来源,决定徽标对分支的信任度:
 *   telemetry  = 从 agent tool-call(Codex cwd / cc 编辑路径)推出的真实工作目录,可信
 *   worktree   = app 托管 worktree 的 live 路径,可信
 *   workingDir = 兜底用 session.working_dir(共享主 checkout,低信任,优先让位 PR 分支)
 *   remote      = 远端 SSH 主机上直接探测到的目录分支,可信
 *   null       = 无可解析目录
 */
export type GitContextDirSource = 'telemetry' | 'worktree' | 'workingDir' | 'remote' | null;

/** git-context:get-for-session 的返回:解析出的目录 + 其 HEAD + 来源。 */
export interface SessionGitDirResult {
  workdir: string | null;
  head: GitHeadInfo | null;
  source: GitContextDirSource;
}

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
      reason: 'no-token' | 'not-found' | 'fetch-failed';
    };
