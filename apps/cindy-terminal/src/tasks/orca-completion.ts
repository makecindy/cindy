import {
  createPluginWorkerCompletionReader,
  readPluginWorkerActivity,
} from "@cindy/app-runtime/pluginWorkerCompletion";
import { PluginTaskError } from "@cindy/plugin-runtime/pluginTaskService";
import type { TerminalTaskHost } from "./host.js";

/** Completion and release use the same durable evidence as the graphical host. */
export async function readTerminalWorkerCompletion(
  host: TerminalTaskHost,
  id: string,
  status: string,
) {
  await (await host.storage.runtime()).persistence.drainPersistQueue();
  const database = await host.storage.database();
  const owner = database.getCurrentDbClientSnapshot();
  if (!owner)
    throw new PluginTaskError(
      "HOST_NOT_READY",
      "Task storage unavailable",
      true,
    );
  const read = createPluginWorkerCompletionReader({
    getCurrentDbClientSnapshot: () => database.getCurrentDbClientSnapshot(),
    getWorkerFlowStatus: async (sessionId) => {
      const flow = (await host.invoke("maker:input:get-projection", [
        sessionId,
      ])) as { pendingQueue: unknown[]; queuePaused: boolean };
      return {
        isWorking: host.isTurnRunning(sessionId),
        queuedCount: flow.pendingQueue.length,
        queuePaused: flow.queuePaused,
      };
    },
  });
  const completion = await read(owner, id, status);
  if (!completion.row || completion.row.status === "deleted")
    throw new PluginTaskError("TASK_NOT_FOUND", "Task is unavailable");
  const activity = await readPluginWorkerActivity(
    owner,
    id,
    completion.row.createdAt,
  );
  if (database.getCurrentDbClientSnapshot() !== owner)
    throw new PluginTaskError("PERMISSION_DENIED", "Account changed");
  return {
    ...completion,
    row: completion.row,
    ...activity,
    startedAt: completion.row.activeTurnStartedAt,
    endedAt: completion.row.lastTurnEndedAt,
  };
}
