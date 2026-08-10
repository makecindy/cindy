import type { SubagentRunsChangedPayload } from '@cindy/maker-shared/subagent-workspace';

import {
  isDataOwnerGenerationCurrent,
  isDataOwnerPushCurrent,
  type DataOwnerGeneration,
} from '@/contexts/dataOwnerGeneration';

/** Fence an in-flight list/detail response captured before an account switch. */
export function isCurrentSubagentReadOwner(owner: DataOwnerGeneration): boolean {
  return isDataOwnerGenerationCurrent(owner);
}

/** Force React state to remount when any task/owner/host ownership axis changes. */
export function subagentReadScopeKey(
  owner: DataOwnerGeneration,
  sessionId: string,
  deviceLinkDeviceId: string | null | undefined,
  remoteHostId: string | null,
): string {
  return JSON.stringify([
    owner.dataOwnerId,
    owner.generation,
    sessionId,
    deviceLinkDeviceId === undefined ? ['unresolved'] : ['resolved', deviceLinkDeviceId],
    remoteHostId,
  ]);
}

/** Ignore invalidations captured under a previous signed-in data owner. */
export function isCurrentSubagentRunsChange(
  payload: SubagentRunsChangedPayload,
  ownerStamp: unknown,
  sessionId: string,
): boolean {
  return payload.sessionId === sessionId && isDataOwnerPushCurrent(ownerStamp);
}
