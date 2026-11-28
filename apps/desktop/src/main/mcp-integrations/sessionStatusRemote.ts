import { DeviceLinkError, type InvokeResultPayload } from '@cindy/device-link';
import type { ArchiveSessionsDeps, SessionSnoozeChangeItem, SessionStatusChangeItem, SnoozeSessionsDeps } from '@cindy/mcps';
import { assertTaskActionCurrent, captureTaskActionSyncGuard } from '../maker-ipc/taskActionAuthorization.js';

type Failure = { errorCode: string; message: string };
export { failure as remoteSessionMutationFailure };
const unknownOutcome = (): Failure => ({
  errorCode: 'REMOTE_RESULT_UNKNOWN',
  message: '未收到可信回执，失败项可能已生效；请先查询目标任务状态再决定是否重试。后续项未执行。',
});

/** Only classify proven pre-write rejections as definite failures. */
function failure(code: string, message: string, beforeSend = false): Failure {
  const actual = code === 'IPC_ERROR'
    ? /(?:^|:\s*(?:Error:\s*)?)\[([A-Z0-9_]+)]/.exec(message)?.[1] ?? code
    : code;
  switch (actual) {
    case 'CHANNEL_NOT_ALLOWED':
    case 'VERSION_MISMATCH':
      return { errorCode: 'REMOTE_UNSUPPORTED', message: '目标电脑的版本不支持此任务状态操作。' };
    case 'DEVICE_OFFLINE':
      return { errorCode: 'REMOTE_DEVICE_OFFLINE', message: '目标电脑不在线。' };
    case 'ACCESS_REVOKED':
      return { errorCode: 'REMOTE_ACCESS_REVOKED', message: '目标电脑已撤销远程控制授权。' };
    case 'PERMISSION_DENIED':
    case 'REMOTE_DISABLED':
    case 'DEVICE_LINK_CONTROL_DISABLED':
      return { errorCode: 'REMOTE_DISABLED', message: '未允许远程控制目标电脑。' };
    case 'BACKPRESSURE':
      // The target can overload while querying its receipt after committing the write.
      if (!beforeSend) return unknownOutcome();
      return { errorCode: 'REMOTE_UNAVAILABLE', message: '发送队列拥塞，尚未发送到目标电脑。' };
    case 'LINK_NOT_OPEN':
    case 'NOT_CONNECTED':
    case 'DEVICE_LINK_NOT_CONNECTED':
    case 'DEVICE_LINK_STANDBY':
    case 'DEVICE_UNRESPONSIVE':
      return { errorCode: 'REMOTE_UNAVAILABLE', message: '暂时无法连接目标电脑。' };
    case 'INVALID_PARAMS':
      return { errorCode: 'INVALID_ARGS', message: '目标电脑拒绝了任务状态参数。' };
    case 'PRECONDITION_FAILED':
      if (message.includes('[PRECONDITION_FAILED] 已删除的任务不能恢复或归档') ||
          message.includes('[PRECONDITION_FAILED] Bot task lifecycle is managed by teammate recovery and history controls')) {
        return { errorCode: 'PRECONDITION_FAILED', message: '目标任务已删除或由专属生命周期管理，不能通过此工具恢复或归档。' };
      }
      // The worktree mutation wrapper can also replace a post-write query error with this code.
      return unknownOutcome();
    case 'NOT_FOUND':
      // dispatch also emits NOT_FOUND *after* the handler on owner/visibility changes.
      if (message.includes('[NOT_FOUND] Session 不存在')) {
        return { errorCode: 'NOT_FOUND', message: '目标任务不存在。' };
      }
      return unknownOutcome();
    default:
      return unknownOutcome();
  }
}

type RemoteInvokeDeps = {
  captureAccess(): () => void;
  invoke(
    deviceId: string,
    channel: string,
    args: unknown[],
    options?: { preSend?: () => void },
  ): Promise<InvokeResultPayload>;
};
type RemoteChange = { status: SessionStatusChangeItem['status'] } | { snoozedUntil: string | null } | { pinnedAt: string | null };
type RemoteItem = { sessionId: string; title: string | null; workingDir: string | null };

/** Reuse the remote UI's narrow patch-meta service; no new channel, DB writes or retries. */
export function createRemoteSessionsStatusSetter(deps: RemoteInvokeDeps) {
  const patch = createRemoteSessionsPatcher(deps);
  return async ({ deviceId, sessionIds, status }: {
    deviceId: string; sessionIds: string[]; status: SessionStatusChangeItem['status'];
  }): Promise<Awaited<ReturnType<NonNullable<ArchiveSessionsDeps['setRemoteSessionsStatus']>>>> => {
    const result = await patch(deviceId, sessionIds, { status });
    const changed = result.changed.map((item) => ({ ...item, status }));
    return result.ok ? { ok: true, changed } : { ...result, changed };
  };
}

/** The inbox's snooze / wake on another computer, through the same patch-meta as its UI. */
export function createRemoteSessionsSnoozeSetter(deps: RemoteInvokeDeps): NonNullable<SnoozeSessionsDeps['setRemoteSessionsSnooze']> {
  const patch = createRemoteSessionsPatcher(deps);
  return async ({ deviceId, sessionIds, snoozedUntil }) => {
    const result = await patch(deviceId, sessionIds, { snoozedUntil });
    const changed: SessionSnoozeChangeItem[] = result.changed.map((item) => ({ ...item, snoozedUntil }));
    return result.ok ? { ok: true, changed } : { ...result, changed };
  };
}

