import { BrowserWindow, ipcMain } from 'electron';
import { desc, eq } from 'drizzle-orm';

import { normalizeProjectKey } from '../../../shared/projectKeys.js';
import type { ProjectAlias } from '../../../shared/projectAliases.js';
import { getDbClient } from '../client/current';
import { projectAliases } from '../schema';
import { requireObject, requireString, throwIpcError } from '../../utils/ipcValidate';
import { IPC_CHANNELS } from '@cindy/cindy-ipc';

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
    if (!w.isDestroyed()) w.webContents.send(IPC_CHANNELS.LOCAL_DB.PROJECT_ALIASES_CHANGED);
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

export async function upsertProjectAlias(projectKeyRaw: unknown, aliasRaw: unknown): Promise<ProjectAlias | null> {
  const projectKey = requireProjectKey(projectKeyRaw);
  const alias = sanitizeAlias(aliasRaw);
  const db = getDbClient().drizzle;

  if (alias == null) {
    await db.delete(projectAliases).where(eq(projectAliases.projectKey, projectKey));
    broadcastProjectAliasesChanged();
    return null;
  }

  const now = Date.now();
  await db
    .insert(projectAliases)
    .values({ projectKey, alias, updatedAt: now })
    .onConflictDoUpdate({
      target: projectAliases.projectKey,
      set: { alias, updatedAt: now },
    });
  broadcastProjectAliasesChanged();
  return { projectKey, alias, updatedAt: new Date(now).toISOString() };
}

export async function deleteProjectAlias(projectKeyRaw: unknown): Promise<void> {
  const projectKey = requireProjectKey(projectKeyRaw);
  const db = getDbClient().drizzle;
  await db.delete(projectAliases).where(eq(projectAliases.projectKey, projectKey));
  broadcastProjectAliasesChanged();
}

export function registerProjectAliasesIpc(): void {
  ipcMain.handle(IPC_CHANNELS.LOCAL_DB.PROJECT_ALIASES_LIST, async () => listProjectAliases());

  ipcMain.handle(IPC_CHANNELS.LOCAL_DB.PROJECT_ALIASES_SET, async (_event, input: unknown) => {
    const body = requireObject(input, 'input');
    return upsertProjectAlias(body.projectKey, body.alias);
  });

  ipcMain.handle(IPC_CHANNELS.LOCAL_DB.PROJECT_ALIASES_DELETE, async (_event, projectKeyRaw: unknown) => {
    await deleteProjectAlias(projectKeyRaw);
  });
}
