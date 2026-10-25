import { createArchivedSessionRestore } from './sessionRestore.js';
import { createSessionTitlePersistence } from './sessionTitlePersistence.js';
import { createSessionClearPersistence } from './sessionClearPersistence.js';
import {createSessionAgentSwitchPersistence} from './sessionAgentSwitchPersistence.js';
export type { SessionRowSnapshot } from "@cindy/runtime-db/sessionSnapshot";
import { queueSessionWorktreeRecycle } from "@cindy/worktree-core/recycleQueue";
import fs from "node:fs/promises";
import path from "node:path";
import {
  eq,
  ne,
  and,
  desc,
  inArray,
  isNotNull,
  isNull,
  sql,
  type SQL,
} from "drizzle-orm";

import {
  clearPiSubagentDeletedTombstone,
  piSubagentRunRoot,
  stopAndRemovePiSubagentRuns,
  writePiSubagentDeletedTombstone,
} from "@cindy/maker-core/pi-subagent-runs";
import {
  DEFAULT_DRAFT_SESSION_TITLE,
  normalizeAutoTitle,
} from "@cindy/maker-shared/session-title";
import type { DbClient } from "@cindy/runtime-db/client/DbClient";
import type { SessionsSetTerminalStatusResult } from "@cindy/runtime-db/client/tx/types";
import { sessions, messages } from "@cindy/runtime-db/schema";
import { createSessionListSingleFlight } from "./sessionListSingleFlight.js";
import {
  throwIpcError,
  requireString,
  requireObject,
} from "@cindy/remote-agent/ipcValidate";
import { resolveBusinessSessionId } from "./sessionIds.js";
import { normalizeDbAgentKind } from "@cindy/maker-shared/agent-kind-conversion";
import {
  projectSessionContextWindow,
  type ContextWindowSession,
} from "./sessionContextWindow.js";
import {
  DESKTOP_TASK_LIST_SESSION_SOURCES,
  DESKTOP_VISIBLE_SESSION_SOURCES,
  isRetainableProjectSession,
} from "@cindy/maker-shared/session-source";
import {
  normalizeWorkingDirForProjectSettings,
  normalizeWorkingDirForStorage,
  workingDirEquals,
} from "@cindy/maker-shared/working-dir";
import {
  WORKTREE_MOVE_BLOCKED_CODE,
  WORKTREE_MOVE_BLOCKED_MESSAGE,
} from "./worktreeMoveGuardError.js";
import type { SessionReference } from "./sessionReference.js";
import { SESSION_READ_BATCH_LIMIT } from "./sessionRead.js";
import { quiesceSessionBeforeWorktreeRecycle } from "./sessionRemovalOperations.js";
import type { SessionServiceHost } from "./sessionServiceHost.js";
import type { SessionRowSnapshot } from "@cindy/runtime-db/sessionSnapshot";
import type { SessionListRow } from "./sessionQueries.js";
import type { SessionListProjectionBackfillItem } from "@cindy/runtime-db/sessionListProjection";
import type { DataOwnerBroadcastScope } from "./ownerBroadcast.js";

type OwnerScope = DataOwnerBroadcastScope | null;
type SessionWorktreeRecycle = (
  sessionId: string,
  resources?: readonly string[],
) => Promise<void>;
export interface SessionRecycleScope {
  ownerScope: OwnerScope;
  mediaDb: DbClient["drizzle"];
}

export interface RegisterSessionIpcOpts {
  /** Use the same live catalog as runtime usage, without writing during reads. */
  resolveContextWindow?: (session: ContextWindowSession) => number | null;
  /** Close a local Pi/Codex runtime only if its current turn is idle. */
  closeIdleSessionForMove?: (sessionId: string) => Promise<boolean>;
}

/**
 * 会话当前 worktree 绑定的查询口。source of truth 是 worktreeStore（electron-store）：
 * `sessions.worktree_path` 只是反范式快照，且回收后刻意保留历史值（徽标看 store
 * 是否存在），所以不能用它当「是否仍持有 worktree」的判据。
 */
type SessionWorktreeBindingLookup = (sessionId: string) => string | null;

type SharedTaskClosurePreparation = {
  sessionId: string;
  marker: number;
  rowIds: number[];
};

/**
 * 自动标题的资格检查:title 仍是系统占位。系统占位有三种 ——
 *
 *   1. `DEFAULT_DRAFT_SESSION_TITLE`:建会话时的默认标题;
 *   2. fork 占位("[Fork…" 前缀 **且** 有 parentSessionId):fork 会话天然带历史
 *      消息,要在用户发出第一句话时才被替换。额外要求 parentSessionId,避免用户
 *      手动改名成 "[Fork] ..." 的普通会话被误判成占位;
 *   3. `synthesizedPlaceholder`:调用方上次为纯附件消息写入的合成占位(文件名 /
 *      「图片」等),让「先只贴图、后打字」的会话在用户打字时把标题换成他写的内容。
 *
 * 只看标题、不要求「零消息且无 userSendAt」:首条输入是纯附件(无文本)时会话已经
 * 有消息和 userSendAt,旧口径会让它永久停在 "New Maker"。标题仍是系统占位本身就
 * 等价于「既没被自动起名、也没被用户改名」,足以作为门槛。
 */
export interface OverwritableAutoTitleTarget {
  /** 当前可覆写的标题 —— 直接用作条件写的期望值。 */
  title: string;
  /**
   * DB 里的权威 agentKind。**不要信调用方快照**:另一个窗口或设备切过 agent 时,
   * 入队时构建的 createOpts 可能已经过期(lazy-create 的
   * `reconcileCreateOptsAgainstDb` 处理的正是同一类漂移),用错 agent 会让标题
   * 走错供应商 —— 纯 Codex / 纯 Claude 用户会因此只拿到 fallback 标题。
   */
  agentKind: "claude-code" | "codex" | "pi";
  /**
   * 是否仍停在建会话时的裸默认标题。合成占位(纯附件消息)只允许覆写这一种 ——
   * fork 占位与上一条附件写下的合成占位都要保留到用户真正打字为止。
   */
  isDefaultDraftTitle: boolean;
}

export interface RenameSessionMetaChange {
  sessionId: string;
  title: string;
  expectedCurrentTitle?: string;
  expectedUpdatedAt?: string;
}

export interface RenameSessionMetaItem {
  sessionId: string;
  currentTitle: string | null;
  newTitle: string;
  workingDir: string | null;
  updatedAt: string;
}

