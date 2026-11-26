import { isSyntheticTriggerContent } from '@cindy/maker-shared/synthetic-trigger';
import type { EngineKind } from '@cindy/maker-core';

export interface TurnModelIdentity {
  agentKind: EngineKind;
  model: string;
  providerId: string | null;
}

/** A model boundary belongs to an actual dispatched input, never a picker change. */
export async function recordTurnModelChange(
  current: TurnModelIdentity,
  deps: {
    input?: { content: string; autoResume: boolean };
    readPrevious: () => Promise<TurnModelIdentity | null>;
    record: (model: TurnModelIdentity) => Promise<boolean>;
    publish: (change: { fromModel: string; toModel: string; modelOnly: true }) => Promise<void>;
  },
): Promise<void> {
  // Automatic recovery can change models just like a visible user input.
  // Other hidden control messages still do not publish model boundaries.
  if (deps.input && !deps.input.autoResume && isSyntheticTriggerContent(deps.input.content)) return;
  const previous = await deps.readPrevious();
  if (!await deps.record(current)) return;
  // Cross-Harness changes already have a history-handoff boundary.
  if (!previous || previous.agentKind !== current.agentKind || previous.model === current.model) return;
  if (current.agentKind === 'acp' && previous.providerId !== current.providerId) return;
  await deps.publish({ fromModel: previous.model, toModel: current.model, modelOnly: true });
}
