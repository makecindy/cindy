import type { Session } from '@cindy/maker-core';
import { recordSessionContextSnapshot } from '../sessionSpendBroadcaster.js';
import { recordCodexAccountUsageSnapshot } from '../usageBroadcaster.js';
import { dbToMakerAgentKind } from '../../shared/agentKindConversion.js';
import { lookupVerifiedContextWindow } from './contextOverflowRollover.js';
import { getSessionProvider } from '../maker-host/session-provider-store.js';
import { getActiveCatalog } from '../maker-host/active-catalog.js';
import { resolveVerifiedContextWindow } from '../maker-host/catalog-to-descriptors.js';
import type { PreparedSessionEvent } from './sessionEventPreparation.js';
export function recordSessionEventSnapshots(session: Session, prepared: PreparedSessionEvent) {
  const { pendingContextSnapshot, pendingCodexAccountUsageSnapshot } = prepared;
  if (pendingContextSnapshot) {
    const piRuntimeWindow =
      session.agentKind === 'pi' &&
      Number.isFinite(pendingContextSnapshot.contextWindow) &&
      pendingContextSnapshot.contextWindow > 0
        ? pendingContextSnapshot.contextWindow
        : null;
    const verifiedWindow = lookupVerifiedContextWindow(
      (agentKind, modelId, providerId) =>
        resolveVerifiedContextWindow(
          getActiveCatalog(),
          dbToMakerAgentKind(agentKind),
          providerId,
          modelId,
        ),
      session.model,
      getSessionProvider(session.id),
      session.agentKind,
    );
    recordSessionContextSnapshot(
      session.id,
      pendingContextSnapshot.contextTokens,
      piRuntimeWindow ?? verifiedWindow ?? pendingContextSnapshot.contextWindow,
    );
  }
  if (pendingCodexAccountUsageSnapshot) {
    recordCodexAccountUsageSnapshot(pendingCodexAccountUsageSnapshot);
  }
}
