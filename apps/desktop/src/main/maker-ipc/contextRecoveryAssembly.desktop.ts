import { isAppSessionBoundaryPending } from '../appSessionState.js';
import { getCurrentDbClientSnapshot } from '../localDb/client/current.js';
import { messageToCamel } from '../localDb/mapper.js';
import { markOversizedInputSkippedRow } from '../localDb/messageMutations.js';
import { contextRecoveryAbortSignal, type RecoveryCallbackPorts } from './contextRecoveryAssembly.js';
import type { ClaimedOversizedInput } from './contextOverflowRollover.js';

type DesktopRecoveryPorts = Omit<RecoveryCallbackPorts, 'persistSkippedOversizedInput'> & {
  enqueueDurableWrite: typeof import('../messagePersistBroadcaster.desktop.js').enqueueDurableWrite;
  broadcastMessageRow: typeof import('../localDb/ipc/messages.js').broadcastMessageRow;
  isCurrentTurn(claim: ClaimedOversizedInput): boolean;
  log: { warn(message: string, detail: Record<string, unknown>): void };
};

export function desktopContextRecoveryAbortSignal(
  ports: DesktopRecoveryPorts, sessionId: string, claim?: ClaimedOversizedInput,
): AbortSignal {
  const owner = getCurrentDbClientSnapshot();
  const isCurrentOwner = () =>
    owner !== null && getCurrentDbClientSnapshot() === owner && !isAppSessionBoundaryPending();
  return contextRecoveryAbortSignal({
    getCoordinator: ports.getCoordinator,
    resetWireNotes: ports.resetWireNotes,
    persistSkippedOversizedInput: (id, clientId) => {
      if (!owner || !isCurrentOwner()) return;
      void ports.enqueueDurableWrite('oversized-input-skipped', async (scope) => {
        if (!isCurrentOwner()) return;
        const row = await markOversizedInputSkippedRow(owner.client, id, clientId);
        if (row && isCurrentOwner()) ports.broadcastMessageRow(id, messageToCamel(row), scope);
      }).catch(() => ports.log.warn('Could not save the skipped input notice', { sessionId: id }));
    },
  }, sessionId, claim && isCurrentOwner() && ports.isCurrentTurn(claim) ? claim : undefined);
}
