import { app, BrowserWindow, ipcMain, powerMonitor } from 'electron';
import { z } from 'zod';
import { activeDataOwnerId, ownerGeneration } from '../ownerContext.js';
import { onAppSessionInvalidated } from '../appSessionState.js';
import {
  assertTrustedAppRendererEvent,
  isTrustedAppRendererWindow,
} from '../security/trustedAppRenderer.js';
import { getKnownControllerIds } from '../device-link/subscriptions.js';
import { isResourceUsageWebContentsId } from '../resource-usage-window/registry.js';
import { isRemoteDesktopViewer } from '../remote-desktop-viewer/registry.js';
import { isRsbWindowWebContentsId } from '../right-sidebar-window/registry.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { createLogger } from '../logger.js';
import {
  TASK_MANAGEMENT_CHANNEL,
  TASK_MANAGEMENT_CHANGED,
  TASK_ARCHIVE_NOTICE,
  type TaskArchiveProtection,
} from '../../shared/taskManagement.js';
import {
  configureTaskArchivePlatform,
  refreshTaskArchiveReadiness,
  requestTaskArchiveCheck,
  taskArchiveEngine,
  updateTaskArchiveSettings,
} from './service.js';
import { taskManagementScope, taskManagementStore } from './store.js';

const ids = z.array(z.string().min(1).max(512)).max(20_000);
const log = createLogger('task-management');
const days = z.number().int().min(1).max(365);
const owner = z.strictObject({
  ownerId: z.string().min(1).max(512),
  ownerGeneration: z.number().int().nonnegative(),
});
const requestSchema = z.discriminatedUnion('operation', [
  z.strictObject({ operation: z.literal('read') }),
  z.strictObject({ operation: z.literal('reset'), owner }),
  z.strictObject({ operation: z.literal('preview'), days: days.optional() }),
  z.strictObject({
    operation: z.literal('update'),
    owner,
    patch: z.strictObject({ enabled: z.boolean().optional(), days: days.optional() }),
  }),
  z.strictObject({ operation: z.literal('undo'), owner, batchId: z.string().uuid() }),
  z.strictObject({
    operation: z.literal('protect'),
    value: owner.extend({ viewed: ids, drafts: ids }),
  }),
]);

export function registerTaskManagementIpc(): void {
  const reports = new Map<number, { scope: string; value: TaskArchiveProtection }>();
  const watched = new Set<number>();
  const windows = () => BrowserWindow.getAllWindows().filter(isTrustedAppRendererWindow);
  const broadcast = (channel: string, value: unknown) => {
    for (const window of windows()) window.webContents.send(channel, value);
  };
  configureTaskArchivePlatform({
    canRun: () => app.isPackaged || process.env.XDT_SCHEDULER_PASSIVE !== '1',
    protection() {
      const scope = taskManagementScope();
      const viewed = new Set<string>();
      const drafts = new Set<string>();
      // These registered utility surfaces load lightweight entries, not task
      // views. In particular, their hidden prewarm must not block MainLayout.
      const appWindows = windows().filter((window) => {
        const id = window.webContents.id;
        return (
          !isResourceUsageWebContentsId(id) &&
          !isRemoteDesktopViewer(id) &&
          !isRsbWindowWebContentsId(id)
        );
      });
      let ready = appWindows.length > 0;
      for (const window of appWindows) {
        const report = reports.get(window.webContents.id);
        if (report?.scope !== scope) {
          ready = false;
          continue;
        }
        report.value.viewed.forEach((id) => viewed.add(id));
        report.value.drafts.forEach((id) => drafts.add(id));
      }
      // Existing controllers do not report off-screen drafts. Treat that unknown
      // state conservatively instead of silently archiving their unsent work.
      return { ready, viewed, drafts, remoteUnknown: getKnownControllerIds().length > 0 };
    },
    notice: (value) => broadcast(TASK_ARCHIVE_NOTICE, value),
    settingsChanged: () => broadcast(TASK_MANAGEMENT_CHANGED, { ownerId: activeDataOwnerId() }),
  });
  onAppSessionInvalidated(() => {
    reports.clear();
    taskArchiveEngine.invalidate();
    refreshTaskArchiveReadiness();
  });
  powerMonitor.on('resume', () => {
    requestTaskArchiveCheck();
  });
  ipcMain.handle(TASK_MANAGEMENT_CHANNEL, async (event, raw: unknown) => {
    assertTrustedAppRendererEvent(event);
    const parsed = requestSchema.safeParse(raw);
    if (!parsed.success) throwIpcError('INVALID_PARAMS', 'Invalid task management request');
    const request = parsed.data;
    const scope = taskManagementScope();
    const stamp =
      'owner' in request ? request.owner : request.operation === 'protect' ? request.value : null;
    if (
      stamp &&
      (stamp.ownerId !== activeDataOwnerId() || stamp.ownerGeneration !== ownerGeneration())
    ) {
      throwIpcError('PRECONDITION_FAILED', 'Task owner changed');
    }
    try {
      switch (request.operation) {
        case 'read':
          return taskManagementStore.read();
        case 'preview':
          return await taskArchiveEngine.preview(request.days);
        case 'undo': {
          const result = await taskArchiveEngine.undo(request.batchId);
          if (scope !== taskManagementScope())
            throwIpcError('PRECONDITION_FAILED', 'Task owner changed');
          broadcast(TASK_MANAGEMENT_CHANGED, { ownerId: activeDataOwnerId() });
          return result;
        }
        case 'protect': {
          if (request.value.ownerId !== activeDataOwnerId())
            throwIpcError('PRECONDITION_FAILED', 'Task owner changed');
          const id = event.sender.id;
          if (!watched.has(id)) {
            watched.add(id);
            event.sender.once('destroyed', () => {
              reports.delete(id);
              watched.delete(id);
              refreshTaskArchiveReadiness();
            });
            event.sender.on('did-start-loading', () => {
              reports.delete(id);
              refreshTaskArchiveReadiness();
            });
          }
          reports.set(id, { scope, value: request.value });
          refreshTaskArchiveReadiness();
          return;
        }
        case 'reset':
        case 'update': {
          return await updateTaskArchiveSettings(
            request.operation === 'reset' ? null : request.patch,
          );
        }
      }
    } catch (error) {
      const code = (error as { code?: string })?.code;
      if (code === 'PRECONDITION_FAILED' || code === 'INVALID_PARAMS') throw error;
      log.warn('Task management request failed', { operation: request.operation });
      throwIpcError('INTERNAL', 'Task management is temporarily unavailable');
    }
  });
}
