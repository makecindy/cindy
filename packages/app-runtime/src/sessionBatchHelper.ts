import { assertTaskActionCurrent } from "./taskActionAuthorization.js";
import { isIpcError } from "@cindy/remote-agent/shared/ipc-errors";
import type { DbClient } from "@cindy/runtime-db";
import type { createSessionService } from "./sessionService.js";
import type { XdtHelperMcpDeps } from "@cindy/mcps";
export function createSessionBatchHelper(
  host: Pick<
    ReturnType<typeof createSessionService>,
    "renameSessionTitlesInDb" | "setSessionsStatusInDb"
  > & { tryGetDbClient(): DbClient | null },
): Pick<XdtHelperMcpDeps, "renameSessions" | "setSessionsStatus"> {
  const { tryGetDbClient, renameSessionTitlesInDb, setSessionsStatusInDb } =
    host;
  return {
    renameSessions: async ({ changes, dryRun }) => {
      if (!tryGetDbClient()) {
        return {
          ok: false,
          errorCode: "HOST_NOT_READY",
          message: "localDb not ready",
        };
      }
      try {
        const renamed = await renameSessionTitlesInDb(
          changes,
          dryRun,
          assertTaskActionCurrent,
        );
        return { ok: true, changes: renamed };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (isIpcError(err)) {
          if (err.code === "NOT_FOUND" || err.code === "PRECONDITION_FAILED") {
            return { ok: false, errorCode: err.code, message };
          }
          if (err.code === "INVALID_PARAMS") {
            return { ok: false, errorCode: "INVALID_ARGS", message };
          }
        }
        return { ok: false, errorCode: "INTERNAL", message };
      }
    },
    setSessionsStatus: async ({ sessionIds, status }) => {
      if (!tryGetDbClient()) {
        return {
          ok: false,
          errorCode: "HOST_NOT_READY",
          message: "localDb not ready",
        };
      }
      try {
        const changed = await setSessionsStatusInDb(
          sessionIds,
          status,
          assertTaskActionCurrent,
        );
        return { ok: true, changed };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (isIpcError(err)) {
          if (err.code === "NOT_FOUND" || err.code === "PRECONDITION_FAILED") {
            return { ok: false, errorCode: err.code, message };
          }
        }
        return { ok: false, errorCode: "INTERNAL", message };
      }
    },
  };
}
