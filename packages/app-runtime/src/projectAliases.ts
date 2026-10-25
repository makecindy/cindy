import {desc} from 'drizzle-orm';
import {normalizeProjectKey,projectKeyComparisonKey} from '@cindy/maker-shared/project-keys';
import type {DbClient} from '@cindy/runtime-db';
import {projectAliases} from '@cindy/runtime-db/schema';
import {requireObject,requireString,throwIpcError} from '@cindy/remote-agent/ipcValidate';
import type {MessageServiceHost} from './messageServiceHost.js';
export interface ProjectAlias {projectKey:string;alias:string;updatedAt:string}
export function createProjectAliases<Event>(host:{getDbClient():DbClient;broadcastProjectAliasesChanged():void;ipcMain:MessageServiceHost<Event>['ipc']}) {
 const {getDbClient,broadcastProjectAliasesChanged,ipcMain}=host;
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

async function listProjectAliases(client: DbClient = getDbClient()): Promise<ProjectAlias[]> {
  const db = client.drizzle;
  const rows = await db
    .select()
    .from(projectAliases)
    .orderBy(desc(projectAliases.updatedAt));
  return rows.map(aliasToCamel);
}

async function upsertProjectAlias(
  projectKeyRaw: unknown,
  aliasRaw: unknown,
  localPlatform: NodeJS.Platform = process.platform,
  scope?: { client: DbClient; assertCurrent: () => void },
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
  scope?.assertCurrent();
  const saved = await (scope?.client ?? getDbClient()).tx('projectAliases.replaceIdentity', {
    projectKey,
    comparisonKey,
    foldCase,
    alias,
    updatedAt: now,
  });
  scope?.assertCurrent();
  broadcastProjectAliasesChanged();
  return saved == null
    ? null
    : {
        projectKey: saved.projectKey,
        alias: saved.alias,
        updatedAt: new Date(saved.updatedAt).toISOString(),
      };
}

async function deleteProjectAlias(
  projectKeyRaw: unknown,
  localPlatform: NodeJS.Platform = process.platform,
): Promise<void> {
  await upsertProjectAlias(projectKeyRaw, '', localPlatform);
}

function registerProjectAliasesIpc(): void {
  ipcMain.handle('local-db:project-aliases:list', async () => listProjectAliases());

  ipcMain.handle('local-db:project-aliases:set', async (_event, input: unknown) => {
    const body = requireObject(input, 'input');
    return upsertProjectAlias(body.projectKey, body.alias);
  });

  ipcMain.handle('local-db:project-aliases:delete', async (_event, projectKeyRaw: unknown) => {
    await deleteProjectAlias(projectKeyRaw);
  });
}

return {listProjectAliases,upsertProjectAlias,deleteProjectAlias,registerProjectAliasesIpc};
}
