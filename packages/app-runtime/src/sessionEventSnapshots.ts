
import type { Session } from '@cindy/maker-core';
import type { PreparedSessionEvent } from './sessionEventPreparation.js';
export interface SessionEventSnapshotsHost {
 isOpenAiSubscriptionProviderId(providerId?:string|null):boolean;
 getSessionProvider(sessionId:string):string|null;
 recordSessionContextSnapshot(sessionId:string,contextTokens:number,contextWindow:number):Promise<void>;
 recordCodexAccountUsageSnapshot(snapshot:unknown,providerId?:string):Promise<void>;
 }

export function createSessionEventSnapshots(host: SessionEventSnapshotsHost) {
const {isOpenAiSubscriptionProviderId,recordSessionContextSnapshot,recordCodexAccountUsageSnapshot,getSessionProvider} = host;


function recordSessionEventSnapshots(session: Session, prepared: PreparedSessionEvent) {
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
return {
  recordSessionEventSnapshots
};
}
