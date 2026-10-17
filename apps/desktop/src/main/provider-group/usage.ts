/** Subscription snapshots used for group eligibility and balancing, never credentials or token estimates. */
import {
  matchScopedWindowForModel,
  type ClaudeSubscriptionUsageSnapshot,
  type ClaudeUsageWindow,
} from '@cindy/maker-shared/subscription-usage';

import { claudeAccountUsageLimit } from '../../shared/accountUsageLimit.js';
import type { ProviderGroupMember } from '../../shared/providerGroup.js';
import { isProviderShareAgentDeviceId } from '../../shared/providerShare.js';

export const PROVIDER_GROUP_USAGE_MAX_AGE_MS = 10 * 60_000;
export const PROVIDER_GROUP_USAGE_READ_TIMEOUT_MS = 1_500;
const REMOTE_USAGE_CACHE_MS = 15_000;
const MAX_CACHED_ACCOUNTS = 512;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function windowOf(raw: unknown): ClaudeUsageWindow | null {
  const value = record(raw);
  if (!value || typeof value.utilization !== 'number' || !Number.isFinite(value.utilization) || value.utilization < 0) return null;
  return {
    utilization: Math.min(100, value.utilization),
    resetsAt: typeof value.resetsAt === 'number' && Number.isFinite(value.resetsAt) && value.resetsAt > 0 ? value.resetsAt : null,
  };
}

/** Old/malformed snapshots are unknown, not a claim of zero usage or a permanent cooldown. */
export function providerGroupUsageSnapshot(raw: unknown, now: number): ClaudeSubscriptionUsageSnapshot | null {
  const value = record(raw);
  if (!value || typeof value.updatedAt !== 'number' || !Number.isFinite(value.updatedAt)
    || value.updatedAt <= 0 || now - value.updatedAt > PROVIDER_GROUP_USAGE_MAX_AGE_MS
    || value.updatedAt - now > 60_000) return null;
  return {
    updatedAt: value.updatedAt,
    fiveHour: windowOf(value.fiveHour),
    sevenDay: windowOf(value.sevenDay),
    scoped: (Array.isArray(value.scoped) ? value.scoped : []).flatMap((rawWindow) => {
      const item = record(rawWindow);
      const window = windowOf(rawWindow);
      if (!window || typeof item?.modelDisplayName !== 'string') return [];
      return [{ ...window, modelDisplayName: item.modelDisplayName, modelId: typeof item.modelId === 'string' ? item.modelId : null }];
    }),
    rateLimitStatus: typeof value.rateLimitStatus === 'string' ? value.rateLimitStatus : null,
    representativeClaim: typeof value.representativeClaim === 'string' ? value.representativeClaim : null,
  };
}

/** Check exhaustion first. A score requires both current windows, so missing data cannot win as 0%. */
export function providerGroupUsageState(raw: unknown, model: string | null | undefined, now: number) {
  const snapshot = providerGroupUsageSnapshot(raw, now);
  const limit = claudeAccountUsageLimit(snapshot, model, now);
  const current = (w: ClaudeUsageWindow | null | undefined) =>
    w && (!w.resetsAt || w.resetsAt * 1000 > now) ? w.utilization : null;
  const fiveHour = current(snapshot?.fiveHour);
  const sevenDay = current(snapshot?.sevenDay);
  const scoped = matchScopedWindowForModel(snapshot?.scoped, model);
  const scopedUsage = current(scoped);
  const usagePercent = fiveHour !== null && sevenDay !== null && (!scoped || scopedUsage !== null)
    ? Math.max(fiveHour, sevenDay, scopedUsage ?? 0) : null;
  // Quota left in a window is lost when it resets; only a known future reset with quota left can be "expiring".
  const unusedUntil = (w: ClaudeUsageWindow | null | undefined) =>
    w?.resetsAt && w.resetsAt * 1000 > now && w.utilization < 100 ? w.resetsAt * 1000 : null;
  return {
    limited: limit?.limited ?? false,
    resetAtMs: limit?.resetAtMs ?? null,
    usagePercent,
    weeklyResetAtMs: unusedUntil(snapshot?.sevenDay),
    fiveHourResetAtMs: unusedUntil(snapshot?.fiveHour),
  };
}

export interface ProviderGroupUsageReaderDeps {
  readLocal(providerId: string): Promise<unknown>;
  readRemote(deviceId: string, providerId: string): Promise<unknown>;
  isCurrent(): boolean;
  now(): number;
}

/** Per-owner, bounded remote reads. A slow/old peer cannot stall routing or multiply in-flight requests. */
export function createProviderGroupUsageReader(deps: ProviderGroupUsageReaderDeps) {
  const cached = new Map<string, { at: number; snapshot: ClaudeSubscriptionUsageSnapshot | null }>();
  const pending = new Map<string, Promise<ClaudeSubscriptionUsageSnapshot | null>>();

  async function bounded(promise: Promise<ClaudeSubscriptionUsageSnapshot | null>) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([promise, new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), PROVIDER_GROUP_USAGE_READ_TIMEOUT_MS);
      })]);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async read(member: ProviderGroupMember): Promise<ClaudeSubscriptionUsageSnapshot | null> {
      if (!deps.isCurrent() || member.kind === 'share'
        || (member.agentDeviceId && isProviderShareAgentDeviceId(member.agentDeviceId))) return null;
      const key = JSON.stringify([member.agentDeviceId, member.providerId]);
      const previous = cached.get(key);
      if (member.kind !== 'local' && previous && deps.now() - previous.at < REMOTE_USAGE_CACHE_MS) {
        return providerGroupUsageSnapshot(previous.snapshot, deps.now());
      }
      let request = pending.get(key);
      if (!request) {
        if (pending.size >= MAX_CACHED_ACCOUNTS) return null;
        request = Promise.resolve().then(async () => {
          if (!deps.isCurrent()) return null;
          const raw = member.kind === 'local'
            ? await deps.readLocal(member.providerId)
            : await deps.readRemote(member.agentDeviceId!, member.providerId);
          return deps.isCurrent() ? providerGroupUsageSnapshot(raw, deps.now()) : null;
        }).catch(() => null).then((snapshot) => {
          pending.delete(key);
          if (deps.isCurrent() && member.kind !== 'local') {
            if (cached.size >= MAX_CACHED_ACCOUNTS) cached.delete(cached.keys().next().value!);
            cached.set(key, { at: deps.now(), snapshot });
          }
          return snapshot;
        });
        pending.set(key, request);
      }
      const snapshot = await bounded(request);
      return deps.isCurrent() ? providerGroupUsageSnapshot(snapshot, deps.now()) : null;
    },
    invalidate() { cached.clear(); },
  };
}
