import { registerCompanionImport } from '../../bot-import/registration.js';
import { registerTaskTagsIpc } from './taskTags';
import { registerRoutineRemoteResources } from '../../routines/remote.js';
import { registerRoutinesIpc } from '../../routines/service.js';
import { registerNightlyLearningIpc } from '../../routines/nightlyLearningIpc.js';
/**
 * chat-data-localization F2/F5：聚合注册所有 localDb IPC handlers + ensure-ready。
 *
 * 在 main 进程 `app.whenReady()` 后调用一次。
 *
 * 退出钩子：本文件**不**再注册——干净退出快照与 `closeDb` 由 main/index.ts 通过
 * lifecycle 统一编排（避免与 feishuBot.dispose 等其它清理 race）。
 */

import { app, ipcMain } from 'electron';
import path from 'node:path';

import { closeDb, ensureReady, getCurrentUserId } from '../index';
import { getCurrentDbClientUserId, tryGetDbClient } from '../client/current';
import {
  registerSessionIpc,
  type RegisterSessionIpcOpts,
  setSessionWorktreeBindingLookup,
  setSessionWorktreeRecycle,
} from './sessions';
import { registerMessageIpc } from './messages';
import { registerOrcaWorkflowIpc } from './orcaTeams';
import { registerSessionImportIpc } from '../../session-import/ipc';
import { registerSessionShareIpc } from './session-share';
import { registerRecentWorkdirsIpc } from './recentWorkdirs';
import { registerProjectAliasesIpc } from './projectAliases';
import { registerRightSidebarTabsIpc } from './rightSidebarTabs';
import { registerSubagentRunsIpc } from './subagentRuns';
import { enqueueDurableWrite } from '../../messagePersistBroadcaster';
import { registerDevSqliteVecIpc } from './dev/sqliteVec';
import { registerSearchIpc } from './search';
import { registerRemoteHistoryIpc } from './history';
import { registerHistoryQueryIpc } from './historyQuery';
import { recoverActiveTeammateInvitations, registerBotIpc } from './bots';
import { botRemoteManagement } from './botRemoteManagement';
import { registerBotRemoteResourceProvider } from './botRemoteResourceProvider';

import { createLogger } from '../../logger';
import { recordDesktopDevLocalDbStartupResult } from '../../devStartupStatus';
import { createOwnerEnsureCoordinator } from './ownerEnsureCoordinator';
import { replyToEnsureReady, type EnsureReadyReply } from '../ensureReadyReply.js';
import { reconcileSessionMediaRefsForDeletedSessions } from '../../cindy-media/sessionCleanup';
import { reconcileGeneratedImageRecovery } from '../../cindy-media/generatedImageRecovery';
import { reconcileMediaRefCompensationsForOwner } from '../../cindy-media/refCompensationJournal';
import { setSessionRouteLockImplementation } from '../sessionRouteLock';
import { LOCAL_DATA_OWNER_ID } from '../../appSessionState';
import { ensureDialogueWorkspaceDir } from '../dialogueWorkspace';
import { isUiMockDataEnabled, seedUiMockData } from '../uiMockSeed';

const log = createLogger('registerAll');
const MEDIA_REF_COMPENSATION_BUSY_RETRY_MS = 12_000;