function confirmsRemoteChange(row: Record<string, unknown>, change: RemoteChange): boolean {
  if ('status' in change) return row.status === change.status;
  if ('snoozedUntil' in change) return row.snoozedUntil === change.snoozedUntil;
  if (change.pinnedAt === null) return row.pinnedAt === null && row.summary === null;
  return typeof row.pinnedAt === 'string' && Number.isFinite(Date.parse(row.pinnedAt));
}

export function createRemoteSessionsPatcher(deps: RemoteInvokeDeps) {
  return async (deviceId: string, sessionIds: string[], change: RemoteChange) => {
    const status = 'status' in change ? change.status : undefined;
    const assertActionCurrent = captureTaskActionSyncGuard();
    const changed: RemoteItem[] = [];
    const fail = (index: number, reason: Failure) => ({
      ok: false as const,
      ...reason,
      changed,
      failedSessionId: sessionIds[index],
      remainingSessionIds: sessionIds.slice(index + 1),
    });
    let assertCurrent: () => void;
    try {
      assertCurrent = deps.captureAccess();
    } catch {
      return fail(0, { errorCode: 'HOST_NOT_READY', message: '账号正在切换，没有写入。' });
    }
    for (const [index, sessionId] of sessionIds.entries()) {
      try {
        assertCurrent();
      } catch {
        // Preserve receipts without returning the previous account's metadata.
        changed.forEach((item) => { item.title = null; item.workingDir = null; });
        return fail(index, { errorCode: 'HOST_NOT_READY', message: '账号已切换，当前项及后续项未执行。' });
      }
      try {
        await assertTaskActionCurrent();
        assertCurrent();
      } catch {
        // The async authorization check can also cross an account boundary.
        changed.forEach((item) => { item.title = null; item.workingDir = null; });
        return fail(index, {
          errorCode: 'TASK_ACTION_AUTHORIZATION_EXPIRED',
          message: '请求来源已失效，当前项及后续项未执行。',
        });
      }
      let response: InvokeResultPayload;
      let actionExpiredBeforeSend = false;
      try {
        const options = {
          preSend: () => {
            assertCurrent();
            try { assertActionCurrent?.(); } catch (error) {
              actionExpiredBeforeSend = true;
              throw error;
            }
          },
        };
        let promoted = false;
        if (status === 'deleted' || 'pinnedAt' in change) {
          const snapshot = await deps.invoke(deviceId, 'local-db:sessions:get', [sessionId], options);
          assertCurrent();
          if (!snapshot.ok) return fail(index, failure(snapshot.error.code, snapshot.error.message));
          const task = snapshot.result as { id?: string; sideChatPromoted?: boolean; pinnedAt?: unknown; status?: string; summary?: unknown } | null;
          if (task?.id !== sessionId) return fail(index, { errorCode: 'NOT_FOUND', message: '目标任务不存在。' });
          if ('pinnedAt' in change) {
            if (task.status === 'deleted') return fail(index, { errorCode: 'PRECONDITION_FAILED', message: '目标任务已删除。' });
            if (task.pinnedAt !== null && (typeof task.pinnedAt !== 'string' || !Number.isFinite(Date.parse(task.pinnedAt))))
              return fail(index, { errorCode: 'REMOTE_UNSUPPORTED', message: '目标电脑未返回置顶状态。' });
            // Older hosts replace the timestamp on every patch; skip already-satisfied pins.
            if (confirmsRemoteChange(task, change)) {
              changed.push({ sessionId, title: null, workingDir: null });
              continue;
            }
          }
          promoted = status === 'deleted' && task.sideChatPromoted === true;
        }
        response = await deps.invoke(deviceId, 'local-db:sessions:patch-meta',
          [sessionId, promoted ? { status, deleteTarget: 'task' } : change], options);
      } catch (error) {
        if (actionExpiredBeforeSend) {
          changed.forEach((item) => { item.title = null; item.workingDir = null; });
          return fail(index, {
            errorCode: 'TASK_ACTION_AUTHORIZATION_EXPIRED',
            message: '请求来源已失效，当前项及后续项未执行。',
          });
        }
        try { assertCurrent(); } catch {
          changed.forEach((item) => { item.title = null; item.workingDir = null; });
        }
        const reason = error instanceof DeviceLinkError
          ? (error.inFlight ? unknownOutcome() : failure(error.code, error.message, true))
          : failure('IPC_ERROR', error instanceof Error ? error.message : '');
        return fail(index, reason);
      }
      try {
        assertCurrent();
      } catch {
        changed.forEach((item) => { item.title = null; item.workingDir = null; });
        return fail(index, unknownOutcome());
      }
      if (!response.ok) return fail(index, failure(response.error.code, response.error.message));
      const row = response.result as Record<string, unknown> | null;
      if (!row || typeof row !== 'object' || Array.isArray(row) || row.id !== sessionId
        || !confirmsRemoteChange(row, change)) {
        return fail(index, unknownOutcome());
      }
      changed.push({
        sessionId,
        title: typeof row.title === 'string' ? row.title : null,
        workingDir: typeof row.workingDir === 'string' ? row.workingDir : null,
      });
    }
    return { ok: true as const, changed };
  };
}
