import type { Effort } from '@cindy/maker-core';
import type { PendingAgentSwitchIntent } from '@cindy/im-runtime/sessionAgentSwitch';
import type { PendingSessionRuntimeMutation } from './sessionRuntimeControl.js';
export function pendingHarnessRuntimeMutation(
  intent: PendingAgentSwitchIntent | undefined,
  generation: number,
): PendingSessionRuntimeMutation | null {
  if (intent?.runtimeSource !== 'agent') return null;
  return {
    generation,
    source: 'agent',
    profile: {
      agentKind: intent.targetAgentKind,
      model: intent.model,
      providerId: intent.providerId ?? null,
      effort: (intent.effort ?? null) as Effort | null,
      fastMode: (intent.fastMode === 'ultrafast' ? 'ultrafast' : intent.fastMode === true),
    },
  };
}

