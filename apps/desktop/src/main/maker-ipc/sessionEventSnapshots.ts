import { isOpenAiSubscriptionProviderId } from '../maker-host/codex-account-auth.js';
import type { Session } from '@cindy/maker-core';
import { recordSessionContextSnapshot } from '../sessionSpendBroadcaster.js';
import { recordCodexAccountUsageSnapshot } from '../usageBroadcaster.js';
import { getSessionProvider } from '../maker-host/session-provider-store.js';
import type { PreparedSessionEvent } from './sessionEventPreparation.js';
export function recordSessionEventSnapshots(session: Session, prepared: PreparedSessionEvent) {
  const { pendingContextSnapshot, pendingCodexAccountUsageSnapshot } = prepared;
  if (pendingContextSnapshot) {
    // Harness translators already normalize the applied runtime budget. Replacing
    // it with the current catalog here corrupts persistence and the later UI push,
    // even when the live status event initially displayed the correct window.
    recordSessionContextSnapshot(
      session.id,
      pendingContextSnapshot.contextTokens,
      pendingContextSnapshot.contextWindow,
    );
  }
  if (pendingCodexAccountUsageSnapshot) {
    const providerId = getSessionProvider(session.id);
    if (providerId == null || isOpenAiSubscriptionProviderId(providerId)) {
      void recordCodexAccountUsageSnapshot(pendingCodexAccountUsageSnapshot, providerId ?? undefined);
    }
  }
}