export interface SessionStatusChangeRow {
  sessionId: string;
  title: string | null;
  workingDir: string | null;
  status: "active" | "archived";
}
export function createSessionService<InvokeEvent>(
  host: SessionServiceHost<InvokeEvent>,
) {
  const {
    ensureOpenedProjectGit,
    openSession,
    claimOwnedProvisionalSession,
    configureProvisionalSessions,
    deleteUnsentSessionRow,
    forgetProvisionalSession,
    isProvisionalSession,
    markProvisionalSession,
    provisionalManagedDir,
    removeEmptyDialogueDir,
    sweepLeftoverProvisionalSessions,
    emitSessionCreated,
    emitSessionListChangedLocally,
    physicalWorktreeKey,
    withWorktreeResourceLocks,
    managedWorktreeRoot,
    notifyWorktreeRecycleOpportunity,
    getDbClient,
    clearSessionAttention,
    selectSessionListRows,
    selectSessionWithCount,
    selectSessionsByIds,
    flattenSessionReadRow,
    projectSessionReadResult,
    commitBotProfileDeletion,
    persistSessionListProjectionBatch,
    bindDeletedPiSubagentCleanupCancel,
    sessionToCamel,
    sessionUsageToCamel,
    sessionCreateToRow,
    sessionPatchToRow,
    persistableSessionEffort,
    projectSessionRuntimeFields,
    normalizeRemoteHostId,
    finalizePlainPreview,
    ensureDialogueWorkspaceDir,
    recomputePrRefsForSession,
    removeDeletedSessionMediaRefs,
    imAttachmentsRoot,
    removeImSessionAttachmentDirs,
    upsertRecentWorkdir,
    assertRendererSessionSourceAllowed,
    notifyAgentIslandSessionPatch,
    ensureHiddenSessionRegistryLoaded,
    recoverGeneratedImagesForHistory,
    noteSessionClearBoundary,
    ackSessionTurnEndedDurable,
    ackSessionTurnEndedIfUnchanged,
    listErrorTailPendingRows,
    listErrorTailPendingSessionIds,
    listInterruptedPendingRows,
    listInterruptedPendingSessionIds,
    setOnSessionTurnEndedPersisted,
    listInterruptedResumeCandidateRows,
    dismissErrorMessage,
    rebroadcastAgentSwitchBoundary,
    isDeviceLinkInvoke,
    assertTrustedAppRendererEvent,
    removeTurnChangeSetsForSession,
    withSessionRouteLock,
    withSessionRouteLocks,
    cleanupSessionRuntimeForTerminalStatus,
    requestSessionArchiveSync,
    recycleCindyMakeTask,
    broadcastSubagentRunsInvalidated,
    compactSessionToolResultsBestEffort,
    consumeWritableDirectoryPickerGrants,
    createSessionRemoteHostIdReader,
    getSessionRowSnapshotStrict,
    getSessionRowSnapshot,
    getSessionFsSnapshot,
    captureOwnerScope,
    isOwnerScopeCurrent,
    getSafeOwnerPushStamp,
    broadcastRecentWorkdirsChanged,
    broadcastWorktreeChanged,
    broadcastSessionPatched,
    touchUserSendInDb,
    setSessionRuntimeCleanup,
    currentDb,
    imageCacheStore,
    logger: log,
    ipc: ipcMain,
  } = host;
  const { buildSessionListFlightKey, runSessionListSingleFlight } =
    createSessionListSingleFlight();

  const REMOTE_EDITABLE_META = new Set(["status", "title", "pinnedAt"]);
  const initialSessionListLogged = new Set<string>();
  const SLOW_SESSION_LIST_MS = 250;

  function readCurrentDbClientSnapshot(): {
    client: DbClient;
    userId: string;
    clientEpoch: number;
  } | null {
    try {
      return currentDb.getCurrentDbClientSnapshot?.() ?? null;
    } catch {
      return null;
    }
  }

  function readCurrentDbClientUserId(): string | null {
    try {
      return currentDb.getCurrentDbClientUserId?.() ?? null;
    } catch {
      return null;
    }
  }

  function compactTerminalSessionToolResults(
    client: DbClient,
    sessionId: string,
    status: unknown,
  ): void {
    if (status !== "archived" && status !== "deleted") return;
    void compactSessionToolResultsBestEffort({
      client,
      sessionId,
    });
  }
  let sessionWorktreeRecycle: SessionWorktreeRecycle | null = null;
  let sessionWorktreeBindingLookup: SessionWorktreeBindingLookup | null = null;

  /** Composition-root injection keeps the localDb IPC layer independent of worktree implementation modules. */
  function setSessionWorktreeBindingLookup(
    lookup: SessionWorktreeBindingLookup | null,
  ): void {
    sessionWorktreeBindingLookup = lookup;
  }
  /** Composition-root injection keeps the localDb IPC layer independent of worktree implementation modules. */
  function setSessionWorktreeRecycle(
    recycle: SessionWorktreeRecycle | null,
  ): void {
    sessionWorktreeRecycle = recycle;
  }

  async function withStatusWriteLock<T>(
    db: DbClient["drizzle"],
    sessionId: string,
    status: unknown,
    task: () => Promise<T>,
    alreadyLocked = false,
    beforeWrite?: () => void,
  ): Promise<T> {
    const write = async () => {
      const resources =
        status === undefined
          ? []
          : await readSessionWorktreeResources(db, sessionId);
      const physicalResources = await Promise.all(
        resources.map(physicalWorktreeKey),
      );
      const mutate = async () => {
        beforeWrite?.();
        if (status === "archived" || status === "deleted")
          await requestWorktreeRecycle(sessionId, resources);
        beforeWrite?.();
        const result = await task();
        for (const resource of physicalResources)
          notifyWorktreeRecycleOpportunity(resource);
        return result;
      };
      return withWorktreeMutation(resources, mutate);
    };
    if (status === undefined || alreadyLocked) return write();
    return withSessionRouteLock(sessionId, write);
  }

  async function prepareSharedTaskClosure(
    sessionId: string,
    dbClient: DbClient,
  ): Promise<SharedTaskClosurePreparation | null> {
    const { prepareSharedTaskClosureForTask } = await host.loadSharedTasks();
    return prepareSharedTaskClosureForTask(sessionId, dbClient);
  }

  async function rollbackSharedTaskClosure(
    dbClient: DbClient,
    prepared: SharedTaskClosurePreparation | null,
  ): Promise<void> {
    if (!prepared) return;
    const { rollbackPreparedSharedTaskClosure } = await host.loadSharedTasks();
    await rollbackPreparedSharedTaskClosure(dbClient, prepared);
  }

  async function finalizeSharedTaskClosure(
    dbClient: DbClient,
    prepared: SharedTaskClosurePreparation | null,
  ): Promise<void> {
    if (!prepared) return;
    const { finalizePreparedSharedTaskClosure } = await host.loadSharedTasks();
    await finalizePreparedSharedTaskClosure(dbClient, prepared);
  }

  async function requestWorktreeRecycle(
    sessionId: string,
    resources: readonly string[] = [],
  ): Promise<void> {
    const recycle = sessionWorktreeRecycle;
    if (!recycle)
      throw new Error("worktree recycle implementation is not wired");
    await recycle(sessionId, resources);
  }

  /** Persist a terminal cleanup intent using references from the same DB snapshot. */
  async function requestSessionWorktreeRecycle(
    db: DbClient["drizzle"],
    sessionId: string,
  ): Promise<void> {
    await requestWorktreeRecycle(
      sessionId,
      await readSessionWorktreeResources(db, sessionId),
    );
  }

  /** Read from the same captured database that will receive the status/path update. */
  async function readSessionWorktreeResources(
    db: DbClient["drizzle"],
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
      throwIpcError(
        "PRECONDITION_FAILED",
        "Worktree references are temporarily unavailable",
      );
    }
  }

  async function withWorktreeMutation<T>(
    resources: string[],
    task: () => Promise<T>,
  ): Promise<T> {
    try {
      return await withWorktreeResourceLocks(resources, task);
    } catch (error) {
      const code = (error as { code?: string })?.code;
      if (
        code &&
        error instanceof Error &&
        error.message.startsWith(`[${code}]`)
      )
        throw error;
      log.warn("worktree mutation postponed", { code: code ?? "unavailable" });
      throwIpcError(
        "PRECONDITION_FAILED",
        "Worktree is busy or its recovery record could not be saved",
      );
    }
  }

  async function writeSessionPatch(
    db: DbClient["drizzle"],
    sessionId: string,
    setObj: ReturnType<typeof sessionPatchToRow>,
    status: unknown,
  ): Promise<void> {
    if (Object.keys(setObj).length === 0) return;
    const deletedIsTerminal = status === "active" || status === "archived";
    const result = await db
      .update(sessions)
      .set(setObj)
      .where(
        deletedIsTerminal
          ? and(eq(sessions.id, sessionId), ne(sessions.status, "deleted"))
          : eq(sessions.id, sessionId),
      )
      .run();
    if (!deletedIsTerminal || result.changes > 0) return;

    const [existing] = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    if (!existing) throwIpcError("NOT_FOUND", "Session 不存在");
    throwIpcError("PRECONDITION_FAILED", "已删除的任务不能恢复或归档");
  }

  async function setTerminalSessionStatus(
    dbClient: DbClient,
    sessionId: string,
    status: "archived" | "deleted",
  ): Promise<SessionsSetTerminalStatusResult["deletedSideChats"]> {
    try {
      const result = await dbClient.tx("sessions.setTerminalStatus", {
        sessionId,
        status,
      });
      return result.deletedSideChats;
    } catch (error) {
      const code = (error as { code?: string }).code;
      const message = error instanceof Error ? error.message : String(error);
      if (
        code === "NOT_FOUND" ||
        code === "INVALID_PARAMS" ||
        code === "PRECONDITION_FAILED"
      ) {
        throwIpcError(code, message);
      }
      throw error;
    }
  }

  /** Side chats belong to the parent view; deleting it must not strand invisible running tasks. */
  async function deleteDependentSideChats(
    parentId: string,
    dbClient: DbClient,
    ownerScope: OwnerScope,
    committed?: SessionsSetTerminalStatusResult["deletedSideChats"],
  ): Promise<void> {
    if (committed) {
      for (const child of committed) {
        if (!isOwnerScopeCurrent(ownerScope) || getDbClient() !== dbClient)
          return;
        // The transaction already committed every status. Cleanup can be fenced
        // by owner/route without stranding active children when it is interrupted.
        await withStatusWriteLock(
          dbClient.drizzle,
          child.sessionId,
          "deleted",
          async () => {
            if (!isOwnerScopeCurrent(ownerScope) || getDbClient() !== dbClient)
              return;
            cleanupSessionRuntimeForTerminalStatus(child.sessionId, "deleted");
            const { closeSharedTaskForTask } = await host.loadSharedTasks();
            await closeSharedTaskForTask(child.sessionId, dbClient);
          },
        );
        if (!isOwnerScopeCurrent(ownerScope) || getDbClient() !== dbClient)
          return;
        clearSessionAttention(child.sessionId, "explicit");
        broadcastSessionPatched(
          child.sessionId,
          { status: "deleted" },
          ownerScope,
        );
        notifyAgentIslandSessionPatch(child.sessionId, {
          ...child,
          status: "deleted",
        });
        void imageCacheStore.removeSession(child.sessionId).catch((err) => {
          log.warn("side chat image cleanup failed", {
            sessionId: child.sessionId,
            err: String(err),
          });
        });
        scheduleWorktreeRecycleForStatusChange(child.sessionId, "deleted", {
          ownerScope,
          mediaDb: dbClient.drizzle,
        });
        notifyGhostSessionStatusChange(
          child.sessionId,
          "deleted",
          child.workingDir,
        );
        cleanupSessionTerminalArtifacts(child.sessionId, "deleted");
        compactTerminalSessionToolResults(dbClient, child.sessionId, "deleted");
      }
      return;
    }
    // Compatibility for callers without the transaction API (legacy adapters).
    const children = await dbClient.drizzle
      .select({ id: sessions.id })
      .from(sessions)
      .where(
        and(
          eq(sessions.parentSessionId, parentId),
          eq(sessions.source, "side-chat"),
          ne(sessions.status, "deleted"),
        ),
      );
    for (const child of children) {
      if (!isOwnerScopeCurrent(ownerScope) || getDbClient() !== dbClient)
        return;
      await patchSessionMetaInDb(child.id, { status: "deleted" });
    }
  }

  function captureSessionRecycleScope(
    dbClient: DbClient = getDbClient(),
  ): SessionRecycleScope {
    return {
      ownerScope: captureOwnerScope(),
      mediaDb: dbClient.drizzle,
    };
  }

  /**
   * 会话 status 显式变为 deleted / archived 后的 worktree 回收调度(P0 重构:回收
   * 唯一驱动点,从 Maker onClose 迁到这里——close 是进程生命周期事件,/clear、鉴权
   * 重连、CLI 崩溃都会触发,不能当"用户不要工作区了"的信号)。
   *
   * fire-and-forget:回收失败不影响状态写库(启动期 reconcile 兜底 deleted 场景)。
   * 先关子进程再回收——Windows 下 CLI 子进程 cwd 在 worktree 内会锁目录。
   * 既有动态 import 避免 localDb → maker-host / worktree 的静态模块环(worktreeStore
   * 反向 import 本文件的 setWorktreePathInDb)。
   *
   * 只为真正进入低层 worktree 回收的 session 广播。普通通知任务没有 worktree，仍会
   * 完成 runtime / media / owner 扫描，但不会让 renderer 扫描全部 worktree。共享路径
   * 扫描若找到另一个终态 owner，则通知 owner 的 sessionId，而不是原任务的 sessionId。
   * 回收失败时仍广播：renderer 单条查询后会保留仍在 store 中的真实状态。
   */
  async function recycleSessionWorktreeForStatusChange(
    sessionId: string,
    status: unknown,
    capturedScope?: SessionRecycleScope,
  ): Promise<void> {
    if (status !== "deleted" && status !== "archived") return;
    // Capture before queueing: an account switch while waiting cannot redirect cleanup.
    try {
      const scope = capturedScope ?? captureSessionRecycleScope();
      await queueSessionWorktreeRecycle(() =>
        recycleSessionWorktreeInQueue(sessionId, scope),
      );
    } catch (error) {
      log.warn("worktree recycle scheduling postponed", {
        sessionId,
        code: (error as NodeJS.ErrnoException).code ?? "unavailable",
      });
    }
  }

  async function recycleSessionWorktreeInQueue(
    sessionId: string,
    capturedScope: SessionRecycleScope,
  ): Promise<void> {
    const affectedWorktreeSessionIds = new Set<string>();
    try {
      const { ownerScope, mediaDb } = capturedScope;
      const ownerIsCurrent = (): boolean =>
        isOwnerScopeCurrent(ownerScope) && getDbClient().drizzle === mediaDb;
      if (!ownerIsCurrent()) return;
      const [mh, recycle] = await Promise.all([
        host.loadMaker(),
        host.loadWorktreeRecycle(),
      ]);
      const isStillRemovable = async (id: string): Promise<boolean> =>
        ownerIsCurrent() && recycle.isSessionStillRemovable(id, mediaDb);
      const closeAndRecycle = async (
        targetSessionId: string,
        scanOwners: boolean,
      ): Promise<void> => {
        if (!(await isStillRemovable(targetSessionId))) return;
        // Settle preparation before taking the send route lock it may be waiting for.
        await host.settleMakeTasksForSession(targetSessionId);
        await withSessionRouteLock(targetSessionId, async () => {
          const shouldRecycle = await quiesceSessionBeforeWorktreeRecycle(
            targetSessionId,
            {
              isOwnerCurrent: ownerIsCurrent,
              isSessionStillRemovable: isStillRemovable,
              closeSession: async (id) => {
                await mh
                  .getMakerIfReady()
                  ?.closeSession(id)
                  .catch(() => undefined);
              },
            },
          );
          if (!shouldRecycle || !ownerIsCurrent()) return;
          await recycleCindyMakeTask(targetSessionId, mediaDb, ownerIsCurrent);

          // Keep irreversible cleanup under the same task route lock as the final
          // status check. A concurrent restore/start/send must not slip between
          // quiescence and ref/worktree deletion.
          await removeDeletedSessionMediaRefs(targetSessionId, mediaDb)
            .then((count) => {
              if (count > 0)
                log.info("session media refs removed", {
                  sessionId: targetSessionId,
                  count,
                });
            })
            .catch((err) => {
              log.warn("session media ref cleanup failed", {
                sessionId: targetSessionId,
                err: err instanceof Error ? err.message : String(err),
              });
            });
          if (!ownerIsCurrent()) return;
          if (recycle.hasRegisteredWorktreeForSession(targetSessionId)) {
            affectedWorktreeSessionIds.add(targetSessionId);
          }
          await recycle.recycleWorktreeForRemovedSession(targetSessionId, {
            scanOwners,
            db: mediaDb,
            isOwnerCurrent: ownerIsCurrent,
            isSessionRuntimeAlive: (candidateSessionId) =>
              mh.getMakerIfReady()?.isSessionAlive(candidateSessionId),
            recycleOwner: (ownerSessionId) =>
              closeAndRecycle(ownerSessionId, false),
          });
        });
      };
      await closeAndRecycle(sessionId, true);
    } catch (err) {
      log.warn("worktree recycle after session status change failed", {
        sessionId,
        err: err instanceof Error ? err.message : String(err),
      });
    } finally {
      for (const affectedSessionId of affectedWorktreeSessionIds) {
        broadcastWorktreeChanged(affectedSessionId);
      }
    }
  }

  function scheduleWorktreeRecycleForStatusChange(
    sessionId: string,
    status: unknown,
    capturedScope?: SessionRecycleScope,
  ): void {
    void recycleSessionWorktreeForStatusChange(
      sessionId,
      status,
      capturedScope,
    );
  }

  // shadow savepoint 链(refs/cindy/savepoints/<sid>)刻意**不**挂 status 变化
  // 即时清理:覆盖导入等流程会把旧会话瞬态置为 deleted、失败后经 journal 恢复,
  // status 触发的 ref 删除与这类回滚天然竞态(删了就不可逆)。孤儿 ref 隐藏且
  // 极小,统一由启动期 reconcileSavepointRefsForDeletedSessions() 清理——启动期
  // 不存在进行中的瞬态软删流程。

  /**
   * 会话 status 变化的订阅槽①旁路通知(archived → did-session-archived)。
   * 与 worktree 回收共用同三个调用点(update / patch-meta / 批量 setStatus),
   * 保证主 UI 归档、device-link 远程归档、MCP 批量归档都发得出事件。
   * fire-and-forget + 动态 import 防环;资格过滤(用户主会话)与订阅者快路径
   * 都在 cindy-brain 内部,这里零判断。
   */
  function notifyGhostSessionStatusChange(
    sessionId: string,
    status: unknown,
    workingDir?: string | null,
  ): void {
    if (status === "active" || status === "archived")
      requestSessionArchiveSync();
    if (status !== "archived") return;
    void host
      .loadPluginNotifications()
      .then((m) =>
        m.notifyGhostSessionEvent("archived", {
          sessionId,
          ...(workingDir ? { workdir: workingDir } : {}),
        }),
      )
      .catch(() => {});
  }

  /** device-link 远程 set-* 回流可持久化的 session settings 字段(见 persistSessionFields)。 */
  const REMOTE_PERSIST_FIELDS = new Set([
    "model",
    // set-model 第 3 参 providerId(per-session 来源)与 model 同批回流:必须在白名单内,
    // 否则被控端 DB 不写 provider_id(跨重启/resume 丢来源)、且广播 patch 不带 providerId →
    // 控制端 mirror 的 session.providerId 永不收敛(模型选择器 settle 永远卡 5s)。
    "providerId",
    "effort",
    "permissionMode",
    "fastMode",
    "planModeEnabled",
    "extraDirs",
    "writableDirs",
  ]);

  /**
   * 远程 set-*(model/providerId/effort/permission/fastMode/extraDirs)持久化回流。
   * 仅由 device-link dispatch 在「远程控制端调用 set-* 成功后」注入调用:被控端的 set-* 是
   * runtime-only(只改 maker-core 运行时 Session,不落库),这里补一次 DB 写,使被控端 DB 成为
   * 真相,控制端重读/收 patched 即拿到真值(取代控制端 settingsOverrides 乐观覆盖)。
   *
   * 不双写:本机会话的 settings 由 renderer 另调 sessions:update 持久化;远程会话才走这条
   * (两路按「本机 vs 远程会话」互斥)。故意**不暴露 IPC handler** —— 这不是远程可调 channel,
   * 只是 dispatch 的内部回流,不开放新的远程裸写面。
   */
  const {applyAgentSwitchToSessionRow,applyAgentSwitchResumeFallbackAtomically} = createSessionAgentSwitchPersistence(host);

  /**
   * session-agent-switch:切换 agent 引擎的 DB 提交(单点,只被
   * sessionAgentSwitchHandler 调用,不暴露 IPC handler——agent_kind 不进任何
   * 通用 update 白名单,防裸写)。语义:
   *  - agent_kind / model 落新引擎值;providerId undefined = 不动,null = 显式清除;
   *  - sdk_session_id:缺省 / null = 清空,新引擎从全新原生会话开始(全量交接注入
   *    承接上下文);Phase 2 切回停泊引擎时传停泊的原生 session id,随后的
   *    bootstrap / lazy-create 走标准 resume 路径续接(增量交接补齐离开期间进展)。
   *    旧引擎的原生会话 id 绝不能原样残留——resume 会以错误引擎解释它(离场值
   *    快照存在边界行 fromSdkSessionId,即停泊绑定)。
   *  - 广播 sessions:patched:本机各窗口 sessionsStore/会话视图收敛 + device-link
   *    tap 让控制端镜像同步(agentKind 翻转驱动 capabilities 缓存按新 key 重取)。
   */
  

  /** resume 停泊失败的原子 DB 回落,提交成功后再把 session 与边界新状态广播。 */
  

  /**
   * Auto 权限分类器降级专用的条件持久化:仅当持久态仍为 'auto' 时把 permissionMode
   * 写成 'ask'(SQL 级 compare-and-swap)。用户在降级过程中并发手动切档时 UPDATE 不
   * 命中,回读到的用户选择原样保留,调用方据返回值决定是否广播降级/回滚 runtime。
   * 返回 true = 写库后(或并发用户恰好也切到 ask 时)持久态已是 'ask'。
   */
  async function persistSessionPermissionModeIfAuto(
    sessionId: string,
  ): Promise<boolean> {
    const ownerScope = captureOwnerScope();
    const db = getDbClient().drizzle;
    await db
      .update(sessions)
      .set({ permissionMode: "ask" })
      .where(
        and(eq(sessions.id, sessionId), eq(sessions.permissionMode, "auto")),
      );
    const row = await db
      .select({ permissionMode: sessions.permissionMode })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .get();
    const applied = row?.permissionMode === "ask";
    if (applied && isOwnerScopeCurrent(ownerScope)) {
      broadcastSessionPatched(sessionId, { permissionMode: "ask" }, ownerScope);
    }
    return applied;
  }

  async function persistSessionFields(
    sessionId: string,
    patch: Record<string, unknown>,
  ): Promise<void> {
    const ownerScope = captureOwnerScope();
    const clean: Record<string, unknown> = {};
    for (const k of Object.keys(patch)) {
      if (REMOTE_PERSIST_FIELDS.has(k)) clean[k] = patch[k];
    }
    if (Object.prototype.hasOwnProperty.call(clean, "effort")) {
      const persistableEffort = persistableSessionEffort(clean.effort);
      if (persistableEffort === undefined) delete clean.effort;
      else clean.effort = persistableEffort;
    }
    if (Object.keys(clean).length === 0) return;
    const db = getDbClient().drizzle;
    const setObj = sessionPatchToRow(
      clean as Parameters<typeof sessionPatchToRow>[0],
      {
        bumpUpdatedAt: false,
      },
    );
    if (Object.keys(setObj).length === 0) return;
    await db.update(sessions).set(setObj).where(eq(sessions.id, sessionId));
    let runtimeProjection = {};
    if (
      ["model", "providerId", "effort", "fastMode"].some((key) => key in clean)
    ) {
      const [row] = await db
        .select({
          id: sessions.id,
          agentKind: sessions.agentKind,
          model: sessions.model,
          providerId: sessions.providerId,
          effort: sessions.effort,
          fastMode: sessions.fastMode,
          scheduledModelBaseline: sessions.scheduledModelBaseline,
        })
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .limit(1);
      if (row?.scheduledModelBaseline) {
        runtimeProjection = projectSessionRuntimeFields({
          ...row,
          agentKind: normalizeDbAgentKind(row.agentKind),
        });
      }
    }
    if (isOwnerScopeCurrent(ownerScope))
      broadcastSessionPatched(
        sessionId,
        { ...clean, ...runtimeProjection },
        ownerScope,
      );
  }

  const MAX_LIMIT = 1000;

  /**
   * 未发送任务转为普通任务（第一次发送）：补做建任务时延后的副作用，并让控制端看到它。
   * 不是未发送任务时什么都不做。最近项目由随后的 touchUserSend 照常记录。
   */
  async function commitProvisionalSession(sessionId: string): Promise<boolean> {
    if (claimOwnedProvisionalSession(sessionId) !== "owned") return false;
    const db = getDbClient().drizzle;
    const [row] = await db
      .select({
        workingDir: sessions.workingDir,
        workspaceKind: sessions.workspaceKind,
        remoteHostId: sessions.remoteHostId,
      })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);
    if (!row) return false;
    await ensureOpenedProjectGit({ id: sessionId, ...row }).catch((error) => {
      log.warn("provisional session git bootstrap failed", {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    // The account may have changed during the awaits: then it stays an unsent leftover of the
    // old account (claim parks it) instead of becoming an ordinary task there.
    if (claimOwnedProvisionalSession(sessionId) !== "owned") return false;
    forgetProvisionalSession(sessionId);
    emitSessionCreated(sessionId);
    void host
      .loadPluginNotifications()
      .then((m) =>
        m.notifyGhostSessionEvent("created", {
          sessionId,
          ...(row.workingDir ? { workdir: row.workingDir } : {}),
        }),
      )
      .catch(() => {});
    log.info("provisional session committed", { sessionId });
    return true;
  }

  /**
   * 删掉一个未发送任务（用户清空了新建页的输入）：仍未发送、没有消息时才真正删除行，
   * 顺带删掉为它新建、仍为空的对话目录，并通知本机窗口移除。调用方负责先关掉它的 Agent。
   */
  async function discardProvisionalSessionRow(
    sessionId: string,
  ): Promise<boolean> {
    if (claimOwnedProvisionalSession(sessionId) !== "owned") return false;
    const managedDir = provisionalManagedDir(sessionId);
    const deleted = await deleteUnsentSessionRow(sessionId);
    if (!deleted) {
      // Already sent (or gone): it is an ordinary task now.
      forgetProvisionalSession(sessionId);
      return false;
    }
    removeEmptyDialogueDir(sessionId, managedDir);
    forgetProvisionalSession(sessionId);
    // Other local windows re-read their lists; the row is gone, so it drops out. No status
    // patch: the same id may be opened again when the user types again.
    emitSessionListChangedLocally(sessionId);
    log.info("provisional session discarded", { sessionId });
    return true;
  }

  const { setOnUserSessionTitleWritten, noteUserTitleWritten, getOverwritableAutoTitle, isUntitledSessionAwaitingAutoTitle, persistSessionTitleIfStillDraft } = createSessionTitlePersistence(host);

  /**
   * `/clear` 权威落库出口。
   *
   * 本机会话历史上由 renderer 在 clearSession 后调 sessions:update 写库；device-link
   * 远程会话的 renderer 在控制端，不能写被控端 DB，所以远程 invoke 必须在被控端 main
   * 补这一步。广播让被控端窗口和控制端镜像都收敛到同一个 clearedAt 边界。
   */
  const { clearSessionContextInDb } = createSessionClearPersistence(host);

  /**
   * registerSessionIpc 收到的运行时依赖(closeIdleSessionForMove 等)。MCP 会话操作工具
   * 不经 IPC 直接调 updateSessionInDb 时沿用同一份,保证与 renderer 路径行为一致。
   */
  let registeredSessionIpcOpts: RegisterSessionIpcOpts = {};

  function registerSessionIpc(
    readSessionListLogScope: () => string | null = () => null,
    opts: RegisterSessionIpcOpts = {},
  ): void {
    registeredSessionIpcOpts = opts;
    configureProvisionalSessions(() => host.userDataDirectory(), {
      // Windows that listed before the sweep finished drop the deleted leftover.
      onSwept: (sessionId) => emitSessionListChangedLocally(sessionId),
    });
    // interrupted-turn-resume 假阳性修复:每次 last_turn_ended_at 真正落库(正常收尾 /
    // barrier 版收尾 / ack)都广播 lastTurnEndedAt patch —— renderer 的 session 快照可能
    // 是在 turn 飞行中或「done → ended 落库」空窗里取的(startedAt > endedAt),此前
    // 只有「忽略」ack 会广播,正常收尾静默写导致快照永不纠正,任务正常结束后切回
    // 会话仍弹「应用退出中断」。注入而非让 sessionActiveTurn 直接 import,避免
    // 反向依赖成环(本文件已 import sessionActiveTurn)。
    setOnSessionTurnEndedPersisted(
      (sid, endedAt, capturedOwnerScope) =>
        broadcastSessionPatched(
          sid,
          { lastTurnEndedAt: endedAt },
          capturedOwnerScope as OwnerScope | undefined,
        ),
      captureOwnerScope,
    );
    ipcMain.handle(
      "local-db:sessions:list",
      async (event, limit: unknown, status: unknown, options: unknown) => {
        const startedAt = performance.now();
        const usageHistory = shouldUseUsageHistoryQuery(options);
        // The usage-history branch is an unbounded privileged read. Keep the
        // legacy capped list available to device-link's synthetic event, but do
        // not let an untrusted renderer turn the new branch into a full-table
        // session disclosure.
        if (usageHistory) assertTrustedAppRendererEvent(event);
        const snapshot = readCurrentDbClientSnapshot();
        const db = snapshot?.client.drizzle ?? getDbClient().drizzle;
        const userId = snapshot?.userId ?? readCurrentDbClientUserId();
        const clientEpoch = snapshot?.clientEpoch ?? 0;
        // sidebar-card-mode: 首次 list(db 必然 ready)触发一次置顶摘要回填——
        // 老置顶会话没有 turn-done 触发点。模块内部 once 守卫 + 串行 + swallow。
        void host
          .loadSummaries()
          .then((m) => m.backfillPinnedSessionSummaries());
        // 首次 list 即账号库就绪:预热插件后台任务索引,灵动岛/通知的同步判定从此可用。
        void ensureHiddenSessionRegistryLoaded();
        // 同一时机清掉上次运行没来得及删的未发送任务；先等它清完再读列表，残留不会被列出来。
        // 每个账号库只真正清理一次，之后直接返回同一个结果。
        await sweepLeftoverProvisionalSessions().catch(() => undefined);
        const cap = clampLimit(limit, 20);
        const includePinned = shouldIncludePinnedSessions(options);
        const fresh = shouldBypassSessionListSingleFlight(options);
        const rawBefore =
          options && typeof options === "object"
            ? (options as { before?: unknown }).before
            : undefined;
        let before: { updatedAt: number; id: string } | undefined;
        if (rawBefore !== undefined) {
          // Pagination is local renderer-only until remote capability negotiation exists.
          assertTrustedAppRendererEvent(event);
          const value = requireObject(rawBefore, "before");
          if (
            typeof value.updatedAt !== "number" ||
            !Number.isSafeInteger(value.updatedAt) ||
            value.updatedAt < 0 ||
            typeof value.id !== "string" ||
            !value.id ||
            value.id.length > 200 ||
            usageHistory ||
            includePinned
          ) {
            throwIpcError("INVALID_PARAMS", "Invalid session list cursor");
          }
          before = { updatedAt: value.updatedAt, id: value.id };
        }

        const rawIds =
          options && typeof options === "object"
            ? (options as { ids?: unknown }).ids
            : undefined;
        let ids: string[] | undefined;
        if (rawIds !== undefined) {
          // Exact-subset pagination remains local-only, like the continuation cursor.
          assertTrustedAppRendererEvent(event);
          if (
            !Array.isArray(rawIds) ||
            rawIds.length > 10_000 ||
            usageHistory ||
            includePinned
          ) {
            throwIpcError("INVALID_PARAMS", "Invalid session list IDs");
          }
          ids = [
            ...new Set(
              rawIds.map((id, index) => {
                const value = requireString(id, `ids[${index}]`);
                if (value.length > 256)
                  throwIpcError("INVALID_PARAMS", "Session list ID too long");
                return value;
              }),
            ),
          ];
        }

        // 支持 Sidebar Filter 的 Active/Archived/All status 过滤。
        //   - 'active' / 'archived' → WHERE status = ?
        //   - 'all' / undefined / 其它非法值 → WHERE status != 'deleted'
        //     （deleted 是软删除墓碑，对所有筛选都应不可见——与 server 端
        //      listSessions 行为一致：'all' 白名单 ['active','archived']）
        const statusFilter: "active" | "archived" | null =
          status === "active" || status === "archived" ? status : null;
        const loadRows = async () => {
          if (ids?.length === 0) return [];
          // 按 DESKTOP_VISIBLE_SESSION_SOURCES 白名单过滤 — 包含 IM 渠道
          // (feishu/slack/discord)与本机自动化(scheduler/learn/shared);
          // feishu 会话以「对话」分组展示(workspaceKind='dialogue')。/review 审查任务
          // 只从来源任务的审查卡片打开,不进普通任务列表(用量历史仍包含)。
          // 插件后台隐藏任务(hidden_at 非空)同样不进任务列表,只在插件详情页「后台任务」
          // 查看与接手;手机/远控经 device-link 调同一 handler,口径一致。
          const sourceFilter = and(
            inArray(sessions.source, DESKTOP_TASK_LIST_SESSION_SOURCES),
            isNull(sessions.hiddenAt),
          );
          const statusWhere = () =>
            statusFilter
              ? eq(sessions.status, statusFilter)
              : ne(sessions.status, "deleted");
          const rows = await selectSessionListRows(
            db,
            and(
              sourceFilter,
              statusWhere(),
              ids ? inArray(sessions.id, ids) : undefined,
            ),
            cap,
            before,
          );

          let mergedRows = rows;
          if (includePinned) {
            const pinnedRows = await selectSessionListRows(
              db,
              and(sourceFilter, statusWhere(), isNotNull(sessions.pinnedAt)),
              null,
            );
            mergedRows = mergeSessionListRows(rows, pinnedRows);
          }

          scheduleSessionListProjectionBackfill(mergedRows);
          return mergedRows.map((row) =>
            projectSessionReadResult(
              flattenSessionReadRow(row),
              opts.resolveContextWindow,
            ),
          );
        };
        const loadUsageHistoryRows = async () => {
          // 用量历史的“最耗任务”必须覆盖整个会话表，再由 renderer 按所选日历范围
          // 精确筛选；不能复用侧栏按 updatedAt 截断的 1000 行列表。这里刻意不算
          // messageCount / preview，避免为统计页引入整库 messages 扫描。
          const sourceFilter = inArray(
            sessions.source,
            DESKTOP_VISIBLE_SESSION_SOURCES,
          );
          const statusWhere = () =>
            statusFilter
              ? eq(sessions.status, statusFilter)
              : ne(sessions.status, "deleted");
          const rows = await selectSessionUsageRows(
            db,
            and(sourceFilter, statusWhere()),
          );
          return rows.map((row) =>
            sessionUsageToCamel(
              projectSessionContextWindow(row, opts.resolveContextWindow),
            ),
          );
        };
        // key 用同一快照上的 userId + clientEpoch + 归一化参数。
        // forceRefresh / status 重拉带 fresh，不并入写前那次查询。
        const loaded = usageHistory
          ? await loadUsageHistoryRows()
          : userId && !fresh && !before && !ids
            ? await runSessionListSingleFlight(
                buildSessionListFlightKey({
                  userId,
                  clientEpoch,
                  cap,
                  statusFilter,
                  includePinned,
                }),
                loadRows,
              )
            : await loadRows();
        // 未发送任务只出现在本机任务列表里，手机 / 其它电脑在它第一次发送后才看到。
        // 在 single-flight 之外过滤：同一次查询可能同时供本机与控制端使用。
        const result = isDeviceLinkInvoke()
          ? ((loaded as Array<{ id: string }>).filter(
              (row) => !isProvisionalSession(row.id),
            ) as typeof loaded)
          : loaded;
        const finishedAt = performance.now();
        const filter = statusFilter ?? "all";
        const elapsedMs = Math.round(finishedAt - startedAt);
        const fields = JSON.stringify({
          event: "localDb.sessions.list.done",
          filter,
          cap: usageHistory ? "all" : cap,
          usageHistory,
          includePinned,
          rows: result.length,
          queryElapsedMs: elapsedMs,
          mapElapsedMs: 0,
          elapsedMs,
        });
        const logScope = readSessionListLogScope() ?? "unscoped";
        const logKey = `${logScope}:${filter}:${includePinned ? "pinned" : "plain"}`;
        if (
          !initialSessionListLogged.has(logKey) ||
          elapsedMs >= SLOW_SESSION_LIST_MS
        ) {
          initialSessionListLogged.add(logKey);
          log.info(fields);
        } else {
          log.debug(fields);
        }
        return result;
      },
    );

    ipcMain.handle("local-db:sessions:create", async (event, body) => {
      assertTrustedAppRendererEvent(event);
      const db = getDbClient().drizzle;
      const now = Date.now();
      const bodyObj =
        body && typeof body === "object"
          ? (body as Record<string, unknown>)
          : {};
      const id = resolveBusinessSessionId(bodyObj.id);
      // 未发送任务（新建页开始输入时先建出来，见 provisionalSessions.ts）：只给本机普通任务，
      // 延后的创建副作用在第一次发送转正时补做。
      const { provisional: provisionalFlag, ...bodyWithoutProvisional } =
        bodyObj;
      const provisional = provisionalFlag === true;
      if (
        provisional &&
        (bodyObj.remoteHostId ||
          bodyObj.agentDeviceId ||
          bodyObj.orcaRole ||
          bodyObj.source !== undefined ||
          (Array.isArray(bodyObj.writableDirs) &&
            bodyObj.writableDirs.length > 0))
      ) {
        throwIpcError(
          "INVALID_PARAMS",
          "only ordinary local tasks can be opened before the first send",
        );
      }
      const createBody = bodyWithoutProvisional as Parameters<
        typeof sessionCreateToRow
      >[1];
      // M16: agentKind 白名单校验（防止 renderer 传非法值）
      const ALLOWED_AGENT_KINDS = new Set<string>(["cc", "codex", "pi"]);
      if (
        bodyObj.agentKind !== undefined &&
        !ALLOWED_AGENT_KINDS.has(bodyObj.agentKind as string)
      ) {
        throwIpcError(
          "INVALID_PARAMS",
          `invalid agentKind: ${String(bodyObj.agentKind)}`,
        );
      }
      if (
        bodyObj.title !== undefined &&
        (typeof bodyObj.title !== "string" || bodyObj.title.length > 200)
      ) {
        throwIpcError(
          "INVALID_PARAMS",
          "title must be a string no longer than 200 characters",
        );
      }
      const ALLOWED_WORKSPACE_KINDS = new Set<string>(["project", "dialogue"]);
      if (
        bodyObj.workspaceKind !== undefined &&
        !ALLOWED_WORKSPACE_KINDS.has(bodyObj.workspaceKind as string)
      ) {
        throwIpcError(
          "INVALID_PARAMS",
          `invalid workspaceKind: ${String(bodyObj.workspaceKind)}`,
        );
      }
      const ALLOWED_ORCA_ROLES = new Set<string>(["lead", "worker"]);
      if (
        bodyObj.orcaRole !== undefined &&
        bodyObj.orcaRole !== null &&
        !ALLOWED_ORCA_ROLES.has(bodyObj.orcaRole as string)
      ) {
        throwIpcError(
          "INVALID_PARAMS",
          `invalid orcaRole: ${String(bodyObj.orcaRole)}`,
        );
      }
      // Agent 在同账号另一台电脑运行：只接受设备 id 形态的值(与 maker:create-session 同一规则)。
      if (
        bodyObj.agentDeviceId !== undefined &&
        bodyObj.agentDeviceId !== null &&
        (typeof bodyObj.agentDeviceId !== "string" ||
          !/^[A-Za-z0-9_.:-]{1,128}$/.test(bodyObj.agentDeviceId))
      ) {
        throwIpcError("INVALID_PARAMS", "agentDeviceId must be a device id");
      }
      const workspaceKind =
        (createBody?.workspaceKind as "project" | "dialogue" | undefined) ??
        "project";
      const explicitWorkingDir =
        normalizeWorkingDirForStorage(
          typeof createBody?.workingDir === "string"
            ? createBody.workingDir
            : null,
        ) ?? undefined;
      assertRendererSessionSourceAllowed({
        source: bodyObj.source,
        workingDir: explicitWorkingDir,
        remoteHostId: createBody?.remoteHostId,
        userData: host.userDataDirectory(),
      });
      const workingDir =
        workspaceKind === "dialogue" && !explicitWorkingDir
          ? ensureDialogueWorkspaceDir(id, now)
          : explicitWorkingDir;
      if (workspaceKind === "dialogue" && !explicitWorkingDir) {
        log.info("[localDb] allocated dialogue workspace", {
          sessionId: id,
          workingDir,
        });
      }
      const requestedWritableDirs = createBody?.writableDirs ?? [];
      if (
        !Array.isArray(requestedWritableDirs) ||
        !requestedWritableDirs.every((dir) => typeof dir === "string")
      ) {
        throwIpcError("INVALID_PARAMS", "writableDirs must be string[]");
      }
      const requestedRemoteHostId = normalizeRemoteHostId(
        createBody?.remoteHostId,
      );
      if (requestedRemoteHostId && requestedWritableDirs.length > 0) {
        throwIpcError(
          "PRECONDITION_FAILED",
          "remote writable directories can only be revoked from an existing task",
        );
      }
      if (!requestedRemoteHostId && requestedWritableDirs.length > 0) {
        try {
          await consumeWritableDirectoryPickerGrants({
            scopeId: id,
            senderId: host.senderId(event),
            requestedDirs: requestedWritableDirs,
            previousDirs: [],
          });
        } catch (error) {
          throwIpcError(
            "PRECONDITION_FAILED",
            error instanceof Error
              ? error.message
              : "Writable directory authorization failed",
          );
        }
      }
      // 未发送任务在写入之前就登记：行一出现，任务列表 / 控制端 / IM / hook 的过滤就已生效。
      const markedProvisional = provisional && !isProvisionalSession(id);
      if (markedProvisional) {
        // Only a dialogue folder allocated here is ours to tidy up if the task is discarded.
        const managedDir =
          workspaceKind === "dialogue" && !explicitWorkingDir
            ? workingDir
            : undefined;
        markProvisionalSession(id, now, managedDir);
      }
      let insertRow: Awaited<ReturnType<typeof openSession>>["row"];
      let row: typeof sessions.$inferSelect | undefined;
      try {
        ({ row: insertRow } = await openSession(
          {
            id,
            now,
            body: { ...createBody, workspaceKind, workingDir },
            ...(provisional ? { deferGitInit: true } : {}),
          },
          async (prepared, assertCurrent) => {
            const resource =
              !prepared.remoteHostId && prepared.workingDir
                ? managedWorktreeRoot(prepared.workingDir)
                : null;
            const insert = async () => {
              assertCurrent();
              await db.insert(sessions).values(prepared);
            };
            if (resource) await withWorktreeMutation([resource], insert);
            else await insert();
          },
        ));
        [row] = await db.select().from(sessions).where(eq(sessions.id, id));
      } catch (error) {
        if (markedProvisional) forgetProvisionalSession(id);
        throw error;
      }
      if (!row) throwIpcError("NOT_FOUND", "Session 创建后查询失败");
      if (provisional) {
        log.info("provisional session opened", {
          sessionId: id,
          workspaceKind: insertRow.workspaceKind,
        });
        return sessionToCamel({ ...row, messageCount: 0 });
      }
      // recent-workdirs: 项目目录走 sidebar 分组,要进"最近"列表;dialogue 目录是
      // app-managed 临时 cwd,跟用户选过的项目目录语义不同,不污染最近列表。
      // 失败仅日志,不阻断创建流程。
      //
      // remote 项目排除:recent_workdirs 表只有 path 主键、无 host 维度,若把 remote
      // 路径写进去,后续 New Maker 项目下拉选中它时会丢失 host、按本机路径创建出一个
      // 错误的本地会话(指向本机不存在的同名目录)。在 host-aware 最近项目(给该表加
      // remote_host_id 列 + picker 区分 local/remote)落地前,remote 项目一律不进最近列表。
      if (
        insertRow.workspaceKind === "project" &&
        insertRow.workingDir &&
        !insertRow.remoteHostId &&
        isRetainableProjectSession(insertRow)
      ) {
        void upsertRecentWorkdir(insertRow.workingDir, now);
      }
      // 订阅槽①旁路通知(fire-and-forget,动态 import 防环):意识旁听会话创建。
      // 资格过滤(用户主会话)与订阅者快路径都在 cindy-brain 内部,这里零判断。
      void host
        .loadPluginNotifications()
        .then((m) =>
          m.notifyGhostSessionEvent("created", {
            sessionId: id,
            ...(row.workingDir ? { workdir: row.workingDir } : {}),
          }),
        )
        .catch(() => {});
      // 新建 session 必然无 message，直接拼 0，免一次 join。
      return sessionToCamel({ ...row, messageCount: 0 });
    });

    // interrupted-turn-resume:「疑似中断」(startedAt > endedAt)的 active 会话 id。
    // ⚠️ 只在**启动首拉**时消费:该判定对正在跑的 turn 天然成立,只有启动时刻才能
    // 断定飞行中的 turn 来自上一个进程。周期性重跑会把运行中的会话误判为中断。
    ipcMain.handle("local-db:sessions:interrupted-pending", async () => {
      return listInterruptedPendingSessionIds();
    });

    // 启动「继续上次中断的任务」弹窗:同一批中断会话,附中断时间与中断那一轮最后一次
    // 工具调用的文案(与灵动岛同源)。查询带 bootAt 守卫,任何时刻调用都不会把本进程
    // 正在跑的 turn 算进来。只服务本机顶层 renderer,不进 device-link allowlist。
    ipcMain.handle(
      "local-db:sessions:interrupted-resume-candidates",
      async (event) => {
        assertTrustedAppRendererEvent(event);
        const rows = await listInterruptedResumeCandidateRows();
        return rows.map(({ sessionId, interruptedAt, lastToolUse }) => ({
          sessionId,
          interruptedAt,
          activity: lastToolUse
            ? (host.formatInterruptedToolDetail(
                lastToolUse.toolName,
                lastToolUse.input,
              ) ?? lastToolUse.toolName)
            : null,
        }));
      },
    );

    // 「尾部停在未 dismissed 错误行」的 active 会话 id —— 红点派生的周期性重算源。
    // 与中断腿不同,这条判定与 turn 是否在跑无关(turn 一跑起来就会插入新的 user 行,
    // error 行不再是尾行,自然不命中),因此可以在每个收敛触发点安全重跑。
    // 故意**不**进 device-link allowlist:renderer 只查本机(远程会话的告警由被控端
    // 自己的派生收敛负责,控制端的处置动作经既有 ack-interrupted / dismiss-error 窄写
    // 落被控端 DB 后触发)。没有跨端调用方就不扩协议面。
    // sender guard:新增 handler 一律验证来源(electron-security-and-process-boundaries.md
    // §5 —— 存量未迁完不构成新 handler 省略校验的理由)。这两个 channel 都**不在**
    // device-link allowlist 里,只由本机顶层 renderer 调用,所以 guard 不会挡掉隧道
    // dispatch;将来若要放行跨端,必须连这道 guard 一起重新设计。
    ipcMain.handle("local-db:sessions:error-tail-pending", async (event) => {
      assertTrustedAppRendererEvent(event);
      return listErrorTailPendingSessionIds();
    });

    // 批量处置未处理告警(自动化分组右键「全部标为已读」)。红点是告警的派生投影,
    // 光清角标会被下一次重算打回来 —— 所以这个入口必须做真正的处置,与用户在横幅上
    // 点「忽略」等价:错误尾行 merge dismissed:true(复用 dismissErrorMessage,带 peer
    // 广播),中断态写 last_turn_ended_at 消化掉。
    // 只处置**当前真的命中告警**的会话:一次全量查询后按传入集合取交集,避免对
    // 无告警会话空写 lastTurnEndedAt 造成无意义的 patch 广播。
    // 输入有界(review 反馈):不接受无上限数组,也不静默吞掉畸形元素 —— 越界或元素
    // 不合法直接 INVALID_PARAMS 拒绝,避免异常调用方让 main 侧分配任意大的集合并跑
    // 一轮数据库写。上限取 sidebar 可能的自动化会话量级的宽松倍数。
    const MAX_DISMISS_SESSION_IDS = 500;
    // 单个 id 也要有界:session id 是 UUID / cuid(≤ 36 字符),128 是宽松上限。
    // 只限数组长度不够 —— 500 个超长字符串同样能让 main 侧白留一大块内存并做无谓比较。
    const MAX_SESSION_ID_LENGTH = 128;
    ipcMain.handle(
      "local-db:sessions:dismiss-pending-alerts",
      async (event, ids: unknown) => {
        // 认证来源再做任何写:payload 有界 ≠ 来源可信(见上方 guard 说明)。
        assertTrustedAppRendererEvent(event);
        if (!Array.isArray(ids))
          throwIpcError("INVALID_PARAMS", "sessionIds 必须是数组");
        if (ids.length > MAX_DISMISS_SESSION_IDS) {
          throwIpcError(
            "INVALID_PARAMS",
            `sessionIds 超过上限 ${MAX_DISMISS_SESSION_IDS}`,
          );
        }
        for (const id of ids) {
          const sid = requireString(id, "sessionId");
          if (sid.length > MAX_SESSION_ID_LENGTH) {
            throwIpcError(
              "INVALID_PARAMS",
              `sessionId 超过长度上限 ${MAX_SESSION_ID_LENGTH}`,
            );
          }
        }
        const wanted = new Set(ids as string[]);
        if (wanted.size === 0)
          return { dismissed: 0, processed: [], failed: [] };
        const [tailRows, interruptedRows] = await Promise.all([
          listErrorTailPendingRows(),
          listInterruptedPendingRows(),
        ]);
        // 回报**确切处置成功的 id**(processed),不让调用方用「不在 failed 里」推断成功:
        // 请求集合里可能有本 handler 根本不处理的告警来源(典型是 WorktreeRestoreBanner
        // 打的红点 —— 它不进错误尾行/中断查询),那些会话既不成功也不失败。按「非 failed
        // 即成功」清点会抹掉它们的红点,而 worktree 告警又不在重算范围内、恢复不了
        // (PR #879 review P1)。
        const processed = new Set<string>();
        const failed = new Set<string>();
        for (const row of tailRows) {
          if (!wanted.has(row.sessionId)) continue;
          try {
            const updated = await dismissErrorMessage(
              row.sessionId,
              row.clientId,
            );
            if (updated) processed.add(row.sessionId);
            else failed.add(row.sessionId);
          } catch {
            failed.add(row.sessionId);
          }
        }
        for (const row of interruptedRows) {
          if (!wanted.has(row.sessionId)) continue;
          // CAS 写:带上快照里的 startedAt。快照之后若该会话已启动新 turn,条件不匹配、
          // 不写入 —— 否则会把刚启动的活跃 turn 记成已收尾,它真被中断时下次启动检测不到
          // (PR #879 review P1)。返回值已含读回校验。
          const landed = await ackSessionTurnEndedIfUnchanged(
            row.sessionId,
            row.startedAt,
          );
          if (landed) processed.add(row.sessionId);
          else failed.add(row.sessionId);
        }
        // 同一会话两条腿都命中时,任一失败即整体算失败(它仍有未处置的告警)。
        for (const id of failed) processed.delete(id);
        return {
          dismissed: processed.size,
          processed: [...processed],
          failed: [...failed],
        };
      },
    );

    // interrupted-turn-resume:用户对「疑似中断」提示点「忽略」/「继续」——写一次
    // 正常收尾时刻,startedAt > endedAt 不再成立,banner 与红点跨重启不复现。
    // 幂等窄写,device-link 远程会话经隧道调用(allowlist 收录)。
    ipcMain.handle(
      "local-db:sessions:ack-interrupted",
      async (_e, id: unknown) => {
        const sid = requireString(id, "id");
        // renderer 的「忽略」立即走本 IPC；「继续任务」由执行端 maker send 事务 /
        // coordinator 在 dispatch 成功后用进入 vendor 前冻结的本机时间戳直调 durable 写。
        // awaited 版:等落库完成才广播 / 返回 —— 用户点忽略后立刻退出/重载时,写不能
        // 还停在内存链上,否则重启后同一提示复现(review P2)。
        // 广播不在此显式调用:ended 落库即经 setOnSessionTurnEndedPersisted 注入的回调
        // 广播(见 registerSessionIpc 头部注入点),ack 路径 await 写链完成,返回前广播
        // 必已发出 —— 其它窗口 / device-link 控制端的 session 快照 merge 后 banner 判定
        // 自动熄灭,启动红点也靠这条 patch 收敛(useInterruptedSessionsAttention)。
        await ackSessionTurnEndedDurable(sid);
        return { ok: true };
      },
    );

    // Bounded reconciliation read: same metadata/count/preview as GET, one DB RPC.
    // Omitted rows mean missing or remotely hidden; the tunnel filters visibility.
    ipcMain.handle(
      "local-db:sessions:get-many",
      async (event, value: unknown) => {
        if (!isDeviceLinkInvoke()) assertTrustedAppRendererEvent(event);
        if (!Array.isArray(value) || value.length > SESSION_READ_BATCH_LIMIT) {
          throwIpcError(
            "INVALID_PARAMS",
            `sessionIds must be an array of at most ${SESSION_READ_BATCH_LIMIT} ids`,
          );
        }
        const ids = [
          ...new Set(value.map((id) => requireString(id, "sessionId"))),
        ];
        if (!ids.length) return [];
        const rows = await selectSessionsByIds(getDbClient().drizzle, ids);
        return rows.map((row) =>
          projectSessionReadResult(row, opts.resolveContextWindow),
        );
      },
    );

    ipcMain.handle("local-db:sessions:get", async (_e, id: unknown) => {
      const sid = requireString(id, "id");
      const db = getDbClient().drizzle;
      const row = await selectSessionWithCount(db, sid);
      if (!row) throwIpcError("NOT_FOUND", "Session 不存在");
      return projectSessionReadResult(row, opts.resolveContextWindow);
    });

    /**
     * 批量解析 scheduler 持有的会话引用。普通列表会隐藏软删除墓碑，renderer 不能
     * 再靠“列表中是否存在”推断可打开状态；单次有界查询也避免每张 run 卡各发 IPC。
     */
    ipcMain.handle(
      "local-db:sessions:resolve-references",
      async (_e, value: unknown) => {
        if (!Array.isArray(value))
          throwIpcError("INVALID_PARAMS", "sessionIds must be an array");
        if (value.length > 200)
          throwIpcError("INVALID_PARAMS", "sessionIds exceeds limit 200");

        const sessionIds = Array.from(
          new Set(
            value.map((id, index) => requireString(id, `sessionIds[${index}]`)),
          ),
        );
        if (sessionIds.length === 0) return [] satisfies SessionReference[];

        const db = getDbClient().drizzle;
        const rows = await db
          .select({
            id: sessions.id,
            status: sessions.status,
            title: sessions.title,
            agentKind: sessions.agentKind,
            agentDeviceId: sessions.agentDeviceId,
            remoteHostId: sessions.remoteHostId,
          })
          .from(sessions)
          .where(inArray(sessions.id, sessionIds));
        const rowsById = new Map(rows.map((row) => [row.id, row]));

        return sessionIds.map((sessionId): SessionReference => {
          const row = rowsById.get(sessionId);
          if (!row) return { sessionId, state: "missing" };
          return {
            sessionId,
            state: row.status === "deleted" ? "deleted" : "available",
            status: row.status,
            title: row.title,
            agentKind: normalizeDbAgentKind(row.agentKind),
            agentDeviceId:
              row.agentDeviceId && !row.remoteHostId ? row.agentDeviceId : null,
          };
        });
      },
    );

    /**
     * 批量恢复的 compare-and-set 写口：确认框期间会话可能被删除、由其他入口恢复，
     * 或移动到别的项目。状态与项目身份必须在同一条 UPDATE 中校验，避免 renderer
     * 先 get 再 update 的 TOCTOU 竞态覆盖较新的状态。
     */
    ipcMain.handle(
      "local-db:sessions:restore-if-archived",
      async (_e, id: unknown, expected: unknown) => {
        const sid = requireString(id, "id");
        const ownerScope = captureOwnerScope();
        const identity = requireObject(expected, "expected");
        const expectedWorkingDir = identity.workingDir;
        const expectedWorkspaceKind = identity.workspaceKind;
        const expectedRemoteHostId = identity.remoteHostId;

        if (
          expectedWorkingDir !== null &&
          typeof expectedWorkingDir !== "string"
        ) {
          throwIpcError(
            "INVALID_PARAMS",
            "expected.workingDir must be a string or null",
          );
        }
        if (
          expectedWorkspaceKind !== "project" &&
          expectedWorkspaceKind !== "dialogue"
        ) {
          throwIpcError(
            "INVALID_PARAMS",
            "expected.workspaceKind must be project or dialogue",
          );
        }
        if (
          expectedRemoteHostId !== null &&
          typeof expectedRemoteHostId !== "string"
        ) {
          throwIpcError(
            "INVALID_PARAMS",
            "expected.remoteHostId must be a string or null",
          );
        }

        const db = getDbClient().drizzle;
        const updated = await withStatusWriteLock(
          db,
          sid,
          "active",
          async () => {
            if (!isOwnerScopeCurrent(ownerScope)) return null;
            await assertGenericSessionLifecycleAllowed(db, sid);
            // 显式 .run() 才能从生产 DbClient.drizzle proxy 拿到 changes；隐式 await
            // 会丢弃写结果。CAS 是否命中必须以该原子 UPDATE 的 changes 判定。
            const writeResult = await db
              .update(sessions)
              .set(sessionPatchToRow({ status: "active" }))
              .where(
                and(
                  eq(sessions.id, sid),
                  eq(sessions.status, "archived"),
                  expectedWorkingDir === null
                    ? isNull(sessions.workingDir)
                    : eq(sessions.workingDir, expectedWorkingDir),
                  eq(sessions.workspaceKind, expectedWorkspaceKind),
                  expectedRemoteHostId === null
                    ? isNull(sessions.remoteHostId)
                    : eq(sessions.remoteHostId, expectedRemoteHostId),
                ),
              )
              .run();

            if (writeResult.changes === 0) {
              const [existing] = await db
                .select({ id: sessions.id })
                .from(sessions)
                .where(eq(sessions.id, sid));
              if (!existing) throwIpcError("NOT_FOUND", "Session 不存在");
              return null;
            }

            const row = await selectSessionWithCount(db, sid);
            if (!row) throwIpcError("NOT_FOUND", "Session 不存在");
            return sessionToCamel(row);
          },
        );
        if (!updated) return null;
        notifyAgentIslandSessionPatch(updated.id, {
          status: updated.status,
          title: updated.title,
          workingDir: updated.workingDir,
          workspaceKind: updated.workspaceKind,
        });
        if (isOwnerScopeCurrent(ownerScope)) {
          broadcastSessionPatched(sid, { status: "active" }, ownerScope);
        }
        scheduleWorktreeRecycleForStatusChange(sid, "active");
        notifyGhostSessionStatusChange(sid, "active", updated.workingDir);
        return updated;
      },
    );

    ipcMain.handle(
      "local-db:sessions:update",
      async (_e, id: unknown, patch: unknown) => {
        const sid = requireString(id, "id");
        const p = requireObject(patch, "patch");
        return updateSessionInDb(sid, p, opts);
      },
    );

    // 窄口径会话元数据编辑(status / title / pinnedAt)。专为 device-link 控制端**远程**
    // 删除/归档/重命名/置顶设计:通用 sessions:update 能写任意字段(workingDir/model/
    // sdkSessionId/orcaRole/clearedAt…),故意不进 allowlist;这个 handler 只放行白名单内的
    // 用户可编辑元数据,是「写库必须经业务 handler、不开裸写」原则下的窄能力(规则 9/13)。
    // 仅被隧道(远程操作)调到 —— 本机操作走 sessions:update + renderer 乐观更新。
    ipcMain.handle(
      "local-db:sessions:patch-meta",
      async (_e, id: unknown, patch: unknown) => {
        const sid = requireString(id, "id");
        const p = requireObject(patch, "patch");
        const updated = await patchSessionMetaInDb(
          sid,
          p as Parameters<typeof patchSessionMetaInDb>[1],
        );
        return updated;
      },
    );

    // fork-session: 已迁到 maker-ipc/fork.ts (Stage 2 C2), IPC channel 改名 maker:fork。
    // 业务函数 forkSessionAtMessage 仍在 apps/desktop/src/main/maker-orchestration/fork.ts, 内部 SDK 调用
    // 走 maker-core 的 Maker.forkSdkSession (Codex 自动抛 NotSupportedError)。

    // 单字段 bump：把 user_send_at 设为 now。fire-and-forget，不返回 row。
    // 故意与 sessions:update 解耦——update 会同步刷 updated_at（mapper.ts:165），
    // 那是给"字段类改动"用的；touchUserSend 只标记"对话活跃"，绝不污染 updated_at。
    ipcMain.handle(
      "local-db:sessions:touchUserSend",
      async (_e, id: unknown, atMs: unknown): Promise<void> => {
        const sid = requireString(id, "id");
        await touchUserSendInDb(
          sid,
          typeof atMs === "number" ? atMs : undefined,
        );
      },
    );

    // 本机 UI 偏好:置顶段是不是卡片模式。故意不进 device-link allowlist —— 摘要
    // oneShot 只服务本机卡片展示,控制端卡片回退 preview,不把付费生成推到被控端。
    // 新增 handler 一律校验顶层 app renderer(electron-security §5)。
    ipcMain.handle(
      "local-db:sessions:set-pinned-card-summaries",
      async (event, enabled: unknown): Promise<void> => {
        assertTrustedAppRendererEvent(event);
        if (typeof enabled !== "boolean") {
          throwIpcError("INVALID_PARAMS", "enabled must be a boolean");
        }
        const m = await host.loadSummaries();
        m.setPinnedSectionCardMode(enabled);
      },
    );
  }

  /**
   * `local-db:sessions:update` 的业务体。renderer 的 sessionService.update 与 MCP
   * 会话操作工具(move / pin / delete 等)共用这一条路径:路由锁 + worktree 锁、
   * review 会话拒改、Pi/Codex 空闲 runtime 关闭、cc 转录目录搬迁、recent-workdir
   * 维护、sessions:patched 广播与 agent-island 通知都在这里,不得另起平行写入链路。
   *
   * 「绑定托管 worktree 的会话不得改到该 worktree 之外」是这里的不变量,所有入口
   * (GUI 侧栏、MCP 工具、device-link)一并生效;GUI 侧的预检只为及时反馈,规则
   * 以本函数为准,不得在入口层另立一份。
   */
  async function updateSessionInDb(
    sid: string,
    p: Record<string, unknown>,
    opts: RegisterSessionIpcOpts = registeredSessionIpcOpts,
    moveGuard?: {
      /** Identity only: also used after commit and inside transcript relocation. */
      assertCurrent: () => void;
      /** Runs inside the existing route/worktree locks, including dialogue moves. */
      beforeUpdate: () => Promise<void>;
      /** Mutable running/IM preconditions must not reject an already committed move. */
      beforeWrite?: () => void | Promise<void>;
    },
  ): Promise<ReturnType<typeof sessionToCamel>> {
    moveGuard?.assertCurrent();
    const ownerScope = captureOwnerScope();
    if (p.extraDirs !== undefined || p.writableDirs !== undefined) {
      throwIpcError(
        "UNSUPPORTED_CAPABILITY",
        "directory grants must be changed through maker:set-*-dirs",
      );
    }
    const dbClient = getDbClient();
    const db = dbClient.drizzle;
    // 工作目录切换必须和发送/懒启动共用同一把路由锁。否则发送可能在
    // 读取旧目录后、写入新目录前重建 runtime，随后仍在旧目录执行。
    const update = async () => {
      if (moveGuard) {
        moveGuard.assertCurrent();
        await moveGuard.beforeUpdate();
        moveGuard.assertCurrent();
      }
      if (p.workspaceKind !== undefined) {
        const value = p.workspaceKind;
        if (value !== "project" && value !== "dialogue") {
          throwIpcError(
            "INVALID_PARAMS",
            `invalid workspaceKind: ${String(value)}`,
          );
        }
      }
      const ALLOWED_UPDATE_ORCA_ROLES = new Set<string>(["lead", "worker"]);
      if (
        p.orcaRole !== undefined &&
        p.orcaRole !== null &&
        !ALLOWED_UPDATE_ORCA_ROLES.has(p.orcaRole as string)
      ) {
        throwIpcError(
          "INVALID_PARAMS",
          `invalid orcaRole: ${String(p.orcaRole)}`,
        );
      }
      if (typeof p.workingDir === "string") {
        p.workingDir = normalizeWorkingDirForStorage(p.workingDir) ?? null;
      }
      const REVIEW_IMMUTABLE_FIELDS = new Set([
        "workingDir",
        "workspaceKind",
        "model",
        "providerId",
        "effort",
        "permissionMode",
        "fastMode",
        "planModeEnabled",
        "orcaRole",
        "extraDirs",
        "writableDirs",
      ]);
      if (Object.keys(p).some((key) => REVIEW_IMMUTABLE_FIELDS.has(key))) {
        const [target] = await db
          .select({ source: sessions.source })
          .from(sessions)
          .where(eq(sessions.id, sid))
          .limit(1);
        if (target?.source === "review") {
          throwIpcError(
            "UNSUPPORTED_CAPABILITY",
            "Review task settings are fixed to the source task",
          );
        }
      }
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
      const requestedWorkingDir =
        typeof p.workingDir === "string" ? p.workingDir : null;
      // 显式清空(`workingDir: null`,或空串/空白串经上面的归一化变成 null)也是改归属:
      // 字符串判据放它过去的话,worktree 会话会被摘掉工作目录,留下同一类归属分裂。
      // 只当键真的出现且归一化后为 null 时才算清空(未传该键的 update 不落库,不能算)。
      const clearsWorkingDir =
        Object.prototype.hasOwnProperty.call(p, "workingDir") &&
        p.workingDir === null;
      if (
        beforeMove &&
        !beforeMove.remoteHostId &&
        (requestedWorkingDir !== null || clearsWorkingDir) &&
        (clearsWorkingDir ||
          !workingDirEquals(requestedWorkingDir, beforeMove.workingDir))
      ) {
        // 归属真源:装了绑定查询(生产路径)就以 store 的答案为唯一依据 —— 返回 null 就是
        // **没有活绑定**(worktree 已被回收的会话仍会留着历史 worktree 路径),此时不能再
        // 从 cwd 反推,否则这些会话会被永久拦死;未装查询的场景(单测/裁剪引导)才退回 cwd。
        let ownedWorktreeRoot: string | null = null;
        if (sessionWorktreeBindingLookup) {
          const liveWorktreePath = sessionWorktreeBindingLookup(sid);
          ownedWorktreeRoot = liveWorktreePath
            ? managedWorktreeRoot(liveWorktreePath)
            : null;
        } else if (beforeMove.workingDir) {
          ownedWorktreeRoot = managedWorktreeRoot(beforeMove.workingDir);
        }
        const targetWorktreeRoot = requestedWorkingDir
          ? managedWorktreeRoot(requestedWorkingDir)
          : null;
        if (
          ownedWorktreeRoot &&
          !workingDirEquals(ownedWorktreeRoot, targetWorktreeRoot)
        ) {
          // 错误码与文案是跨进程契约:renderer 按它把这次拒绝映射成同一条 toast
          // (shared/worktreeMoveGuardError.ts),两侧共用常量避免文案漂移。
          throwIpcError(
            WORKTREE_MOVE_BLOCKED_CODE,
            WORKTREE_MOVE_BLOCKED_MESSAGE,
          );
        }
      }
      const movingLocalNonClaudeSession =
        beforeMove &&
        beforeMove.agentKind !== "cc" &&
        !beforeMove.remoteHostId &&
        beforeMove.workingDir &&
        typeof p.workingDir === "string" &&
        p.workingDir &&
        normalizeWorkingDirForStorage(beforeMove.workingDir) !== p.workingDir;
      // Pi/Codex keep a live Maker handle whose cwd is fixed at bootstrap. Close it
      // before persisting the new directory so the next send lazily recreates the
      // runtime with the moved session's cwd instead of continuing in the old one.
      if (movingLocalNonClaudeSession) {
        await moveGuard?.beforeWrite?.();
        moveGuard?.assertCurrent();
        if (!opts.closeIdleSessionForMove) {
          throwIpcError("INTERNAL", "会话移动 runtime 操作未配置");
        }
        const idle = await opts.closeIdleSessionForMove(sid);
        if (idle === false) {
          throwIpcError("PRECONDITION_FAILED", "运行中的任务不能移动");
        }
      }
      // 只有纯设置字段(model/effort 等)才跳过 bump；凡带 activity 字段
      // (clearedAt / sdkSessionId / status / token 用量等)仍需更新 updatedAt，
      // 否则本地 /clear 后重启侧栏时间回退旧值。
      const SETTINGS_ONLY_FIELDS = new Set([
        "model",
        "effort",
        "permissionMode",
        "fastMode",
        "planModeEnabled",
        "providerId",
        "orcaRole",
        "extraDirs",
        "writableDirs",
        "pinnedAt",
        "workingDir",
        "workspaceKind",
        "title",
      ]);
      const isSettingsOnly = Object.keys(p).every((k) =>
        SETTINGS_ONLY_FIELDS.has(k),
      );
      const setObj = sessionPatchToRow(
        p as Parameters<typeof sessionPatchToRow>[0],
        {
          bumpUpdatedAt: !isSettingsOnly,
        },
      );
      if (p.clearedAt !== undefined) {
        setObj.summary = null;
        setObj.listPreview = null;
        setObj.listPreviewRole = null;
      }
      // 在提交新 cwd 前完成现有 CC 迁移,与 Pi/Codex 的 runtime 关闭同处提交前。
      // 迁移只复制、不删除旧转录:切账号或写库失败时旧 cwd 仍可恢复；提交后
      // 围栏即使拒绝返回,也不会留下新 cwd 配旧转录。复用原锁与 best-effort 策略。
      // 动态 import 避免 localDb → maker-host 静态模块环。
      if (
        beforeMove &&
        beforeMove.agentKind === "cc" &&
        !beforeMove.remoteHostId &&
        beforeMove.workingDir &&
        typeof p.workingDir === "string" &&
        p.workingDir &&
        normalizeWorkingDirForStorage(beforeMove.workingDir) !== p.workingDir
      ) {
        const m = await host.loadTranscriptRelocation();
        moveGuard?.assertCurrent();
        await moveGuard?.beforeWrite?.();
        moveGuard?.assertCurrent();
        const reloc = await m.relocateClaudeTranscriptsForSessionMove(
          sid,
          beforeMove.workingDir,
          p.workingDir,
          ...(moveGuard
            ? [{ client: dbClient, assertCurrent: moveGuard.assertCurrent }]
            : []),
        );
        if (reloc.persistedSdkSessionId) {
          p.sdkSessionId = reloc.persistedSdkSessionId;
          setObj.sdkSessionId = reloc.persistedSdkSessionId;
        }
      }
      // 用户手动改名(重命名框 / 侧边栏)走这条:告诉自动起名收手。同值改名不会让
      // 条件写落空,不显式说一声的话智能标题会把他刚保存的名字盖掉(review P1)。
      // **必须先于 UPDATE**:写库是一次 worker RPC 往返,改名提交与这里拿到回执之间
      // 有真实时间差,在那期间智能标题仍能满足 `WHERE title = 期望值` 把名字盖掉。
      // 先记号后写库,代价只是写库失败时该会话本进程内不再自动起名 —— 用户毕竟确实
      // 按下过保存,这个方向的偏差是安全的。
      if (typeof p.title === "string") noteUserTitleWritten(sid);
      let deletedSideChats:
        SessionsSetTerminalStatusResult["deletedSideChats"] | undefined;
      await withStatusWriteLock(
        db,
        sid,
        p.status,
        async () => {
          moveGuard?.assertCurrent();
          if (p.status !== undefined)
            await assertGenericSessionLifecycleAllowed(db, sid);
          await moveGuard?.beforeWrite?.();
          moveGuard?.assertCurrent();
          const terminal = p.status === "archived" || p.status === "deleted";
          if (terminal) {
            if (typeof dbClient.tx === "function") {
              const { status: _status, ...nonTerminalPatch } = setObj;
              await writeSessionPatch(db, sid, nonTerminalPatch, undefined);
              deletedSideChats = await setTerminalSessionStatus(
                dbClient,
                sid,
                p.status as "archived" | "deleted",
              );
            } else {
              const prepared = await prepareSharedTaskClosure(sid, dbClient);
              try {
                await writeSessionPatch(db, sid, setObj, p.status);
              } catch (error) {
                await rollbackSharedTaskClosure(dbClient, prepared);
                throw error;
              }
              await finalizeSharedTaskClosure(dbClient, prepared);
            }
          } else {
            await writeSessionPatch(db, sid, setObj, p.status);
          }
          cleanupSessionRuntimeForTerminalStatus(sid, p.status);
          if (terminal) {
            const { closeSharedTaskForTask } = await host.loadSharedTasks();
            await closeSharedTaskForTask(sid, dbClient);
          }
        },
        p.workingDir !== undefined,
      );
      moveGuard?.assertCurrent();
      // session-git-pr-context:/clear 经此处写 clearedAt——边界之前的消息对用户
      // 不可见,PR 引用同步重算(fire-and-forget,内部按 clearedAt/rewindAt 过滤)。
      if (p.clearedAt !== undefined) {
        noteSessionClearBoundary(sid, p.clearedAt as string | null);
        // sidebar-card-mode(codex review):summary 是基于 clear 前内容生成的,clear 后
        // 已过时;置顶卡片优先用 summary 而非 preview,不清就会继续显示旧任务摘要。
        // 与 clearedAt 同一句 UPDATE 置空，避免崩溃后非 NULL 缓存绕过 clear 边界。
        if (isOwnerScopeCurrent(ownerScope)) {
          broadcastSessionPatched(
            sid,
            { summary: null, preview: null },
            ownerScope,
          );
        }
        void recomputePrRefsForSession(sid).catch(() => undefined);
      }
      const row = await selectSessionWithCount(db, sid);
      moveGuard?.assertCurrent();
      if (!row) throwIpcError("NOT_FOUND", "Session 不存在");
      // 取消置顶后摘要不再有展示面,立刻清掉,避免列表/再次置顶前继续吃旧句。
      if (p.pinnedAt !== undefined && row.pinnedAt == null) {
        await db
          .update(sessions)
          .set({ summary: null })
          .where(eq(sessions.id, sid));
        row.summary = null;
      }
      const updated = sessionToCamel(row);
      if (updated.status === "deleted" && isOwnerScopeCurrent(ownerScope)) {
        clearSessionAttention(sid, "explicit");
      }
      const projectTargetChanged =
        p.workspaceKind !== undefined || p.workingDir !== undefined;
      const settingsChanged = Object.keys(p).some((key) =>
        REMOTE_PERSIST_FIELDS.has(key),
      );
      const titleChanged = p.title !== undefined;
      // 归档/删除这类纯 status 变化也要广播:本机多窗口收敛靠 sessions:patched,
      // 否则「在新窗口打开」的副窗口无从得知会话已被移除,仍停留在旧视图(#3175)。
      const statusChanged = p.status !== undefined;
      if (
        projectTargetChanged &&
        row.workspaceKind === "project" &&
        row.workingDir &&
        !row.remoteHostId &&
        isRetainableProjectSession(row)
      ) {
        const touched = await upsertRecentWorkdir(
          row.workingDir,
          Date.now(),
          process.platform,
          dbClient,
        );
        if (touched) broadcastRecentWorkdirsChanged(row.workingDir, ownerScope);
      }
      // status 广播必须用**广播时刻的持久化真值**,不能带请求值 p.status,也不能用
      // 上方读行的快照:写入(withStatusWriteLock)与广播不在同一串行区间,且读行
      // 之后、广播之前还有 await(摘要清理 / recent-workdir / 转录迁移),两个窗口
      // 对同一任务并发操作时,本请求可能在此期间被另一窗口推进到更晚的终态(如
      // 归档写入后被删除)。用过期值广播会把镜像回滚成旧 UI 状态(已删除任务在
      // 副窗/控制端复活),且若本广播是最后一条,镜像不会自愈。
      //
      // 因此含 status 的 patch 在广播前(所有 await 之后)**重读一次**:重读与广播
      // 之间无 await,同进程单事件循环下不可能再插入并发写;即便并发删除的广播
      // 晚于本广播到达,镜像最终也收敛到 deleted。
      let broadcastStatus = updated.status;
      if (p.status !== undefined) {
        const [currentRow] = await db
          .select({ status: sessions.status })
          .from(sessions)
          .where(eq(sessions.id, sid))
          .limit(1);
        if (currentRow) broadcastStatus = currentRow.status;
      }
      const broadcastPatch =
        p.pinnedAt === undefined && p.status === undefined
          ? p
          : {
              ...p,
              ...(p.pinnedAt !== undefined
                ? { pinnedAt: updated.pinnedAt }
                : {}),
              ...(p.status !== undefined ? { status: broadcastStatus } : {}),
              ...(p.pinnedAt !== undefined && updated.pinnedAt === null
                ? { summary: null }
                : {}),
              ...(p.pinnedAt !== undefined && updated.pinnedAt !== null
                ? { status: broadcastStatus }
                : {}),
            };
      moveGuard?.assertCurrent();
      if (
        projectTargetChanged ||
        settingsChanged ||
        titleChanged ||
        statusChanged ||
        p.pinnedAt !== undefined
      ) {
        if (isOwnerScopeCurrent(ownerScope)) {
          broadcastSessionPatched(sid, broadcastPatch, ownerScope);
        }
      }
      // sidebar-card-mode: 会话被置顶那一刻补生成任务摘要(turn-done 路径只覆盖
      // "置顶后又跑过 turn"的会话)。动态 import 避免 localDb → maker-host 的静态
      // 模块环;fire-and-forget,模块内部自带置顶/节流守卫。
      if (p.pinnedAt !== undefined && updated.pinnedAt !== null) {
        void host
          .loadSummaries()
          .then((m) => m.maybeGenerateSessionTaskSummary(sid, { force: true }));
      }
      notifyAgentIslandSessionPatch(updated.id, {
        status: updated.status,
        title: updated.title,
        workingDir: updated.workingDir,
        workspaceKind: updated.workspaceKind,
      });
      scheduleWorktreeRecycleForStatusChange(sid, p.status, {
        ownerScope,
        mediaDb: db,
      });
      notifyGhostSessionStatusChange(sid, p.status, updated.workingDir);
      cleanupSessionTerminalArtifacts(sid, p.status);
      compactTerminalSessionToolResults(dbClient, sid, p.status);
      if (p.status === "deleted" && updated.source !== "side-chat")
        await deleteDependentSideChats(
          sid,
          dbClient,
          ownerScope,
          deletedSideChats,
        );
      return updated;
    };
    if (p.workingDir === undefined && !moveGuard) return update();
    return withSessionRouteLock(sid, async () => {
      const [binding] = await db
        .select({ remoteHostId: sessions.remoteHostId })
        .from(sessions)
        .where(eq(sessions.id, sid))
        .limit(1);
      const resource =
        !binding?.remoteHostId && typeof p.workingDir === "string"
          ? managedWorktreeRoot(p.workingDir)
          : null;
      const resources = await readSessionWorktreeResources(db, sid);
      if (resource) resources.push(resource);
      return withWorktreeMutation(resources, update);
    });
  }

  const restoreArchivedSessionForSend = createArchivedSessionRestore({
    getDbClient, captureOwnerScope, isOwnerScopeCurrent, withSessionRouteLock, patchSessionMetaInDb,
  });

  async function patchSessionMetaInDb(
    sessionId: string,
    patch: {
      status?: "active" | "archived" | "deleted";
      title?: string;
      pinnedAt?: string | null;
    },
    options: {
      routeLockHeld?: boolean;
      signal?: AbortSignal;
      beforeWrite?: () => void;
    } = {},
  ): Promise<ReturnType<typeof sessionToCamel>> {
    const ownerScope = captureOwnerScope();
    for (const k of Object.keys(patch)) {
      if (!REMOTE_EDITABLE_META.has(k)) {
        throwIpcError(
          "INVALID_PARAMS",
          `field not allowed in patch-meta: ${k}`,
        );
      }
    }
    if (
      patch.status !== undefined &&
      patch.status !== "active" &&
      patch.status !== "archived" &&
      patch.status !== "deleted"
    ) {
      throwIpcError(
        "INVALID_PARAMS",
        `invalid status: ${String(patch.status)}`,
      );
    }
    if (patch.title !== undefined && typeof patch.title !== "string") {
      throwIpcError("INVALID_PARAMS", "title must be a string");
    }

    const dbClient = getDbClient();
    const db = dbClient.drizzle;
    const setObj = sessionPatchToRow(patch, { bumpUpdatedAt: false });
    // 控制端远程改名走这条,与本机改名同口径(同样先记号后写库)。
    if (patch.title !== undefined) noteUserTitleWritten(sessionId);
    let deletedSideChats:
      SessionsSetTerminalStatusResult["deletedSideChats"] | undefined;
    const updated = await withStatusWriteLock(
      db,
      sessionId,
      patch.status,
      async () => {
        if (patch.status !== undefined)
          await assertGenericSessionLifecycleAllowed(db, sessionId);
        options.beforeWrite?.();
        const terminal =
          patch.status === "archived" || patch.status === "deleted";
        if (terminal) {
          if (typeof dbClient.tx === "function") {
            const { status: _status, ...nonTerminalPatch } = setObj;
            await writeSessionPatch(db, sessionId, nonTerminalPatch, undefined);
            options.beforeWrite?.();
            deletedSideChats = await setTerminalSessionStatus(
              dbClient,
              sessionId,
              patch.status as "archived" | "deleted",
            );
          } else {
            const prepared = await prepareSharedTaskClosure(
              sessionId,
              dbClient,
            );
            try {
              options.beforeWrite?.();
              await writeSessionPatch(db, sessionId, setObj, patch.status);
            } catch (error) {
              await rollbackSharedTaskClosure(dbClient, prepared);
              throw error;
            }
            await finalizeSharedTaskClosure(dbClient, prepared);
          }
        } else {
          // All asynchronous preparation has finished. Once this write is issued,
          // cancellation does not roll back a committed lifecycle transition.
          if (options.signal?.aborted)
            throwIpcError("PRECONDITION_FAILED", "Session send aborted");
          await writeSessionPatch(db, sessionId, setObj, patch.status);
        }
        const row = await selectSessionWithCount(db, sessionId);
        if (!row) throwIpcError("NOT_FOUND", "Session 不存在");
        if (patch.pinnedAt !== undefined && row.pinnedAt == null) {
          await db
            .update(sessions)
            .set({ summary: null })
            .where(eq(sessions.id, sessionId));
          row.summary = null;
        }
        cleanupSessionRuntimeForTerminalStatus(sessionId, patch.status);
        if (terminal) {
          const { closeSharedTaskForTask } = await host.loadSharedTasks();
          await closeSharedTaskForTask(sessionId, dbClient);
        }
        return sessionToCamel(row);
      },
      options.routeLockHeld,
      options.beforeWrite,
    );
    if (updated.status === "deleted" && isOwnerScopeCurrent(ownerScope)) {
      clearSessionAttention(sessionId, "explicit");
    }
    notifyAgentIslandSessionPatch(updated.id, {
      status: updated.status,
      title: updated.title,
      workingDir: updated.workingDir,
      workspaceKind: updated.workspaceKind,
    });
    if (patch.status === "deleted") {
      void imageCacheStore.removeSession(sessionId).catch((err) => {
        log.warn("remote session image cleanup failed", {
          sessionId,
          err: err instanceof Error ? err.message : String(err),
        });
      });
    }
    cleanupSessionTerminalArtifacts(sessionId, patch.status);
    scheduleWorktreeRecycleForStatusChange(sessionId, patch.status, {
      ownerScope,
      mediaDb: db,
    });
    notifyGhostSessionStatusChange(sessionId, patch.status, updated.workingDir);
    // 远程 / MCP 改动绕过 renderer 乐观更新,故主动广播 sessions:patched:
    //   - sessionsStore.onPatched → patchLocal,即时反映到 sidebar(删/归档移出 active 桶、改名/置顶刷新);
    //   - CCAgentSessionView.onPatched → 合并进 serverSession。
    // 经 tap 转发:订阅了该被控端 `sessions` topic 的控制端也即时收到这条 patched(push 驱动镜像)。
    const broadcastPatch =
      patch.pinnedAt !== undefined && updated.pinnedAt == null
        ? { ...patch, summary: null }
        : patch;
    if (isOwnerScopeCurrent(ownerScope)) {
      broadcastSessionPatched(sessionId, broadcastPatch, ownerScope);
    }
    if (patch.pinnedAt !== undefined && updated.pinnedAt != null) {
      void host
        .loadSummaries()
        .then((m) =>
          m.maybeGenerateSessionTaskSummary(sessionId, { force: true }),
        );
    }
    compactTerminalSessionToolResults(dbClient, sessionId, patch.status);
    if (patch.status === "deleted" && updated.source !== "side-chat")
      await deleteDependentSideChats(
        sessionId,
        dbClient,
        ownerScope,
        deletedSideChats,
      );
    return updated;
  }

  /**
   * Bot tasks are absent from the ordinary task pool, so their active/history/
   * route transitions must go through the Bot lifecycle service. That service
   * updates the Profile pointer and Session projection atomically.
   */
  async function assertGenericSessionLifecycleAllowed(
    db: DbClient["drizzle"],
    sessionId: string,
  ): Promise<void> {
    const [target] = await db
      .select({ source: sessions.source })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);
    if (target?.source === "bot") {
      throwIpcError(
        "PRECONDITION_FAILED",
        "Bot task lifecycle is managed by teammate recovery and history controls",
      );
    }
  }

  async function renameSessionTitlesInDb(
    changes: RenameSessionMetaChange[],
    dryRun: boolean,
    beforeMutation?: () => Promise<void>,
  ): Promise<RenameSessionMetaItem[]> {
    if (changes.length === 0) return [];
    const ownerScope = captureOwnerScope();

    const db = getDbClient().drizzle;
    const ids = changes.map((change) => change.sessionId);
    const rows = await db
      .select({
        id: sessions.id,
        title: sessions.title,
        workingDir: sessions.workingDir,
        updatedAt: sessions.updatedAt,
      })
      .from(sessions)
      .where(inArray(sessions.id, ids));
    const rowById = new Map(rows.map((row) => [row.id, row]));

    const preview: RenameSessionMetaItem[] = [];
    for (const change of changes) {
      const row = rowById.get(change.sessionId);
      if (!row) {
        throwIpcError("NOT_FOUND", `Session 不存在: ${change.sessionId}`);
      }

      const updatedAt = new Date(row.updatedAt).toISOString();
      if (
        change.expectedCurrentTitle !== undefined &&
        row.title !== change.expectedCurrentTitle
      ) {
        throwIpcError(
          "PRECONDITION_FAILED",
          `Session 标题已变化: ${change.sessionId}`,
        );
      }
      if (
        change.expectedUpdatedAt !== undefined &&
        updatedAt !== change.expectedUpdatedAt
      ) {
        throwIpcError(
          "PRECONDITION_FAILED",
          `Session updatedAt 已变化: ${change.sessionId}`,
        );
      }

      preview.push({
        sessionId: change.sessionId,
        currentTitle: row.title,
        newTitle: change.title,
        workingDir: row.workingDir,
        updatedAt,
      });
    }

    if (dryRun) return preview;

    await beforeMutation?.();
    // 批量改名(MCP 工具)同样是"人给的名字",自动起名不得再覆盖;与上面两条出口
    // 一样先记号后写库,不给并发的智能标题留窗口。
    for (const change of changes) noteUserTitleWritten(change.sessionId);
    const applied = await getDbClient()
      .tx("sessions.renameTitles", { changes })
      .catch((err) => {
        const code = (err as { code?: string }).code;
        const message = err instanceof Error ? err.message : String(err);
        if (
          code === "NOT_FOUND" ||
          code === "PRECONDITION_FAILED" ||
          code === "INVALID_PARAMS"
        ) {
          throwIpcError(code, message);
        }
        throw err;
      });

    if (!isOwnerScopeCurrent(ownerScope)) return applied;
    for (const item of applied) {
      notifyAgentIslandSessionPatch(item.sessionId, {
        title: item.newTitle,
        workingDir: item.workingDir,
      });
      broadcastSessionPatched(
        item.sessionId,
        { title: item.newTitle },
        ownerScope,
      );
    }
    return applied;
  }

  /**
   * 批量归档 / 取消归档:把一组 session 的 status 置为 archived / active。
   *
   * 供 MCP 工具(archive_sessions / unarchive_sessions)调用,让 agent 能批量整理历史会话。
   *  - 原子写入:存在性预检 + 状态更新在 `sessions.setStatus` 事务里一把完成,任一 id 缺失
   *    整批回滚(全有才写,绝不半应用 —— 这点比逐个 patchSessionMetaInDb 更强)。
   *  - 事务提交成功后,再逐个 notifyAgentIslandSessionPatch + 广播 sessions:patched,与
   *    device-link 远程归档(patchSessionMetaInDb)同口径,sidebar / agent-island 即时收敛
   *    (归档移出 active 桶),无需刷新或重启。
   */
  async function setSessionsStatusInDb(
    sessionIds: string[],
    status: "active" | "archived",
    beforeMutation?: () => Promise<void>,
  ): Promise<SessionStatusChangeRow[]> {
    if (sessionIds.length === 0) return [];
    const ownerScope = captureOwnerScope();
    const dbClient = getDbClient();
    const applied = await withSessionRouteLocks(sessionIds, async () => {
      const resources: string[] = [];
      const perSession = new Map<string, string[]>();
      for (const id of sessionIds) {
        const paths = await readSessionWorktreeResources(dbClient.drizzle, id);
        perSession.set(id, paths);
        resources.push(...paths);
      }
      const physicalResources = await Promise.all(
        [...new Set(resources)].map(physicalWorktreeKey),
      );
      return withWorktreeMutation(resources, async () => {
        if (status === "archived") {
          for (const id of sessionIds) {
            await beforeMutation?.();
            await requestWorktreeRecycle(id, perSession.get(id));
          }
        }
        await beforeMutation?.();
        const rows = await dbClient
          .tx(
            "sessions.setStatus",
            status === "archived"
              ? { sessionIds, status, closeSharedTasks: true }
              : { sessionIds, status },
          )
          .catch((err) => {
            const code = (err as { code?: string }).code;
            const message = err instanceof Error ? err.message : String(err);
            if (
              code === "NOT_FOUND" ||
              code === "INVALID_PARAMS" ||
              code === "PRECONDITION_FAILED"
            ) {
              throwIpcError(code, message);
            }
            throw err;
          });
        for (const item of rows) {
          cleanupSessionRuntimeForTerminalStatus(item.sessionId, item.status);
          if (item.status === "archived") {
            const { closeSharedTaskForTask } = await host.loadSharedTasks();
            await closeSharedTaskForTask(item.sessionId, dbClient);
          }
        }
        for (const resource of physicalResources)
          notifyWorktreeRecycleOpportunity(resource);
        return rows;
      });
    });
    for (const item of applied) {
      compactTerminalSessionToolResults(dbClient, item.sessionId, item.status);
    }
    if (!isOwnerScopeCurrent(ownerScope))
      return applied.map((item) => ({
        sessionId: item.sessionId,
        title: item.title,
        workingDir: item.workingDir,
        status: item.status,
      }));
    for (const item of applied) {
      notifyAgentIslandSessionPatch(item.sessionId, {
        status: item.status,
        title: item.title,
        workingDir: item.workingDir,
        workspaceKind: item.workspaceKind,
      });
      broadcastSessionPatched(
        item.sessionId,
        { status: item.status },
        ownerScope,
      );
      scheduleWorktreeRecycleForStatusChange(item.sessionId, item.status, {
        ownerScope,
        mediaDb: dbClient.drizzle,
      });
      notifyGhostSessionStatusChange(
        item.sessionId,
        item.status,
        item.workingDir,
      );
      cleanupSessionTerminalArtifacts(item.sessionId, item.status);
    }
    return applied.map((item) => ({
      sessionId: item.sessionId,
      title: item.title,
      workingDir: item.workingDir,
      status: item.status,
    }));
  }

  const piSubagentCleanupTimers = new Map<string, NodeJS.Timeout>();
  const piSubagentCleanupEpoch = new Map<string, number>();
  const piSubagentCleanupWork = new Set<Promise<void>>();
  let piSubagentCleanupStopped = false;
  /** Longer than the adapter's own close budget, so a normal close is never cut short. */
  const PI_SUBAGENT_CLEANUP_CLOSE_TIMEOUT_MS = 15_000;

  function piSubagentCleanupCurrentEpoch(sessionId: string): number {
    return piSubagentCleanupEpoch.get(sessionId) ?? 0;
  }

  function cancelDeletedPiSubagentCleanupImpl(sessionId: string): void {
    piSubagentCleanupEpoch.set(
      sessionId,
      piSubagentCleanupCurrentEpoch(sessionId) + 1,
    );
    const timer = piSubagentCleanupTimers.get(sessionId);
    if (!timer) return;
    clearTimeout(timer);
    piSubagentCleanupTimers.delete(sessionId);
  }

  bindDeletedPiSubagentCleanupCancel(cancelDeletedPiSubagentCleanupImpl);

  /**
   * Detach Bot-owned tasks before the owning Profile is permanently removed.
   * Kept transcripts become ordinary archived tasks; discarded transcripts
   * become ordinary deleted tombstones so no inaccessible source=bot orphan is
   * left after the Bot FK graph is cascaded away.
   */
  async function deleteBotProfileAndDetachSessionsInDb(
    botId: string,
    sessionIds: string[],
    keepTaskHistory: boolean,
  ): Promise<void> {
    const ids = [...new Set(sessionIds)];
    const ownerScope = captureOwnerScope();
    const dbClient = getDbClient();
    const db = dbClient.drizzle;
    const commitDeletion = () =>
      commitBotProfileDeletion({
        botId,
        sessionIds: ids,
        keepTaskHistory,
      });
    const prepared: SharedTaskClosurePreparation[] = [];
    let committedStatus = false;
    let committedResult: Awaited<ReturnType<typeof commitBotProfileDeletion>>;
    try {
      for (const id of ids) {
        const closure = await prepareSharedTaskClosure(id, dbClient);
        if (closure) prepared.push(closure);
      }
      committedResult =
        ids.length > 0
          ? await withSessionRouteLocks(ids, commitDeletion)
          : await commitDeletion();
      committedStatus = true;
    } catch (error) {
      if (!committedStatus) {
        for (const closure of prepared)
          await rollbackSharedTaskClosure(dbClient, closure);
      }
      throw error;
    }
    const committed = committedResult;
    const status = committed.status;
    const committedSessionIds = [...new Set(committed.sessionIds)];

    for (const closure of prepared)
      await finalizeSharedTaskClosure(dbClient, closure);

    // Bot profile deletion commits terminal task status through a dedicated
    // transaction, so it bypasses the ordinary session patch/status writers.
    // Close the corresponding shared task only after that durable transition;
    // closeSharedTaskForTask journals network failures and never revives the task.
    if (committedSessionIds.length > 0) {
      const { closeSharedTaskForTask } = await host.loadSharedTasks();
      for (const id of committedSessionIds)
        await closeSharedTaskForTask(id, dbClient);
    }

    for (const id of committedSessionIds) {
      if (status === "deleted" && isOwnerScopeCurrent(ownerScope)) {
        clearSessionAttention(id, "explicit");
      }
      notifyAgentIslandSessionPatch(id, { status });
      broadcastSessionPatched(id, { status, source: "desktop" }, ownerScope);
      notifyGhostSessionStatusChange(id, status, null);
      removeHookAttachmentDir(id, status);
      if (status === "deleted") {
        void imageCacheStore.removeSession(id).catch((error) => {
          log.warn("Bot task image cleanup failed", {
            sessionId: id,
            error: String(error),
          });
        });
        void removeImAttachmentsIfStillDeleted(id).catch((error) => {
          log.warn("Bot task attachment cleanup failed", {
            sessionId: id,
            error: String(error),
          });
        });
        void removeDeletedSessionMediaRefs(id, db).catch((error) => {
          log.warn("Bot task media cleanup failed", {
            sessionId: id,
            error: String(error),
          });
        });
      }
    }
  }

  /**
   * hook 入站附件目录回收(fire-and-forget): deleted/archived 都是终态,
   * 文件在 turn 送出后即无用。所有把 session 置为终态的路径都应调用。
   */
  function removeHookAttachmentDir(sessionId: string, status: unknown): void {
    if (status === "deleted")
      void recoverGeneratedImagesForHistory(sessionId).catch(() => undefined);
    if (status !== "deleted" && status !== "archived") return;
    if (status === "deleted") {
      void removeTurnChangeSetsForSession(sessionId).catch((err) => {
        log.warn("turn change-set cleanup failed", {
          sessionId,
          err: err instanceof Error ? err.message : String(err),
        });
      });
    }
    const attachRoot = path.join(host.userDataDirectory(), "hook-attachments");
    const attachDir = path.join(attachRoot, sessionId);
    if (!attachDir.startsWith(attachRoot + path.sep)) return;
    void fs.rm(attachDir, { recursive: true, force: true }).catch((err) => {
      log.warn("hook attachment dir cleanup failed", {
        sessionId,
        err: err instanceof Error ? err.message : String(err),
      });
    });
  }

  /**
   * Can this parent task still start a durable Subagent?
   *
   * Only one thing can: the `cindy-subagent` extension, which exists solely
   * inside the parent PI process. `stopAndRemovePiSubagentRuns` finishes by
   * scanning for an empty run root and deleting it — so if the parent is still
   * alive, a launch entering after that scan recreates the root and spawns a
   * detached runner, on the deleted task's inherited provider credentials, with
   * the cleanup already reporting success and its retry timer discarded. The
   * publish-intent-first protocol makes the converse true: a launch that started
   * before the parent died has already written its `queued` status, so the scan
   * sees it and stops it.
   *
   * This function only proves the launcher in *this* process stopped. Other
   * supported instances share userData, so a parent PI elsewhere can still be
   * alive; the per-session tombstone written before the scan is what stops those
   * launches. Not the host-level launch fence: that one blocks *every* session
   * for the duration, and this is one deleted task's cleanup.
   *
   * `closeSession` is idempotent and is issued here rather than waited for
   * elsewhere: the worktree recycle path also closes the session, but the two are
   * unordered and its close is best-effort, so waiting on it could mean waiting
   * forever. It resolves only after `proc.close()` confirms the PI process exited
   * (adapter contract); if the close failed the session is left in `error`, which
   * `isSessionAlive` still reports as alive — so the recheck below stays
   * conservative by construction.
   */
  async function piSubagentLauncherProvenStopped(
    sessionId: string,
  ): Promise<boolean> {
    let maker: ReturnType<
      Awaited<
        ReturnType<SessionServiceHost<InvokeEvent>["loadMaker"]>
      >["getMakerIfReady"]
    >;
    try {
      // Dynamic, like every other maker-host use here: localDb must not take a
      // static edge on it.
      const mh = await host.loadMaker();
      maker = mh.getMakerIfReady();
    } catch (err) {
      // Unable to ask is not permission to proceed.
      log.warn("PI Subagent cleanup could not reach the Maker host", {
        sessionId,
        err: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
    // Nothing loaded in *this* process. Another instance sharing userData may
    // still have the parent PI alive; the deleted-task tombstone (written before
    // this function is used as a scan gate) is what stops its launches. Returning
    // true here only means there is no local launcher left to close.
    if (!maker) return true;
    if (!maker.isSessionAlive(sessionId)) return true;
    const closing = maker.closeSession(sessionId).catch((err: unknown) => {
      log.warn("PI Subagent cleanup close of the deleted parent task failed", {
        sessionId,
        err: err instanceof Error ? err.message : String(err),
      });
    });
    // Bounded. `closeSession` has no deadline of its own, and this path used to
    // await nothing unbounded: a wedged close would otherwise park this attempt
    // forever, and with it the retry that is supposed to keep trying. Giving up
    // returns "not proven stopped", so the backoff re-enters — and `Session.close`
    // hands back the same in-flight promise, so no second close is issued.
    let deadline: NodeJS.Timeout | undefined;
    const closed = await Promise.race([
      closing.then(() => true),
      new Promise<boolean>((resolve) => {
        deadline = setTimeout(
          () => resolve(false),
          PI_SUBAGENT_CLEANUP_CLOSE_TIMEOUT_MS,
        );
        deadline.unref?.();
      }),
    ]).finally(() => {
      if (deadline) clearTimeout(deadline);
    });
    if (!closed) {
      log.warn(
        "PI Subagent cleanup timed out closing the deleted parent task",
        { sessionId },
      );
      return false;
    }
    return !maker.isSessionAlive(sessionId);
  }

  function scheduleDeletedPiSubagentCleanup(
    sessionId: string,
    attempt = 0,
  ): void {
    if (piSubagentCleanupStopped || piSubagentCleanupTimers.has(sessionId)) return;
    const epoch = piSubagentCleanupCurrentEpoch(sessionId);
    const marker = setTimeout(() => undefined, 0);
    marker.unref?.();
    piSubagentCleanupTimers.set(sessionId, marker);
    const work = (async () => {
      const agentHome = host.piAgentHomeForSession(sessionId);
      const superseded = (): boolean =>
        piSubagentCleanupCurrentEpoch(sessionId) !== epoch;
      try {
        if (piSubagentCleanupStopped || superseded()) return;
        // Tombstone first, before asking whether *this* process still has a
        // launcher. Dev, packaged and --passive instances share userData, so a
        // parent PI in another process can still spawn after our local Maker
        // reports the task unloaded. The in-Pi launcher reads this marker after
        // publishing queued and before spawn — same opposite-order protocol as
        // the launch fence. Without it, stopAndRemove deleting an empty root is
        // not a proof.
        try {
          await writePiSubagentDeletedTombstone(agentHome, sessionId);
        } catch (err) {
          log.warn(
            "PI Subagent cleanup could not write the deleted-task tombstone",
            {
              sessionId,
              err: err instanceof Error ? err.message : String(err),
            },
          );
          throw err;
        }
        if (piSubagentCleanupStopped) return;
        if (superseded()) {
          await clearPiSubagentDeletedTombstone(agentHome, sessionId);
          return;
        }
        // Every attempt, not just the first: the parent may still have been alive
        // when an earlier one gave up, and this is the only thing standing
        // between the conclusive scan and a launch that outruns it.
        if (await piSubagentLauncherProvenStopped(sessionId)) {
          if (piSubagentCleanupStopped) return;
          if (superseded()) {
            await clearPiSubagentDeletedTombstone(agentHome, sessionId);
            return;
          }
          const removed = await stopAndRemovePiSubagentRuns(
            piSubagentRunRoot(agentHome, sessionId),
          );
          if (removed) {
            piSubagentCleanupTimers.delete(sessionId);
            return;
          }
        } else {
          log.warn(
            "PI Subagent cleanup deferred: the deleted parent task is still running",
            {
              sessionId,
              attempt,
            },
          );
        }
      } catch (err) {
        log.warn("PI Subagent cleanup attempt failed", {
          sessionId,
          err: err instanceof Error ? err.message : String(err),
        });
      }
      if (piSubagentCleanupStopped || superseded()) return;
      const delayMs = Math.min(60_000, 1_000 * 2 ** Math.min(attempt, 6));
      const timer = setTimeout(() => {
        piSubagentCleanupTimers.delete(sessionId);
        scheduleDeletedPiSubagentCleanup(sessionId, attempt + 1);
      }, delayMs);
      timer.unref?.();
      piSubagentCleanupTimers.set(sessionId, timer);
    })();
    piSubagentCleanupWork.add(work);
    void work.finally(() => piSubagentCleanupWork.delete(work)).catch(() => undefined);
  }

  async function resumeDeletedPiSubagentCleanup(): Promise<void> {
    let idsFromDisk: string[] = [];
    for (const agentHome of await host.piSubagentRunHomes()) {
      const parentRoot = path.join(agentHome, "runtime", "pi-subagent-runs");
      try {
        const entries = await fs.readdir(parentRoot, { withFileTypes: true });
        idsFromDisk.push(...entries.filter(entry => entry.isDirectory() && entry.name && !/[\\/\0]/.test(entry.name)).map(entry => entry.name));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    }
    idsFromDisk = [...new Set(idsFromDisk)];

    const db = getDbClient().drizzle;
    // Deleted PI parents must get a tombstone even when they never grew a run
    // root. Crash between the delete commit and the fire-and-forget write would
    // otherwise leave another shared-userData process free to launch later.
    const deletedPi = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(and(eq(sessions.status, "deleted"), eq(sessions.agentKind, "pi")));

    const diskDeleted =
      idsFromDisk.length === 0
        ? []
        : await db
            .select({ id: sessions.id })
            .from(sessions)
            .where(
              and(
                inArray(sessions.id, idsFromDisk),
                eq(sessions.status, "deleted"),
              ),
            );

    const ids = new Set<string>();
    for (const row of deletedPi) ids.add(row.id);
    for (const row of diskDeleted) ids.add(row.id);
    for (const id of ids) scheduleDeletedPiSubagentCleanup(id);
  }

  async function stopDeletedPiSubagentCleanup(): Promise<void> {
    piSubagentCleanupStopped = true;
    for (const timer of piSubagentCleanupTimers.values()) clearTimeout(timer);
    piSubagentCleanupTimers.clear();
    // Keep durable deletion markers. Stopping the owner is not an IM revival.
    await Promise.allSettled(piSubagentCleanupWork);
  }

  /**
   * Terminal task artifact cleanup. Archive only removes one-shot hook files;
   * delete additionally stops and removes detached PI Subagents owned by the
   * parent task. All status writers must pass through this helper.
   */
  /**
   * 个人 IM 附件目录的删除清理是异步的, 两类后到事件都不能让它删错:
   *   - 同账号内, 确定性 IM 任务删除后再来消息会把同一 session id 原地复活并往同一目录
   *     领养新附件 —— 在路由锁内复查任务仍是 deleted(行不存在也算)再删, 复活就保留;
   *     读库失败按保留处理(宁可多留不可误删);
   *   - 删除后切换账号, 另一账号可能有同 id 的任务 —— 目录根与账号作用域都在发起删除时
   *     同步捕获: 只删发起账号自己的目录; 账号已切走时发起账号的任务不可能再被复活,
   *     不再读(新账号的)库, 直接按捕获的根目录清理。
   * 本函数须在发起删除的同步上下文里调用(捕获发生在第一个 await 之前)。
   */
  function removeImAttachmentsIfStillDeleted(sessionId: string): Promise<void> {
    const ownerScope = captureOwnerScope();
    const root = imAttachmentsRoot();
    return withSessionRouteLock(sessionId, async () => {
      if (isOwnerScopeCurrent(ownerScope)) {
        let row: SessionRowSnapshot | null;
        try {
          row = await getSessionRowSnapshotStrict(sessionId);
        } catch {
          return;
        }
        if (row && row.status !== "deleted") return;
      }
      await removeImSessionAttachmentDirs(sessionId, root);
    });
  }

  function cleanupSessionTerminalArtifacts(
    sessionId: string,
    status: unknown,
  ): void {
    if (status !== "deleted" && status !== "archived") return;
    if (status === "deleted") {
      void removeTurnChangeSetsForSession(sessionId).catch((err) => {
        log.warn("turn change-set cleanup failed", {
          sessionId,
          err: err instanceof Error ? err.message : String(err),
        });
      });
      scheduleDeletedPiSubagentCleanup(sessionId);
      // 个人 IM 渠道(含微信)入站文件随任务删除清理 —— 归档保留, 与微信既有口径一致。
      void removeImAttachmentsIfStillDeleted(sessionId).catch((err) => {
        log.warn("IM session attachment cleanup failed", {
          sessionId,
          err: err instanceof Error ? err.message : String(err),
        });
      });
    }
    const attachRoot = path.join(host.userDataDirectory(), "hook-attachments");
    const attachDir = path.join(attachRoot, sessionId);
    if (!attachDir.startsWith(attachRoot + path.sep)) return;
    void fs.rm(attachDir, { recursive: true, force: true }).catch((err) => {
      log.warn("hook attachment dir cleanup failed", {
        sessionId,
        err: err instanceof Error ? err.message : String(err),
      });
    });
  }

  const pendingSessionListProjectionBackfill = new Map<
    string,
    SessionListProjectionBackfillItem
  >();
  let sessionListProjectionBackfillInFlight = false;

  /**
   * list 算出来的 preview / count 异步写回 sessions。
   * 必须合成一次 RPC：首屏 1000 行每人两条 drizzle UPDATE 会打爆 worker 队列
   * （inFlight=128 queued=512）。两次 list 交错时也先攒进同一批。
   */
  function scheduleSessionListProjectionBackfill(
    rows: readonly SessionListRow[],
  ): void {
    for (const row of rows) {
      const sessionId = row.session.id;
      const item = pendingSessionListProjectionBackfill.get(sessionId) ?? {
        id: sessionId,
      };
      if (row.session.listPreview == null && row.latestMessageExtract != null) {
        const preview = finalizePlainPreview(
          row.latestMessageExtract,
          row.latestMessageRole,
        );
        if (preview != null) {
          item.preview = preview;
          item.role = row.latestMessageRole;
        }
      }
      if (row.session.listMessageCount == null) {
        item.count = row.messageCount;
      }
      if (item.preview !== undefined || item.count !== undefined) {
        pendingSessionListProjectionBackfill.set(sessionId, item);
      }
    }
    void drainSessionListProjectionBackfill();
  }

  async function drainSessionListProjectionBackfill(): Promise<void> {
    if (sessionListProjectionBackfillInFlight) return;
    if (pendingSessionListProjectionBackfill.size === 0) return;
    sessionListProjectionBackfillInFlight = true;
    try {
      while (pendingSessionListProjectionBackfill.size > 0) {
        const items = Array.from(pendingSessionListProjectionBackfill.values());
        pendingSessionListProjectionBackfill.clear();
        try {
          await persistSessionListProjectionBatch(items);
        } catch (err) {
          log.warn("session list projection backfill failed", {
            count: items.length,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } finally {
      sessionListProjectionBackfillInFlight = false;
      if (pendingSessionListProjectionBackfill.size > 0) {
        void drainSessionListProjectionBackfill();
      }
    }
  }

  /** 用量历史专用行查询：全量读取 sessions，但跳过 sidebar 的消息预览子查询。 */
  function selectSessionUsageRows(
    db: DbClient["drizzle"],
    where: SQL | undefined,
  ): Promise<
    Array<
      Pick<
        typeof sessions.$inferSelect,
        | "id"
        | "title"
        | "model"
        | "providerId"
        | "totalTokenUsage"
        | "contextTokens"
        | "contextWindow"
        | "contextWindowRuntime"
        | "agentKind"
        | "userSendAt"
        | "updatedAt"
      >
    >
  > {
    return db
      .select({
        id: sessions.id,
        title: sessions.title,
        model: sessions.model,
        providerId: sessions.providerId,
        totalTokenUsage: sessions.totalTokenUsage,
        contextTokens: sessions.contextTokens,
        contextWindow: sessions.contextWindow,
        contextWindowRuntime: sessions.contextWindowRuntime,
        agentKind: sessions.agentKind,
        userSendAt: sessions.userSendAt,
        updatedAt: sessions.updatedAt,
      })
      .from(sessions)
      .where(where)
      .orderBy(desc(sessions.updatedAt))
      .then((rows) => rows);
  }

  function clampLimit(raw: unknown, fallback: number): number {
    const n = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return Math.min(Math.max(Math.floor(n), 1), MAX_LIMIT);
  }

  function shouldIncludePinnedSessions(options: unknown): boolean {
    return !!(
      options &&
      typeof options === "object" &&
      (options as { includePinned?: unknown }).includePinned === true
    );
  }

  function shouldBypassSessionListSingleFlight(options: unknown): boolean {
    return !!(
      options &&
      typeof options === "object" &&
      (options as { fresh?: unknown }).fresh === true
    );
  }

  function shouldUseUsageHistoryQuery(options: unknown): boolean {
    return !!(
      options &&
      typeof options === "object" &&
      (options as { usageHistory?: unknown }).usageHistory === true
    );
  }

  function mergeSessionListRows<T extends { session: { id: string } }>(
    recentRows: readonly T[],
    pinnedRows: readonly T[],
  ): T[] {
    const seen = new Set<string>();
    const merged: T[] = [];
    for (const row of recentRows) {
      seen.add(row.session.id);
      merged.push(row);
    }
    for (const row of pinnedRows) {
      if (seen.has(row.session.id)) continue;
      seen.add(row.session.id);
      merged.push(row);
    }
    return merged;
  }

  /**
   * worktree-parallel-sessions: 把 sessions.worktree_path 同步到 DB（反范式快照）。
   * source of truth 是 worktreeStore（electron-store）；DB 字段仅为 sidebar 渲染优化。
   *
   * 故意不通过 sessions:update IPC 暴露——renderer 不应也不能直接改这个字段。
   * 仅由 main 侧 worktreeStore.set/delete 内部调用；worktreeStore.delete 不调本函数
   * （保留历史值，徽标按 store 是否存在判定）。
   *
   * 失败仅日志告警，不抛——store 是 source of truth，DB 只是快照，落败不阻塞主流程。
   */
  async function setWorktreePathInDb(
    sessionId: string,
    worktreePath: string | null,
  ): Promise<void> {
    try {
      const db = getDbClient().drizzle;
      await db
        .update(sessions)
        .set({ worktreePath })
        .where(eq(sessions.id, sessionId));
    } catch (err) {
      log.warn(
        `[localDb] setWorktreePathInDb failed for ${sessionId}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  /**
   * 无人值守建会话(hook 等)把显式选定的来源(供应商)落 sessions.provider_id。
   *
   * 背景: DesktopSessionStorage.create() 的 INSERT 字段清单不含 provider_id
   * (SessionMeta 接口没有 provider 字段, 该列由 SET_MODEL 回流 / 各无人值守
   * 入口自行补写), 不补的话会话来源恒为 NULL —— 聊天里打开时来源 picker 显示
   * 默认来源、冷 resume 时 register 的 hydrate funnel 读不到用户设置的来源。
   * 与 scheduler 的 backfillSessionMeta({providerId}) 同语义, 但只动这一列,
   * 不碰 hook v1 刻意保留默认值的 permission_mode / source; updatedAt 也不
   * bump(时间轴推进由同流程的 touchUserSendInDb 负责)。
   *
   * 失败仅日志告警, 不抛 —— 运行时路由以 session-provider-store 为准, DB 是
   * 持久化快照, 落败不阻塞 turn 主流程。
   */
  async function setSessionProviderIdInDb(
    sessionId: string,
    providerId: string,
  ): Promise<void> {
    try {
      const db = getDbClient().drizzle;
      await db
        .update(sessions)
        .set({ providerId })
        .where(eq(sessions.id, sessionId));
    } catch (err) {
      log.warn(
        `[localDb] setSessionProviderIdInDb failed for ${sessionId}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  /** Persist the provider-facing source for a newly-created shared IM session. */
  async function setSessionSourceInDb(
    sessionId: string,
    source: "telegram" | "x",
  ): Promise<void> {
    try {
      const db = getDbClient().drizzle;
      await db
        .update(sessions)
        .set({ source })
        .where(eq(sessions.id, sessionId));
    } catch (err) {
      log.warn(
        `[localDb] setSessionSourceInDb failed for ${sessionId}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  return {
    setSessionWorktreeBindingLookup,
    setSessionWorktreeRecycle,
    requestSessionWorktreeRecycle,
    captureSessionRecycleScope,
    recycleSessionWorktreeForStatusChange,
    flushSessionWorktreeRecycle: () => queueSessionWorktreeRecycle(async () => {}),
    scheduleWorktreeRecycleForStatusChange,
    applyAgentSwitchToSessionRow,
    applyAgentSwitchResumeFallbackAtomically,
    persistSessionPermissionModeIfAuto,
    persistSessionFields,
    commitProvisionalSession,
    discardProvisionalSessionRow,
    setOnUserSessionTitleWritten,
    getOverwritableAutoTitle,
    isUntitledSessionAwaitingAutoTitle,
    persistSessionTitleIfStillDraft,
    clearSessionContextInDb,
    registerSessionIpc,
    updateSessionInDb,
    restoreArchivedSessionForSend,
    patchSessionMetaInDb,
    renameSessionTitlesInDb,
    setSessionsStatusInDb,
    deleteBotProfileAndDetachSessionsInDb,
    resumeDeletedPiSubagentCleanup,
    stopDeletedPiSubagentCleanup,
    setWorktreePathInDb,
    setSessionProviderIdInDb,
    setSessionSourceInDb,
    createSessionRemoteHostIdReader,
    getSessionRowSnapshotStrict,
    getSessionRowSnapshot,
    getSessionFsSnapshot,
    broadcastSessionPatched,
    touchUserSendInDb,
    setSessionRuntimeCleanup,
  };
}
