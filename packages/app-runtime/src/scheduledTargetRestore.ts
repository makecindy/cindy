import { eq } from "drizzle-orm";
import type { AgentKind } from "@cindy/maker-core";
import { dbToMakerAgentKind } from "@cindy/maker-shared/agent-kind-conversion";
import { isReviewSessionSource } from "@cindy/maker-shared/session-source";
import { sessions } from "@cindy/runtime-db/schema";
import { throwIpcError } from "@cindy/remote-agent/ipcValidate";
import type { SchedulerDrizzleDb } from "./scheduleStorage.js";
import path from "node:path";
import { managedWorktreeBaseRepo as getManagedWorktreeBasePath } from "@cindy/maker-shared/worktree-paths";
import type {
  SessionRowSnapshot,
  createSessionSnapshot,
} from "@cindy/runtime-db/sessionSnapshot";
import type { createSessionRouteLock } from "./sessionRouteLock.js";
import type { createArchivedSessionRestore } from "./sessionRestore.js";
import type { createWorktreeRestore } from "@cindy/worktree-core/restore";
type ScheduledTargetLifecycle = Pick<
  SessionRowSnapshot,
  "source" | "orcaRole" | "orcaRemoteLead"
>;

/** Service-owned tasks keep their existing archive/retirement lifecycle. */
export function isManagedScheduledTarget(
  target: ScheduledTargetLifecycle,
): boolean {
  return (
    target.source === "bot" ||
    target.source === "review" ||
    target.orcaRole === "worker" ||
    !!target.orcaRemoteLead
  );
}

export function createScheduledTargetRestore(host: {
  getSessionRowSnapshotStrict: ReturnType<
    typeof createSessionSnapshot
  >["getSessionRowSnapshotStrict"];
  restoreArchivedSessionForSend: ReturnType<
    typeof createArchivedSessionRestore
  >;
  withSessionRouteLock: ReturnType<
    typeof createSessionRouteLock
  >["withSessionRouteLock"];
  getManagedWorktreeReadinessForSession: ReturnType<
    typeof createWorktreeRestore
  >["getManagedWorktreeReadinessForSession"];
}) {
  const {
    getSessionRowSnapshotStrict,
    restoreArchivedSessionForSend,
    withSessionRouteLock,
    getManagedWorktreeReadinessForSession,
  } = host;
  /** Scheduled input uses the ordinary restore boundary, including its managed-task
   * exclusions and multi-device status broadcast. Never archive again after a run. */
  async function restoreScheduledTarget(
    sessionId: string,
    target: Pick<SessionRowSnapshot, "status" | "workingDir" | "remoteHostId"> &
      ScheduledTargetLifecycle,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    if (isManagedScheduledTarget(target)) return;
    const dir = target.workingDir;
    const managed =
      !target.remoteHostId &&
      dir &&
      getManagedWorktreeBasePath(path.resolve(dir).replace(/\\/g, "/"));
    if (target.status !== "archived" && !managed) return;
    await withSessionRouteLock(sessionId, async () => {
      signal?.throwIfAborted();
      if (target.status === "archived") {
        await restoreArchivedSessionForSend(sessionId, {
          routeLockHeld: true,
          signal,
        });
      } else {
        const current = await getSessionRowSnapshotStrict(sessionId);
        if (
          !current ||
          current.status === "archived" ||
          current.status === "deleted"
        ) {
          throw new Error(
            "Scheduled target became unavailable during preparation",
          );
        }
      }
      // Hooks run before native session startup. Reuse send-time snapshot recovery
      // before either a hook or an Agent can touch a recycled managed worktree.
      if (managed && dir) {
        const ready = await getManagedWorktreeReadinessForSession(
          sessionId,
          dir,
        );
        if (ready !== "ready")
          throw new Error("Scheduled task worktree could not be restored");
      }
      signal?.throwIfAborted();
    });
  }

  return restoreScheduledTarget;
}

interface ScheduledModelTarget {
  agentKind: AgentKind;
  status: string;
  remoteHostId?: string | null;
  orcaRole?: string | null;
}
/** Enforce the existing runtime boundary at save time as well as dispatch. */
export function assertScheduledHarnessSupported(
  target: ScheduledModelTarget | null,
  agentKind: AgentKind | undefined,
): void {
  if (
    target?.status !== "active" ||
    !agentKind ||
    target.agentKind === agentKind
  )
    return;
  // Orca Lead/Worker use the ordinary handoff transaction, including restoration
  // before the next manual send. Only SSH still lacks cross-Harness handoff.
  if (target.remoteHostId) {
    throwIpcError(
      "SSH_HARNESS_SWITCH_UNSUPPORTED",
      "SSH automation targets must keep their current Harness",
    );
  }
}

/** Keep missing/deleted target retirement in the runner, as in Desktop. */
export function createScheduledTargetValidator(
  getDb: () => SchedulerDrizzleDb,
) {
  return async (
    targetSessionId: string,
    _operation: unknown,
    selection: { modelAgentKind?: AgentKind },
  ) => {
    const [row] = await getDb()
      .select({
        source: sessions.source,
        agentKind: sessions.agentKind,
        status: sessions.status,
        remoteHostId: sessions.remoteHostId,
        orcaRole: sessions.orcaRole,
      })
      .from(sessions)
      .where(eq(sessions.id, targetSessionId))
      .limit(1);
    if (isReviewSessionSource(row?.source)) {
      throw new Error(
        "Review tasks cannot be targets of scheduled automations",
      );
    }
    assertScheduledHarnessSupported(
      row
        ? {
            ...row,
            agentKind: dbToMakerAgentKind(row.agentKind),
          }
        : null,
      selection.modelAgentKind,
    );
  };
}
