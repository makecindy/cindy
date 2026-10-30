import type { BotModelRoute } from './botModelChain.js';
import type { DataOwnerPushStamp } from './dataOwnerPush.js';
import { normalizeModelRoute } from '@cindy/maker-shared/model-route';

/** Task defaults include native engines that cannot run a companion profile. */
export type AppDefaultModelRoute = Omit<BotModelRoute, 'harness'> & {
  harness: BotModelRoute['harness'] | 'zcode';
};

/** Retain native task identity without adding that engine to companion chains. */
export function normalizeAppDefaultModelRoute(value: unknown): AppDefaultModelRoute | null {
  const route = normalizeModelRoute(value);
  if (!route) return null;
  if ((value as Record<string, unknown>).harness !== 'zcode') return route;
  if (route.agentDeviceId) return null;
  return { ...route, harness: 'zcode' };
}

/** Host-only write-through request; existing remote preference payloads remain unchanged. */
export interface AppDefaultModelSelection {
  requestId: string;
  route: AppDefaultModelRoute;
  expectedRoute: AppDefaultModelRoute | null;
  ownerStamp: DataOwnerPushStamp;
  expiresAt: number;
}

export function sameModelRoute(a: AppDefaultModelRoute | null | undefined, b: AppDefaultModelRoute | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  return a.harness === b.harness && a.providerId === b.providerId && a.model === b.model
    && a.effort === b.effort && a.fastMode === b.fastMode && (a.agentDeviceId ?? null) === (b.agentDeviceId ?? null);
}
