import { BrowserWindow, ipcMain } from 'electron';
import { desc } from 'drizzle-orm';
import {
  PROJECT_ALIASES_GET_CHANNEL,
  PROJECT_ALIASES_CHANGED_CHANNEL,
  type HostProjectAliasesSnapshot,
} from '@cindy/maker-shared/project-alias-sync';

import { normalizeProjectKey, projectKeyComparisonKey } from '../../../shared/projectKeys.js';
import type { ProjectAlias } from '../../../shared/projectAliases.js';
import type { DbClient } from '../client/DbClient.js';
import { getDbClient } from '../client/current';
import { projectAliases } from '../schema';
import { requireObject, requireString, throwIpcError } from '../../utils/ipcValidate';
import {
  captureDataOwnerBroadcastScope,
  isDataOwnerBroadcastScopeCurrent,
  tapWindowBroadcast,
  type DataOwnerBroadcastScope,
} from '../../device-link/broadcast-tap.js';
import { assertTrustedAppRendererEvent, isTrustedAppRendererWindow } from '../../security/trustedAppRenderer.js';
import { isDeviceLinkInvoke } from '../../device-link/invoke-context.js';

const MAX_ALIAS_LENGTH = 80;

function aliasToCamel(row: typeof projectAliases.$inferSelect): ProjectAlias {
  return {
    projectKey: row.projectKey,
    alias: row.alias,
    updatedAt: new Date(row.updatedAt).toISOString(),
  };
}

function sanitizeAlias(raw: unknown): string | null {
  if (typeof raw !== 'string') {
    throwIpcError('INVALID_PARAMS', 'alias must be a string');
  }
  const alias = raw.trim();
  if (alias.length === 0) return null;
  if (alias.length > MAX_ALIAS_LENGTH) {
    throwIpcError('INVALID_PARAMS', `alias must be at most ${MAX_ALIAS_LENGTH} characters`);
  }
  return alias;
}

function requireProjectKey(raw: unknown): string {
  const value = requireString(raw, 'projectKey');
  const normalized = normalizeProjectKey(value);
  if (!normalized || (!normalized.startsWith('local:') && !normalized.startsWith('remote:') && !normalized.startsWith('device:'))) {
    throwIpcError('INVALID_PARAMS', 'invalid projectKey');
  }
  return normalized;
}

function broadcastProjectAliasesChanged(scope: DataOwnerBroadcastScope): void {
  if (!isDataOwnerBroadcastScopeCurrent(scope)) return;
  for (const w of BrowserWindow.getAllWindows()) {
    if (isTrustedAppRendererWindow(w)) {
      w.webContents.send(PROJECT_ALIASES_CHANGED_CHANNEL, {}, scope.ownerStamp);
    }
  }
  tapWindowBroadcast(PROJECT_ALIASES_CHANGED_CHANNEL, {}, scope.ownerStamp);
}

export async function listProjectAliases(client: DbClient = getDbClient()): Promise<ProjectAlias[]> {
  const scope = captureDataOwnerBroadcastScope();
  const db = client.drizzle;
  const rows = await db
    .select()
    .from(projectAliases)
    .orderBy(desc(projectAliases.updatedAt));
  if (!isDataOwnerBroadcastScopeCurrent(scope)) throwIpcError('NOT_FOUND', 'Owner changed');
  return rows.map(aliasToCamel);
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
  return {
    aliases: rows
      .filter((row) => row.projectKey.startsWith('local:') || row.projectKey.startsWith('remote:'))
      .map(({ projectKey, alias }) => ({ projectKey, alias })),
    platform: process.platform,
    ...(scope.ownerStamp ? { ownerStamp: scope.ownerStamp } : {}),
  };
}

export async function upsertProjectAlias(
  projectKeyRaw: unknown,
  aliasRaw: unknown,
  localPlatform: NodeJS.Platform = process.platform,
  scope?: { client: DbClient; assertCurrent: () => void },
): Promise<ProjectAlias | null> {
  const broadcastScope = captureDataOwnerBroadcastScope();
  const projectKey = requireProjectKey(projectKeyRaw);
  const alias = sanitizeAlias(aliasRaw);
  const now = Date.now();
  const workingDir = projectKey.startsWith('local:') ? projectKey.slice('local:'.length) : '';
  const foldCase =
    localPlatform === 'win32' && (/^[A-Za-z]:\//.test(workingDir) || workingDir.startsWith('//'));
  const comparisonKey = foldCase
    ? (projectKeyComparisonKey(projectKey, localPlatform) ?? projectKey)
    : projectKey;
  scope?.assertCurrent();
  const saved = await (scope?.client ?? getDbClient()).tx('projectAliases.replaceIdentity', {
    projectKey,
    comparisonKey,
    foldCase,
    alias,
    updatedAt: now,
  });
  scope?.assertCurrent();
  broadcastProjectAliasesChanged(broadcastScope);
  return saved == null
    ? null
    : {
        projectKey: saved.projectKey,
        alias: saved.alias,
        updatedAt: new Date(saved.updatedAt).toISOString(),
      };
}

export async function deleteProjectAlias(
  projectKeyRaw: unknown,
  localPlatform: NodeJS.Platform = process.platform,
): Promise<void> {
  await upsertProjectAlias(projectKeyRaw, '', localPlatform);
}

export function registerProjectAliasesIpc(): void {
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
