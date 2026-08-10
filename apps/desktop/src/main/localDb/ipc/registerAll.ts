/**
 * chat-data-localization F2/F5：聚合注册所有 localDb IPC handlers + ensure-ready。
 *
 * 在 main 进程 `app.whenReady()` 后调用一次。
 *
 * 退出钩子：本文件**不**再注册——干净退出快照与 `closeDb` 由 main/index.ts 通过
 * lifecycle 统一编排（避免与 feishuBot.dispose 等其它清理 race）。
 */

import { ipcMain } from 'electron';

import { closeDb, ensureReady, getCurrentUserId } from '../index';
import { getCurrentDbClientUserId } from '../client/current';
import { registerSessionIpc } from './sessions';
import { registerMessageIpc } from './messages';
import { registerOrcaWorkflowIpc } from './orcaTeams';
import { registerSessionImportIpc } from './session-import';
import { registerSessionShareIpc } from './session-share';
import { registerRecentWorkdirsIpc } from './recentWorkdirs';
import { registerProjectAliasesIpc } from './projectAliases';
import { registerRightSidebarTabsIpc } from './rightSidebarTabs';
import { registerSubagentRunsIpc } from './subagentRuns';
import { registerDevSqliteVecIpc } from './dev/sqliteVec';
import { registerSearchIpc } from './search';
import { registerRemoteHistoryIpc } from './history';

import { createLogger } from '../../logger';
import { recordDesktopDevLocalDbStartupResult } from '../../devStartupStatus';
import { createOwnerEnsureCoordinator } from './ownerEnsureCoordinator';

const log = createLogger('registerAll');

export interface RegisterLocalDbIpcOpts {
  /** Current stable app-session owner. False makes queued/in-flight work stale. */
  isOwnerCurrent?: (userId: string) => boolean;
  /** Dispose any secondary DB client committed by a stale onReady callback. */
  discardStaleOwner?: (userId: string) => void | Promise<void>;
  /** ensureReady 打开/创建目标库前执行；失败时阻断，避免跳过认领后创建空库。 */
  beforeEnsureReady?: (userId: string) => void | Promise<void>;
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
  const runEnsureReady = createOwnerEnsureCoordinator({
    isOwnerCurrent: opts.isOwnerCurrent ?? (() => true),
    beforeEnsureReady: opts.beforeEnsureReady,
    ensureReady,
    onReady: opts.onReady,
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
  ipcMain.handle('local-db:ensure-ready', async (_e, userId: unknown) => {
    const startedAt = performance.now();
    log.info(
      JSON.stringify({
        event: 'localDb.ipc.ensure-ready.recv',
        userId: typeof userId === 'string' ? userId : `<${typeof userId}>`,
      }),
    );
    if (typeof userId !== 'string' || !userId) {
      log.warn(
        JSON.stringify({
          event: 'localDb.ipc.ensure-ready.reject',
          reason: 'invalid userId',
        }),
      );
      const result = {
        ready: false,
        error: { code: 'DB_INIT_FAILED', message: 'invalid userId' },
      } as const;
      recordDesktopDevLocalDbStartupResult(result);
      return result;
    }
    let result;
    try {
      result = await runEnsureReady(userId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(JSON.stringify({
        event: 'localDb.ipc.ensure-ready.failed',
        userId,
        error: message,
      }));
      result = {
        ready: false,
        error: { code: 'DB_INIT_FAILED', message },
      } as const;
    }
    recordDesktopDevLocalDbStartupResult(result);
    log.info(
      JSON.stringify({
        event: 'localDb.ipc.ensure-ready.done',
        userId,
        ready: result.ready,
        elapsedMs: Math.round(performance.now() - startedAt),
        ...(result.ready ? {} : { error: result.error }),
      }),
    );
    return result;
  });

  registerSessionIpc(getCurrentDbClientUserId);
  registerMessageIpc();
  registerRemoteHistoryIpc();
  registerSessionImportIpc();
  registerSessionShareIpc();
  registerOrcaWorkflowIpc();
  registerRecentWorkdirsIpc();
  registerProjectAliasesIpc();
  registerRightSidebarTabsIpc();
  registerSubagentRunsIpc();
  registerSearchIpc();
  registerDevSqliteVecIpc();
}
