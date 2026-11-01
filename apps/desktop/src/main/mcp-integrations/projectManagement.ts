import { stat } from 'node:fs/promises';
import path from 'node:path';
import { app } from 'electron';
import { eq } from 'drizzle-orm';
import { collapseWorktreeDirForGrouping } from '@cindy/maker-shared/worktree-paths';
import { getActiveDataOwnerPushStamp, isAppSessionBoundaryPending } from '../appSessionState.js';
import { tryGetDbClient } from '../localDb/client/current.js';
import { listRecentWorkdirs } from '../localDb/ipc/recentWorkdirs.js';
import { listProjectAliases, upsertProjectAlias } from '../localDb/ipc/projectAliases.js';
import { recentWorkdirs, sessions } from '../localDb/schema.js';
import { loadSidebarSettingsSnapshot, setLocalProjectHidden } from '../sidebarSettingsStore.js';
import { projectKeyComparisonKey } from '../../shared/projectKeys.js';
import type { ProjectsRootState } from '../../shared/projectsRoot.js';
import { readProjectsRootDirectory } from '../projects-root-settings.js';
import type { DbClient } from '../localDb/client/DbClient.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import {
  validateLocalProjectDirectory,
  validateExistingLocalProjectDirectory,
  withLocalProjectContext,
  type LocalProjectContext,
} from './createProject.js';

const identity = (directory: string) =>
  projectKeyComparisonKey(`local:${directory}`, process.platform);

/** Self-inspection only: reads current membership without touching the catalog. */
export async function readCurrentSessionProject(sessionId: string) {
  const client = tryGetDbClient();
  if (!client || isAppSessionBoundaryPending()) throw new Error('Project storage unavailable');
  const owner = getActiveDataOwnerPushStamp();
  const [row] = await client.drizzle.select({
    projectDir: sessions.projectDir,
    workingDir: sessions.workingDir,
    workspaceKind: sessions.workspaceKind,
    remoteHostId: sessions.remoteHostId,
  }).from(sessions).where(eq(sessions.id, sessionId)).limit(1);
  const current = getActiveDataOwnerPushStamp();
  if (isAppSessionBoundaryPending() || tryGetDbClient() !== client ||
      current.dataOwnerId !== owner.dataOwnerId || current.ownerGeneration !== owner.ownerGeneration)
    throw new Error('Active account changed');
  if (!row) throw new Error('Calling task unavailable');
  return {
    projectDir: row.workspaceKind === 'dialogue' ? null
      : row.projectDir ?? (row.workingDir ? collapseWorktreeDirForGrouping(row.workingDir) : null),
    workspaceKind: row.workspaceKind,
    remoteHostId: row.remoteHostId,
  };
}

/** Metadata edits remain usable even when a registered directory is temporarily offline. */
async function requireRegisteredProject(
  context: LocalProjectContext,
  directory: string,
): Promise<string> {
  const rows = await context.client.drizzle
    .select({ path: recentWorkdirs.path })
    .from(recentWorkdirs);
  context.assertCurrent();
  const match = rows.find((row) => identity(row.path) === identity(directory));
  if (!match)
    throwIpcError(
      'NOT_FOUND',
      'Project is not registered. Use list_projects to find it or create_project to add it.',
    );
  return match.path;
}

/** Selecting a task's project is read-only: never register or restore a directory. */
export async function resolveSessionProject(params: {
  callerSessionId: string;
  /** undefined inherits the persisted source; null explicitly creates a dialogue. */
  projectDir?: string | null;
}) {
  return withLocalProjectContext(params.callerSessionId, async (context) => {
    let selected = params.projectDir;
    if (selected === undefined) {
      const source = await readCurrentSessionProject(params.callerSessionId);
      context.assertCurrent();
      if (source.workspaceKind === 'dialogue') selected = null;
      else if (source.workspaceKind === 'project' && source.projectDir) selected = source.projectDir;
      else return { ok: false as const, errorCode: 'INVALID_ARGS',
        message: '无法确定来源任务的项目。请指定已有项目的 project_path，或传 null 创建不绑项目的任务。' };
    }
    if (selected === null) return { ok: true as const, projectDir: null };
    const directory = validateLocalProjectDirectory(selected);
    if (!directory.ok) return directory;
    const projectDir = await requireRegisteredProject(context, directory.workingDir);
    const hidden = loadSidebarSettingsSnapshot().hiddenProjectKeys.some(
      (key) => projectKeyComparisonKey(key, process.platform) === identity(projectDir),
    );
    if (hidden) return { ok: false as const, errorCode: 'INVALID_ARGS',
      message: '项目已移除，请选择 list_projects 中的可见项目；确需恢复时显式调用 create_project。' };
    const checked = await validateExistingLocalProjectDirectory(projectDir);
    if (!checked.ok) return checked;
    context.assertCurrent();
    return { ok: true as const, projectDir };
  });
}

