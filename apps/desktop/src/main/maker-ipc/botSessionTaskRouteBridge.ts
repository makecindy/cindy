import type { BotDelegationServiceDeps } from './botDelegationService.js';
import type { SessionRuntimeResult, SessionRuntimeSetResult } from './sessionControlService.js';
import type { SessionRuntimeProfile } from './sessionRuntimeControl.js';

interface TaskRouteBridgeDeps {
  getSessionRuntime(params: { targetSessionId: string }): Promise<SessionRuntimeResult>;
  setSessionRuntime(params: {
    targetSessionId: string;
    expectedGeneration: number;
    patch: {
      harness?: SessionRuntimeProfile['agentKind'];
      model: string;
      providerId: string | null;
      effort: SessionRuntimeProfile['effort'];
      fastMode: boolean;
    };
  }): Promise<SessionRuntimeSetResult>;
  readConfiguredCandidate(
    callerSessionId: string,
    current: SessionRuntimeProfile,
    childSessionId: string,
  ): Promise<{ candidate: SessionRuntimeProfile | null }>;
}

/** Keep Bot task ownership in delegation; this bridge only uses public Session runtime control. */
export function createBotSessionTaskRouteBridge(
  deps: TaskRouteBridgeDeps,
): NonNullable<BotDelegationServiceDeps['taskRoute']> {
  return {
    inspect: async (callerSessionId, childSessionId) => {
      const runtime = await deps.getSessionRuntime({ targetSessionId: childSessionId });
      if (!runtime.ok) return runtime;
      const next = await deps.readConfiguredCandidate(
        callerSessionId, runtime.runtime.effectiveProfile, childSessionId,
      );
      return {
        ok: true,
        generation: runtime.runtime.runtimeGeneration,
        current: runtime.runtime.effectiveProfile,
        next: next.candidate,
      };
    },
    advance: async (childSessionId, expectedGeneration, route) => {
      const current = await deps.getSessionRuntime({ targetSessionId: childSessionId });
      if (!current.ok) return current;
      if (current.runtime.runtimeGeneration !== expectedGeneration) {
        return { ok: false, errorCode: 'CONFLICT', message: 'Task runtime changed before model selection' };
      }
      const result = await deps.setSessionRuntime({
        targetSessionId: childSessionId,
        expectedGeneration,
        patch: {
          ...(current.runtime.effectiveProfile.agentKind === route.agentKind ? {} : { harness: route.agentKind }),
          model: route.model,
          providerId: route.providerId,
          effort: route.effort,
          fastMode: route.fastMode,
        },
      });
      return result.ok
        ? { ok: true, status: result.status, generation: result.generation }
        : result;
    },
  };
}
