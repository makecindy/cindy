/**
 * The working-directory move steps of `updateSessionInDb` (sessions.ts), shared with the Node Host.
 *
 * sessions.ts loads Electron, so the Host cannot load it; these steps are moved here as they were, one
 * function per contiguous span of `updateSessionInDb`, each called where the span was. The spans are not
 * contiguous in the original (other fields' handling sits between them) and they share its local state:
 * `p` is changed in place (the stored working directory, the resume id the transcript move persisted) and
 * the caller broadcasts that same object; the row snapshot before the move (`beforeMove`) is carried across
 * later awaits. That state goes in and out through the parameters and return values here; nothing below
 * starts a flow of its own. Nothing here loads Electron.
 */
import { eq } from 'drizzle-orm';

import type { DbClient } from '../client/DbClient';
import type { sessionPatchToRow } from '../mapper';
import { sessions } from '../schema';
import { withSessionRouteLock } from '../sessionRouteLock.js';
import { withWorktreeMutation } from './createUserSession.js';
import type { touchRecentWorkdir as touchRecentWorkdirInDb } from './recentWorkdirsCore.js';
import { throwIpcError } from '../../utils/ipcValidate';
import { managedWorktreeRoot } from '../../worktree/managedResourcePath.js';
import { isRetainableProjectSession } from '../../../shared/sessionSource.js';
import {
  normalizeWorkingDirForStorage,
  workingDirEquals,
} from '../../../shared/workingDir.js';
import {
  WORKTREE_MOVE_BLOCKED_CODE,
  WORKTREE_MOVE_BLOCKED_MESSAGE,
} from '../../../shared/worktreeMoveGuardError.js';

/** The members of updateSessionInDb's moveGuard (the MCP move tool's) these steps use. */
export interface SessionWorkingDirMoveGuard {
  assertCurrent: () => void;
  beforeWrite?: () => void | Promise<void>;
}

/** A task's live worktree binding (the desktop's worktree store); null when it holds none. */
export type SessionWorktreeBindingLookup = (sessionId: string) => string | null;

/** From updateSessionInDb: a workspaceKind in the patch is project or dialogue. */
export function assertSessionWorkspaceKindPatch(p: Record<string, unknown>): void {
  if (p.workspaceKind !== undefined) {
    const value = p.workspaceKind;
    if (value !== 'project' && value !== 'dialogue') {
      throwIpcError('INVALID_PARAMS', `invalid workspaceKind: ${String(value)}`);
    }
  }
}

/** From updateSessionInDb: the patch's working directory in its stored form, written into `p`. */
export function normalizeSessionWorkingDirPatch(p: Record<string, unknown>): void {
  if (typeof p.workingDir === 'string') {
    p.workingDir = normalizeWorkingDirForStorage(p.workingDir) ?? null;
  }
}

/** From updateSessionInDb: a Review task's settings follow its source task. */
export async function assertReviewSessionPatchAllowed({
  db,
  sid,
  p,
}: {
  db: DbClient['drizzle'];
  sid: string;
  p: Record<string, unknown>;
}): Promise<void> {
  const REVIEW_IMMUTABLE_FIELDS = new Set([
    'workingDir',
    'workspaceKind',
    'model',
    'providerId',
    'contextWindowBudget',
    'effort',
    'permissionMode',
    'fastMode',
    'planModeEnabled',
    'orcaRole',
    'extraDirs',
    'writableDirs',
  ]);
  if (Object.keys(p).some((key) => REVIEW_IMMUTABLE_FIELDS.has(key))) {
    const [target] = await db
      .select({ source: sessions.source })
      .from(sessions)
      .where(eq(sessions.id, sid))
      .limit(1);
    if (target?.source === 'review') {
      throwIpcError(
        'UNSUPPORTED_CAPABILITY',
        'Review task settings are fixed to the source task',
      );
    }
  }
}

/**
 * From updateSessionInDb: the row before the move, the worktree ownership guard, and closing an
 * idle local Pi/Codex runtime. Returns the row snapshot the Claude transcript move reads later.
 */
