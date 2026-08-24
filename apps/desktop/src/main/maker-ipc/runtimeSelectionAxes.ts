import type { AgentKind, Effort } from '@cindy/maker-core';

interface RuntimeSelectionAxesSession {
  agentKind: AgentKind;
  setEffort: (effort: Effort) => Promise<void>;
  setFastMode: (enabled: boolean) => Promise<void>;
}

export interface ApplyRuntimeSelectionAxesWithRecoveryInput {
  session: RuntimeSelectionAxesSession;
  effort: Effort | null;
  fastMode: boolean;
  commitControlStores: () => void;
  restoreControlStores: () => void;
  terminateSession: () => Promise<void>;
}

/**
 * Finishes the effort/Fast half of an already-applied model switch.
 *
 * Harness control calls are not transactional. If either axis rejects after the
 * model/provider changed, restore the old host-side routing stores and retire the
 * partially-mutated Session. The next send then rebuilds from the still-current
 * runtime-control generation instead of exposing a mixed live profile.
 */
export async function applyRuntimeSelectionAxesWithRecovery(
  input: ApplyRuntimeSelectionAxesWithRecoveryInput,
): Promise<void> {
  try {
    if (input.effort !== null) await input.session.setEffort(input.effort);
    if (input.session.agentKind === 'codex') {
      await input.session.setFastMode(input.fastMode);
    }
  } catch (axisError) {
    input.restoreControlStores();
    try {
      await input.terminateSession();
    } catch (terminationError) {
      throw new AggregateError(
        [axisError, terminationError],
        'runtime selection axis update and session recovery both failed',
      );
    }
    throw axisError;
  }
  input.commitControlStores();
}
