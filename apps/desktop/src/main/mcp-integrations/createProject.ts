import { BrowserWindow } from 'electron';
import { getActiveDataOwnerPushStamp, isAppSessionBoundaryPending } from '../appSessionState.js';
import { tryGetDbClient } from '../localDb/client/current.js';
import { dialogueWorkspaceRoots } from '../localDb/dialogueWorkspace.js';
import { normalizeRecentWorkdirPath, upsertRecentWorkdir } from '../localDb/ipc/recentWorkdirs.js';
import { restoreLocalProjectVisibility } from '../sidebarSettingsStore.js';
import { createLogger } from '../logger.js';
import { isTrustedAppRendererWindow } from '../security/trustedAppRenderer.js';
import { createProjectRegistration } from '@cindy/app-runtime/projectRegistration';
export type { LocalProjectContext } from '@cindy/app-runtime/projectRegistration';
const log = createLogger('mcp/projects');
export const {
  createProject,
  withLocalProjectContext,
  validateLocalProjectDirectory,
  validateExistingLocalProjectDirectory,
} = createProjectRegistration({
  logger: log,
  getActiveDataOwnerPushStamp,
  isAppSessionBoundaryPending,
  tryGetDbClient,
  dialogueWorkspaceRoots,
  normalizeRecentWorkdirPath,
  upsertRecentWorkdir,
  restoreLocalProjectVisibility,
  broadcastRegistered(directory, owner) {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!isTrustedAppRendererWindow(window)) continue;
      try {
        window.webContents.send('local-db:recent-workdirs:changed', { path: directory }, owner);
      } catch (error) {
        log.warn('project registered but window refresh failed', { error: String(error) });
      }
    }
  },
});
