/**
 * Changing a task's permission mode, moved verbatim out of register.ts so the Node Host runs the same
 * steps: commitSessionPermissionMode (ordered per Bot and per task behind the permission queues, the
 * account checked at each step, review tasks refused, the runtime rolled back when the write fails, the
 * shared provider's "always allow for this task" dropped when the mode changes, the Bot's other lanes
 * synced). register.ts keeps its function declaration (the session control service refers to it before
 * its line) and calls this with its ports.
 *
 * Ports are what register.ts held in its own scope or took from modules the Node Host cannot load:
 * the Maker, the review-task check, the patch broadcast, the Bot lane sync (botPermissionSync.ts reaches
 * the desktop's Maker host), the Device Link response mark and the logger. The permission queues, the
 * account snapshot and forgetCredentialGrants stay module imports: the Node Host loads the same modules.
 */
import type { Maker, PermissionMode } from '@cindy/maker-core';
import { eq } from 'drizzle-orm';
import { getCurrentDbClientSnapshot } from '../localDb/client/current.js';
import { sessions } from '../localDb/schema.js';
import type { Logger } from '../logger.js';
import { forgetCredentialGrants } from '../remote-agent/executor/credentialGrants.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { withBotPermissionChange } from './botPermissionDispatch.js';
import { withSessionPermissionChange } from './sessionPermissionChange.js';

/** The patch broadcast and the Device Link response mark, as register.ts imports them. */
type BroadcastSessionPatched = (sessionId: string, patch: Record<string, unknown>) => void;
type MarkRemoteSettingPersistedInsideHandler = typeof import('../device-link/dispatch.desktop.js').markRemoteSettingPersistedInsideHandler;

/** register.ts's commitSessionPermissionMode, with its ports. */
export async function commitSessionPermissionModeWith(
  ports: {
    maker: Pick<Maker, 'getSession'>;
    assertReviewSettingsUnlocked: (sessionId: string) => Promise<void>;
    broadcastSessionPatched: BroadcastSessionPatched;
    syncBotLinkedLanePermissions: (canonicalSessionId: string) => Promise<void>;
    markRemoteSettingPersistedInsideHandler: MarkRemoteSettingPersistedInsideHandler;
    log: Logger;
  },
  sessionId: string,
  mode: string,
  remote = false,
  beforeMutation?: () => Promise<void>,
) {
  const {
    maker, assertReviewSettingsUnlocked, broadcastSessionPatched, syncBotLinkedLanePermissions,
    markRemoteSettingPersistedInsideHandler, log,
  } = ports;
  const snapshot = getCurrentDbClientSnapshot();
  const assertOwnerCurrent = () => {
    if (!snapshot || snapshot !== getCurrentDbClientSnapshot()) {
      throwIpcError('PRECONDITION_FAILED', 'Account changed during permission update');
    }
  };
  return withBotPermissionChange(sessionId, () => withSessionPermissionChange(sessionId, async () => {
    await beforeMutation?.();
    assertOwnerCurrent();
    await assertReviewSettingsUnlocked(sessionId);
    await beforeMutation?.();
    assertOwnerCurrent();
    const [row] = await snapshot!.client.drizzle.select({permissionMode: sessions.permissionMode})
      .from(sessions).where(eq(sessions.id, sessionId)).limit(1);
    assertOwnerCurrent();
    if (!row) throwIpcError('NOT_FOUND', 'session not found');
    await beforeMutation?.();
    const sess = maker.getSession(sessionId);
    let runtimeChanged = false;
    try {
      if (sess) {
        await sess.setPermissionMode(mode as PermissionMode);
        runtimeChanged = true;
      }
      await beforeMutation?.();
      assertOwnerCurrent();
      const saved = await snapshot!.client.tx('bots.persistSessionPermission', {sessionId, mode});
      if (!saved.updated) throwIpcError('NOT_FOUND', 'session not found');
      assertOwnerCurrent();
    } catch (error) {
      // Keep recovery inside the same permission operation so it cannot
      // overwrite a later user choice. Never recover into a new account.
      if (runtimeChanged && sess && snapshot === getCurrentDbClientSnapshot()) {
        await sess.setPermissionMode(row.permissionMode as PermissionMode).catch((rollbackError) => {
          log.warn('permission runtime rollback failed', {sessionId, error: String(rollbackError)});
        });
      }
      throw error;
    }
    // 分享供应商的「本任务总是允许」随权限档变化失效；Agent 实例被回收时执行器收不到这次切换。
    if (row.permissionMode !== mode) forgetCredentialGrants(sessionId);
    broadcastSessionPatched(sessionId, { permissionMode: mode });
    await syncBotLinkedLanePermissions(sessionId);
    if (remote) {
      const result = {};
      markRemoteSettingPersistedInsideHandler(result);
      return result;
    }
    return true;
  }));
}
