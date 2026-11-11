import type { AgentKind } from '@cindy/maker-core';

export interface TurnModelIdentity {
  agentKind: AgentKind;
  model: string;
  providerId: string | null;
}

/** A model boundary belongs to an actual dispatched input, never a picker change. */
export async function recordTurnModelChange(
  current: TurnModelIdentity,
  deps: {
    readPrevious: () => Promise<TurnModelIdentity | null>;
    record: (model: TurnModelIdentity) => Promise<boolean>;
    publish: (change: { fromModel: string; toModel: string; modelOnly: true }) => Promise<void>;
  },
): Promise<void> {
  const previous = await deps.readPrevious();
  if (!await deps.record(current)) return;
  // Cross-Harness changes already have a history-handoff boundary.
  if (!previous || previous.agentKind !== current.agentKind || previous.model === current.model) return;
  await deps.publish({ fromModel: previous.model, toModel: current.model, modelOnly: true });
}
