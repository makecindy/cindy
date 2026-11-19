import { DeviceLinkError, type InvokeResultPayload } from '@cindy/device-link';
import type { ArchiveSessionsDeps, SessionSnoozeChangeItem, SessionStatusChangeItem, SetSessionsSnoozeResult } from '@cindy/mcps';
import { assertTaskActionCurrent, captureTaskActionSyncGuard } from '../maker-ipc/taskActionAuthorization.js';

type Failure = { errorCode: string; message: string };
export { failure as remoteSessionMutationFailure };
const tooOld = (): Failure => ({ errorCode: 'REMOTE_UNSUPPORTED', message: '目标电脑的版本不支持稍后处理，请先升级那台电脑。' });
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
      // Hosts from before the inbox reject the snooze field by name; nothing was written.
      if (message.includes('field not allowed in patch-meta: snoozedUntil')) return tooOld();
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

type RemoteInvoke = (
  deviceId: string,
  channel: string,
  args: unknown[],
  options?: { preSend?: () => void },
) => Promise<InvokeResultPayload>;

type RemotePatchResult<Item> =
  | { ok: true; changed: Item[] }
  | { ok: false; errorCode: string; message: string; changed: Item[]; failedSessionId: string; remainingSessionIds: string[] };

/**
 * Sequential patch-meta writes on one remote computer: stop on the first failure, no rollback
 * or replay. `receipt` turns the returned row into a change item, or a failure when the row
 * does not prove the write.
 */
async function patchRemoteSessions<Item extends { title: string | null }>(
  deps: { captureAccess(): () => void; invoke: RemoteInvoke },
  { deviceId, sessionIds, patch, receipt }: {
    deviceId: string;
    sessionIds: string[];
    patch: Record<string, unknown>;
    receipt(row: Record<string, unknown>, sessionId: string): Item | Failure;
  },
): Promise<RemotePatchResult<Item>> {
  const assertActionCurrent = captureTaskActionSyncGuard();
  const changed: Item[] = [];
  // Preserve receipts without returning the previous account's metadata.
  const redact = () => changed.forEach((item) => {
    item.title = null;
    if ('workingDir' in item) (item as { workingDir: string | null }).workingDir = null;
  });
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
      redact();
      return fail(index, { errorCode: 'HOST_NOT_READY', message: '账号已切换，当前项及后续项未执行。' });
    }
    try {
      await assertTaskActionCurrent();
      assertCurrent();
    } catch {
      // The async authorization check can also cross an account boundary.
      redact();
      return fail(index, {
        errorCode: 'TASK_ACTION_AUTHORIZATION_EXPIRED',
        message: '请求来源已失效，当前项及后续项未执行。',
      });
    }
    let response: InvokeResultPayload;
    let actionExpiredBeforeSend = false;
    try {
      response = await deps.invoke(deviceId, 'local-db:sessions:patch-meta', [sessionId, patch], {
        preSend: () => {
          assertCurrent();
          try { assertActionCurrent?.(); } catch (error) {
            actionExpiredBeforeSend = true;
            throw error;
          }
        },
      });
    } catch (error) {
      if (actionExpiredBeforeSend) {
        redact();
        return fail(index, {
          errorCode: 'TASK_ACTION_AUTHORIZATION_EXPIRED',
          message: '请求来源已失效，当前项及后续项未执行。',
        });
      }
      try { assertCurrent(); } catch {
        redact();
      }
      const reason = error instanceof DeviceLinkError
        ? (error.inFlight ? unknownOutcome() : failure(error.code, error.message, true))
        : failure('IPC_ERROR', error instanceof Error ? error.message : '');
      return fail(index, reason);
    }
    try {
      assertCurrent();
    } catch {
      redact();
      return fail(index, unknownOutcome());
    }
    if (!response.ok) return fail(index, failure(response.error.code, response.error.message));
    const row = response.result as Record<string, unknown> | null;
    if (!row || typeof row !== 'object' || Array.isArray(row) || row.id !== sessionId) {
      return fail(index, unknownOutcome());
    }
    const item = receipt(row, sessionId);
    if ('errorCode' in item) return fail(index, item);
    changed.push(item);
  }
  return { ok: true, changed };
}

/** Reuse the remote UI's narrow patch-meta service; no new channel, DB writes or retries. */
export function createRemoteSessionsStatusSetter(deps: { captureAccess(): () => void; invoke: RemoteInvoke }) {
  return async ({ deviceId, sessionIds, status }: {
    deviceId: string; sessionIds: string[]; status: SessionStatusChangeItem['status'];
  }): Promise<Awaited<ReturnType<NonNullable<ArchiveSessionsDeps['setRemoteSessionsStatus']>>>> =>
    patchRemoteSessions<SessionStatusChangeItem>(deps, {
      deviceId,
      sessionIds,
      patch: { status },
      receipt: (row, sessionId) => row.status !== status ? unknownOutcome() : {
        sessionId,
        status,
        title: typeof row.title === 'string' ? row.title : null,
        workingDir: typeof row.workingDir === 'string' ? row.workingDir : null,
      },
    });
}

/**
 * Snooze through the same patch-meta write as the remote sidebar. A host from before the
 * inbox rejects the field, and its row has no snooze pair: both mean the target is too old.
 */
export function createRemoteSessionsSnoozeSetter(deps: { captureAccess(): () => void; invoke: RemoteInvoke }) {
  return async ({ deviceId, sessionIds, snoozedUntil }: {
    deviceId: string; sessionIds: string[]; snoozedUntil: string | null;
  }): Promise<SetSessionsSnoozeResult> => {
    return patchRemoteSessions<SessionSnoozeChangeItem>(deps, {
      deviceId,
      sessionIds,
      patch: { snoozedUntil },
      receipt: (row, sessionId) => {
        if (!('snoozedUntil' in row)) return tooOld();
        const saved = typeof row.snoozedUntil === 'string' ? Date.parse(row.snoozedUntil) : null;
        // The host returns normalized ISO; compare instants, not strings.
        if (snoozedUntil === null ? row.snoozedUntil !== null : saved !== Date.parse(snoozedUntil)) return unknownOutcome();
        return {
          sessionId,
          title: typeof row.title === 'string' ? row.title : null,
          snoozedUntil: typeof row.snoozedUntil === 'string' ? row.snoozedUntil : null,
          snoozedAt: typeof row.snoozedAt === 'string' ? row.snoozedAt : null,
        };
      },
    });
  };
}
