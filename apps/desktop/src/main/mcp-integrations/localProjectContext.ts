import { eq } from 'drizzle-orm';
import { getActiveDataOwnerPushStamp, isAppSessionBoundaryPending } from '../appSessionState.js';
import { tryGetDbClient } from '../localDb/client/current.js';
import { sessions, botSessionLinks } from '../localDb/schema.js';
import { isIpcError } from '../../shared/ipc-errors.js';
import { createLogger } from '../logger.js';
import type { ControlResult } from '@cindy/mcps';
import type { DbClient } from '../localDb/client/DbClient.js';
import type { DataOwnerPushStamp } from '../../shared/dataOwnerPush.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { assertTaskActionCurrent, captureTaskActionSyncGuard } from '../maker-ipc/taskActionAuthorization.js';
const log = createLogger('mcp/projects');
const fail = (errorCode: string, message: string) => ({ ok: false as const, errorCode, message });

export interface LocalProjectContext {
  client: DbClient;
  owner: DataOwnerPushStamp;
  assertCurrent: () => void;
}

/** All project operations use one captured account and validate the calling local task. */
export async function withLocalProjectContext<T extends object>(
  callerSessionId: string | undefined,
  run: (context: LocalProjectContext) => Promise<ControlResult<T, string>>,
): Promise<ControlResult<T, string>> {
  const client = tryGetDbClient();
  if (!client || isAppSessionBoundaryPending())
    return fail('HOST_NOT_READY', 'Cindy project storage is not ready.');
  const owner = getActiveDataOwnerPushStamp();
  const assertActionCurrent = captureTaskActionSyncGuard();
  const isCurrent = () => {
    const current = getActiveDataOwnerPushStamp();
    return (
      !isAppSessionBoundaryPending() &&
      tryGetDbClient() === client &&
      current.dataOwnerId === owner.dataOwnerId &&
      current.ownerGeneration === owner.ownerGeneration
    );
  };
  const assertCurrent = () => {
    assertActionCurrent?.();
    if (!isCurrent()) throwIpcError('PRECONDITION_FAILED', 'The active Cindy account changed.');
  };
  try {
    await assertTaskActionCurrent();
    // Undefined is reserved for authenticated remote host adapters; tools always bind a caller.
    if (callerSessionId !== undefined) {
      const [caller] = await client.drizzle
        .select({ id: sessions.id, remoteHostId: sessions.remoteHostId })
        .from(sessions)
        .where(eq(sessions.id, callerSessionId))
        .limit(1);
      if (!isCurrent()) return fail('PRECONDITION_FAILED', 'The active Cindy account changed.');
      if (!caller)
        return fail('NO_SESSION_CONTEXT', 'The calling task is not available in this account.');
      if (caller.remoteHostId)
        return fail(
          'UNSUPPORTED_CAPABILITY',
          'Project registration only supports local Cindy tasks.',
        );
      // Account-generation checkpoint. Bot callers may manage projects; the
      // helper surface names the five project tools and keeps the rest of
      // control/history closed. This read must stay so an account switch during
      // the lookup still fails closed.
      await client.drizzle
        .select({ botId: botSessionLinks.botId })
        .from(botSessionLinks)
        .where(eq(botSessionLinks.sessionId, callerSessionId))
        .limit(1);
    }
    assertCurrent();
    const result = await run({ client, owner, assertCurrent });
    assertCurrent();
    return result;
  } catch (error) {
    if (isIpcError(error)) return fail(error.code, error.message);
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT')
      return fail('NOT_FOUND', 'Directory does not exist. Create it with your file tools first.');
    if (code === 'ENOTDIR') return fail('NOT_A_DIRECTORY', 'working_dir is not a directory.');
    log.warn('project operation failed', { error: String(error) });
    return fail('INTERNAL', 'Could not complete the project operation.');
  }
}

