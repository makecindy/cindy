import { z } from "zod";
import type { LiziMcpSessionContext } from "../types.js";
import type { XdtHelperToolRegistry } from "../lizi_xdtHelperToolRegistry.js";
import { errorPayload, okPayload } from "./_payload.js";

export interface WorkspaceMigrationRequest {
  callerSessionId: string;
  callerSessionInstanceId: string;
  action: "preview" | "request" | "status" | "cancel";
  teammateId: string;
  target?: string;
}

export interface WorkspaceMigrationCallbacks {
  run(
    request: WorkspaceMigrationRequest,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>>;
}

export function registerWorkspaceMigrationTool(
  registry: XdtHelperToolRegistry,
  deps: {
    getSessionContext(): LiziMcpSessionContext;
    callbacks: WorkspaceMigrationCallbacks;
  },
): void {
  registry.register({
    name: "teammate_workspace_migration",
    category: "bots",
    description:
      "Move an existing buddy workspace to another LOCAL disk/directory when the user asks. Use its exact local id from list_agents. preview checks a NEW absolute target folder (its parent must exist); request records the move for the next full host restart, without stopping Cindy or copying live data. Tell the user it is scheduled, not moved, and to close external programs using that workspace before restarting normally. The host then copies and verifies files/links, keeps the old logical path as a junction/symlink so scripts and schedules still work, and recovers interrupted cutovers. status reports the real result; after an uncertain request read status before retrying. cancel withdraws pending/failed intent or a stale intermediate receipt only when the host proves the original has been restored; copies remain. A startupWarning means the recorded phase may be stale: inspect workspaceAvailable and the warning rather than claiming the move completed. MIGRATION_WAITING_FOR_EXCLUSIVE_STARTUP requires closing other instances sharing this profile and starting the original host version; personal preview versions defer execution. On failed, the original stays authoritative; inspect the reason and retained copy paths before requesting a different empty target. Scope is the workspace (including V2 project memory), not the entire Bot Home, V1 memory archive or another computer. First relocation only: an already redirected workspace (including a completed move) cannot be moved again. WORKSPACE_ALREADY_REDIRECTED means keep its existing link and data; do not unlink it or retry with filesystem commands. For newly created buddies, users can configure the default Buddy workspace directory in Settings > Storage. request/cancel follow the current task permission mode.",
    inputShape: {
      action: z.enum(["preview", "request", "status", "cancel"]),
      teammate_id: z.string().min(1).max(200),
      target_directory: z.string().min(1).max(4096).optional(),
    },
    handler: async ({ action, teammate_id, target_directory }, signal) => {
      const context = deps.getSessionContext();
      if (
        !context.sessionId ||
        !context.sessionInstanceId ||
        context.remoteHostId
      )
        return errorPayload(
          "LOCAL_SESSION_REQUIRED",
          "Use an active task on the computer that stores this buddy workspace.",
        );
      if (
        (action === "preview" || action === "request") !==
        (target_directory !== undefined)
      )
        return errorPayload(
          "INVALID_ARGS",
          "preview/request require target_directory; status/cancel do not accept it.",
        );
      try {
        return okPayload(
          await deps.callbacks.run(
            {
              action,
              teammateId: teammate_id,
              callerSessionId: context.sessionId,
              callerSessionInstanceId: context.sessionInstanceId,
              ...(target_directory ? { target: target_directory } : {}),
            },
            signal,
          ),
        );
      } catch (cause) {
        return errorPayload(
          "WORKSPACE_MIGRATION_FAILED",
          cause instanceof Error ? cause.message : "Workspace migration failed",
        );
      }
    },
  });
}
