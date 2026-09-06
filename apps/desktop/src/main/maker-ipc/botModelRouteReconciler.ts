import type { AgentKind } from '@cindy/maker-core';
import type { BotModelRoute } from '../../shared/botModelChain.js';

interface RuntimeRoute {
  agentKind: AgentKind;
  model: string;
  providerId: string | null;
  effort: string | null;
  fastMode: boolean;
}

interface BotRouteState {
  chain: BotModelRoute[];
  current: RuntimeRoute;
  hasRuntimeOverride: boolean;
}

/** Apply the permanent profile through ordinary Session model/switch controls.
 * Fallback and Agent choices remain effective until the configured chain changes.
 * Background tasks keep their frozen route; the reader selects canonical tasks only.
 */
export function createBotModelRouteReconciler(deps: {
  ownerEpoch(): string;
  read(sessionId: string): Promise<BotRouteState | null>;
  apply(sessionId: string, route: RuntimeRoute, current: RuntimeRoute): Promise<void>;
}) {
  let owner: string | undefined;
  const configured = new Map<string, string>();
  const inFlight = new Map<string, Promise<void>>();
  return async (sessionId: string): Promise<void> => {
    const epoch = deps.ownerEpoch();
    if (owner !== epoch) {
      owner = epoch;
      configured.clear();
      inFlight.clear();
    }
    const existing = inFlight.get(sessionId);
    if (existing) return existing;
    const operation = (async () => {
      const state = await deps.read(sessionId);
      if (deps.ownerEpoch() !== epoch) throw new Error('Bot model route owner changed');
      if (!state?.chain.length) {
        configured.delete(sessionId);
        return;
      }
      const key = JSON.stringify(state.chain);
      const previous = configured.get(sessionId);
      if (state.hasRuntimeOverride && (previous === undefined || previous === key)) {
        configured.set(sessionId, key);
        return;
      }
      const primary = state.chain[0];
      const route: RuntimeRoute = {
        agentKind: primary.harness === 'claude' ? 'claude-code' : primary.harness,
        model: primary.model,
        providerId: primary.providerId,
        effort: primary.effort || null,
        fastMode: primary.fastMode,
      };
      const current = state.current;
      if (route.agentKind !== current.agentKind || route.model !== current.model
        || route.providerId !== current.providerId || route.effort !== current.effort
        || route.fastMode !== current.fastMode) {
        await deps.apply(sessionId, route, current);
      }
      if (deps.ownerEpoch() !== epoch) throw new Error('Bot model route owner changed');
      configured.set(sessionId, key);
    })();
    inFlight.set(sessionId, operation);
    try { await operation; } finally {
      if (inFlight.get(sessionId) === operation) inFlight.delete(sessionId);
    }
  };
}
