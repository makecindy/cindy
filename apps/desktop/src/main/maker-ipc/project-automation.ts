import { BrowserWindow, ipcMain } from 'electron';
import { eq } from 'drizzle-orm';

import { createLogger } from '../logger.js';
import { getDbClient } from '../localDb/client/current.js';
import { projectAutomationConsents } from '../localDb/schema.js';
import { projectAutomationConsentToCamel } from '../localDb/mapper.js';
import type {
  ProjectAutomationEvent,
  ProjectAutomationLoader,
  ProjectScheduleConfig,
  ReconcileResult,
} from '../scheduler-host/project-automation-loader.js';
import { requireObject, requireString, throwIpcError } from '../utils/ipcValidate.js';
import { tapWindowBroadcast } from '../device-link/broadcast-tap.js';
import { MAKER_INVOKE, MAKER_PUSH } from './channels.js';

const log = createLogger('maker-ipc:project-automation');

const PROJECT_AUTOMATION_INVOKE_CHANNELS: readonly string[] = [
  MAKER_INVOKE.PROJECT_AUTOMATION_RECONCILE,
  MAKER_INVOKE.PROJECT_AUTOMATION_PENDING_IMPORTS,
  MAKER_INVOKE.PROJECT_AUTOMATION_LIST_CONSENTS,
  MAKER_INVOKE.PROJECT_AUTOMATION_REVOKE_CONSENT,
  MAKER_INVOKE.PROJECT_AUTOMATION_UPSERT_SCHEDULE,
  MAKER_INVOKE.PROJECT_AUTOMATION_REMOVE_SCHEDULE,
];

let unsubscribeAutomationEvent: (() => void) | null = null;

function broadcast(channel: string, payload: unknown): void {
  // device-link tap:project-automation:event 在 PUSH_FORWARD_ALLOWLIST,补 tap 才会转发给控制端。
  tapWindowBroadcast(channel, payload);
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      win.webContents.send(channel, payload);
    } catch (e) {
      log.warn(`broadcast to window failed: ${String(e)}`);
    }
  }
}

function rewrapProjectAutomationError(err: unknown): never {
  if (err instanceof Error && typeof (err as { code?: unknown }).code === 'string') {
    throw err;
  }
  const msg = err instanceof Error ? err.message : String(err);
  if (/not found/i.test(msg)) throwIpcError('NOT_FOUND', msg);
  if (/invalid|workingDir|required|json|parse/i.test(msg)) {
    throwIpcError('INVALID_PARAMS', msg);
  }
  throwIpcError('INTERNAL', msg);
}

export function registerProjectAutomationIpc(
  loader: ProjectAutomationLoader,
): void {
  log.info('registering maker:project-automation:* IPC handlers');

  for (const ch of PROJECT_AUTOMATION_INVOKE_CHANNELS) ipcMain.removeHandler(ch);
  if (unsubscribeAutomationEvent) {
    unsubscribeAutomationEvent();
    unsubscribeAutomationEvent = null;
  }

  unsubscribeAutomationEvent = loader.onEvent((event: ProjectAutomationEvent) => {
    broadcast(MAKER_PUSH.PROJECT_AUTOMATION_EVENT, event);
  });

  ipcMain.handle(
    MAKER_INVOKE.PROJECT_AUTOMATION_RECONCILE,
    async (_e, payload: unknown): Promise<ReconcileResult> => {
      const body = requireObject(payload, 'payload');
      const workingDir = requireString(body.workingDir, 'workingDir');
      try {
        const approvedHash = body.approvedHash === undefined ? undefined : requireString(body.approvedHash, 'approvedHash');
        return await loader.reconcile(workingDir, approvedHash);
      } catch (err) {
        rewrapProjectAutomationError(err);
      }
    },
  );

  ipcMain.handle(MAKER_INVOKE.PROJECT_AUTOMATION_PENDING_IMPORTS, async () => {
    try {
      return await loader.listPendingImports();
    } catch (err) {
      rewrapProjectAutomationError(err);
    }
  });

  ipcMain.handle(MAKER_INVOKE.PROJECT_AUTOMATION_LIST_CONSENTS, async () => {
    try {
      const rows = await getDbClient().drizzle.select().from(projectAutomationConsents);
      return rows.map(projectAutomationConsentToCamel);
    } catch (err) {
      rewrapProjectAutomationError(err);
    }
  });

  ipcMain.handle(
    MAKER_INVOKE.PROJECT_AUTOMATION_REVOKE_CONSENT,
    async (_e, payload: unknown): Promise<{ deleted: number }> => {
      const body = requireObject(payload, 'payload');
      const workingDir = requireString(body.workingDir, 'workingDir');
      try {
        await getDbClient().drizzle
          .delete(projectAutomationConsents)
          .where(eq(projectAutomationConsents.workingDir, workingDir));
        const deleted = await loader.deleteProjectSchedules(workingDir);
        return { deleted };
      } catch (err) {
        rewrapProjectAutomationError(err);
      }
    },
  );

  ipcMain.handle(
    MAKER_INVOKE.PROJECT_AUTOMATION_UPSERT_SCHEDULE,
    async (_e, payload: unknown): Promise<ReconcileResult> => {
      const body = requireObject(payload, 'payload');
      const workingDir = requireString(body.workingDir, 'workingDir');
      const config = requireObject(body.config, 'config') as unknown as ProjectScheduleConfig;
      try {
        return await loader.upsertSchedule(workingDir, config);
      } catch (err) {
        rewrapProjectAutomationError(err);
      }
    },
  );

  ipcMain.handle(
    MAKER_INVOKE.PROJECT_AUTOMATION_REMOVE_SCHEDULE,
    async (_e, payload: unknown): Promise<ReconcileResult> => {
      const body = requireObject(payload, 'payload');
      const workingDir = requireString(body.workingDir, 'workingDir');
      const id = requireString(body.id, 'id');
      try {
        return await loader.removeSchedule(workingDir, id);
      } catch (err) {
        rewrapProjectAutomationError(err);
      }
    },
  );

  log.info('maker:project-automation:* IPC handlers registered');
}
