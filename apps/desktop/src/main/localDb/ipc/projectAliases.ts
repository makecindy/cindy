import { rendererProjectRequest } from '../../projectConfirmation.desktop.js';
import { projectCreationRoot } from '../../projectCreation.js';
import { readProjectDirectories } from '../../projectDirectoryStore.js';
import { resolveAutomaticProjectIcon } from '../../projectAutomaticIcon.desktop.js';
import { readProjectIconImage, updateProjectInfo as updateProjectInfoCore } from '../../projectInfoCore.js';
import { readProjectIcons } from '../../projectIconStore.js';
import { PROJECT_SETTINGS_SET_CHANNEL, PROJECT_ICON_IMAGE_CHANNEL } from '@cindy/maker-shared/project-alias-sync';
import { BrowserWindow, ipcMain } from 'electron';
import * as core from './projectAliasesCore.js';
import {
  PROJECT_ALIASES_GET_CHANNEL,
  PROJECT_ALIASES_CHANGED_CHANNEL,
  type HostProjectAliasesSnapshot,
} from '@cindy/maker-shared/project-alias-sync';

import type { ProjectAlias } from '../../../shared/projectAliases.js';
import { emitProjectCatalogChanged } from '../../projectCatalogEvents.js';
import type { DbClient } from '../client/DbClient.js';
import { getDbClient } from '../client/current';
import { requireObject, throwIpcError } from '../../utils/ipcValidate';
import {
  captureDataOwnerBroadcastScope,
  isDataOwnerBroadcastScopeCurrent,
  tapWindowBroadcast,
  type DataOwnerBroadcastScope,
} from '../../device-link/broadcast-tap.js';
import { assertTrustedAppRendererEvent, isTrustedAppRendererWindow } from '../../security/trustedAppRenderer.js';
import { isDeviceLinkInvoke } from '../../device-link/invoke-context.js';
import type { ProjectInfoAuthorization } from '../../projectInfoAuthorization.js';

export function broadcastProjectAliasesChanged(scope: DataOwnerBroadcastScope): void {
  if (!isDataOwnerBroadcastScopeCurrent(scope)) return;
  emitProjectCatalogChanged();
  for (const w of BrowserWindow.getAllWindows()) {
    if (isTrustedAppRendererWindow(w)) {
      w.webContents.send(PROJECT_ALIASES_CHANGED_CHANNEL, {}, scope.ownerStamp);
    }
  }
  tapWindowBroadcast(PROJECT_ALIASES_CHANGED_CHANNEL, {}, scope.ownerStamp);
}

export async function listProjectAliases(client: DbClient = getDbClient()): Promise<ProjectAlias[]> {
  const scope = captureDataOwnerBroadcastScope();
  const rows = await core.listProjectAliases(client);
  if (!isDataOwnerBroadcastScopeCurrent(scope)) throwIpcError('NOT_FOUND', 'Owner changed');
  return rows;
}

/** Read-only host projection; controller-local overrides never propagate to a third device. */
export async function readHostProjectAliasesSnapshot(): Promise<HostProjectAliasesSnapshot> {
  const scope = captureDataOwnerBroadcastScope();
  const rows = await listProjectAliases().catch((error: unknown) => {
    if (!isDataOwnerBroadcastScopeCurrent(scope)) {
      throwIpcError('PRECONDITION_FAILED', 'active account changed during project alias read');
    }
    throw error;
  });
  if (!isDataOwnerBroadcastScopeCurrent(scope)) {
    throwIpcError('PRECONDITION_FAILED', 'active account changed during project alias read');
  }
  const creationRoot = await projectCreationRoot();
  if (!isDataOwnerBroadcastScopeCurrent(scope)) throwIpcError('PRECONDITION_FAILED', 'Project account changed');
  return {
    aliases: rows
      .filter((row) => row.projectKey.startsWith('local:') || row.projectKey.startsWith('remote:'))
      .map(({ projectKey, alias }) => ({ projectKey, alias })),
    icons: Object.fromEntries(Object.entries(readProjectIcons()).filter(([key]) => !key.startsWith('device:'))),
    settingsSupported: true,
    settingsVersion: 7,
    creationRoot,
    directories: readProjectDirectories(),
    platform: process.platform,
    ...(scope.ownerStamp ? { ownerStamp: scope.ownerStamp } : {}),
  };
}

export async function upsertProjectAlias(...args: Parameters<typeof core.upsertProjectAlias>): Promise<ProjectAlias | null> {
  const scope = captureDataOwnerBroadcastScope();
  const result = await core.upsertProjectAlias(...args);
  broadcastProjectAliasesChanged(scope);
  return result;
}

export async function deleteProjectAlias(
  projectKeyRaw: unknown,
  localPlatform: NodeJS.Platform = process.platform,
): Promise<void> {
  await upsertProjectAlias(projectKeyRaw, '', localPlatform);
}

export async function updateProjectInfo(
  input: unknown,
  authorization?: ProjectInfoAuthorization,
): Promise<HostProjectAliasesSnapshot> {
  const scope = captureDataOwnerBroadcastScope();
  const result = await updateProjectInfoCore(input, authorization);
  broadcastProjectAliasesChanged(scope);
  const body = requireObject(input, 'input');
  if (body.create === true && isDataOwnerBroadcastScopeCurrent(scope)) {
    for (const window of BrowserWindow.getAllWindows()) {
      if (isTrustedAppRendererWindow(window))
        window.webContents.send('local-db:recent-workdirs:changed', {}, scope.ownerStamp);
    }
    tapWindowBroadcast('local-db:recent-workdirs:changed', {}, scope.ownerStamp);
  }
  return result;
}

export function registerProjectAliasesIpc(): void {
  ipcMain.handle('sidebar-settings:get-project-auto-icon', (event, input: unknown) => {
    if (!isDeviceLinkInvoke()) assertTrustedAppRendererEvent(event);
    return resolveAutomaticProjectIcon(input);
  });
  ipcMain.handle(PROJECT_ICON_IMAGE_CHANNEL, (event, input: unknown) => {
    if (!isDeviceLinkInvoke()) assertTrustedAppRendererEvent(event);
    return readProjectIconImage(input);
  });
  ipcMain.handle(PROJECT_SETTINGS_SET_CHANNEL, (event, input: unknown) => {
    if (isDeviceLinkInvoke()) return updateProjectInfo(input, { kind: 'host' });
    return updateProjectInfo(input, rendererProjectRequest(event, input));
  });
  ipcMain.handle(PROJECT_ALIASES_GET_CHANNEL, async (event) => {
    if (!isDeviceLinkInvoke()) assertTrustedAppRendererEvent(event);
    return readHostProjectAliasesSnapshot();
  });
  ipcMain.handle('local-db:project-aliases:list', async () => {
    const rows = await listProjectAliases();
    return isDeviceLinkInvoke()
      ? rows.filter(row => row.projectKey.startsWith('local:') || row.projectKey.startsWith('remote:'))
      : rows;
  });

  ipcMain.handle('local-db:project-aliases:set', async (_event, input: unknown) => {
    const body = requireObject(input, 'input');
    return upsertProjectAlias(body.projectKey, body.alias);
  });

  ipcMain.handle('local-db:project-aliases:delete', async (_event, projectKeyRaw: unknown) => {
    await deleteProjectAlias(projectKeyRaw);
  });
}
