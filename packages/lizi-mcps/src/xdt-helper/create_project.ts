import { z } from "zod";
import type { XdtHelperToolRegistry } from "../lizi_xdtHelperToolRegistry.js";
import type { ControlResult, LiziMcpSessionContext } from "../types.js";
import { errorPayload, okPayload } from "./_payload.js";

export type CreateProjectCallback = (params: {
  callerSessionId: string;
  workingDir?: string;
  name?: string;
  repositoryUrl?: string;
  icon?: string | null;
  directories?: Array<{ path: string; access: 'read' | 'write' }>;
  device?: string;
}) => Promise<ControlResult<{ workingDir: string }, string>>;

export function registerCreateProjectTool(
  registry: XdtHelperToolRegistry,
  deps: {
    getSessionContext: () => LiziMcpSessionContext;
    createProject: CreateProjectCallback;
  },
): void {
  registry.register({
    name: "create_project",
    category: "control",
    description:
      "Create a Cindy project or add an existing directory on the selected computer (device; omitted means local). Omit working_dir to allocate a directory using this computer's project location preference, common project parent or ~/Projects; name supplies the folder name and collisions receive a number. Paste a GitHub, GitLab (including self-hosted) or Git HTTPS/SSH URL in repository_url to clone; an explicit clone directory must be empty. Git uses the selected computer's existing access. Set icon and directories in this same call to match the creation form; directories are additional roots, the returned project_path is the main directory. New directories default to write. Creation, repository access and directory grants go through the task's existing per-call permissions. Does not publish a repository or send a message. Use only when the user has asked to create, register or restore a project. Opening a session needs no project creation. Use list_projects to reuse related projects. Pass the returned project_path to send_to_session, or project_key with the same device to get_project_info/update_project_info. Existing directories can also restore hidden projects.",
    inputShape: {
      device: z
        .string()
        .min(1)
        .max(128)
        .optional()
        .describe(
          "Computer ID from list_machines; omitted or local means this computer.",
        ),
      name: z
        .string()
        .trim()
        .max(80)
        .optional()
        .describe("Project name; defaults to the repository name or Project."),
      repository_url: z
        .string()
        .trim()
        .max(4096)
        .optional()
        .describe(
          "GitHub, GitLab or Git clone URL. Omit for an empty project.",
        ),
      icon: z.string().max(300_000).nullable().optional().describe(
        'Same formats as update_project_info: emoji, symbol:<Lucide name>[:color], text:<1-2 letters/numbers>[:color], or PNG/JPEG/WebP data URI; null restores automatic artwork.',
      ),
      directories: z.array(z.object({
        path: z.string().trim().min(1).max(4096),
        access: z.enum(['read', 'write']).default('write'),
      }).strict()).max(10).optional().describe('Other existing directories on the selected computer, excluding the main directory. Paths must not overlap. Omitted preserves existing project directories; [] removes them.'),
      working_dir: z
        .string()
        .trim()
        .min(1)
        .max(4096)
        .describe(
          "Optional existing directory on the selected computer; omit to allocate automatically.",
        )
        .optional(),
    },
    handler: async ({
      working_dir,
      name,
      repository_url,
      device,
      icon,
      directories,
    }: {
      working_dir?: string;
      name?: string;
      repository_url?: string;
      device?: string;
      icon?: string | null;
      directories?: Array<{ path: string; access: 'read' | 'write' }>;
    }) => {
      const context = deps.getSessionContext();
      if (!context.sessionId)
        return errorPayload(
          "NO_SESSION_CONTEXT",
          "No Cindy task is bound to this call.",
        );
      if (context.remoteHostId)
        return errorPayload(
          "UNSUPPORTED_CAPABILITY",
          "Project registration only supports local Cindy tasks.",
        );
      const result = await deps.createProject({
        callerSessionId: context.sessionId,
        workingDir: working_dir,
        ...(name !== undefined ? { name } : {}),
        ...(repository_url !== undefined
          ? { repositoryUrl: repository_url }
          : {}),
        ...(device !== undefined ? { device } : {}),
        ...(icon !== undefined ? { icon } : {}),
        ...(directories !== undefined ? { directories } : {}),
      });
      return result.ok
        ? okPayload({
            working_dir: result.workingDir,
            project_path: result.workingDir,
            project_key: `local:${result.workingDir}`,
            device: device ?? 'local',
          })
        : errorPayload(result.errorCode, result.message);
    },
  });
}
