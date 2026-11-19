/**
 * Changing a task's permission mode or Plan mode, moved verbatim out of register.ts so the Node Host runs
 * the same steps: the SET_PERMISSION_MODE handler's body after its sender check (the argument checks, then the
 * commit), and commitSessionPermissionMode (ordered per Bot and per task behind the permission queues, the
 * account checked at each step, review tasks refused, the runtime rolled back when the write fails, the
 * shared provider's "always allow for this task" dropped when the mode changes, the Bot's other lanes
 * synced); the SET_PLAN_MODE handler's body after its sender check (the same queue, checks and rollback);
 * and the save of a Plan mode the runtime changed itself (emitWiredSessionEvent's plan_mode_changed, behind
 * the same queue, written only while the account, the task's binding and the runtime's value still hold).
 * register.ts keeps each IPC registration and its sender check (assertTrustedAppRendererEvent,
 * before anything else) and calls the moved body; it keeps commitSessionPermissionMode's function
 * declaration (the session control service refers to it before its line) and calls the moved body with
 * its ports; emitWiredSessionEvent calls the moved plan_mode_changed handling.
 *
 * Ports are what register.ts held in its own scope or took from modules the Node Host cannot load:
 * the Maker, the review-task check, the session field write, the patch broadcast, the Bot lane sync (botPermissionSync.ts reaches
 * the desktop's Maker host), the Device Link response mark, the logger, and for the runtime's own Plan
 * change the owner snapshot and the session bindings register.ts wired the runtime with. The permission queues, the
 * account snapshot and forgetCredentialGrants stay module imports: the Node Host loads the same modules.
 */
import type { AgentEvent, Maker, PermissionMode, Session } from '@cindy/maker-core';
import { eq } from 'drizzle-orm';
import { getCurrentDbClientSnapshot } from '../localDb/client/current.js';
import { sessions } from '../localDb/schema.js';
import type { Logger } from '../logger.js';
import { forgetCredentialGrants } from '../remote-agent/executor/credentialGrants.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { isDeviceLinkInvoke } from '../device-link/invoke-context.js';
import { withBotPermissionChange } from './botPermissionDispatch.js';
import { withSessionPermissionChange } from './sessionPermissionChange.js';
import { isSessionPermissionMode } from './sessionPermissionModes.js';

/** The patch broadcast and the Device Link response mark, as register.ts imports them. */
type BroadcastSessionPatched = (sessionId: string, patch: Record<string, unknown>) => void;
type MarkRemoteSettingPersistedInsideHandler = typeof import('../device-link/dispatch.desktop.js').markRemoteSettingPersistedInsideHandler;
type PersistSessionFields = typeof import('../localDb/ipc/sessions.js').persistSessionFields;

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

/** register.ts's SET_PERMISSION_MODE handler body, after its sender check. */
export function createSetSessionPermissionMode(ports: {
  commitSessionPermissionMode: (sessionId: string, mode: string, remote?: boolean) => Promise<unknown>;
}) {
  const { commitSessionPermissionMode } = ports;
  return async (sessionId: unknown, mode: unknown) => {
    if (typeof sessionId !== 'string' || typeof mode !== 'string') {
      throwIpcError('INVALID_PARAMS', 'sessionId + mode required');
    }
    if (!isSessionPermissionMode(mode)) {
      throwIpcError('INVALID_PARAMS', 'invalid permission mode');
    }
    return commitSessionPermissionMode(sessionId, mode, isDeviceLinkInvoke());
  };
}

/** register.ts's SET_PLAN_MODE handler body, after its sender check. */
export function createSetSessionPlanMode(ports: {
  maker: Pick<Maker, 'getSession'>;
  assertReviewSettingsUnlocked: (sessionId: string) => Promise<void>;
  persistSessionFields: PersistSessionFields;
  markRemoteSettingPersistedInsideHandler: MarkRemoteSettingPersistedInsideHandler;
  log: Logger;
}) {
  const { maker, assertReviewSettingsUnlocked, persistSessionFields, markRemoteSettingPersistedInsideHandler, log } = ports;
  return async (sessionId: unknown, enabled: unknown) => {
    if (typeof sessionId !== 'string' || typeof enabled !== 'boolean') {
      throwIpcError('INVALID_PARAMS', 'sessionId + enabled required');
    }
    const snapshot = getCurrentDbClientSnapshot();
    const remote = isDeviceLinkInvoke();
    const assertOwnerCurrent = () => {
      if (!snapshot || snapshot !== getCurrentDbClientSnapshot())
        throwIpcError('PRECONDITION_FAILED', 'Account changed during Plan update');
    };
    return withSessionPermissionChange(sessionId, async () => {
      assertOwnerCurrent();
      await assertReviewSettingsUnlocked(sessionId);
      assertOwnerCurrent();
      const [row] = await snapshot!.client.drizzle.select({planModeEnabled: sessions.planModeEnabled})
        .from(sessions).where(eq(sessions.id, sessionId)).limit(1);
      assertOwnerCurrent();
      if (!row) throwIpcError('NOT_FOUND', 'session not found');
      const sess = maker.getSession(sessionId);
      try {
        if (sess) await sess.setPlanMode(enabled);
        assertOwnerCurrent();
        if (maker.getSession(sessionId) !== sess) throwIpcError('PRECONDITION_FAILED', 'Session changed during Plan update');
        await persistSessionFields(sessionId, {planModeEnabled: enabled});
        assertOwnerCurrent();
      } catch (error) {
        // A provider may change its runtime before rejecting. Preserve the
        // existing best-effort recovery, inside this same complete commit.
        if (sess && snapshot === getCurrentDbClientSnapshot() && maker.getSession(sessionId) === sess) {
          await sess.setPlanMode(!!row.planModeEnabled).catch((rollbackError) => {
            log.warn('Plan runtime rollback failed', {sessionId, error: String(rollbackError)});
          });
        }
        throw error;
      }
      // 计划模式同属权限档：分享供应商的「本任务总是允许」随之失效(同上)。
      if (!!row.planModeEnabled !== enabled) forgetCredentialGrants(sessionId);
      if (remote) {
        const result = {};
        markRemoteSettingPersistedInsideHandler(result);
        return result;
      }
    });
  };
}

/** emitWiredSessionEvent's handling of a runtime's own plan_mode_changed event (register.ts). */
export function persistAgentPlanModeChangeWith(
  ports: {
    ownerDb: ReturnType<typeof getCurrentDbClientSnapshot>;
    sessionBindings: { getSession(sessionId: string): unknown };
    persistSessionFields: PersistSessionFields;
    log: Logger;
  },
  session: Pick<Session, 'id' | 'getPlanMode'>,
  event: AgentEvent,
): void {
  const { ownerDb, sessionBindings, persistSessionFields, log } = ports;
  const enabled = (event.data as { enabled?: unknown })?.enabled;
  if (typeof enabled === 'boolean') {
    // Do not block event consumption/turn lease release on this queue.
    void withSessionPermissionChange(session.id, async () => {
      if (!ownerDb || ownerDb !== getCurrentDbClientSnapshot()
        || sessionBindings.getSession(session.id) !== session
        || session.getPlanMode() !== enabled) return;
      await persistSessionFields(session.id, {planModeEnabled: enabled});
    }).catch((error) => log.warn('persist plan_mode_changed failed', {sessionId: session.id, error: String(error)}));
  }
}
