import type { BotModelRoute } from './botModelChain.js';
import type { DataOwnerPushStamp } from './dataOwnerPush.js';

/** Host-only write-through request; existing remote preference payloads remain unchanged. */
export interface AppDefaultModelSelection {
  requestId: string;
  route: BotModelRoute;
  expectedRoute: BotModelRoute | null;
  ownerStamp: DataOwnerPushStamp;
  expiresAt: number;
}

export function sameModelRoute(a: BotModelRoute | null | undefined, b: BotModelRoute | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  return a.harness === b.harness && a.providerId === b.providerId && a.model === b.model
    && a.effort === b.effort && a.fastMode === b.fastMode;
}
