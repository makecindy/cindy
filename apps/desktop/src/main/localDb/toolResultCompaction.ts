import { createLogger } from '../logger.js';
import { drainPersistQueue } from '../messagePersistBroadcaster.js';
import type { DbClient } from './client/DbClient.js';

const log = createLogger('localDb/toolResultCompaction');

export async function compactSessionToolResultsBestEffort(options: {
  client: DbClient;
  sessionId: string;
}): Promise<void> {
  try {
    // Archive/delete must remain responsive, so callers fire-and-forget this
    // whole helper. Drain only the writes already queued at the status boundary;
    // the compaction transaction itself stays outside the global persist queue.
    await drainPersistQueue();
    const result = await options.client.tx('toolResults.compactSession', {
      sessionId: options.sessionId,
      now: Date.now(),
    });
    if (result.compactedRows > 0) {
      log.info('task tool results compacted', {
        sessionId: options.sessionId,
        rows: result.compactedRows,
        originalBytes: result.originalBytes,
      });
    }
  } catch (error) {
    log.warn('task tool result compaction failed', {
      sessionId: options.sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
