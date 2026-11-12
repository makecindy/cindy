import { z } from "zod";
import type { XdtHelperToolRegistry } from "../lizi_xdtHelperToolRegistry.js";
import type { ControlResult, LiziMcpSessionContext } from "../types.js";
import { errorPayload, okPayload } from "./_payload.js";

export type CreateProjectCallback = (params: {
  callerSessionId: string;
  workingDir: string;
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
      "Explicitly add an existing local directory to Cindy’s project list, or restore a hidden project. Use list_projects first and reuse an existing project for related work; temporary execution directories and worktrees do not need their own projects. Does not create directories, initialize Git, create a task, or start an agent. Pass the returned project_path to send_to_session to select this project; working_dir there may differ. Repeating this call reuses the same project. Runs on the Cindy host; unavailable from SSH tasks.",
    inputShape: {
      working_dir: z
        .string()
        .trim()
        .min(1)
        .max(4096)
        .describe(
          "Absolute path of an existing directory on the local Cindy host.",
        ),
    },
    handler: async ({ working_dir }: { working_dir: string }) => {
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
      });
      return result.ok
        ? okPayload({ working_dir: result.workingDir, project_path: result.workingDir })
        : errorPayload(result.errorCode, result.message);
    },
  });
}
