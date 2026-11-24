import { promises as fsp } from 'node:fs';
import { BrowserWindow } from 'electron';
import { activeOwnerScopeKey, isAppSessionBoundaryPending } from '../appSessionState.js';
import { getDbClient, tryGetDbClient } from '../localDb/client/current.js';
import { getPluginHostToolCaller } from '../mcp-integrations/hostToolCaller.js';
import { assertTaskActionCurrent, captureTaskActionSyncGuard } from '../maker-ipc/taskActionAuthorization.js';
import { getGhostHandoffStore } from '../cindy-brain/handoffStore.desktop.js';
import { sanitizeSaveFileName, writeNewSaveFile } from '../cindy-brain/dirDeposit.js';
import { createLogger } from '../logger.js';
import { readTaskExportDirectory } from '../task-export-settings.js';
import { captureDataOwnerBroadcastScope } from '../device-link/broadcast-tap.js';
import { handleIncomingShareFile } from '../deepLink.js';
import { exportSessionShare } from './sessionShareExport.js';
import { inspectShareFile, inspectShareBytes, cancelShareDraft } from './sessionShareImport.js';
import { chooseSessionShareExportPath, commitSessionShareOnHost, sessionShareExportFileName } from './sessionShareHost.desktop.js';
import { createSessionShareToolCallbacks } from './sessionShareTools.js';

const log = createLogger('session-share-tools');

/**
 * The Settings export folder as the canonical path recorded when the owner approved it (the
 * shared callbacks verify it still resolves to itself). A set but unusable or unreadable setting
 * fails instead of opening a dialog nobody may be there to answer.
 */
async function presetExportDestination(sessionId: string) {
  const configured = await readTaskExportDirectory();
  if (!configured) return null;
  if (configured === 'unreadable' ||
    !(await fsp.stat(configured.realPath).then(stat => stat.isDirectory(), () => false))) {
    log.warn('task export directory unavailable', { unreadable: configured === 'unreadable' });
    throw new Error('EXPORT_DIRECTORY_UNAVAILABLE');
  }
  return { directory: configured.realPath, fileName: sanitizeSaveFileName(await sessionShareExportFileName(sessionId)) };
}

/** No I/O, timers or background work until a discovered tool is called. */
export function createDesktopSessionShareCallbacks() {
  return createSessionShareToolCallbacks({
    capture: async context => {
      await assertTaskActionCurrent();
      const db = getDbClient(), owner = activeOwnerScopeKey();
      const plugin = context.hostCaller ? getPluginHostToolCaller() : undefined;
      if (context.hostCaller ? !plugin || context.sessionId !== undefined ||
        context.hostCaller.pluginId !== plugin.caller.pluginId || context.hostCaller.dataOwnerId !== plugin.caller.dataOwnerId ||
        context.hostCaller.ownerGeneration !== plugin.caller.ownerGeneration : !context.sessionId) throw new Error('PERMISSION_DENIED');
      const action = captureTaskActionSyncGuard();
      const assertCurrent = () => {
        if (isAppSessionBoundaryPending() || activeOwnerScopeKey() !== owner || tryGetDbClient() !== db) throw new Error('PERMISSION_DENIED');
        plugin?.assertCurrent();
        action?.();
      };
      assertCurrent();
      return { pluginId: plugin?.caller.pluginId, assertCurrent };
    },
    exportShare: exportSessionShare,
    inspectShare: (filePath, bytes) => bytes ? inspectShareBytes(bytes, filePath) : inspectShareFile(filePath),
    commitShare: commitSessionShareOnHost,
    cancelDraft: cancelShareDraft, chooseExportPath: chooseSessionShareExportPath, handoff: getGhostHandoffStore,
    presetExportDestination,
    writeExportFile: (directory, fileName, bytes, assertCurrent) =>
      writeNewSaveFile(directory, fileName, bytes, { assertCurrent, exactCase: true }),
    openImportWizard: filePath => {
      if (!BrowserWindow.getAllWindows().some(win => !win.isDestroyed())) throw new Error('HOST_NOT_READY');
      handleIncomingShareFile(filePath, 'host-tool', captureDataOwnerBroadcastScope());
    },
  });
}
