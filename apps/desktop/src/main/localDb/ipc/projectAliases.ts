import { BrowserWindow, ipcMain } from 'electron';
import { desc } from 'drizzle-orm';

import { normalizeProjectKey, projectKeyComparisonKey } from '../../../shared/projectKeys.js';
import type { ProjectAlias } from '../../../shared/projectAliases.js';
import { getDbClient } from '../client/current';
import { projectAliases } from '../schema';
import { requireObject, requireString, throwIpcError } from '../../utils/ipcValidate';

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

function broadcastProjectAliasesChanged(): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('local-db:project-aliases:changed');
  }
}

export async function listProjectAliases(): Promise<ProjectAlias[]> {
  const db = getDbClient().drizzle;
  const rows = await db
    .select()
    .from(projectAliases)
    .orderBy(desc(projectAliases.updatedAt));
  return rows.map(aliasToCamel);
}

export async function upsertProjectAlias(
  projectKeyRaw: unknown,
  aliasRaw: unknown,
  localPlatform: NodeJS.Platform = process.platform,
): Promise<ProjectAlias | null> {
  const projectKey = requireProjectKey(projectKeyRaw);
  const alias = sanitizeAlias(aliasRaw);
  const now = Date.now();
  const workingDir = projectKey.startsWith('local:') ? projectKey.slice('local:'.length) : '';
  const foldCase =
    localPlatform === 'win32' && (/^[A-Za-z]:\//.test(workingDir) || workingDir.startsWith('//'));
  const comparisonKey = foldCase
    ? (projectKeyComparisonKey(projectKey, localPlatform) ?? projectKey)
    : projectKey;
  const saved = await getDbClient().tx('projectAliases.replaceIdentity', {
    projectKey,
    comparisonKey,
    foldCase,
    alias,
    updatedAt: now,
  });
  broadcastProjectAliasesChanged();
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
  ipcMain.handle('local-db:project-aliases:list', async () => listProjectAliases());

  ipcMain.handle('local-db:project-aliases:set', async (_event, input: unknown) => {
    const body = requireObject(input, 'input');
    return upsertProjectAlias(body.projectKey, body.alias);
  });

  ipcMain.handle('local-db:project-aliases:delete', async (_event, projectKeyRaw: unknown) => {
    await deleteProjectAlias(projectKeyRaw);
  });
}
