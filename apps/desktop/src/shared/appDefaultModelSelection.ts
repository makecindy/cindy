import type { ModelRoute } from '@cindy/maker-shared/model-route';
import type { DataOwnerPushStamp } from './dataOwnerPush.js';

/** Host-only write-through request; existing remote preference payloads remain unchanged. */
export interface AppDefaultModelSelection {
  requestId: string;
  route: ModelRoute;
  expectedRoute: ModelRoute | null;
  ownerStamp: DataOwnerPushStamp;
  expiresAt: number;
}

export function sameModelRoute(a: ModelRoute | null | undefined, b: ModelRoute | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  return a.harness === b.harness && a.providerId === b.providerId && a.model === b.model
    && a.effort === b.effort && a.fastMode === b.fastMode && (a.agentDeviceId ?? null) === (b.agentDeviceId ?? null);
}
