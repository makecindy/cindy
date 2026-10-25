import path from "node:path";
import { recentWorkdirs } from "@cindy/runtime-db/schema";
import { projectKeyComparisonKey } from "@cindy/maker-shared/project-keys";
import { throwIpcError } from "@cindy/remote-agent/ipcValidate";
import type {
  LocalProjectContext,
  createProjectRegistration,
} from "./projectRegistration.js";
import type { createRecentWorkdirs } from "./recentWorkdirs.js";
import type { createProjectAliases } from "./projectAliases.js";
import type { SidebarSettingsShape } from "./sidebarSettingsDocument.js";
import type { DataOwnerPushStamp } from "@cindy/maker-shared/dataOwnerPush";
export type ProjectManagementHost = Pick<
  ReturnType<typeof createProjectRegistration>,
  "validateLocalProjectDirectory" | "withLocalProjectContext"
> &
  Pick<ReturnType<typeof createRecentWorkdirs>, "listRecentWorkdirs"> &
  Pick<
    ReturnType<typeof createProjectAliases>,
    "listProjectAliases" | "upsertProjectAlias"
  > & {
    loadSidebarSettingsSnapshot(): SidebarSettingsShape;
    setLocalProjectHidden(
      directory: string,
      hidden: boolean,
      owner: DataOwnerPushStamp,
    ): Promise<boolean>;
  };

export function createProjectManagement(host: ProjectManagementHost) {
  const {
    listRecentWorkdirs,
    listProjectAliases,
    upsertProjectAlias,
    loadSidebarSettingsSnapshot,
    setLocalProjectHidden,
    validateLocalProjectDirectory,
    withLocalProjectContext,
  } = host;

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
    const match = rows.find(
      (row) => identity(row.path) === identity(directory),
    );
    if (!match)
      throwIpcError(
        "NOT_FOUND",
        "Project is not registered. Use list_projects to find it or create_project to add it.",
      );
    return match.path;
  }

  async function listProjects(params: {
    callerSessionId: string;
    includeHidden: boolean;
    offset: number;
    limit: number;
  }) {
    return withLocalProjectContext(params.callerSessionId, (context) =>
      listRegisteredProjects(context, params),
    );
  }
  async function listRegisteredProjects(
    context: LocalProjectContext,
    params: { includeHidden: boolean; offset: number; limit: number },
  ) {
    context.assertCurrent();
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
  }

  async function renameProject(params: {
    callerSessionId: string;
    workingDir: string;
    name: string;
  }) {
    const directory = validateLocalProjectDirectory(params.workingDir);
    if (!directory.ok) return directory;
    return withLocalProjectContext(params.callerSessionId, (context) =>
      renameRegisteredProject(context, directory.workingDir, params.name),
    );
  }
  async function renameRegisteredProject(
    context: LocalProjectContext,
    directory: string,
    name: string,
  ) {
    context.assertCurrent();
    const workingDir = await requireRegisteredProject(context, directory);
    const saved = await upsertProjectAlias(
      `local:${workingDir}`,
      name,
      process.platform,
      context,
    );
    return {
      ok: true as const,
      workingDir,
      alias: saved?.alias ?? null,
    };
  }

  async function removeProject(params: {
    callerSessionId: string;
    workingDir: string;
  }) {
    const directory = validateLocalProjectDirectory(params.workingDir);
    if (!directory.ok) return directory;
    return withLocalProjectContext(params.callerSessionId, (context) =>
      removeRegisteredProject(context, directory.workingDir),
    );
  }
  async function removeRegisteredProject(
    context: LocalProjectContext,
    directory: string,
  ) {
    context.assertCurrent();
    const workingDir = await requireRegisteredProject(context, directory);
    await setLocalProjectHidden(workingDir, true, context.owner);
    context.assertCurrent();
    return { ok: true as const, workingDir, removed: true };
  }
  return {
    listProjects,
    renameProject,
    removeProject,
    listRegisteredProjects,
    renameRegisteredProject,
    removeRegisteredProject,
  };
}
