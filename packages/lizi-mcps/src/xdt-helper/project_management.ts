import { z } from "zod";
import type { ControlResult, LiziMcpSessionContext } from "../types.js";
import type { XdtHelperToolRegistry } from "../lizi_xdtHelperToolRegistry.js";
import { errorPayload, okPayload } from "./_payload.js";

export interface ProjectManagementCallbacks {
  list(params: {
    callerSessionId: string;
    includeHidden: boolean;
    offset: number;
    limit: number;
  }): Promise<
    ControlResult<
      {
        projects: Array<{
          workingDir: string;
          directoryName: string;
          alias: string | null;
          hidden: boolean;
          exists: boolean;
          lastUsedAt: string;
        }>;
        total: number;
        nextOffset: number | null;
      },
      string
    >
  >;
  rename(params: {
    callerSessionId: string;
    workingDir: string;
    name: string;
  }): Promise<
    ControlResult<{ workingDir: string; alias: string | null }, string>
  >;
  remove(params: {
    callerSessionId: string;
    workingDir: string;
  }): Promise<ControlResult<{ workingDir: string; removed: boolean }, string>>;
}

export function registerProjectManagementTools(
  registry: XdtHelperToolRegistry,
  deps: {
    getSessionContext: () => LiziMcpSessionContext;
    callbacks: ProjectManagementCallbacks;
  },
): void {
  const workingDir = z
    .string()
    .trim()
    .min(1)
    .max(4096)
    .describe("Exact working_dir returned by list_projects.");
  async function call<T extends object>(
    run: (callerSessionId: string) => Promise<ControlResult<T, string>>,
    format: (data: T) => Record<string, unknown>,
  ) {
    const context = deps.getSessionContext();
    if (!context.sessionId)
      return errorPayload(
        "NO_SESSION_CONTEXT",
        "No Cindy task is bound to this call.",
      );
    if (context.remoteHostId)
      return errorPayload(
        "UNSUPPORTED_CAPABILITY",
        "Project management only supports local Cindy tasks.",
      );
    const result = await run(context.sessionId);
    return result.ok
      ? okPayload(format(result))
      : errorPayload(result.errorCode, result.message);
  }
  registry.register({
    name: "list_projects",
    category: "control",
    description:
      "List registered projects on the local Cindy host, including empty projects with no tasks. Returns working_dir, directory_name, custom display alias (null means default), hidden state and whether the directory exists. The sidebar may disambiguate identical directory names with parent paths; always identify targets by working_dir. Hidden projects are included by default so they can be restored. Use next_offset for the next page. Unlike list_workdirs, this reads the project list rather than task history. Unavailable from SSH tasks.",
    inputShape: {
      include_hidden: z.boolean().default(true),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(500).default(100),
    },
    handler: ({ include_hidden, offset, limit }) =>
      call(
        (callerSessionId) =>
          deps.callbacks.list({
            callerSessionId,
            includeHidden: include_hidden,
            offset,
            limit,
          }),
        (data) => ({
          projects: data.projects.map((row) => ({
            working_dir: row.workingDir,
            directory_name: row.directoryName,
            alias: row.alias,
            hidden: row.hidden,
            exists: row.exists,
            last_used_at: row.lastUsedAt,
          })),
          total: data.total,
          next_offset: data.nextOffset,
        }),
      ),
  });
  registry.register({
    name: "rename_project",
    category: "control",
    description:
      'Change a registered local Cindy project’s display name. Only changes its Cindy alias, never the filesystem directory or task working directories. Pass name="" to restore its default directory-derived name. Find the exact working_dir with list_projects first. Does not change visibility.',
    inputShape: {
      working_dir: workingDir,
      name: z
        .string()
        .trim()
        .max(80)
        .describe(
          "New display name, or empty string to restore the default name.",
        ),
    },
    handler: ({ working_dir, name }) =>
      call(
        (callerSessionId) =>
          deps.callbacks.rename({
            callerSessionId,
            workingDir: working_dir,
            name,
          }),
        (data) => ({
          working_dir: data.workingDir,
          alias: data.alias,
        }),
      ),
  });
  registry.register({
    name: "remove_project",
    category: "control",
    description:
      "Remove a registered local project from Cindy’s sidebar. Existing tasks remain available as projectless chats; files, tasks and aliases are preserved. Does not archive or stop tasks. Find the exact working_dir with list_projects first. Repeating removal is safe. To restore the project, call create_project with the same working_dir.",
    inputShape: {
      working_dir: workingDir,
    },
    handler: ({ working_dir }) =>
      call(
        (callerSessionId) =>
          deps.callbacks.remove({
            callerSessionId,
            workingDir: working_dir,
          }),
        (data) => ({ working_dir: data.workingDir, removed: data.removed }),
      ),
  });
}
