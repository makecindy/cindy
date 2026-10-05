import { persistCancelledCreationDraft } from './mobileDurableOutbox';
import { dismissRecoveredPrecreatedSession } from './newSessionCreation';
import type { PendingPrecreatedWorktree } from './precreatedWorktreeRecovery';

/** Keep the recovery ledger until its matching draft is durably safe to resubmit. */
export async function completePrecreatedWorktreeRecovery(record: PendingPrecreatedWorktree): Promise<void> {
  await persistCancelledCreationDraft(record);
  dismissRecoveredPrecreatedSession(record);
}
