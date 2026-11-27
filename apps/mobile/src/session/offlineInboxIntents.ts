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
import { isExplicitRemoteNotFoundError } from '@/session/newSessionWorktree';
import type { RemoteSession } from '@/session/types';

const STORAGE_KEY_PREFIX = 'cindy.offlineInboxIntents.v1.';

let activeUserId = '';
let writeEpoch = 0;
let writeSeq = 0;
let revision = 0;
let intentsByKey = new Map<string, OfflineInboxIntent>();
const keyWriteSeq = new Map<string, number>();
let persistQueue: Promise<void> = Promise.resolve();
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

function enqueuePersist(task: () => Promise<void>): Promise<void> {
  const next = persistQueue.then(task, task);
  persistQueue = next.catch(() => undefined);
  return next;
}

async function persistCurrentForUser(userId: string, epoch: number): Promise<void> {
  if (!userId.trim() || epoch !== writeEpoch) return;
  await enqueuePersist(async () => {
    if (!userId.trim() || epoch !== writeEpoch) return;
    const key = storageKeyForUser(userId);
    const normalized = normalizeOfflineInboxIntents([...intentsByKey.values()]);
    if (normalized.length === 0) {
      await AsyncStorage.removeItem(key);
      return;
    }
    const serialized = JSON.stringify({ schemaVersion: 1, intents: normalized });
    if (epoch !== writeEpoch) return;
    await AsyncStorage.setItem(key, serialized);
    if (epoch !== writeEpoch) {
      await AsyncStorage.removeItem(key).catch(() => undefined);
    }
  });
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
    keyWriteSeq.clear();
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
  const epoch = writeEpoch;
  const key = offlineInboxIntentKey(intent.deviceId, intent.sessionId);
  const previous = intentsByKey.get(key);
  const token = (writeSeq += 1);
  keyWriteSeq.set(key, token);
  const next = new Map(intentsByKey);
  next.set(key, intent);
  intentsByKey = next;
  emit();
  if (!trimmed) return;
  try {
    await persistCurrentForUser(trimmed, epoch);
  } catch (err) {
    if (epoch === writeEpoch && keyWriteSeq.get(key) === token) {
      const rolledBack = new Map(intentsByKey);
      if (previous) rolledBack.set(key, previous);
      else rolledBack.delete(key);
      intentsByKey = rolledBack;
      emit();
    }
    throw err;
  }
}

export async function removeMobileOfflineInboxIntent(
  userId: string,
  deviceId: string,
  sessionId: string,
): Promise<void> {
  const epoch = writeEpoch;
  const key = offlineInboxIntentKey(deviceId, sessionId);
  const previous = intentsByKey.get(key);
  const token = (writeSeq += 1);
  keyWriteSeq.set(key, token);
  if (intentsByKey.has(key)) {
    const next = new Map(intentsByKey);
    next.delete(key);
    intentsByKey = next;
    emit();
  }
  const trimmed = userId.trim() || activeUserId;
  if (!trimmed) return;
  try {
    await persistCurrentForUser(trimmed, epoch);
  } catch (err) {
    if (epoch === writeEpoch && keyWriteSeq.get(key) === token) {
      const rolledBack = new Map(intentsByKey);
      if (previous) rolledBack.set(key, previous);
      else rolledBack.delete(key);
      intentsByKey = rolledBack;
      emit();
    }
    throw err;
  }
}

export async function clearMobileOfflineInboxIntentsForDevice(
  userId: string,
  deviceId: string,
): Promise<void> {
  const trimmedDevice = deviceId.trim();
  if (!trimmedDevice) return;
  const epoch = writeEpoch;
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
    await persistCurrentForUser(trimmedUser, epoch).catch(() => undefined);
  }
}

