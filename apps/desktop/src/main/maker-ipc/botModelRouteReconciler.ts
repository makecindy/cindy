import { parseScheduledModelBaseline } from '../../shared/scheduledModelBaseline';
import { throwIpcError } from '../utils/ipcValidate.js';
import type { AgentKind } from '@cindy/maker-core';
import { normalizeBotModelChain, type BotModelRoute } from '../../shared/botModelChain.js';

interface RuntimeRoute {
  agentDeviceId?: string | null;
  agentKind: AgentKind;
  model: string;
  providerId: string | null;
  effort: string | null;
  fastMode: boolean | 'ultrafast';
}

interface BotRouteState {
  chain: BotModelRoute[];
  current: RuntimeRoute;
  hasRuntimeOverride: boolean;
  scheduledModelBaseline?: string | null;
  followsCindyDefault?: boolean;
  next?: RuntimeRoute;
}

function configuredRoute(
  state: BotRouteState,
  previous: string | undefined,
  chain = state.chain,
): RuntimeRoute | null {
  const key = JSON.stringify(chain);
  const isDraftChange = key !== JSON.stringify(state.chain);
  // An automation owns its temporary route until ordinary input restores it.
  // This also applies to companions following Cindy defaults and after restart.
  if (!isDraftChange && parseScheduledModelBaseline(state.scheduledModelBaseline) && (previous === undefined || previous === key)) return null;
  if (!state.followsCindyDefault && !isDraftChange && state.hasRuntimeOverride && (previous === undefined || previous === key)) return null;
  const primary = chain[0];
  if (!primary) return null;
  return {
    agentKind: primary.harness === 'claude' ? 'claude-code' : primary.harness,
    model: primary.model,
    ...(primary.agentDeviceId ? { agentDeviceId: primary.agentDeviceId } : {}),
    providerId: primary.providerId,
    effort: primary.effort || null,
    fastMode: primary.fastMode,
  };
}

function savedRuntimeRoute(state: BotRouteState): RuntimeRoute | null {
  const baseline = parseScheduledModelBaseline(state.scheduledModelBaseline);
  if (!baseline || baseline.pendingBotProfileVersion) return null;
  const { agentKind, model, providerId, effort, fastMode } = baseline;
  return { agentKind, model, providerId, effort, fastMode,
    ...(state.current.agentDeviceId ? { agentDeviceId: state.current.agentDeviceId } : {}),
  };
}

function sameRoute(a: RuntimeRoute, b: RuntimeRoute): boolean {
  return a.agentKind === b.agentKind && a.model === b.model && a.providerId === b.providerId
    && a.effort === b.effort && a.fastMode === b.fastMode && (a.agentDeviceId ?? null) === (b.agentDeviceId ?? null);
}

/** Apply the permanent profile through ordinary Session model/switch controls.
 * Fallback and Agent choices remain effective until the configured chain changes.
 * Background tasks keep their frozen route; the reader selects canonical tasks only.
 */
