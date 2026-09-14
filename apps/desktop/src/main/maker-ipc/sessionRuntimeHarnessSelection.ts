import type { AgentKind, Effort } from '@cindy/maker-core';
import type { SessionRuntimeSetResult } from './sessionControlService.js';
import type { PendingAgentSwitchIntent } from './sessionAgentSwitchHandler.js';
import type {
  PendingSessionRuntimeMutation,
  SessionRuntimeProfile,
} from './sessionRuntimeControl.js';

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
      fastMode: intent.fastMode === true,
    },
  };
}

export interface HarnessRuntimeSelectionDeps {
  withSessionLock<T>(sessionId: string, run: () => Promise<T>): Promise<T>;
  ownerEpoch(): string;
  generation(sessionId: string): number;
  pendingRevision(sessionId: string): number;
  read(sessionId: string): Promise<SessionRuntimeProfile | null>;
  resolve(
    profile: SessionRuntimeProfile,
    explicit: { effort: boolean; fast: boolean },
  ): Promise<SessionRuntimeProfile>;
  stage(
    sessionId: string,
    profile: SessionRuntimeProfile,
    assertCurrent: () => void,
  ): Promise<{ deferred?: boolean; sameEngineSuperseded?: boolean }>;
  pending(sessionId: string): PendingAgentSwitchIntent | undefined;
}

/** Complete selections share the picker/send transaction, never the turn-end override queue. */
export async function setSessionRuntimeHarness(
  deps: HarnessRuntimeSelectionDeps,
  params: {
    targetSessionId: string;
    expectedGeneration?: number;
    patch: {
      harness: AgentKind;
      model?: string;
      providerId?: string | null;
      effort?: Effort;
      fastMode?: boolean;
    };
  },
): Promise<SessionRuntimeSetResult> {
  const { targetSessionId: id, expectedGeneration, patch } = params;
  if (!['claude-code', 'codex', 'pi'].includes(patch.harness) || !patch.model?.trim()) {
    return {
      ok: false,
      errorCode: 'INVALID_ARGS',
      message: 'harness requires a valid target harness and model',
    };
  }
  const owner = deps.ownerEpoch();
  try {
    return await deps.withSessionLock(id, async () => {
      const revision = deps.pendingRevision(id);
      const assertCurrent = () => {
        if (
          expectedGeneration === undefined ||
          deps.ownerEpoch() !== owner ||
          deps.generation(id) !== expectedGeneration ||
          deps.pendingRevision(id) !== revision
        ) {
          throw Object.assign(
            new Error('session runtime changed; read get_session_runtime again before retrying'),
            { code: 'CONFLICT' },
          );
        }
      };
      assertCurrent();
      const effective = await deps.read(id);
      if (!effective)
        return { ok: false, errorCode: 'NOT_FOUND', message: `session ${id} not found` };
      const profile = await deps.resolve(
        {
          agentKind: patch.harness,
          model: patch.model!,
          // Never inherit an old harness's provider when selecting a new target.
          providerId: patch.providerId ?? null,
          effort: patch.effort ?? effective.effort,
          fastMode: patch.fastMode ?? effective.fastMode,
        },
        { effort: patch.effort !== undefined, fast: patch.fastMode !== undefined },
      );
      assertCurrent();
      const result = await deps.stage(id, profile, assertCurrent);
      if (result.sameEngineSuperseded) {
        return {
          ok: false,
          errorCode: 'CONFLICT',
          message: 'session selection was superseded; read its runtime again',
        };
      }
      if (!result.deferred) {
        return {
          ok: false,
          errorCode: 'ROUTE_UNAVAILABLE',
          message: 'session selection could not be staged',
        };
      }
      const generation = deps.generation(id);
      return {
        ok: true,
        status: 'deferred',
        effectiveBoundary: 'next_send',
        generation,
        effectiveProfile: effective,
        pendingMutation: pendingHarnessRuntimeMutation(deps.pending(id), generation),
      };
    });
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (
      code === 'CONFLICT' ||
      code === 'NOT_FOUND' ||
      code === 'INVALID_PARAMS' ||
      code === 'UNSUPPORTED_CAPABILITY' ||
      code === 'CREDENTIAL_SWITCH_BUSY'
    ) {
      return {
        ok: false,
        errorCode: code === 'CONFLICT' || code === 'NOT_FOUND' ? code : 'ROUTE_UNAVAILABLE',
        message: error instanceof Error ? error.message : String(error),
      };
    }
    throw error;
  }
}
