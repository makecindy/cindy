import path from 'node:path';
import { listRecentWorkdirs } from '../localDb/ipc/recentWorkdirs.js';
import { listProjectAliases, upsertProjectAlias } from '../localDb/ipc/projectAliases.js';
import { recentWorkdirs } from '../localDb/schema.js';
import { loadSidebarSettingsSnapshot, setLocalProjectHidden } from '../sidebarSettingsStore.js';
import { projectKeyComparisonKey } from '../../shared/projectKeys.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import {
  validateLocalProjectDirectory,
  withLocalProjectContext,
  type LocalProjectContext,
} from './createProject.js';

const identity = (directory: string) =>
  projectKeyComparisonKey(`local:${directory}`, process.platform);

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
    return {
      ok: true as const,
      projects: projects.slice(params.offset, end),
      total: projects.length,
      nextOffset: end < projects.length ? end : null,
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
