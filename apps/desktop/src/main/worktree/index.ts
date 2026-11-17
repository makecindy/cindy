/**
 * worktree-parallel-sessions: 模块 barrel + IPC 注册。
 *
 * 在 main `index.ts` 的 IPC 注册阶段调用 `registerWorktreeIpc(ipcMain)`,
 * 常规 worktree:* channel 在此注册；通用删除路径**故意不暴露**。
 * 两步远程创建的窄补偿口由 maker-ipc 单独注册，并自行承担身份与 ownership 校验。
 */

import path from 'node:path';
import { createCheckoutHandler } from './checkoutHandler';
import type { CheckoutActivity } from './checkout';
import { readOriginDefaultBranch } from './branchSync';
import { createBranchSyncHandlers } from './branchSyncHandlers';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer';
import { getDeviceLinkInvokeContext, isDeviceLinkInvoke } from '../device-link/invoke-context';
import { isDesktopPlatform } from '../device-link/controllerPlatform';
import { getCurrentDbClientSnapshot } from '../localDb/client/current';

import { ipcMain as ipcMainType, type IpcMain, shell } from 'electron';
import * as WorktreeManager from './WorktreeManager';
import * as worktreeStore from './worktreeStore';
import { getWorktreeRestoreStatus, restoreWorktreeForSession } from './restore';
import { generateModelWorktreeName } from './modelName';
import { createLogger } from '../logger';
import { throwIpcError } from '../utils/ipcValidate';

const log = createLogger('worktree');

import type {
  CreateWorktreeReq,
  DetectCwdReq,
  ListBranchesReq,
  RevealReq,
  SuggestNameReq,
} from './types';

export * as WorktreeManager from './WorktreeManager';
export * as WorktreePool from './WorktreePool';
export * as worktreeStore from './worktreeStore';
export { resolveFreshSourceBranch, type FreshSourceResolution } from './freshBase';
export {
  recycleWorktreeForRemovedSession,
  reconcileWorktreesForDeletedSessions,
} from './sessionRemovalRecycle';
export { reconcilePendingSafeDirectoryCleanups } from './WorktreeManager';
export {
  getWorktreeRestoreStatus,
  getManagedWorktreeReadinessForSession,
  restoreMissingManagedWorktreeForSession,
  restoreWorktreeForSession,
  type WorktreeRestoreStatus,
  type WorktreeRestoreResult,
} from './restore';
export * from './types';

/**
 * 注册所有 worktree 相关 IPC handler。重复调用会抛(ipcMain 不允许重复 handle)——
 * 调用方保证只调一次。
 */
