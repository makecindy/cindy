import { normalizeBotModelRoute, type BotModelRoute } from './botModelChain.js';
import type { DataOwnerPushStamp } from './dataOwnerPush.js';

/** Ordinary task defaults also include engines without Bot runtime support. */
export type AppModelRoute = Omit<BotModelRoute, 'harness'> & {
  harness: BotModelRoute['harness'] | 'cursor';
};

export function normalizeAppModelRoute(value: unknown): AppModelRoute | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.harness !== 'cursor') return normalizeBotModelRoute(value);
  if (typeof record.model !== 'string' || !record.model.trim()) return null;
  return {
    harness: 'cursor', model: record.model.trim(),
    providerId: typeof record.providerId === 'string' && record.providerId.trim() ? record.providerId.trim() : null,
    effort: typeof record.effort === 'string' ? record.effort : '', fastMode: record.fastMode === true,
  };
}

/** Host-only write-through request; existing remote preference payloads remain unchanged. */
export interface AppDefaultModelSelection {
  requestId: string;
  route: BotModelRoute;
  expectedRoute: AppModelRoute | null;
  ownerStamp: DataOwnerPushStamp;
  expiresAt: number;
}

export function sameModelRoute(a: AppModelRoute | null | undefined, b: AppModelRoute | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  return a.harness === b.harness && a.providerId === b.providerId && a.model === b.model
    && a.effort === b.effort && a.fastMode === b.fastMode;
}
