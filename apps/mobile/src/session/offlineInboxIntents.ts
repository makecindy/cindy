/**
 * Persistent per-account queue and reconnect replayer for offline inbox actions on Mobile.
 * Uses AsyncStorage keyed by userId with a logout writeEpoch guard (same pattern as
 * mobileHomeListCache.ts) and shares all projection/replay rules via @cindy/maker-shared.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSyncExternalStore } from 'react';
import {
  createOfflineCompleteIntent,
  evaluateOfflineInboxIntentReplay,
  normalizeOfflineInboxIntents,
  offlineInboxIntentKey,
  resolveOfflineSnoozeIntent,
  type OfflineInboxIntent,
  type OfflineInboxReplayRejectReason,
  type OfflineInboxSessionSnapshot,
} from '@cindy/maker-shared/offline-inbox-intent';
import {
  isDeviceUnresponsiveRemoteError,
  isTransientRemoteError,
} from '@cindy/maker-shared/device-link-contract';
import { isExplicitRemoteNotFoundError, isWorktreeChannelNotAllowedError } from '@/session/newSessionWorktree';
import type { RemoteSession } from '@/session/types';

const STORAGE_KEY_PREFIX = 'cindy.offlineInboxIntents.v1.';

let activeUserId = '';
let writeEpoch = 0;
let revision = 0;
let intentsByKey = new Map<string, OfflineInboxIntent>();
const listeners = new Set<() => void>();

function storageKeyForUser(userId: string): string {
  return `${STORAGE_KEY_PREFIX}${userId}`;
}

function emit(): void {
  revision += 1;
  for (const listener of listeners) listener();
}

function replaceIntents(nextList: OfflineInboxIntent[]): void {
  const next = new Map<string, OfflineInboxIntent>();
  for (const intent of normalizeOfflineInboxIntents(nextList)) {
    next.set(offlineInboxIntentKey(intent.deviceId, intent.sessionId), intent);
  }
  if (
    next.size === intentsByKey.size &&
    [...next].every(([key, value]) => JSON.stringify(intentsByKey.get(key)) === JSON.stringify(value))
  ) {
    return;
  }
  intentsByKey = next;
  emit();
}

async function persistForUser(userId: string, list: OfflineInboxIntent[], epoch: number): Promise<void> {
  if (!userId.trim() || epoch !== writeEpoch) return;
  const key = storageKeyForUser(userId);
  const normalized = normalizeOfflineInboxIntents(list);
  if (normalized.length === 0) {
    await AsyncStorage.removeItem(key).catch(() => undefined);
    return;
  }
  const serialized = JSON.stringify({ schemaVersion: 1, intents: normalized });
  if (epoch !== writeEpoch) return;
  await AsyncStorage.setItem(key, serialized).catch(() => undefined);
  if (epoch !== writeEpoch) {
    await AsyncStorage.removeItem(key).catch(() => undefined);
  }
}

export function subscribeMobileOfflineInboxIntents(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getMobileOfflineInboxIntentsRevision(): number {
  return revision;
}

export function useMobileOfflineInboxIntentsRevision(): number {
  return useSyncExternalStore(
    subscribeMobileOfflineInboxIntents,
    getMobileOfflineInboxIntentsRevision,
    getMobileOfflineInboxIntentsRevision,
  );
}

export function getMobileOfflineInboxIntent(
  deviceId: string | null | undefined,
  sessionId: string | null | undefined,
): OfflineInboxIntent | undefined {
  if (!deviceId || !sessionId) return undefined;
  return intentsByKey.get(offlineInboxIntentKey(deviceId, sessionId));
}

export function getMobileOfflineInboxIntentsForDevice(deviceId: string): OfflineInboxIntent[] {
  const trimmed = deviceId.trim();
  if (!trimmed) return [];
  const out: OfflineInboxIntent[] = [];
  for (const intent of intentsByKey.values()) {
    if (intent.deviceId === trimmed) out.push(intent);
  }
  return out;
}

export async function hydrateMobileOfflineInboxIntents(userId: string): Promise<void> {
  const trimmed = userId.trim();
  if (trimmed !== activeUserId) {
    activeUserId = trimmed;
    intentsByKey = new Map();
    emit();
  }
  if (!trimmed) return;
  const epoch = writeEpoch;
  const raw = await AsyncStorage.getItem(storageKeyForUser(trimmed)).catch(() => null);
  if (epoch !== writeEpoch || activeUserId !== trimmed) return;
  if (!raw) return;
  try {
    const parsed = JSON.parse(raw) as { intents?: unknown };
    replaceIntents([...intentsByKey.values(), ...normalizeOfflineInboxIntents(parsed?.intents)]);
  } catch {
    // Corrupt local storage drops cleanly without blocking inbox usage.
  }
}

export async function upsertMobileOfflineInboxIntent(
  userId: string,
  intent: OfflineInboxIntent,
): Promise<void> {
  const trimmed = userId.trim();
  if (trimmed && activeUserId !== trimmed) {
    activeUserId = trimmed;
  }
  const key = offlineInboxIntentKey(intent.deviceId, intent.sessionId);
  const next = new Map(intentsByKey);
  next.set(key, intent);
  intentsByKey = next;
  emit();
  if (trimmed) {
    await persistForUser(trimmed, [...intentsByKey.values()], writeEpoch);
  }
}

export async function removeMobileOfflineInboxIntent(
  userId: string,
  deviceId: string,
  sessionId: string,
): Promise<void> {
  const key = offlineInboxIntentKey(deviceId, sessionId);
  if (intentsByKey.has(key)) {
    const next = new Map(intentsByKey);
    next.delete(key);
    intentsByKey = next;
    emit();
  }
  const trimmed = userId.trim() || activeUserId;
  if (trimmed) {
    await persistForUser(trimmed, [...intentsByKey.values()], writeEpoch);
  }
}

export async function clearMobileOfflineInboxIntentsForDevice(
  userId: string,
  deviceId: string,
): Promise<void> {
  const trimmedDevice = deviceId.trim();
  if (!trimmedDevice) return;
  let changed = false;
  const next = new Map<string, OfflineInboxIntent>();
  for (const [key, intent] of intentsByKey) {
    if (intent.deviceId === trimmedDevice) changed = true;
    else next.set(key, intent);
  }
  if (changed) {
    intentsByKey = next;
    emit();
  }
  const trimmedUser = userId.trim() || activeUserId;
  if (trimmedUser) {
    await persistForUser(trimmedUser, [...intentsByKey.values()], writeEpoch);
  }
}

export async function clearAllMobileOfflineInboxIntents(): Promise<void> {
  writeEpoch += 1;
  activeUserId = '';
  if (intentsByKey.size > 0) {
    intentsByKey = new Map();
    emit();
  }
  const keys = await AsyncStorage.getAllKeys().catch(() => [] as readonly string[]);
  const targets = keys.filter((key) => key.startsWith(STORAGE_KEY_PREFIX));
  if (targets.length > 0) {
    await AsyncStorage.multiRemove(targets).catch(() => undefined);
  }
}

export async function queueMobileOfflineInboxSnooze(
  userId: string,
  deviceId: string,
  sessionId: string,
  rawHostSession: OfflineInboxSessionSnapshot,
  snoozedUntil: string | null,
): Promise<void> {
  const intent = resolveOfflineSnoozeIntent(deviceId, sessionId, rawHostSession, snoozedUntil);
  if (!intent) {
    await removeMobileOfflineInboxIntent(userId, deviceId, sessionId);
    return;
  }
  await upsertMobileOfflineInboxIntent(userId, intent);
}

export async function queueMobileOfflineInboxComplete(
  userId: string,
  deviceId: string,
  sessionId: string,
  rawHostSession: OfflineInboxSessionSnapshot,
): Promise<void> {
  const intent = createOfflineCompleteIntent(deviceId, sessionId, rawHostSession);
  await upsertMobileOfflineInboxIntent(userId, intent);
}

export interface MobileOfflineInboxReplayDeps {
  userId: string;
  deviceId: string;
  getIntents(deviceId: string): OfflineInboxIntent[];
  getCurrentIntent(deviceId: string, sessionId: string): OfflineInboxIntent | undefined;
  removeIntent(userId: string, deviceId: string, sessionId: string): Promise<void>;
  isStillCurrent(): boolean;
  getCachedFreshSession(deviceId: string, sessionId: string): RemoteSession | undefined;
  fetchFreshSession(deviceId: string, sessionId: string): Promise<RemoteSession | null>;
  isRunning(sessionId: string): boolean;
  hasActiveAutomation(session: RemoteSession): boolean;
  preflightWorktree(deviceId: string, sessionId: string): Promise<'clean' | 'dirty' | 'unknown'>;
  patchMeta(deviceId: string, sessionId: string, patch: Record<string, unknown>): Promise<RemoteSession>;
  applyPatchedSession(deviceId: string, sessionId: string, patch: Partial<RemoteSession>): void;
  markAutomationTaskRead(deviceId: string, session: RemoteSession): Promise<void>;
  notifyRejected(intent: OfflineInboxIntent, reason: OfflineInboxReplayRejectReason): void;
  notifySnoozeFailed(intent: OfflineInboxIntent): void;
  nowMs?: () => number;
}

const inFlightByDevice = new Map<string, Promise<void>>();

export function isOfflineInboxTransientError(err: unknown): boolean {
  if (isTransientRemoteError(err) || isDeviceUnresponsiveRemoteError(err)) return true;
  const message = err instanceof Error ? err.message : String(err);
  return /TIMEOUT|NOT_CONNECTED|DEVICE_OFFLINE|LINK_NOT_OPEN|DbClient not ready/i.test(message);
}

function isTransientReplayError(err: unknown): boolean {
  return isOfflineInboxTransientError(err);
}

/**
 * Replay queued offline inbox intents for a reconnected device on Mobile.
 * Serialized per device; transient errors keep the intent queued for the next sync.
 */