export async function prepareSessionWorkingDirMove({
  db,
  sid,
  p,
  moveGuard,
  opts,
  sessionWorktreeBindingLookup,
}: {
  db: DbClient['drizzle'];
  sid: string;
  p: Record<string, unknown>;
  moveGuard?: SessionWorkingDirMoveGuard;
  /** Close a local Pi/Codex runtime only if its current turn is idle (false: it is running). */
  opts: { closeIdleSessionForMove?: (sessionId: string) => Promise<boolean> };
  /** Installed: its answer is the only ownership source. Null: the old cwd is read instead. */
  sessionWorktreeBindingLookup: SessionWorktreeBindingLookup | null;
}) {
  // 会话移动转录迁移:patch 带 workingDir 时先留存旧值,提交前对比实际变化。
  // CLI 转录按 cwd 转码目录存放,workingDir 变了必须跟着搬,否则 resume 报
  // "No conversation found with session ID"(见 claude-transcript-relocation.ts)。
  const beforeMove =
    p.workingDir !== undefined
      ? (
          await db
            .select({
              workingDir: sessions.workingDir,
              agentKind: sessions.agentKind,
              remoteHostId: sessions.remoteHostId,
            })
            .from(sessions)
            .where(eq(sessions.id, sid))
        )[0]
      : undefined;
  // worktree-handoff:worktree 会话的工作区边界就是它绑定的 worktree。只改 workingDir
  // 会留下「半移动」—— 侧栏按新项目归组,而聊天框底部路径、Git 上下文、worktree
  // store 归属与回收义务仍留在旧 worktree。完整的 worktree → Local Handoff 是独立
  // 特性(#2190/#2585,需显式处置未提交改动与 worktree 归属),落地前这里拒绝把会话
  // 移出 worktree;worktree 创建流程(基线目录 → 自己的 worktree)与同 worktree 内的
  // no-op 不受影响。拦截发生在关 runtime / 写库 / 转录迁移之前,拒绝不留部分写入。
  //
  // 归属以 worktreeStore(组合层注入)为真源:旧版允许过的「半移动」会给会话留下
  // working_dir 在普通项目、绑定仍在旧 worktree 的状态,只看 cwd 会漏掉这类存量行;
  // 反过来,DB 的 worktree_path 快照在回收后仍保留历史值,也不能当活绑定用。
  const requestedWorkingDir = typeof p.workingDir === 'string' ? p.workingDir : null;
  // 显式清空(`workingDir: null`,或空串/空白串经上面的归一化变成 null)也是改归属:
  // 字符串判据放它过去的话,worktree 会话会被摘掉工作目录,留下同一类归属分裂。
  // 只当键真的出现且归一化后为 null 时才算清空(未传该键的 update 不落库,不能算)。
  const clearsWorkingDir = Object.prototype.hasOwnProperty.call(p, 'workingDir') && p.workingDir === null;
  if (
    beforeMove &&
    !beforeMove.remoteHostId &&
    (requestedWorkingDir !== null || clearsWorkingDir) &&
    (clearsWorkingDir || !workingDirEquals(requestedWorkingDir, beforeMove.workingDir))
  ) {
    // 归属真源:装了绑定查询(生产路径)就以 store 的答案为唯一依据 —— 返回 null 就是
    // **没有活绑定**(worktree 已被回收的会话仍会留着历史 worktree 路径),此时不能再
    // 从 cwd 反推,否则这些会话会被永久拦死;未装查询的场景(单测/裁剪引导)才退回 cwd。
    let ownedWorktreeRoot: string | null = null;
    if (sessionWorktreeBindingLookup) {
      const liveWorktreePath = sessionWorktreeBindingLookup(sid);
      ownedWorktreeRoot = liveWorktreePath ? managedWorktreeRoot(liveWorktreePath) : null;
    } else if (beforeMove.workingDir) {
      ownedWorktreeRoot = managedWorktreeRoot(beforeMove.workingDir);
    }
    const targetWorktreeRoot = requestedWorkingDir
      ? managedWorktreeRoot(requestedWorkingDir)
      : null;
    if (ownedWorktreeRoot && !workingDirEquals(ownedWorktreeRoot, targetWorktreeRoot)) {
      // 错误码与文案是跨进程契约:renderer 按它把这次拒绝映射成同一条 toast
      // (shared/worktreeMoveGuardError.ts),两侧共用常量避免文案漂移。
      throwIpcError(WORKTREE_MOVE_BLOCKED_CODE, WORKTREE_MOVE_BLOCKED_MESSAGE);
    }
  }
  const movingLocalNonClaudeSession =
    beforeMove &&
    beforeMove.agentKind !== 'cc' &&
    !beforeMove.remoteHostId &&
    beforeMove.workingDir &&
    typeof p.workingDir === 'string' &&
    p.workingDir &&
    normalizeWorkingDirForStorage(beforeMove.workingDir) !== p.workingDir;
  // Pi/Codex keep a live Maker handle whose cwd is fixed at bootstrap. Close it
  // before persisting the new directory so the next send lazily recreates the
  // runtime with the moved session's cwd instead of continuing in the old one.
  if (movingLocalNonClaudeSession) {
    await moveGuard?.beforeWrite?.();
    moveGuard?.assertCurrent();
    if (!opts.closeIdleSessionForMove) {
      throwIpcError('INTERNAL', '会话移动 runtime 操作未配置');
    }
    const idle = await opts.closeIdleSessionForMove(sid);
    if (idle === false) {
      throwIpcError('PRECONDITION_FAILED', '运行中的任务不能移动');
    }
  }
  return beforeMove;
}

/**
 * From updateSessionInDb: an existing local Claude task's transcripts follow it before the new cwd
 * is committed. A resume id the move persisted is written into `p` and `setObj`.
 */
