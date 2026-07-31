/**
 * 预创建 worktree 补偿回收 IPC。
 *
 * 手机/桌面控制端的远程新建流程会先用预生成 sessionId 创建 worktree，再调用
 * maker:create-session。只有第二步确定失败、用户明确放弃并返回编辑时才调用本口。
 * handler 只编排身份、参数、session ownership 与互斥；path / recoveryKey 的登记匹配、
 * dirty 与分支安全裁决仍由 WorktreeManager 负责。
 */
import type { DiscardPrecreatedWorktreeResult } from '../worktree/WorktreeManager.js';
import { requireObject, requireString, throwIpcError } from '../utils/ipcValidate.js';
import type { IpcHandlerRegistry } from './ipcHandlerRegistry.js';

export const WORKTREE_DISCARD_PRECREATED_CHANNEL = 'worktree:discard-precreated';

const MAX_SESSION_ID_LENGTH = 256;
const MAX_EXPECTED_PATH_LENGTH = 4_096;
const MAX_RECOVERY_KEY_LENGTH = 256;

export interface PrecreatedWorktreeDiscardHandlerDeps {
  assertCaller(event: unknown): void;
  withSessionLock<T>(sessionId: string, task: () => Promise<T>): Promise<T>;
  /** DB row 或 live Maker handle 任一存在即表示该 session 已认领 worktree。 */
  isSessionClaimed(sessionId: string): Promise<boolean>;
  discard(
    sessionId: string,
    expectedPath: string,
    options: { canRemove: () => Promise<boolean> },
  ): Promise<DiscardPrecreatedWorktreeResult>;
  discardByRecoveryKey(
    sessionId: string,
    recoveryKey: string,
    options: { canRemove: () => Promise<boolean> },
  ): Promise<DiscardPrecreatedWorktreeResult>;
}

async function readSessionClaimed(
  deps: PrecreatedWorktreeDiscardHandlerDeps,
  sessionId: string,
): Promise<boolean> {
  try {
    return await deps.isSessionClaimed(sessionId);
  } catch {
    // ownership 无法确认时 fail closed；不把 DB/路径细节带回不可信调用方。
    throwIpcError('INTERNAL', '无法确认预创建 worktree 的会话归属');
  }
}

export function registerPrecreatedWorktreeDiscardHandler(
  registry: IpcHandlerRegistry,
  deps: PrecreatedWorktreeDiscardHandlerDeps,
): void {
  registry.handle(WORKTREE_DISCARD_PRECREATED_CHANNEL, async (event, raw: unknown) => {
    deps.assertCaller(event);
    const body = requireObject(raw, 'discard pre-created worktree request');
    const sessionId = requireString(body.sessionId, 'sessionId');
    const hasPath = body.path !== undefined;
    const hasRecoveryKey = body.recoveryKey !== undefined;
    if (hasPath === hasRecoveryKey) {
      throwIpcError(
        'INVALID_PARAMS',
        'discard pre-created worktree requires exactly one recovery locator',
      );
    }
    const expectedPath = hasPath ? requireString(body.path, 'path') : null;
    const recoveryKey = hasRecoveryKey
      ? requireString(body.recoveryKey, 'recoveryKey')
      : null;
    if (
      sessionId.length > MAX_SESSION_ID_LENGTH ||
      (expectedPath !== null && expectedPath.length > MAX_EXPECTED_PATH_LENGTH) ||
      (recoveryKey !== null && recoveryKey.length > MAX_RECOVERY_KEY_LENGTH)
    ) {
      throwIpcError('INVALID_PARAMS', 'discard pre-created worktree request is too large');
    }

    return deps.withSessionLock(sessionId, async () => {
      if (await readSessionClaimed(deps, sessionId)) {
        throwIpcError('PRECONDITION_FAILED', '会话已认领该 worktree，拒绝补偿回收');
      }

      let result: DiscardPrecreatedWorktreeResult;
      try {
        const options = {
          // WorktreeManager 在真正删除前再次调用，封住 ownership 查询后的竞态窗口。
          canRemove: async () => !(await readSessionClaimed(deps, sessionId)),
        };
        if (expectedPath !== null) {
          result = await deps.discard(sessionId, expectedPath, options);
        } else if (recoveryKey !== null) {
          result = await deps.discardByRecoveryKey(sessionId, recoveryKey, options);
        } else {
          throwIpcError('INVALID_PARAMS', 'discard pre-created worktree locator is missing');
        }
      } catch {
        throwIpcError('INTERNAL', '预创建 worktree 回收失败');
      }

      if (result.status === 'path-mismatch') {
        throwIpcError('PERMISSION_DENIED', '预创建 worktree 路径与登记记录不匹配');
      }
      if (result.status === 'preserved') {
        if (await readSessionClaimed(deps, sessionId)) {
          throwIpcError('PRECONDITION_FAILED', '会话已认领该 worktree，拒绝补偿回收');
        }
        throwIpcError('PRECONDITION_FAILED', 'worktree 已有改动、保留标记或仍被使用');
      }
      return {
        discarded: true,
        ...(result.status === 'discarded' ? { branchDeleted: result.branchDeleted } : {}),
      };
    });
  });
}
