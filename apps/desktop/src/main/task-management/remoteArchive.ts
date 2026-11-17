import { DL_SESSION_ARCHIVE_GET_CHANNEL, DL_SESSION_ARCHIVE_SET_CHANNEL } from '@cindy/device-link';
import { getDeviceLinkInvokeContext } from '../device-link/invoke-context.js';
import type { captureDataOwnerBroadcastScope } from '../device-link/broadcast-tap.js';
import { activeDataOwnerId } from '../ownerContext.js';
import { getCurrentDbClientSnapshot } from '../localDb/client/current.js';
import type { SessionArchiveVersion } from '../localDb/client/tx/types.js';
import { publishRemoteArchiveStatus } from '../localDb/ipc/sessions.js';
import { isProvisionalSession } from '../localDb/provisionalSessions.js';
import { withRequiredSessionRouteLock } from '../localDb/sessionRouteLock.js';
import { managedWorktreeRoot } from '../worktree/managedResourcePath.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { assertRemoteArchiveRuntimeIdle } from './service.js';

type ArchiveRead = SessionArchiveVersion & {
  archived: number;
  workingDir: string | null;
  worktreePath: string | null;
  operationId: string | null;
  receiptRevision: number | null;
  expectedRevision: number | null;
  receiptArchived: number | null;
};

const identifier = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const instancePattern = /^(?:[a-f0-9]{32})?$/;
const LOCAL_ARCHIVE_TASK_SQL = `s.status IN ('active', 'archived') AND s.source = 'desktop'
  AND s.hidden_at IS NULL AND s.remote_host_id IS NULL AND s.agent_device_id IS NULL
  AND s.orca_role IS NULL AND s.orca_remote_lead IS NULL`;

function archiveIdentifier(value: unknown): string {
  if (typeof value !== 'string' || !identifier.test(value)) {
    throwIpcError('INVALID_PARAMS', 'Invalid task archive identifier');
  }
  return value;
}