/** Most recently used parent shared by at least two projects; ties keep the newer one. */
export function inferProjectsRoot(directories: readonly string[], platform = process.platform): string | null {
  const counts = new Map<string, { parent: string; count: number }>();
  for (const directory of directories) {
    const parent = path.dirname(directory);
    if (parent === directory) continue;
    const key = platform === 'win32' ? parent.toLowerCase() : parent;
    const entry = counts.get(key) ?? { parent, count: 0 };
    entry.count++;
    counts.set(key, entry);
  }
  let best: { parent: string; count: number } | null = null;
  for (const entry of counts.values()) {
    if (entry.count >= 2 && (!best || entry.count > best.count)) best = entry;
  }
  return best?.parent ?? null;
}

/**
 * Explicit choice first, then visible existing projects, then ~/Projects. Never writes.
 * Callers that already listed the catalog pass it to avoid a second scan.
 */
export async function resolveProjectsRoot(
  client: DbClient,
  catalog?: ReadonlyArray<{ path: string; exists: boolean }>,
): Promise<ProjectsRootState> {
  const setting = readProjectsRootDirectory();
  let root: Omit<ProjectsRootState, 'exists'>;
  if (setting) {
    root = { path: setting, source: 'setting' };
  } else {
    const hidden = new Set(
      loadSidebarSettingsSnapshot().hiddenProjectKeys.map((key) =>
        projectKeyComparisonKey(key, process.platform),
      ),
    );
    const visible = (catalog ?? (await listRecentWorkdirs(client)))
      .filter((row) => row.exists && !hidden.has(identity(row.path)))
      .map((row) => row.path);
    const inferred = inferProjectsRoot(visible);
    root = inferred
      ? { path: inferred, source: 'inferred' }
      : { path: path.join(app.getPath('home'), 'Projects'), source: 'default' };
  }
  const exists = await stat(root.path).then((info) => info.isDirectory(), () => false);
  return { ...root, exists };
}

export async function listProjects(params: {
  callerSessionId: string;
  includeHidden: boolean;
  offset: number;
  limit: number;
}) {
  return withLocalProjectContext(params.callerSessionId, async (context) => {
    const [directories, aliases] = await Promise.all([
      listRecentWorkdirs(context.client),
      listProjectAliases(context.client),
    ]);
    context.assertCurrent();
    const hidden = new Set(
      loadSidebarSettingsSnapshot().hiddenProjectKeys.map((key) =>
        projectKeyComparisonKey(key, process.platform),
      ),
    );
    const names = new Map<string | null, string>();
    // Aliases arrive newest first; keep that choice for legacy Windows variants.
    for (const row of aliases) {
      const key = projectKeyComparisonKey(row.projectKey, process.platform);
      if (!names.has(key)) names.set(key, row.alias);
    }
    const projects = directories
      .map((row) => {
        const key = identity(row.path);
        const alias = names.get(key) ?? null;
        return {
          workingDir: row.path,
          directoryName: path.basename(row.path) || row.path,
          alias,
          hidden: hidden.has(key),
          exists: row.exists,
          lastUsedAt: row.lastUsedAt,
        };
      })
      .filter((row) => params.includeHidden || !row.hidden);
    const end = params.offset + params.limit;
    const projectsRoot = await resolveProjectsRoot(context.client, directories);
    context.assertCurrent();
    return {
      ok: true as const,
      projects: projects.slice(params.offset, end),
      total: projects.length,
      nextOffset: end < projects.length ? end : null,
      projectsRoot,
    };
  });
}

export async function renameProject(params: {
  callerSessionId: string;
  workingDir: string;
  name: string;
}) {
  const directory = validateLocalProjectDirectory(params.workingDir);
  if (!directory.ok) return directory;
  return withLocalProjectContext(params.callerSessionId, async (context) => {
    const workingDir = await requireRegisteredProject(context, directory.workingDir);
    const saved = await upsertProjectAlias(
      `local:${workingDir}`,
      params.name,
      process.platform,
      context,
    );
    return {
      ok: true as const,
      workingDir,
      alias: saved?.alias ?? null,
    };
  });
}

export async function removeProject(params: { callerSessionId: string; workingDir: string }) {
  const directory = validateLocalProjectDirectory(params.workingDir);
  if (!directory.ok) return directory;
  return withLocalProjectContext(params.callerSessionId, async (context) => {
    const workingDir = await requireRegisteredProject(context, directory.workingDir);
    await setLocalProjectHidden(workingDir, true, context.owner);
    return { ok: true as const, workingDir, removed: true };
  });
}
