import { makerToDbAgentKind } from '@cindy/maker-shared/agent-kind-conversion';
import type { ScheduledModelSelection } from './scheduledModelSelection.js';
import type { createSessionRuntimeControl } from './sessionRuntimeControl.js';
export function createScheduledModelProjection(projectSessionRuntimeControl: ReturnType<typeof createSessionRuntimeControl>['projectSessionRuntimeControl']) {
  const projectScheduledPreferences = (sessionId: string, saved: ScheduledModelSelection) => {
    const baseline: ScheduledModelSelection = {
      agentKind: saved.agentKind, model: saved.model, providerId: saved.providerId,
      effort: saved.effort, fastMode: saved.fastMode,
    };
    return {
      ...projectSessionRuntimeControl(sessionId, baseline),
      agentKind: makerToDbAgentKind(baseline.agentKind),
      model: baseline.model,
      providerId: baseline.providerId,
      effort: baseline.effort ?? '',
      fastMode: baseline.fastMode,
      runtimeBaseline: baseline,
      runtimeEffective: baseline,
      runtimePending: null,
    };
  };
return projectScheduledPreferences;
}