export async function clearAllMobileOfflineInboxIntents(): Promise<void> {
  writeEpoch += 1;
  activeUserId = '';
  keyWriteSeq.clear();
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

export type MobileAutomationCheckResult = 'active' | 'none' | 'transient' | 'unknown';
export type MobileSharedTaskCheckResult = 'active' | 'inactive' | 'transient' | 'unknown';
export type MobileWorktreePreflightResult = 'clean' | 'dirty' | 'transient' | 'unknown';

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
  /** Authoritatively query the target host for active bound automation status. */
  checkActiveBoundAutomation(
    deviceId: string,
    session: RemoteSession,
  ): Promise<MobileAutomationCheckResult>;
  /** Authoritatively query the target host for active owned shared-task status. */
  checkActiveOwnedSharedTask(
    deviceId: string,
    sessionId: string,
  ): Promise<MobileSharedTaskCheckResult>;
  /** Authoritatively query the target host for worktree removal preflight status. */
  preflightWorktree(
    deviceId: string,
    sessionId: string,
  ): Promise<MobileWorktreePreflightResult>;
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
 * Destructive `complete` replay fails closed on every host precondition check.
 */
export function replayMobileOfflineInboxIntentsForDevice(
  deps: MobileOfflineInboxReplayDeps,
): Promise<void> {
  const { deviceId, userId } = deps;
  const existing = inFlightByDevice.get(deviceId);
  if (existing) return existing;
  const safeRemoveIntent = async (sessionId: string): Promise<void> => {
    try {
      await deps.removeIntent(userId, deviceId, sessionId);
    } catch {
      // Do not abort replay of other intents if clearing local storage fails.
    }
  };
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

      // For destructive `complete`, always fetch the authoritative single session from the target
      // host so `imAttached`, status, and activity anchors reflect real-time host state.
      let freshSession: RemoteSession | null =
        intent.kind === 'snooze'
          ? (deps.getCachedFreshSession(deviceId, intent.sessionId) ?? null)
          : null;
      if (!freshSession) {
        try {
          freshSession = await deps.fetchFreshSession(deviceId, intent.sessionId);
        } catch (err) {
          if (isExplicitRemoteNotFoundError(err)) {
            freshSession = null;
          } else if (isTransientReplayError(err)) {
            continue;
          } else {
            if (!isIntentCurrent(intent)) continue;
            if (intent.kind === 'complete') {
              await safeRemoveIntent(intent.sessionId);
              deps.notifyRejected(intent, 'preflight-unknown');
            }
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
        await safeRemoveIntent(intent.sessionId);
        continue;
      }

      if (decision.action === 'reject') {
        await safeRemoveIntent(intent.sessionId);
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
            await safeRemoveIntent(intent.sessionId);
            deps.notifySnoozeFailed(intent);
            continue;
          }
          deps.applyPatchedSession(deviceId, intent.sessionId, {
            snoozedUntil: updated.snoozedUntil ?? null,
            snoozedAt: updated.snoozedAt ?? null,
          });
          await safeRemoveIntent(intent.sessionId);
        } catch (err) {
          if (isTransientReplayError(err)) continue;
          await safeRemoveIntent(intent.sessionId);
          if (!isExplicitRemoteNotFoundError(err)) deps.notifySnoozeFailed(intent);
        }
        continue;
      }

      // decision.action === 'apply-complete'
      if (!freshSession) continue;
      // Pinned tasks settle without archiving (task-inbox.md): mark read and preserve pin/worktree.
      const automationStatus =
        freshSession.pinnedAt != null
          ? 'active'
          : await deps.checkActiveBoundAutomation(deviceId, freshSession);
      if (!isIntentCurrent(intent)) continue;
      if (automationStatus === 'transient') continue;
      if (automationStatus === 'unknown') {
        await safeRemoveIntent(intent.sessionId);
        deps.notifyRejected(intent, 'preflight-unknown');
        continue;
      }
      if (automationStatus === 'active') {
        try {
          await deps.markAutomationTaskRead(deviceId, freshSession);
          if (isIntentCurrent(intent)) {
            await safeRemoveIntent(intent.sessionId);
          }
        } catch (err) {
          if (isTransientReplayError(err)) continue;
          await safeRemoveIntent(intent.sessionId);
          deps.notifyRejected(intent, 'preflight-unknown');
        }
        continue;
      }

      const sharedTaskStatus = await deps.checkActiveOwnedSharedTask(deviceId, intent.sessionId);
      if (!isIntentCurrent(intent)) continue;
      if (sharedTaskStatus === 'transient') continue;
      if (sharedTaskStatus === 'active') {
        await safeRemoveIntent(intent.sessionId);
        deps.notifyRejected(intent, 'attached');
        continue;
      }
      if (sharedTaskStatus === 'unknown') {
        await safeRemoveIntent(intent.sessionId);
        deps.notifyRejected(intent, 'preflight-unknown');
        continue;
      }

      const preflight = await deps.preflightWorktree(deviceId, intent.sessionId);
      if (!isIntentCurrent(intent)) continue;
      if (preflight === 'transient') continue;
      if (preflight === 'dirty') {
        await safeRemoveIntent(intent.sessionId);
        deps.notifyRejected(intent, 'dirty-worktree');
        continue;
      }
      if (preflight !== 'clean') {
        await safeRemoveIntent(intent.sessionId);
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
          archivedAt: updated.archivedAt ?? null,
        });
        await safeRemoveIntent(intent.sessionId);
      } catch (err) {
        if (isTransientReplayError(err)) continue;
        await safeRemoveIntent(intent.sessionId);
        if (!isExplicitRemoteNotFoundError(err)) {
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
    writeSeq = 0;
    keyWriteSeq.clear();
    persistQueue = Promise.resolve();
    intentsByKey = new Map();
    inFlightByDevice.clear();
    emit();
  },
};
