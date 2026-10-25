import type { SessionRuntimeMutationSource, SessionRuntimeProfile } from './sessionRuntimeControl.js';
export type InternalRuntimeSelectionOptions = {
    source: 'user' | SessionRuntimeMutationSource;
    runtimeSource?: 'agent';
    /** 系统配置对齐(IM 渠道默认跟随 / 伙伴模型对齐)登记: 落地时不打「脱离跟随」标记。 */
    configStaged?: boolean;
    assertSelectionCurrent?: () => void;
    beforeMutation?: () => Promise<void>;
    /** Internal calls from the send / switch transaction already own the route lock. */
    sessionLockHeld?: boolean;
    applyingUserSelectionOnSend?: boolean;
    /** Reassess the current Pi route after its catalog descriptor or budget changed. */
    refreshPiConfiguration?: boolean;
    /** The pending service owns removal and queue release after this apply commits. */
    applyingPiCredentialPending?: boolean;
    /** Renderer may have staged the target in DB while the old Pi runtime went cold. */
    previousPiRoute?: { model: string; providerId: string | null };
    expectedGeneration?: number;
    deferWhileRunning?: boolean;
    applyingPendingGeneration?: number;
    previousProfile?: SessionRuntimeProfile;
    /** Effective profile observed by the Agent CAS read; axis-only patches use it as the live base. */
    effectiveProfile?: SessionRuntimeProfile;
    effortExplicit?: boolean;
    fastExplicit?: boolean;
    /** False only for Agent axis-only patches; model/provider routing stays untouched. */
    routeExplicit?: boolean;
  };
export type ApplySessionRuntimeSelection = (sessionId: string, model: string, providerId: string | null | undefined,
  selection: {effort: SessionRuntimeProfile['effort']; fastMode: boolean | 'ultrafast'; confirmedContextWindow?: number; thinking?: boolean},
  options: InternalRuntimeSelectionOptions) => Promise<{deferred: boolean; superseded: boolean; generation?: number;
    effectiveProviderId?: string | null; contextWindowConfirmationRequired?: number; contextTokensForConfirmation?: number}>;
export function runtimeSelectionRequiresModelWindowConfirmation(result: {contextWindowConfirmationRequired?: number; contextTokensForConfirmation?: number}) {
  return result.contextWindowConfirmationRequired !== undefined || result.contextTokensForConfirmation !== undefined;
}