export function registerWorktreeIpc(
  ipcMain: IpcMain = ipcMainType,
  listActivity: () => Promise<CheckoutActivity[]> = async () => [],
): void {
  ipcMain.handle(
    'worktree:checkout',
    createCheckoutHandler({
      assertTrustedAppRendererEvent,
      isDeviceLinkInvoke,
      listActivity,
      getCallerScope: () => {
        const owner = getCurrentDbClientSnapshot();
        return owner
          ? JSON.stringify([
              owner.userId,
              owner.clientEpoch,
              getDeviceLinkInvokeContext()?.controllerDeviceId ?? 'local',
            ])
          : null;
      },
    }),
  );
  const branchSync = createBranchSyncHandlers({
    assertTrustedAppRendererEvent,
    isDeviceLinkInvoke,
    getCallerScope: () => {
      const owner = getCurrentDbClientSnapshot();
      return owner
        ? JSON.stringify([
            owner.userId,
            owner.clientEpoch,
            getDeviceLinkInvokeContext()?.controllerDeviceId ?? 'local',
          ])
        : null;
    },
  });
  ipcMain.handle('worktree:branch-sync-status', branchSync.status);
  ipcMain.handle('worktree:sync-branch', branchSync.sync);

  ipcMain.handle('worktree:create', (_e, req: CreateWorktreeReq) => {
    const context = getDeviceLinkInvokeContext();
    // Experience routing only: mobile/unknown controllers keep using their local ref.
    return WorktreeManager.createWorktree(req, {
      refreshDefaultSource: !context || isDesktopPlatform(context.controllerPlatform),
    });
  });

  ipcMain.handle('worktree:detect-cwd', async (_e, req: DetectCwdReq) => {
    try {
      return await WorktreeManager.detectCwd(req.cwd);
    } catch {
      // Keep probe failure distinct from a missing directory, without sending
      // raw Git output or internal paths across the IPC boundary.
      throwIpcError('INTERNAL', 'Worktree directory probe failed');
    }
  });

  ipcMain.handle('worktree:get-for-session', (_e, sessionId: string) =>
    WorktreeManager.getForSession(sessionId),
  );

  ipcMain.handle('worktree:list-all', () => WorktreeManager.listAll());

  ipcMain.handle('worktree:reveal', async (_e, req: RevealReq) => {
    if (!req?.path || typeof req.path !== 'string') {
      return {
        ok: false,
        error: { kind: 'unknown', message: 'invalid reveal request' },
      };
    }
    // 白名单校验: 只允许 reveal store 里登记过的 worktree 路径,
    // 防止 renderer 构造任意路径调起 shell.showItemInFolder 探测系统目录。
    const requested = path.resolve(req.path);
    const managed = worktreeStore
      .getAllPaths()
      .map((p) => path.resolve(p));
    if (!managed.includes(requested)) {
      return {
        ok: false,
        error: { kind: 'unknown', message: 'Path not in managed worktrees' },
      };
    }
    try {
      shell.showItemInFolder(requested);
      return { ok: true };
    } catch (err) {
      log.warn(
        'shell.showItemInFolder failed:',
        err instanceof Error ? err.message : String(err),
      );
      return {
        ok: false,
        error: {
          kind: 'unknown',
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
  });

  ipcMain.handle('worktree:suggest-name', async (_e, req: SuggestNameReq) => ({
    name: await WorktreeManager.suggestName(req.baseRepo),
  }));

  // Opt-in model-written name for a new task's worktree. Local renderer only: it spends
  // this computer's auxiliary model on the user's own first message. Remote creation gets
  // the name from the controlling computer and passes it as an ordinary explicit name.
  ipcMain.handle('worktree:generate-name', async (event, req: unknown) => {
    if (isDeviceLinkInvoke()) throwIpcError('PERMISSION_DENIED', 'worktree:generate-name is local only');
    assertTrustedAppRendererEvent(event);
    const taskText = (req as { taskText?: unknown } | null)?.taskText;
    if (typeof taskText !== 'string') return { name: null };
    // Loaded on demand: maker-host imports this module, a static import would be a cycle.
    const { requestAuxiliaryText } = await import('../maker-host/auxiliary-title-one-shot.js');
    const name = await generateModelWorktreeName(taskText, (args) => requestAuxiliaryText({
      ...args,
      // Only consulted by the session-agent fallback, which is off: a cold agent start
      // cannot finish inside the naming budget while the user waits.
      agentKind: 'claude-code',
      sessionAgentFallback: false,
    }));
    if (!name) log.info('model worktree name unavailable; keeping the generated name');
    return { name };
  });

  ipcMain.handle('worktree:list-branches', async (_e, req: ListBranchesReq) => {
    const branches = await WorktreeManager.listBranches(req.baseRepo);
    // Optional UI enrichment must never affect creation or the local branch list.
    const remoteDefaultBranch = await readOriginDefaultBranch(req.baseRepo).catch(() => undefined);
    return { ...branches, remoteDefaultBranch };
  });

  // ── P1: 删除确认预检 + 回收后恢复 ──────────────────────────────────────────
  // removal-preview 是只读查询，允许 device-link 控制端在被控端执行；restore 仍是
  // 本机入口，远程会话未进 allowlist，控制端保持无恢复入口降级。

  ipcMain.handle('worktree:removal-preview', (_e, sessionId: unknown) => {
    if (typeof sessionId !== 'string' || !sessionId) return { hasWorktree: false, dirty: false };
    return WorktreeManager.getRemovalPreview(sessionId);
  });

  ipcMain.handle('worktree:restore-status', (_e, sessionId: unknown) => {
    if (typeof sessionId !== 'string' || !sessionId) return { state: 'no-worktree' };
    return getWorktreeRestoreStatus(sessionId);
  });

  ipcMain.handle('worktree:restore-for-session', (_e, sessionId: unknown) => {
    if (typeof sessionId !== 'string' || !sessionId) {
      return { ok: false, message: 'invalid sessionId' };
    }
    return restoreWorktreeForSession(sessionId);
  });
}
