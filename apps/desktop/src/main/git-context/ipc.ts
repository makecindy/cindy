/**
 * git-context IPC 装配层 — 单例组装 + handler 注册 + renderer 广播。
 *
 * Channels(invoke):
 *   git-context:get             (workdir) → GitContextSnapshot
 *   git-context:get-for-session ({sessionId,workingDir,worktreePath}) → SessionGitDirResult
 *   git-context:watch           (workdir) → void(开始监听 HEAD,refcount)
 *   git-context:unwatch       (workdir) → void
 *   git-context:pr-refs:list  (sessionId) → SessionPrRef[]
 *   git-context:pr-status     (queries[]) → PrStatusResult[]
 *
 * Channels(push,main → all windows):
 *   git-context:changed         { workdir, head }
 *   git-context:pr-refs-changed { sessionId }
 *
 * GitHub token 只用本地 gh CLI 登录态(`gh auth token`,零配置)——agent 干活
 * 本来就靠 gh,凭证天然就有;未登录时降级 no-token,UI 提示让 agent 跑一次
 * gh auth login 即可。不做 app 级 PAT 绑定(设计收敛,见 PR #94 讨论)。
 */

import { BrowserWindow, ipcMain } from 'electron';
import { GithubClient } from '@cindy/github-client';

import { createLogger } from '../logger.js';
import { getCurrentDbClientUserId } from '../localDb/client/current';
import { outboundFetch } from '../maker-host/outbound-fetch.js';
import { requireString, throwIpcError } from '../utils/ipcValidate';
import { getSharedGhCliTokenSource } from './ghCliTokenSource.js';
import { GitContextService } from './GitContextService.js';
import { resolveSessionGitDirLive } from './sessionDirResolver.js';
import {
  ensurePrRefsBackfill,
  listAllPrRefs,
  listPrRefs,
  setPrRefsChangedListener,
} from './prRefsStore.js';
import {
  PrStatusService,
  type PrStatusQuery,
  type PrRemoteState,
} from './prStatusService.js';

const log = createLogger('git-context/ipc');

export const GIT_CONTEXT_INVOKE = {
  GET: 'git-context:get',
  GET_FOR_SESSION: 'git-context:get-for-session',
  WATCH: 'git-context:watch',
  UNWATCH: 'git-context:unwatch',
  PR_REFS_LIST: 'git-context:pr-refs:list',
  PR_REFS_LIST_ALL: 'git-context:pr-refs:list-all',
  PR_STATUS: 'git-context:pr-status',
} as const;

export const GIT_CONTEXT_PUSH = {
  CHANGED: 'git-context:changed',
  PR_REFS_CHANGED: 'git-context:pr-refs-changed',
} as const;

function broadcastToAllWindows(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      win.webContents.send(channel, payload);
    } catch (e) {
      log.warn(`broadcast failed: ${String(e)}`);
    }
  }
}

/** gh CLI 登录态来源(进程内共享单例,内置 5min 正 / 30s 负缓存)。 */
const ghCliTokenSource = getSharedGhCliTokenSource();

async function readGithubToken(): Promise<string | null> {
  return ghCliTokenSource.readToken();
}

/** GraphQL 查未解决 review thread 数(REST 不暴露 isResolved)。上限 100。 */
const UNRESOLVED_THREADS_QUERY = `
query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100) { nodes { isResolved } }
    }
  }
}`;

async function fetchUnresolvedCount(client: GithubClient, q: PrStatusQuery): Promise<number> {
  const data = await client.graphql<{
    repository: {
      pullRequest: { reviewThreads: { nodes: Array<{ isResolved: boolean }> } } | null;
    } | null;
  }>(UNRESOLVED_THREADS_QUERY, { owner: q.owner, repo: q.repo, number: q.prNumber });
  const nodes = data.repository?.pullRequest?.reviewThreads?.nodes ?? [];
  return nodes.filter((n) => !n.isResolved).length;
}

async function fetchPrRemote(token: string, q: PrStatusQuery): Promise<PrRemoteState> {
  // fetchImpl:api.github.com 是境外端点,走吃系统代理的通道(见 maker-host/outbound-fetch)。
  const client = new GithubClient({ token, owner: q.owner, repo: q.repo, fetchImpl: outboundFetch });
  // 核心状态走 REST(所有 token 类型通用);未解决数走 GraphQL 增强信号,
  // 失败(老 fine-grained PAT 不支持 GraphQL 等)降级 null,不拖垮整条状态。
  const [pr, unresolved] = await Promise.all([
    client.getPullRequest(q.prNumber),
    fetchUnresolvedCount(client, q).catch((err) => {
      log.debug('unresolved threads query failed (degrade to null)', { err: String(err) });
      return null;
    }),
  ]);
  return {
    state: pr.state,
    draft: pr.draft,
    merged: pr.merged,
    merged_at: pr.merged_at,
    title: pr.title,
    html_url: pr.html_url,
    branch: pr.head.ref,
    unresolved_count: unresolved,
  };
}

