import { BrowserWindow } from 'electron';
import * as creation from './createProjectCore.js';
import * as management from './projectManagementCore.js';
import { broadcastProjectAliasesChanged } from '../localDb/ipc/projectAliases.js';
import {
  captureDataOwnerBroadcastScope,
  isDataOwnerBroadcastScopeCurrent,
  tapWindowBroadcast,
} from '../device-link/broadcast-tap.js';
import { isTrustedAppRendererWindow } from '../security/trustedAppRenderer.js';
import { createLogger } from '../logger.js';

const log = createLogger('mcp/projects');

export async function createProject(input: Parameters<typeof creation.createProject>[0]) {
  const scope = captureDataOwnerBroadcastScope();
  const result = await creation.createProject(input);
  if (result.ok && isDataOwnerBroadcastScopeCurrent(scope)) {
    broadcastProjectAliasesChanged(scope);
    const payload = { path: result.workingDir };
    for (const window of BrowserWindow.getAllWindows()) {
      if (!isTrustedAppRendererWindow(window)) continue;
      try {
        window.webContents.send('local-db:recent-workdirs:changed', payload, scope.ownerStamp);
      } catch (error) {
        log.warn('project registered but window refresh failed', { error: String(error) });
      }
    }
    tapWindowBroadcast('local-db:recent-workdirs:changed', payload, scope.ownerStamp);
  }
  return result;
}

export async function renameProject(input: Parameters<typeof management.renameProject>[0]) {
  const scope = captureDataOwnerBroadcastScope();
  const result = await management.renameProject(input);
  if (result.ok) broadcastProjectAliasesChanged(scope);
  return result;
}

export const removeProject = management.removeProject;
