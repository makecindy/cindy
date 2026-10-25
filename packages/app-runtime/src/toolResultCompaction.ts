import type { DbClient } from "@cindy/runtime-db/client/DbClient";
import type { DbLogger } from "@cindy/runtime-db/logging";

export function createToolResultCompaction(host: {
  logger: DbLogger;
  drainPersistQueue(): Promise<void>;
}) {
  const { logger: log, drainPersistQueue } = host;

  async function compactSessionToolResultsBestEffort(options: {
    client: DbClient;
    sessionId: string;
  }): Promise<void> {
    try {
      // Archive/delete must remain responsive, so callers fire-and-forget this
      // whole helper. Drain only the writes already queued at the status boundary;
      // the compaction transaction itself stays outside the global persist queue.
      await drainPersistQueue();
      const result = await options.client.tx("toolResults.compactSession", {
        sessionId: options.sessionId,
        now: Date.now(),
      });
      if (result.compactedRows > 0) {
        log.info("task tool results compacted", {
          sessionId: options.sessionId,
          rows: result.compactedRows,
          originalBytes: result.originalBytes,
        });
      }
    } catch (error) {
      log.warn("task tool result compaction failed", {
        sessionId: options.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return {
    compactSessionToolResultsBestEffort,
  };
}
