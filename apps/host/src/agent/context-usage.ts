import { recordSessionContextSnapshotWith } from '../../../desktop/src/main/localDb/sessionContextSnapshotPersistence.ts';
import * as broadcastTap from '../../../desktop/src/main/device-link/broadcast-tap.js';
import { createLogger } from '../../../desktop/src/main/logger.ts';

/**
 * A task's context usage (tokens used, window) written back to its row, as the desktop's
 * recordSessionContextSnapshot (sessionSpendBroadcaster.ts) writes it: the same shared writer with the
 * same rules. The model-window gate reads these columns for a task without a live runtime
 * (resolveModelSwitchContextTokens); without them the row stayed at its default 0, taken as known
 * usage.
 *
 * Ports bound here: the data owner scope capture and check, as sessionSpendBroadcaster.ts binds them
 * (the same broadcast tap); the logger. The broadcast of the written usage is not done on the Host
 * yet (release table, context usage write-back: the write is done, the broadcast is the third
 * batch), so that port does nothing.
 */
const ports = {
  captureOwnerScope: () => broadcastTap.captureDataOwnerBroadcastScope?.() ?? null,
  isOwnerScopeCurrent: (scope: ReturnType<typeof broadcastTap.captureDataOwnerBroadcastScope> | null) =>
    scope === null || broadcastTap.isDataOwnerBroadcastScopeCurrent?.(scope) !== false,
  broadcastContext: () => {},
  log: createLogger('host-context-usage'),
};

export function recordHostContextSnapshot(sessionId: string, contextTokens: number, contextWindow: number): Promise<void> {
  return recordSessionContextSnapshotWith(ports, sessionId, contextTokens, contextWindow);
}
