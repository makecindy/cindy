import type { AgentInputCoordinator } from "./agent-input-coordinator.js";
import { resolveSessionQueueCounts } from "./sessionQueueInspection.js";

/** GUI and Node expose the coordinator's authoritative queue, including active steering. */
export function createSessionQueueReader(deps: {
  getSessionMeta(sessionId: string): Promise<unknown>;
  inputCoordinator: Pick<
    AgentInputCoordinator,
    | "ensureQueueRestored"
    | "isQueueRestored"
    | "getQueueInspection"
    | "getQueueInspectionIfRestored"
  >;
  loadAgentInputQueueSnapshotCounts(
    sessionIds: readonly string[],
  ): Promise<Record<string, number>>;
  isDbClientNotReadyError(error: unknown): boolean;
}) {
  const {
    loadAgentInputQueueSnapshotCounts,
    isDbClientNotReadyError,
  } = deps;
  return {
    listSessionQueue: async (sessionId: string) => {
      try {
        const meta = await deps.getSessionMeta(sessionId);
        if (!meta) {
          return {
            ok: false as const,
            errorCode: "NOT_FOUND" as const,
            message: `session ${sessionId} not found`,
          };
        }
        await deps.inputCoordinator.ensureQueueRestored(sessionId);
        if (!deps.inputCoordinator.isQueueRestored(sessionId)) {
          return {
            ok: false as const,
            errorCode: "INTERNAL" as const,
            message: `queue restore incomplete for ${sessionId}`,
          };
        }
        return {
          ok: true as const,
          messages: deps.inputCoordinator.getQueueInspection(sessionId),
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          ok: false as const,
          errorCode: isDbClientNotReadyError(err)
            ? ("HOST_NOT_READY" as const)
            : ("INTERNAL" as const),
          message,
        };
      }
    },
    listSessionQueuedCounts: async (sessionIds: readonly string[]) => {
      try {
        const counts = await resolveSessionQueueCounts(sessionIds, {
          getLiveQueue: (sessionId) =>
            deps.inputCoordinator.getQueueInspectionIfRestored(sessionId),
          loadPersistedCounts: loadAgentInputQueueSnapshotCounts,
        });
        return { ok: true as const, counts };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          ok: false as const,
          errorCode: isDbClientNotReadyError(err)
            ? ("HOST_NOT_READY" as const)
            : ("INTERNAL" as const),
          message,
        };
      }
    },
  };
}
