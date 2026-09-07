import type { AgentKind, Effort } from '@cindy/maker-core';

/** A saved automation choice, applied only while its target's send lock is held. */
export interface ScheduledModelSelection {
  agentKind: AgentKind;
  model: string;
  providerId: string | null;
  effort: Effort | null;
  fastMode: boolean;
}

export class ScheduledModelSelectionBusyError extends Error {}

/** Reuse the ordinary history handoff; never stage an automation intent on a busy task. */
export async function applyScheduledModelSelection(
  selection: ScheduledModelSelection,
  deps: {
    getTarget: () => Promise<{ agentKind: AgentKind; status: string } | null>;
    isBusy: () => boolean;
    switchHarness: (selection: ScheduledModelSelection) => Promise<{ engineReady: boolean; retryPending?: boolean }>;
    applyModel: (selection: ScheduledModelSelection) => Promise<void>;
  },
): Promise<void> {
  const target = await deps.getTarget();
  // The runner owns missing/archived target recovery, including persistent-task rebinding.
  if (!target || target.status === 'archived' || target.status === 'deleted') return;
  if (deps.isBusy()) throw new ScheduledModelSelectionBusyError('Scheduled model selection waits for the current turn');
  if (target.agentKind !== selection.agentKind) {
    const result = await deps.switchHarness(selection);
    if (!result.engineReady || result.retryPending) throw new Error('Scheduled Harness switch did not become ready');
  }
  await deps.applyModel(selection);
}
