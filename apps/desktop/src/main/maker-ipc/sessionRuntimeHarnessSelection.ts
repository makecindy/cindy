import type { AgentKind, Effort } from '@cindy/maker-core';
import type { SessionRuntimeSetResult } from './sessionControlService.js';
import { isUserPendingAgentSwitchIntent, type PendingAgentSwitchIntent } from './sessionAgentSwitchHandler.js';
import type {
  PendingSessionRuntimeMutation,
  SessionRuntimeProfile,
} from './sessionRuntimeControl.js';

export function pendingHarnessRuntimeMutation(
  intent: PendingAgentSwitchIntent | undefined,
  generation: number,
  currentAgentDeviceId?: string | null,
): PendingSessionRuntimeMutation | null {
  // Agents stage built-in selections only; a switch onto a plugin engine is the user's own choice.
  if (intent?.runtimeSource !== 'agent' || intent.targetAgentKind === 'acp') return null;
  return {
    generation,
    source: 'agent',
    profile: {
      ...(intent.targetAgentDeviceId !== undefined || currentAgentDeviceId !== undefined
        ? { agentDeviceId: intent.targetAgentDeviceId === undefined ? currentAgentDeviceId : intent.targetAgentDeviceId }
        : {}),
      agentKind: intent.targetAgentKind,
      model: intent.model,
      providerId: intent.providerId ?? null,
      effort: (intent.effort ?? null) as Effort | null,
      fastMode: (intent.fastMode === 'ultrafast' ? 'ultrafast' : intent.fastMode === true),
    },
  };
}

/**
 * The complete selection a task has staged for its next send, whoever staged it. Recovery
 * payloads are internal handoffs, not a choice that can be revised.
 */
export function stagedSelectionProfile(
  intent: PendingAgentSwitchIntent | undefined,
  currentAgentDeviceId?: string | null,
): SessionRuntimeProfile | null {
  // Runtime controls cover the built-in engines; a pending plugin-engine switch is not projected.
  if (!intent || intent.resumeFallbackRecovery || intent.targetAgentKind === 'acp') return null;
  const agentDeviceId = intent.targetAgentDeviceId === undefined ? currentAgentDeviceId : intent.targetAgentDeviceId;
  return {
    ...(agentDeviceId !== undefined ? { agentDeviceId } : {}),
    agentKind: intent.targetAgentKind,
    model: intent.model,
    providerId: intent.providerId ?? null,
    effort: (intent.effort ?? null) as Effort | null,
    fastMode: intent.fastMode === 'ultrafast' ? 'ultrafast' : intent.fastMode === true,
  };
}

/**
 * A picker choice staged for the next send, projected for Agent runtime reads. Agent-staged
 * selections already appear through `pendingHarnessRuntimeMutation`; system follow-ups
 * (`configStaged`) and recovery payloads are not anyone's choice to revise.
 */
export function userStagedSelectionProjection(
  intent: PendingAgentSwitchIntent | undefined,
  generation: number,
  currentAgentDeviceId?: string | null,
): { generation: number; source: 'user'; profile: SessionRuntimeProfile } | null {
  if (!isUserPendingAgentSwitchIntent(intent)) return null;
  const profile = stagedSelectionProfile(intent, currentAgentDeviceId);
  return profile ? { generation, source: 'user', profile } : null;
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
    beforeMutation?: () => Promise<void>,
    source?: 'user' | 'agent',
  ): Promise<{ deferred?: boolean; sameEngineSuperseded?: boolean }>;
  pending(sessionId: string): PendingAgentSwitchIntent | undefined;
}

/**
 * Complete selections share the picker/send transaction, never the turn-end override queue.
 * Without `harness`, the patch revises the selection already staged for the next send, like
 * choosing again in the picker: omitted fields keep the staged values. The turn-end queue
 * cannot run ahead of a staged selection, so this is the only way to change it.
 */
