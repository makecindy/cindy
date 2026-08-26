import { createLogger } from '../logger.js';
import type { DbClient } from './client/DbClient.js';

export const TOOL_RESULT_COMPACTION_MIN_BYTES = 16 * 1024;

const log = createLogger('localDb/toolResultCompaction');

export async function compactSessionToolResultsBestEffort(options: {
  client: DbClient;
  sessionId: string;
}): Promise<void> {
  try {
    const result = await options.client.tx('toolResults.compactSession', {
      sessionId: options.sessionId,
      now: Date.now(),
      minContentBytes: TOOL_RESULT_COMPACTION_MIN_BYTES,
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