function startMediaRefCompensationReconcile(
  userId: string,
  client: NonNullable<ReturnType<typeof tryGetDbClient>>,
  isOwnerCurrent: () => boolean,
): void {
  const run = async (allowBusyRetry: boolean): Promise<void> => {
    if (!isOwnerCurrent()) return;
    const result = await reconcileMediaRefCompensationsForOwner({
      ownerId: userId,
      db: client.drizzle,
      isOwnerCurrent,
    });
    if (!allowBusyRetry || result.busy === 0 || !isOwnerCurrent()) return;
    const retry = setTimeout(() => {
      void run(false).catch((error) => {
        log.warn('delayed media reference compensation reconcile failed', {
          userId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, MEDIA_REF_COMPENSATION_BUSY_RETRY_MS);
    retry.unref?.();
  };
  void reconcileGeneratedImageRecovery().catch(() => log.warn('native image cleanup reconciliation deferred'));
  void run(true).catch((error) => {
    log.warn('media reference compensation reconcile failed', {
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

export interface RegisterLocalDbIpcOpts {
  isSessionTurnPendingCompletion?: (sessionId: string) => boolean;
  readHistoryLiveMessages?: (sessionId: string) => import('../../../renderer/lib/ccAgent.types').Message[];
  resolveContextWindow?: RegisterSessionIpcOpts['resolveContextWindow'];
  /** Current stable app-session owner. False makes queued/in-flight work stale. */
  isOwnerCurrent?: (userId: string) => boolean;
  /** Dispose any secondary DB client committed by a stale onReady callback. */
  discardStaleOwner?: (userId: string) => void | Promise<void>;
  /** ensureReady 打开/创建目标库前执行；失败时阻断，避免跳过认领后创建空库。 */
  beforeEnsureReady?: (userId: string) => void | Promise<void>;
  /** Record worktree recycle intent before a terminal session status is persisted. */
  requestWorktreeRecycle?: (sessionId: string, resources?: readonly string[]) => Promise<void>;
  /** 当前 worktree 绑定（worktreeStore 是 source of truth，DB 只存反范式快照）。 */
  lookupSessionWorktreeBinding?: (sessionId: string) => string | null;
  /** Close a moved local Pi/Codex runtime after revalidating that its turn is idle. */
  closeIdleSessionForMove?: (sessionId: string) => Promise<boolean>;
  /** Apply a persisted task-level context window budget to the live runtime. */
  applyContextWindowBudget?: RegisterSessionIpcOpts['applyContextWindowBudget'];
  /** Serialize startup tombstone cleanup with task restore/start/send operations. */
  withSessionLock?: <T>(sessionId: string, task: () => Promise<T>) => Promise<T>;
  /**
   * Is the parent task currently loaded as a live PI session? Decides whether a
   * finished durable Subagent may still advertise `resume`, which the control
   * handler only accepts while that session exists.
   */
  isParentPiSessionLive?: (sessionId: string) => boolean;
  /**
   * 可选回调：localDb.ensureReady 成功（含已就绪复用路径）后触发。
   * 用途：启动依赖 localDb 的 host 单例（如 scheduler-host）。失败时协调器会
   * 丢弃已提交的 owner DB 并返回 DB_INIT_FAILED，允许 renderer 完整重试。
   *
   * 设计原因：scheduler-host 的 startScheduler 需要 localDb + maker 都 ready，
   * 二者就绪时序不固定（splash check-environment 走在 user login 前/后都可能）；
   * 在两个就绪事件源（registerMakerIpcsAfterSplash + 本回调）各调一次幂等的
   * startScheduler，谁后到谁负责真正启动。
   */
  onReady?: (userId: string) => void | Promise<void>;
}

export function registerLocalDbIpc(opts: RegisterLocalDbIpcOpts = {}): void {
  setSessionWorktreeRecycle(opts.requestWorktreeRecycle ?? null);
  setSessionWorktreeBindingLookup(opts.lookupSessionWorktreeBinding ?? null);
  setSessionRouteLockImplementation(opts.withSessionLock ?? null);
  const runEnsureReady = createOwnerEnsureCoordinator({
    isOwnerCurrent: opts.isOwnerCurrent ?? (() => true),
    beforeEnsureReady: opts.beforeEnsureReady,
    ensureReady,
    onReady: async (userId) => {
      await opts.onReady?.(userId);
      const client = tryGetDbClient();
      if (
        !client ||
        getCurrentDbClientUserId() !== userId ||
        !(opts.isOwnerCurrent?.(userId) ?? true)
      ) {
        return;
      }
      const isReadyOwnerCurrent = (): boolean =>
        tryGetDbClient() === client &&
        getCurrentDbClientUserId() === userId &&
        (opts.isOwnerCurrent?.(userId) ?? true);
      if (isUiMockDataEnabled() && userId === LOCAL_DATA_OWNER_ID) {
        // Dev `--mock` sandbox: seed before the renderer lists tasks. Never block startup.
        try {
          const added = await seedUiMockData({
            db: client.drizzle,
            projectRoot: path.join(app.getPath('userData'), 'ui-mock', 'projects'),
            dialogueDir: ensureDialogueWorkspaceDir,
          });
          log.info('ui mock data seeded', { added });
        } catch (error) {
          log.warn('ui mock data seed failed', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
        if (!isReadyOwnerCurrent()) return;
      }
      // Resume saved invitations after the database and account boundary are ready.
      await recoverActiveTeammateInvitations();
      if (!isReadyOwnerCurrent()) return;
      startMediaRefCompensationReconcile(userId, client, isReadyOwnerCurrent);
      const withSessionLock = opts.withSessionLock;
      const db = client.drizzle;
      void (async () => {
        if (!isReadyOwnerCurrent()) return;
        if (
          !isReadyOwnerCurrent() ||
          !withSessionLock
        ) {
          return;
        }
        await reconcileSessionMediaRefsForDeletedSessions({
          db,
          isOwnerCurrent: isReadyOwnerCurrent,
          withSessionLock,
        });
      })().catch((error) => {
        log.warn('deleted task media reconcile failed', {
          userId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    },
    onReadyError: (userId, err) => {
      log.warn(
        JSON.stringify({
          event: 'localDb.ipc.ensure-ready.onReady.failed',
          userId,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    },
    discardReadyOwner: async (userId) => {
      // The queue prevents a newer IPC ensure from starting first. Keep the
      // identity check for non-IPC callers so stale cleanup never closes them.
      if (getCurrentUserId() === userId) closeDb();
      await opts.discardStaleOwner?.(userId);
    },
  });
  ipcMain.handle('local-db:ensure-ready', (_e, userId: unknown) =>
    replyToEnsureReady(userId, {
      run: (id) => runEnsureReady(id) as Promise<EnsureReadyReply>,
      record: recordDesktopDevLocalDbStartupResult as (result: EnsureReadyReply) => void,
      log,
    }));

  registerSessionIpc(getCurrentDbClientUserId, {
    resolveContextWindow: opts.resolveContextWindow,
    closeIdleSessionForMove: opts.closeIdleSessionForMove,
    applyContextWindowBudget: opts.applyContextWindowBudget,
  });
  registerMessageIpc(opts.isSessionTurnPendingCompletion, opts.readHistoryLiveMessages);
  registerRemoteHistoryIpc();
  registerHistoryQueryIpc();
  registerBotIpc();
  registerCompanionImport();
  registerRoutinesIpc();
  registerNightlyLearningIpc();
  registerRoutineRemoteResources(botRemoteManagement);
  registerBotRemoteResourceProvider(botRemoteManagement);
  registerSessionImportIpc();
  registerSessionShareIpc();
  registerOrcaWorkflowIpc();
  registerRecentWorkdirsIpc();
  registerProjectAliasesIpc();
  registerTaskTagsIpc();
  registerRightSidebarTabsIpc();
  // Durable Subagent projection writes share the agent event path's FIFO, so a
  // reconciliation and an agent_task_update cannot both insert the first
  // sighting of the same run. Supplied here because the storage layer must not
  // import the broadcaster back (it already depends on localDb).
  registerSubagentRunsIpc({
    enqueueDurableWrite,
    // `resume` is a runtime capability, not a property of the stored run: the
    // handler needs the parent task loaded as a live PI session. Supplied from
    // the composition root so this layer never imports the Maker.
    ...(opts.isParentPiSessionLive ? { isParentPiSessionLive: opts.isParentPiSessionLive } : {}),
  });
  registerSearchIpc();
  registerDevSqliteVecIpc();
}