export async function executeRemoteSessionArchive(
  channel: string,
  args: unknown[],
  ownerScope: ReturnType<typeof captureDataOwnerBroadcastScope>,
  authorize: () => Promise<void>,
) {
  const context = getDeviceLinkInvokeContext();
  if (!context || context.sharedTask || context.channel !== channel ||
      (channel !== DL_SESSION_ARCHIVE_GET_CHANNEL && channel !== DL_SESSION_ARCHIVE_SET_CHANNEL)) {
    throwIpcError('NOT_FOUND', 'Session does not exist');
  }
  const [target, input] = args;
  const sessionId = archiveIdentifier(target);
  const controllerId = context.controllerDeviceId;
  const db = getCurrentDbClientSnapshot();
  if (!db || db.userId !== activeDataOwnerId()) {
    throwIpcError('PRECONDITION_FAILED', 'Task database is not ready');
  }
  const verifyScope = () => {
    const current = getCurrentDbClientSnapshot();
    if (current?.client !== db.client || current.clientEpoch !== db.clientEpoch ||
        current.userId !== activeDataOwnerId() || isProvisionalSession(sessionId)) {
      throwIpcError('NOT_FOUND', 'Session does not exist');
    }
  };
  const read = async (operationId?: string) => {
    verifyScope();
    const row = await db.client.queryOne<ArchiveRead>(`
      SELECT s.archive_instance AS instance, s.archive_revision AS revision,
        s.status = 'archived' AS archived, s.working_dir AS workingDir, s.worktree_path AS worktreePath,
        r.operation_id AS operationId,
        r.revision AS receiptRevision, r.expected_revision AS expectedRevision, r.archived AS receiptArchived
      FROM sessions s
      LEFT JOIN session_archive_receipts r ON r.controller_id = ? AND r.operation_id = ?
        AND r.session_id = s.id AND r.session_instance = s.archive_instance
      WHERE s.id = ? AND ${LOCAL_ARCHIVE_TASK_SQL}
    `, [controllerId, operationId ?? null, sessionId]);
    verifyScope();
    if (!row) throwIpcError('NOT_FOUND', 'Session does not exist');
    return row;
  };
  const params = input && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, unknown> : undefined;
  if (args.length > 2 || input !== undefined && !params) {
    throwIpcError('INVALID_PARAMS', 'Invalid task archive parameters');
  }
  if (channel === DL_SESSION_ARCHIVE_GET_CHANNEL) {
    const id = params?.operationId === undefined ? undefined : archiveIdentifier(params.operationId);
    const row = await read(id);
    await authorize();
    verifyScope();
    return {
      version: 1, sessionId,
      current: { instance: row.instance, revision: row.revision, archived: Boolean(row.archived) },
      receipt: row.operationId ? {
        sessionId, operationId: row.operationId, instance: row.instance,
        revision: row.receiptRevision, archived: Boolean(row.receiptArchived),
      } : null,
    };
  }

  const operationId = archiveIdentifier(params?.operationId);
  const { instance, revision, archived } = params!;
  if (typeof instance !== 'string' || !instancePattern.test(instance) ||
      typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0 ||
      typeof archived !== 'boolean') {
    throwIpcError('INVALID_PARAMS', 'Invalid task archive precondition');
  }
  return withRequiredSessionRouteLock(sessionId, async () => {
    const current = await read(operationId);
    if (current.operationId) {
      if (current.instance !== instance || current.expectedRevision !== revision || Boolean(current.receiptArchived) !== archived) {
        throwIpcError('PRECONDITION_FAILED', 'Archive operation ID was previously used with different parameters');
      }
      await authorize();
      verifyScope();
      return { version: 1, sessionId, operationId, instance, revision: current.receiptRevision, archived };
    }
    if (current.instance !== instance || current.revision !== revision || Boolean(current.archived) === archived) {
      throwIpcError('PRECONDITION_FAILED', 'Task archive status changed');
    }
    if (current.worktreePath || current.workingDir && managedWorktreeRoot(current.workingDir)) {
      throwIpcError('PRECONDITION_FAILED', 'Task has a worktree');
    }
    await assertRemoteArchiveRuntimeIdle(sessionId);
    await authorize();
    verifyScope();
    const { receipt, applied } = await db.client.tx('sessions.setRemoteArchive', {
      sessionId, controllerId, operationId, expected: { instance, revision }, archived, workingDir: current.workingDir,
    }).catch((error: unknown) => {
      if ((error as { code?: string }).code === 'PRECONDITION_FAILED') {
        throwIpcError('PRECONDITION_FAILED', error instanceof Error ? error.message : 'Task archive precondition failed');
      }
      throw error;
    });
    if (applied) publishRemoteArchiveStatus(db.client, sessionId, archived ? 'archived' : 'active', current.workingDir, ownerScope);
    return { version: 1, ...receipt };
  });
}

/** A reliable reply may wait in the outbox while the task or its owner changes. */
export async function revalidateRemoteArchiveReply(channel: string, reply: unknown): Promise<unknown> {
  const value = reply as Record<string, unknown>;
  const sessionId = archiveIdentifier(value.sessionId);
  const reading = channel === DL_SESSION_ARCHIVE_GET_CHANNEL;
  const instance = reading ? (value.current as SessionArchiveVersion).instance : value.instance;
  const owner = activeDataOwnerId();
  const db = getCurrentDbClientSnapshot();
  if (!db || db.userId !== owner || isProvisionalSession(sessionId)) {
    throwIpcError('NOT_FOUND', 'Session does not exist');
  }
  const state = await db.client.queryOne<{ revision: number; archived: number }>(`
    SELECT s.archive_revision AS revision, s.status = 'archived' AS archived
    FROM sessions s WHERE s.id = ? AND s.archive_instance = ? AND ${LOCAL_ARCHIVE_TASK_SQL}
  `, [sessionId, instance]);
  const current = getCurrentDbClientSnapshot();
  if (!state || current?.client !== db.client || current.clientEpoch !== db.clientEpoch || owner !== activeDataOwnerId()) {
    throwIpcError('NOT_FOUND', 'Session does not exist');
  }
  return reading
    ? { ...value, current: { instance, revision: state.revision, archived: Boolean(state.archived) } }
    : reply;
}
