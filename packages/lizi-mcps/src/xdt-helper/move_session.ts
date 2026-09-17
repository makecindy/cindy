import { z } from "zod";
import type { ControlResult, LiziMcpSessionContext } from "../types.js";
import type { XdtHelperToolRegistry } from "../lizi_xdtHelperToolRegistry.js";
import { errorPayload, okPayload } from "./_payload.js";

export type MoveSessionCallback = (params: {
  callerSessionId: string;
  sessionId: string;
  workingDir: string | null;
}) => Promise<
  ControlResult<
    {
      sessionId: string;
      workingDir: string | null;
      workspaceKind: string;
    },
    string
  >
>;

export function registerMoveSessionTool(
  registry: XdtHelperToolRegistry,
  deps: {
    getSessionContext: () => LiziMcpSessionContext;
    moveSession: MoveSessionCallback;
  },
): void {
  registry.register({
    name: "move_session",
    category: "control",
    description:
      "Move an existing local Cindy task into a project or between projects. Pass an existing absolute directory as working_dir. Pass null to remove the project grouping while retaining the task’s working directory, matching the UI. Reuses Cindy’s task move path, including transcript relocation and idle runtime refresh; does not move project files or create a task. Running tasks (including a lead with running workers), IM-controlled tasks, archived/deleted tasks, Bot-owned tasks and Review tasks cannot move. SSH tasks are unsupported. Cannot move the calling task while it is executing this tool. Use list_sessions to find session_id and list_projects to find directories; create_project restores a hidden project.",
    inputShape: {
      session_id: z.string().trim().min(1).max(256),
      working_dir: z.string().trim().min(1).max(4096).nullable(),
    },
    handler: async ({ session_id, working_dir }) => {
      const context = deps.getSessionContext();
      if (!context.sessionId)
        return errorPayload(
          "NO_SESSION_CONTEXT",
          "No Cindy task is bound to this call.",
        );
      if (context.remoteHostId)
        return errorPayload(
          "UNSUPPORTED_CAPABILITY",
          "Moving tasks is only supported from local tasks.",
        );
      if (session_id === context.sessionId)
        return errorPayload(
          "PRECONDITION_FAILED",
          "Cannot move the calling task while it is running.",
        );
      const result = await deps.moveSession({
        callerSessionId: context.sessionId,
        sessionId: session_id,
        workingDir: working_dir,
      });
      return result.ok
        ? okPayload({
            session_id: result.sessionId,
            working_dir: result.workingDir,
            workspace_kind: result.workspaceKind,
          })
        : errorPayload(result.errorCode, result.message);
    },
  });
}
