import { z } from "zod";
import type { ControlResult, LiziMcpSessionContext } from "../types.js";
import type { XdtHelperToolRegistry } from "../lizi_xdtHelperToolRegistry.js";
import { errorPayload, okPayload } from "./_payload.js";

export interface ProjectManagementCallbacks {
  inspectIcon?(params: {
    callerSessionId: string;
    device?: string;
    projectKey: string;
  }): Promise<ControlResult<{ icon: unknown }, string>>;
  updateInfo?(params: {
    callerSessionId: string;
    device?: string;
    projectKey: string;
    field: "name" | "icon" | "profile";
    value: string | null | { name?: string; icon?: string | null };
  }): Promise<ControlResult<{ saved: boolean }, string>>;
  list(params: {
    callerSessionId: string;
    device?: string;
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
        projectsRoot: {
          path: string;
          source: "setting" | "inferred" | "default";
          exists: boolean;
        };
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
      "List registered projects on the selected Cindy computer (device; omitted means local), including empty projects. Use the returned project_path to select an existing visible project when creating a task with send_to_session. working_dir is the same project directory for rename/remove operations. Returns directory_name, display alias, hidden state and whether the directory exists. Identify projects by path, not display name. Hidden projects are included by default; restore explicitly with create_project before selecting one. Also returns projects_root: where new project folders go on this computer (source=setting is the user's choice; inferred/default are suggestions, so confirm the location with the user before creating a folder there; exists=false means it has not been created yet). Use next_offset for pagination. Unlike list_workdirs, this is the project catalog, not task execution directory history. Unavailable from SSH tasks.",
    inputShape: {
      device: z
        .string()
        .trim()
        .min(1)
        .max(128)
        .optional()
        .describe(
          "查询哪台电脑的项目；取 list_machines 的 machines.computers[].deviceId，省略或 local 为本机。返回的项目路径只用于同一电脑。",
        ),
      include_hidden: z.boolean().default(true),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(500).default(100),
    },
    handler: ({ include_hidden, offset, limit, device }) =>
      call(
        (callerSessionId) =>
          deps.callbacks.list({
            callerSessionId,
            ...(device !== undefined ? { device } : {}),
            includeHidden: include_hidden,
            offset,
            limit,
          }),
        (data) => ({
          device: device ?? "local",
          projects: data.projects.map((row) => ({
            working_dir: row.workingDir,
            project_path: row.workingDir,
            directory_name: row.directoryName,
            alias: row.alias,
            hidden: row.hidden,
            exists: row.exists,
            last_used_at: row.lastUsedAt,
          })),
          total: data.total,
          next_offset: data.nextOffset,
          projects_root: data.projectsRoot,
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
  if (deps.callbacks.inspectIcon)
    registry.register({
      name: "get_project_icon",
      category: "control",
      description:
        "Find the project's automatic icon and source on its owning computer. Returns a cached PNG data URI and whether it is only a GitHub account-avatar candidate. Does not change a manual icon. To restore automatic defaults use update_project_info with field=icon and value=null; adopting a candidate requires explicitly setting its image data URI.",
      inputShape: {
        device: z.string().optional(),
        project_key: z.string().min(1).max(4096),
      },
      handler: ({ device, project_key }) =>
        call(
          (callerSessionId) =>
            deps.callbacks.inspectIcon!({
              callerSessionId,
              device,
              projectKey: project_key,
            }),
          (data) => data,
        ),
    });
  if (deps.callbacks.updateInfo)
    registry.register({
      name: "update_project_info",
      category: "control",
      description:
        "Set a project's display name or icon on this computer or another connected computer (device). project_key is local:<full directory> or remote:<URL-encoded SSH host id>:<full directory> on that target. Does not move files. For name use a string up to 80 characters, empty restores default. For icon use one emoji, symbol:<Lucide name> (e.g. Rocket, Code, Folder), optionally symbol:<Lucide name>:<color> with the tag palette red/orange/yellow/green/blue/purple/gray/pink/coral/teal/indigo/white (requires target settingsVersion >= 3; omit color for theme default), text:<1-2 letters/numbers> with optional :<color> from the same palette (letter colors require target settingsVersion >= 5), or PNG/JPEG/WebP data URI (at most 300000 characters). null restores automatic project artwork (falling back to a theme-adaptive letter tile derived from the project name). To save both together use field=profile and value={name,icon}. Uploaded images are cropped square and stored on the target computer.",
      inputShape: {
        device: z.string().optional(),
        project_key: z.string().min(1).max(4096),
        field: z.enum(["name", "icon", "profile"]),
        value: z.union([
          z.string().max(300_000).nullable(),
          z
            .object({
              name: z.string().max(80).optional(),
              icon: z.string().max(300_000).nullable().optional(),
            })
            .strict(),
        ]),
      },
      handler: ({ device, project_key, field, value }) =>
        call(
          (callerSessionId) =>
            deps.callbacks.updateInfo!({
              callerSessionId,
              device,
              projectKey: project_key,
              field,
              value,
            }),
          (data) => data,
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
