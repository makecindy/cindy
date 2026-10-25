import { eq } from "drizzle-orm";
import { sessions } from "@cindy/runtime-db/schema";
import type { DbClient } from "@cindy/runtime-db";
import { throwIpcError } from "@cindy/remote-agent/ipcValidate";
import type { createSessionRouteLock } from "./sessionRouteLock.js";

export type SessionRestoreOptions = {
  routeLockHeld?: boolean;
  signal?: AbortSignal;
};
export function createArchivedSessionRestore<Owner>(host: {
  getDbClient(): DbClient;
  captureOwnerScope(): Owner;
  isOwnerScopeCurrent(owner: Owner): boolean;
  withSessionRouteLock: ReturnType<
    typeof createSessionRouteLock
  >["withSessionRouteLock"];
  patchSessionMetaInDb(
    id: string,
    patch: { status: "active" },
    options: SessionRestoreOptions,
  ): Promise<unknown>;
}) {
  const {
    getDbClient,
    captureOwnerScope,
    isOwnerScopeCurrent,
    withSessionRouteLock,
    patchSessionMetaInDb,
  } = host;
  /** Sending continues an ordinary archived task. Serialize with archive/delete and
   * use the normal status writer so native projection and all clients see active. */
  async function restoreArchivedSessionForSend(
    sessionId: string,
    options: { routeLockHeld?: boolean; signal?: AbortSignal } = {},
  ): Promise<void> {
    const ownerScope = captureOwnerScope();
    const db = getDbClient().drizzle;
    const restore = async () => {
      const [row] = await db
        .select({
          status: sessions.status,
          source: sessions.source,
          orcaRole: sessions.orcaRole,
          orcaRemoteLead: sessions.orcaRemoteLead,
        })
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .limit(1);
      if (!isOwnerScopeCurrent(ownerScope))
        throwIpcError("PRECONDITION_FAILED", "Task owner changed");
      if (row?.status === "deleted")
        throwIpcError("NOT_FOUND", "Session does not exist");
      if (row?.status !== "archived") return;
      if (
        row.source === "bot" ||
        row.orcaRole === "worker" ||
        row.orcaRemoteLead
      ) {
        throwIpcError(
          "PRECONDITION_FAILED",
          "Restore the managed task before continuing",
        );
      }
      await patchSessionMetaInDb(
        sessionId,
        { status: "active" },
        { ...options, routeLockHeld: true },
      );
    };
    if (options.routeLockHeld) await restore();
    else await withSessionRouteLock(sessionId, restore);
  }

  return restoreArchivedSessionForSend;
}