export function replayMobileOfflineInboxIntentsForDevice(
  deps: MobileOfflineInboxReplayDeps,
): Promise<void> {
  const { deviceId, userId } = deps;
  const existing = inFlightByDevice.get(deviceId);
  if (existing) return existing;
  const run = (async () => {
    const intents = deps.getIntents(deviceId);
    if (intents.length === 0) return;

    const isIntentCurrent = (intent: OfflineInboxIntent): boolean => {
      if (!deps.isStillCurrent()) return false;
      const current = deps.getCurrentIntent(deviceId, intent.sessionId);
      return Boolean(current && current.createdAt === intent.createdAt && current.kind === intent.kind);
    };

    for (const intent of intents) {
      if (!isIntentCurrent(intent)) continue;

      let freshSession: RemoteSession | null = deps.getCachedFreshSession(deviceId, intent.sessionId) ?? null;
      if (!freshSession) {
        try {
          freshSession = await deps.fetchFreshSession(deviceId, intent.sessionId);
        } catch (err) {
          if (isExplicitRemoteNotFoundError(err)) {
            freshSession = null;
          } else if (isTransientReplayError(err)) {
            continue;
          } else {
            continue;
          }
        }
      }
      if (!isIntentCurrent(intent)) continue;

      const decision = evaluateOfflineInboxIntentReplay(intent, freshSession, {
        isRunning: deps.isRunning(intent.sessionId),
        nowMs: deps.nowMs?.(),
      });

      if (decision.action === 'drop') {
        await deps.removeIntent(userId, deviceId, intent.sessionId);
        continue;
      }

      if (decision.action === 'reject') {
        await deps.removeIntent(userId, deviceId, intent.sessionId);
        deps.notifyRejected(intent, decision.reason);
        continue;
      }

      if (decision.action === 'apply-snooze') {
        try {
          const updated = await deps.patchMeta(deviceId, intent.sessionId, {
            snoozedUntil: decision.snoozedUntil,
          });
          if (!isIntentCurrent(intent)) continue;
          if ((updated?.snoozedUntil ?? null) !== decision.snoozedUntil) {
            await deps.removeIntent(userId, deviceId, intent.sessionId);
            deps.notifySnoozeFailed(intent);
            continue;
          }
          deps.applyPatchedSession(deviceId, intent.sessionId, {
            snoozedUntil: updated.snoozedUntil ?? null,
            snoozedAt: updated.snoozedAt ?? null,
          });
          await deps.removeIntent(userId, deviceId, intent.sessionId);
        } catch (err) {
          if (isTransientReplayError(err)) continue;
          await deps.removeIntent(userId, deviceId, intent.sessionId);
          if (!isExplicitRemoteNotFoundError(err)) deps.notifySnoozeFailed(intent);
        }
        continue;
      }

      // decision.action === 'apply-complete'
      if (freshSession && deps.hasActiveAutomation(freshSession)) {
        try {
          await deps.markAutomationTaskRead(deviceId, freshSession);
          if (isIntentCurrent(intent)) {
            await deps.removeIntent(userId, deviceId, intent.sessionId);
          }
        } catch (err) {
          if (isTransientReplayError(err)) continue;
          await deps.removeIntent(userId, deviceId, intent.sessionId);
        }
        continue;
      }

      const preflight = await deps.preflightWorktree(deviceId, intent.sessionId);
      if (!isIntentCurrent(intent)) continue;
      if (preflight === 'dirty') {
        await deps.removeIntent(userId, deviceId, intent.sessionId);
        deps.notifyRejected(intent, 'dirty-worktree');
        continue;
      }
      if (preflight === 'unknown') {
        if (!deps.isStillCurrent()) continue;
        await deps.removeIntent(userId, deviceId, intent.sessionId);
        deps.notifyRejected(intent, 'preflight-unknown');
        continue;
      }

      try {
        const updated = await deps.patchMeta(deviceId, intent.sessionId, { status: 'archived' });
        if (!isIntentCurrent(intent)) continue;
        deps.applyPatchedSession(deviceId, intent.sessionId, {
          status: updated.status ?? 'archived',
          pinnedAt: updated.pinnedAt ?? null,
          snoozedUntil: null,
          snoozedAt: null,
        });
        await deps.removeIntent(userId, deviceId, intent.sessionId);
      } catch (err) {
        if (isTransientReplayError(err)) continue;
        await deps.removeIntent(userId, deviceId, intent.sessionId);
        if (!isExplicitRemoteNotFoundError(err) && !isWorktreeChannelNotAllowedError(err)) {
          deps.notifyRejected(intent, 'preflight-unknown');
        }
      }
    }
  })();
  inFlightByDevice.set(deviceId, run);
  void run.finally(() => {
    if (inFlightByDevice.get(deviceId) === run) inFlightByDevice.delete(deviceId);
  });
  return run;
}

export const __testing = {
  reset(): void {
    activeUserId = '';
    writeEpoch += 1;
    intentsByKey = new Map();
    inFlightByDevice.clear();
    emit();
  },
};