export function createBotModelRouteReconciler(deps: {
  ownerEpoch(): string;
  withSessionLock?<T>(sessionId: string, run: () => Promise<T>): Promise<T>;
  read(sessionId: string, purpose: 'apply' | 'preview'): Promise<BotRouteState | null>;
  apply(sessionId: string, route: RuntimeRoute, current: RuntimeRoute): Promise<void>;
  /** An accepted permanent choice supersedes temporary preferences, even without a switch. */
  onSelectionAccepted?(sessionId: string, expectedBaseline?: string | null): Promise<void | boolean>;
}) {
  let owner: string | undefined;
  const configured = new Map<string, string>();
  const revisions = new Map<string, number>();
  const inFlight = new Map<string, Promise<void>>();
  const syncOwner = () => {
    const epoch = deps.ownerEpoch();
    if (owner !== epoch) {
      owner = epoch;
      configured.clear();
      revisions.clear();
      inFlight.clear();
    }
    return epoch;
  };
  const reconcile = async (sessionId: string, sessionLockHeld = false): Promise<void> => {
    const epoch = syncOwner();
    const existing = inFlight.get(sessionId);
    if (existing && !sessionLockHeld) return existing;
    const run = async () => {
      for (;;) {
        const revision = revisions.get(sessionId) ?? 0;
        const state = await deps.read(sessionId, 'apply');
        if (deps.ownerEpoch() !== epoch) throw new Error('Bot model route owner changed');
        if ((revisions.get(sessionId) ?? 0) !== revision) continue;
        if (!state) {
          // Paused profiles are absent from the apply reader. Keep an explicit
          // save pending until resume can accept it and invalidate the scope.
          if (configured.get(sessionId) !== '') configured.delete(sessionId);
          return;
        }
        if (!state.chain.length) {
          configured.delete(sessionId);
          throwIpcError('PRECONDITION_FAILED', '请先选择已开启的伙伴模型');
        }
        const key = JSON.stringify(state.chain);
        const previous = parseScheduledModelBaseline(state.scheduledModelBaseline)?.pendingBotProfileVersion
          ? '' : configured.get(sessionId);
        const route = configuredRoute(state, previous);
        if (!route) {
          configured.set(sessionId, key);
          return;
        }
        const current = state.current;
        const needsApply = !sameRoute(route, current) || !!(state.next && !sameRoute(route, state.next));
        try {
          if (needsApply) await deps.apply(sessionId, route, current);
          if (deps.ownerEpoch() !== epoch) throw new Error('Bot model route owner changed');
          if ((revisions.get(sessionId) ?? 0) !== revision) continue;
          // Only a durable save or profileChanged's explicit marker supersedes the scope.
          // Ordinary IM preparation can switch routes before automation restore.
          if (previous === '') {
            const accepted = await deps.onSelectionAccepted?.(sessionId, state.scheduledModelBaseline);
            if (accepted === false) continue; // A newer durable save won the compare-and-set.
          }
        } catch (error) {
          // A failed obsolete selection must not discard a newer explicit save.
          if (deps.ownerEpoch() !== epoch) throw new Error('Bot model route owner changed');
          if ((revisions.get(sessionId) ?? 0) !== revision) continue;
          throw error;
        }
        if (deps.ownerEpoch() !== epoch) throw new Error('Bot model route owner changed');
        if ((revisions.get(sessionId) ?? 0) !== revision) continue;
        configured.set(sessionId, key);
        return;
      }
    };
    // Read inside the ordinary send lock. An already-locked sender must not
    // await an outside reconcile that is itself queued behind this sender.
    if (sessionLockHeld) return run();
    const operation = deps.withSessionLock ? deps.withSessionLock(sessionId, run) : run();
    inFlight.set(sessionId, operation);
    try {
      await operation;
    } finally {
      if (inFlight.get(sessionId) === operation) inFlight.delete(sessionId);
    }
  };
  const invalidate = (sessionId: string): void => {
    syncOwner();
    revisions.set(sessionId, (revisions.get(sessionId) ?? 0) + 1);
    configured.set(sessionId, '');
  };
  return Object.assign(reconcile, {
    invalidate,
    /** Explicit saves invalidate fallback even before the first send. A newer
     * save during an in-flight switch is reread before this promise settles. */
    profileChanged(sessionId: string): Promise<void> {
      invalidate(sessionId);
      return reconcile(sessionId);
    },
    /** Read-only preview: sharing the send decision must not consume a profile change. */
    async preview(sessionId: string, draftChain?: BotModelRoute[]): Promise<RuntimeRoute | null> {
      const epoch = syncOwner();
      await inFlight.get(sessionId);
      const state = await deps.read(sessionId, 'preview');
      if (deps.ownerEpoch() !== epoch) throw new Error('Bot model route owner changed');
      if (!state?.chain.length) return null;
      return (
        configuredRoute(
          state,
          parseScheduledModelBaseline(state.scheduledModelBaseline)?.pendingBotProfileVersion
            ? '' : configured.get(sessionId),
          draftChain ? normalizeBotModelChain(draftChain) : undefined,
        ) ??
        state.next ??
        savedRuntimeRoute(state) ??
        state.current
      );
    },
  });
}
