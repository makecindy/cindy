import type { SetSessionProjectPin } from '@cindy/mcps';
import type { InvokeResultPayload } from '@cindy/device-link';
import { isIpcError } from '../../shared/ipc-errors.js';
import { assertTaskActionCurrent, captureTaskActionSyncGuard } from '../maker-ipc/taskActionAuthorization.js';

/** UI and Agent share patch-meta, including project membership checks and push. */
export function createSessionProjectPinSetter(deps: {
  patch(sessionId: string, patch: { projectPinnedAt: string | null }, options: { beforeWrite?: () => void }): Promise<{ projectPinnedAt?: string | null }>;
  remote?: {
    captureAccess(): () => void;
    invoke(deviceId: string, channel: string, args: unknown[], options?: { preSend?: () => void }): Promise<InvokeResultPayload>;
  };
}): SetSessionProjectPin {
  return async ({ sessionId, pinned, deviceId }) => {
    const projectPinnedAt = pinned ? new Date().toISOString() : null;
    const assertActionCurrent = captureTaskActionSyncGuard();
    if (!deviceId) {
      try {
        await assertTaskActionCurrent();
        const row = await deps.patch(sessionId, { projectPinnedAt }, { beforeWrite: assertActionCurrent });
        return { ok: true, projectPinnedAt: row.projectPinnedAt ?? null };
      } catch (error) {
        return { ok: false, errorCode: isIpcError(error) ? error.code : 'INTERNAL',
          message: error instanceof Error ? error.message : '无法更新项目内置顶。' };
      }
    }
    if (!deps.remote) return { ok: false, errorCode: 'REMOTE_UNSUPPORTED', message: '当前宿主不支持跨电脑项目内置顶。' };
    let sent = false;
    try {
      const assertAccess = deps.remote.captureAccess();
      const preSend = () => { assertAccess(); assertActionCurrent?.(); };
      await assertTaskActionCurrent();
      preSend();
      const current = await deps.remote.invoke(deviceId, 'local-db:sessions:get', [sessionId], { preSend });
      assertAccess();
      if (!current.ok) return { ok: false, errorCode: current.error.code, message: current.error.message };
      const row = current.result as { id?: unknown; projectPinnedAt?: unknown } | null;
      if (!row || row.id !== sessionId) return { ok: false, errorCode: 'NOT_FOUND', message: '目标任务不存在。' };
      if (row.projectPinnedAt === undefined) return { ok: false, errorCode: 'REMOTE_UNSUPPORTED', message: '目标电脑版本不支持项目内置顶。' };
      await assertTaskActionCurrent();
      preSend();
      const response = await deps.remote.invoke(deviceId, 'local-db:sessions:patch-meta', [sessionId, { projectPinnedAt }], {
        preSend: () => { preSend(); sent = true; },
      });
      assertAccess();
      if (!response.ok) throw new Error(response.error.message);
      const updated = response.result as { id?: unknown; projectPinnedAt?: unknown } | null;
      if (!updated || updated.id !== sessionId || updated.projectPinnedAt !== projectPinnedAt) throw new Error('Invalid project pin receipt');
      return { ok: true, projectPinnedAt };
    } catch (error) {
      return sent
        ? { ok: false, errorCode: 'REMOTE_RESULT_UNKNOWN', message: '未收到可信回执，可能已生效；请先查询目标任务再决定是否重试。' }
        : { ok: false, errorCode: 'REMOTE_UNAVAILABLE', message: error instanceof Error ? error.message : '无法连接目标电脑。' };
    }
  };
}
