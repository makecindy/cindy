import { z } from "zod";
import type { XdtHelperToolRegistry } from "../lizi_xdtHelperToolRegistry.js";
import type { ControlResult, LiziMcpSessionContext } from "../types.js";
import { errorPayload, okPayload } from "./_payload.js";

export type CreateProjectCallback = (params: {
  callerSessionId: string;
  workingDir?: string;
  name?: string;
  repositoryUrl?: string;
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
      "Create a Cindy project or add an existing directory on the selected computer. Omit working_dir to allocate a directory using this computer's project location preference, common project parent or ~/Projects; name supplies the folder name and collisions receive a number. Paste a GitHub, GitLab (including self-hosted) or Git HTTPS/SSH URL in repository_url to clone; a manually selected clone directory must be empty. Git uses the selected computer's existing access. Does not publish a repository or send a message. Use list_projects first to reuse related projects. Return project_path to send_to_session. Existing directories can also restore hidden projects.",
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
    }: {
      working_dir?: string;
      name?: string;
      repository_url?: string;
      device?: string;
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
      });
      return result.ok
        ? okPayload({
            working_dir: result.workingDir,
            project_path: result.workingDir,
          })
        : errorPayload(result.errorCode, result.message);
    },
  });
}