let gitContextService: GitContextService | null = null;
let prStatusService: PrStatusService | null = null;

/** main 启动期注册(bootstrap-electron 调一次)。 */
export function registerGitContextIpc(): void {
  gitContextService = new GitContextService({
    onChanged: (snapshot) => broadcastToAllWindows(GIT_CONTEXT_PUSH.CHANGED, snapshot),
  });
  prStatusService = new PrStatusService({
    readToken: readGithubToken,
    fetchPr: fetchPrRemote,
  });
  setPrRefsChangedListener((sessionId) =>
    broadcastToAllWindows(GIT_CONTEXT_PUSH.PR_REFS_CHANGED, { sessionId }),
  );

  ipcMain.handle(GIT_CONTEXT_INVOKE.GET, async (_e, workdir: unknown) => {
    const dir = requireString(workdir, 'workdir');
    return gitContextService!.get(dir);
  });

  // 按 session 解析「对话真实工作目录」+ 其 HEAD + 来源:从 agent tool-call 遥测
  // 推断(Codex cwd / cc 编辑路径),拿不到才回退 worktree / working_dir。
  // renderer 用返回的 workdir 去 watch,用 source 决定分支信任度。
  ipcMain.handle(GIT_CONTEXT_INVOKE.GET_FOR_SESSION, async (_e, payload: unknown) => {
    const obj = payload as {
      sessionId?: unknown;
      workingDir?: unknown;
      worktreePath?: unknown;
    };
    const sessionId = requireString(obj?.sessionId, 'sessionId');
    const fallbackWorkingDir =
      typeof obj?.workingDir === 'string' && obj.workingDir !== '' ? obj.workingDir : null;
    const fallbackWorktreePath =
      typeof obj?.worktreePath === 'string' && obj.worktreePath !== '' ? obj.worktreePath : null;
    return resolveSessionGitDirLive({ sessionId, fallbackWorktreePath, fallbackWorkingDir });
  });

  ipcMain.handle(GIT_CONTEXT_INVOKE.WATCH, async (_e, workdir: unknown) => {
    const dir = requireString(workdir, 'workdir');
    await gitContextService!.watch(dir);
  });

  ipcMain.handle(GIT_CONTEXT_INVOKE.UNWATCH, async (_e, workdir: unknown) => {
    const dir = requireString(workdir, 'workdir');
    await gitContextService!.unwatch(dir);
  });

  ipcMain.handle(GIT_CONTEXT_INVOKE.PR_REFS_LIST, async (_e, sessionId: unknown) => {
    const sid = requireString(sessionId, 'sessionId');
    // 一次性历史回填(fire-and-forget,幂等):功能上线前的老会话也能绑上 PR。
    // 此处触发是因为 db 此时必然 ready;完成后经 pr-refs-changed 推送刷新。
    void ensurePrRefsBackfill();
    return listPrRefs(sid);
  });

  ipcMain.handle(GIT_CONTEXT_INVOKE.PR_REFS_LIST_ALL, async () => {
    // PrRefsProvider 挂在 App 顶层,首次调用通常早于登录后的 db ensureReady。
    // 未就绪时返回 null 当"稍后再试"信号(renderer 定时重试),不抛错刷日志。
    if (getCurrentDbClientUserId() === null) return null;
    // sidebar 启动期就会调这条 → 回填触发点前移到 app 打开侧边栏时,
    // 不再依赖"先打开某个会话"。
    void ensurePrRefsBackfill();
    return listAllPrRefs();
  });

  ipcMain.handle(GIT_CONTEXT_INVOKE.PR_STATUS, async (_e, queries: unknown) => {
    if (!Array.isArray(queries)) {
      throwIpcError('INVALID_PARAMS', 'queries 必须是数组');
    }
    const parsed: PrStatusQuery[] = (queries as unknown[]).map((q) => {
      const obj = q as { owner?: unknown; repo?: unknown; prNumber?: unknown };
      const owner = requireString(obj?.owner, 'owner');
      const repo = requireString(obj?.repo, 'repo');
      const prNumber = Number(obj?.prNumber);
      if (!Number.isSafeInteger(prNumber) || prNumber <= 0) {
        throwIpcError('INVALID_PARAMS', 'prNumber 必须是正整数');
      }
      return { owner, repo, prNumber };
    });
    return prStatusService!.getStatuses(parsed);
  });
}

/** 应用退出时清理 watcher 订阅。 */
export async function disposeGitContext(): Promise<void> {
  await gitContextService?.dispose();
}
