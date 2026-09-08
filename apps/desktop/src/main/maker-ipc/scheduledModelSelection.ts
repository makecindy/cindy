import type { AgentKind, Effort } from '@cindy/maker-core';
import { effectiveSourceIdForModel, findCatalogModel, type ProviderView } from '@cindy/model-providers';
import { resolveCompatibleSessionRuntimeEffort } from './sessionRuntimeControl';

/** A saved automation choice, applied only while its target's send lock is held. */
export interface ScheduledModelSelection {
  agentKind: AgentKind;
  model: string;
  providerId: string | null;
  effort: Effort | null;
  fastMode: boolean;
}

export class ScheduledModelSelectionBusyError extends Error {}

interface ScheduledModelTarget {
  agentKind: AgentKind;
  status: string;
  remoteHostId?: string | null;
  orcaRole?: string | null;
}

/** Enforce the existing runtime boundary at save time as well as dispatch. */
export function assertScheduledHarnessSupported(
  target: ScheduledModelTarget | null,
  agentKind: AgentKind | undefined,
): void {
  if (target?.status !== 'active' || !agentKind || target.agentKind === agentKind) return;
  if (target.remoteHostId || target.orcaRole) {
    throw new Error('SSH and Orca automation targets must keep their current Harness');
  }
}

/** Saved selections may outlive catalog effort tiers; resolve the actual route first. */
export function resolveScheduledModelSelection(
  selection: ScheduledModelSelection,
  providers: ProviderView[],
): ScheduledModelSelection {
  const providerId = selection.providerId ??
    effectiveSourceIdForModel(providers, null, selection.model, selection.agentKind);
  const provider = providers.find((candidate) => candidate.id === providerId);
  const model = findCatalogModel(provider, selection.model, selection.agentKind, { exact: true });
  if (!provider?.connected || !model) {
    throw new Error(`Scheduled model "${selection.model}" is unavailable from provider "${providerId ?? 'default'}"`);
  }
  return { ...selection, providerId, effort: resolveCompatibleSessionRuntimeEffort(model, selection.effort) };
}

/** Reuse the ordinary history handoff; never stage an automation intent on a busy task. */
export async function applyScheduledModelSelection(
  selection: ScheduledModelSelection,
  deps: {
    getTarget: () => Promise<ScheduledModelTarget | null>;
    isBusy: () => boolean;
    resolveSelection: (selection: ScheduledModelSelection) => Promise<ScheduledModelSelection>;
    switchHarness: (selection: ScheduledModelSelection) => Promise<{ engineReady: boolean; retryPending?: boolean }>;
    applyModel: (selection: ScheduledModelSelection) => Promise<void>;
  },
): Promise<void> {
  const target = await deps.getTarget();
  // The runner owns missing/archived target recovery, including persistent-task rebinding.
  if (!target || target.status === 'archived' || target.status === 'deleted') return;
  if (deps.isBusy()) throw new ScheduledModelSelectionBusyError('Scheduled model selection waits for the current turn');
  assertScheduledHarnessSupported(target, selection.agentKind);
  const resolved = await deps.resolveSelection(selection);
  if (target.agentKind !== resolved.agentKind) {
    const result = await deps.switchHarness(resolved);
    if (!result.engineReady || result.retryPending) throw new Error('Scheduled Harness switch did not become ready');
  }
  await deps.applyModel(resolved);
}