export async function relocateClaudeTranscriptsForMove({
  sid,
  p,
  beforeMove,
  moveGuard,
  dbClient,
  setObj,
}: {
  sid: string;
  p: Record<string, unknown>;
  beforeMove: Awaited<ReturnType<typeof prepareSessionWorkingDirMove>>;
  moveGuard?: SessionWorkingDirMoveGuard;
  dbClient: DbClient;
  setObj: ReturnType<typeof sessionPatchToRow>;
}): Promise<void> {
  // 在提交新 cwd 前完成现有 CC 迁移,与 Pi/Codex 的 runtime 关闭同处提交前。
  // 迁移只复制、不删除旧转录:切账号或写库失败时旧 cwd 仍可恢复；提交后
  // 围栏即使拒绝返回,也不会留下新 cwd 配旧转录。复用原锁与 best-effort 策略。
  // 动态 import 避免 localDb → maker-host 静态模块环。
  if (
    beforeMove &&
    beforeMove.agentKind === 'cc' &&
    !beforeMove.remoteHostId &&
    beforeMove.workingDir &&
    typeof p.workingDir === 'string' &&
    p.workingDir &&
    normalizeWorkingDirForStorage(beforeMove.workingDir) !== p.workingDir
  ) {
    const m = await import('../../maker-host/claude-transcript-relocation.js');
    moveGuard?.assertCurrent();
    await moveGuard?.beforeWrite?.();
    moveGuard?.assertCurrent();
    const reloc = await m.relocateClaudeTranscriptsForSessionMove(
      sid,
      beforeMove.workingDir,
      p.workingDir,
      ...(moveGuard ? [{ client: dbClient, assertCurrent: moveGuard.assertCurrent }] : []),
    );
    if (reloc.persistedSdkSessionId) {
      p.sdkSessionId = reloc.persistedSdkSessionId;
      setObj.sdkSessionId = reloc.persistedSdkSessionId;
    }
  }
}

/** From updateSessionInDb: a task moved to a retainable project records that project as recent. */
export async function recordRecentWorkdirForMove<OwnerScope>({
  projectTargetChanged,
  row,
  dbClient,
  ownerScope,
  touchRecentWorkdir,
  broadcastRecentWorkdirsChanged,
}: {
  projectTargetChanged: boolean;
  row: {
    workspaceKind: string | null;
    workingDir: string | null;
    projectDir: string | null;
    remoteHostId: string | null;
    source?: unknown;
    orcaRole?: unknown;
  };
  dbClient: DbClient;
  ownerScope: OwnerScope;
  touchRecentWorkdir: typeof touchRecentWorkdirInDb;
  broadcastRecentWorkdirsChanged: (path: string, ownerScope: OwnerScope) => void;
}): Promise<void> {
  if (
    projectTargetChanged &&
    row.workspaceKind === 'project' &&
    row.workingDir &&
    !row.remoteHostId &&
    isRetainableProjectSession(row)
  ) {
    const touched = await touchRecentWorkdir(
      row.projectDir ?? row.workingDir,
      Date.now(),
      process.platform,
      dbClient,
    );
    if (touched) broadcastRecentWorkdirsChanged(row.projectDir ?? row.workingDir, ownerScope);
  }
}

/**
 * From updateSessionInDb: a working-directory change (or a guarded MCP move) runs `update` under the
 * task's route lock and the worktree mutation locks of its current and target worktrees.
 */
export async function withSessionWorkingDirMoveLocks<T>({
  sid,
  p,
  moveGuard,
  db,
  update,
}: {
  sid: string;
  p: Record<string, unknown>;
  moveGuard?: SessionWorkingDirMoveGuard;
  db: DbClient['drizzle'];
  update: () => Promise<T>;
}): Promise<T> {
  if (p.workingDir === undefined && !moveGuard) return update();
  return withSessionRouteLock(sid, async () => {
    const [binding] = await db
      .select({ remoteHostId: sessions.remoteHostId })
      .from(sessions)
      .where(eq(sessions.id, sid))
      .limit(1);
    const resource =
      !binding?.remoteHostId && typeof p.workingDir === 'string'
        ? managedWorktreeRoot(p.workingDir)
        : null;
    const resources = await readSessionWorktreeResources(db, sid);
    if (resource) resources.push(resource);
    return withWorktreeMutation(resources, update);
  });
}

/** Read from the same captured database that will receive the status/path update. */
export async function readSessionWorktreeResources(
  db: DbClient['drizzle'],
  sessionId: string,
): Promise<string[]> {
  try {
    const [row] = await db
      .select({
        workingDir: sessions.workingDir,
        worktreePath: sessions.worktreePath,
        remoteHostId: sessions.remoteHostId,
      })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);
    if (!row || row.remoteHostId) return [];
    return [row.workingDir, row.worktreePath].flatMap((value) => {
      const root = value ? managedWorktreeRoot(value) : null;
      return root ? [root] : [];
    });
  } catch {
    throwIpcError('PRECONDITION_FAILED', 'Worktree references are temporarily unavailable');
  }
}