export async function setSessionRuntimeHarness(
  deps: HarnessRuntimeSelectionDeps,
  params: {
    targetSessionId: string;
    expectedGeneration?: number;
    beforeMutation?: () => Promise<void>;
    patch: {
      harness?: AgentKind;
      agentDeviceId?: string | null;
      model?: string;
      providerId?: string | null;
      effort?: Effort | null;
      fastMode?: boolean | 'ultrafast';
    };
  },
): Promise<SessionRuntimeSetResult> {
  const { targetSessionId: id, expectedGeneration, patch } = params;
  const explicitHarness = patch.harness !== undefined;
  const changingDevice = patch.agentDeviceId !== undefined;
  const revisingStagedOnly = !explicitHarness && !changingDevice;
  if (explicitHarness
    ? !['claude-code', 'codex', 'pi'].includes(patch.harness!) || !patch.model?.trim()
    : patch.model !== undefined && !patch.model.trim()) {
    return {
      ok: false,
      errorCode: 'INVALID_ARGS',
      message: 'harness requires a valid target harness and model',
    };
  }
  if (patch.agentDeviceId !== undefined && patch.agentDeviceId !== null &&
    (!/^[A-Za-z0-9_.:-]{1,128}$/.test(patch.agentDeviceId) || patch.agentDeviceId === 'local')) {
    return { ok: false, errorCode: 'INVALID_ARGS', message: 'Invalid Agent execution source' };
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
      if (params.beforeMutation) await params.beforeMutation();
      if (!effective)
        return { ok: false, errorCode: 'NOT_FOUND', message: `session ${id} not found` };
      const previous = deps.pending(id);
      const staged = !explicitHarness ? stagedSelectionProfile(previous, effective.agentDeviceId) : null;
      // Revising a picker choice must retain its provenance until send records the
      // manual-route override, even when the Agent changes only effort or Fast.
      const source = revisingStagedOnly && isUserPendingAgentSwitchIntent(previous) ? 'user' : 'agent';
      if (revisingStagedOnly && !staged) {
        return {
          ok: false,
          errorCode: 'CONFLICT',
          message: 'the staged selection already landed or was cancelled; read get_session_runtime again',
        };
      }
      const base = staged ?? effective;
      const targetAgentDeviceId = patch.agentDeviceId === undefined ? base.agentDeviceId : patch.agentDeviceId;
      const deviceChanged = changingDevice && (targetAgentDeviceId ?? null) !== (base.agentDeviceId ?? null);
      const profile = await deps.resolve(
        {
          ...(patch.agentDeviceId !== undefined || base.agentDeviceId !== undefined
            ? { agentDeviceId: targetAgentDeviceId }
            : {}),
          agentKind: patch.harness ?? base.agentKind,
          model: patch.model?.trim() || base.model,
          // Never inherit an old harness's or old computer's provider when selecting a new target;
          // a same-harness, same-location revision keeps the base source unless it names another one.
          providerId: explicitHarness || deviceChanged
            ? (patch.providerId ?? null)
            : (patch.providerId !== undefined ? patch.providerId : base.providerId),
          effort: patch.effort !== undefined ? patch.effort : base.effort,
          fastMode: patch.fastMode ?? base.fastMode,
        },
        { effort: patch.effort !== undefined, fast: patch.fastMode !== undefined },
      );
      assertCurrent();
      const result = await deps.stage(id, profile, assertCurrent, params.beforeMutation, source);
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
        pendingMutation: pendingHarnessRuntimeMutation(deps.pending(id), generation, effective.agentDeviceId)
          ?? userStagedSelectionProjection(deps.pending(id), generation, effective.agentDeviceId),
      };
    });
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (
      code === 'CONFLICT' ||
      code === 'NOT_FOUND' ||
      code === 'INVALID_PARAMS' ||
      code === 'PRECONDITION_FAILED' ||
      code === 'MODEL_SELECTION_UNAVAILABLE' ||
      code === 'UNSUPPORTED_CAPABILITY' ||
      code === 'SSH_HARNESS_SWITCH_UNSUPPORTED' ||
      code === 'CREDENTIAL_SWITCH_BUSY' ||
      code === 'PROVIDER_ROUTE_UNAVAILABLE' ||
      code === 'PROVIDER_GROUP_UNAVAILABLE' ||
      code === 'REMOTE_AGENT_DEVICE_UNREACHABLE' ||
      code === 'REMOTE_AGENT_MODEL_UNAVAILABLE' ||
      code === 'REMOTE_AGENT_SHARE_PAUSED' ||
      code === 'REMOTE_AGENT_SHARE_REMOVED' ||
      code === 'REMOTE_AGENT_SHARE_UNAVAILABLE' ||
      code === 'REMOTE_AGENT_SHARE_LEGACY_DISABLED'
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
