/**
 * Replays queued offline inbox intents (`snooze` / `complete`) once the owning computer
 * reconnects and finishes its authoritative bootstrap snapshot.
 */

import { SHARED_TASK_HOST_CHANNEL, type SharedTaskHostState } from '@cindy/device-link';
import {
  evaluateOfflineInboxIntentReplay,
  type OfflineInboxIntent,
  type OfflineInboxReplayRejectReason,
} from '@cindy/maker-shared/offline-inbox-intent';
import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
} from '@/contexts/dataOwnerGeneration';
import i18n from '@/i18n';
import type { Session } from '@/lib/ccAgent.types';
import { createLogger } from '@/lib/logger';
import { toast } from '@/lib/toast';
import { clearSessionAttentionMany } from '@/lib/sessionAttentionStore';
import { markScheduleRunsReadAndSync } from '../scheduler/lib/scheduleRunReadSync';
import {
  getOfflineInboxIntent,
  getOfflineInboxIntentsForDevice,
  removeOfflineInboxIntent,
} from './offlineInboxIntentsStore';
import { isTransientRemoteError, readRemoteScheduleIndex } from './refreshRemoteSessions';
import { remoteProjectsStore } from './remoteProjectsStore';
import { getRemoteSessionActivity } from './remoteSessionActivityStore';

const log = createLogger('device-link:offline-inbox-replay');

export type OfflineAutomationCheckResult = 'active' | 'none' | 'transient' | 'unknown';
export type OfflineSharedTaskCheckResult = 'active' | 'inactive' | 'transient' | 'unknown';
export type OfflineWorktreePreflightResult = 'clean' | 'dirty' | 'transient' | 'unknown';

export interface OfflineInboxReplayDeps {
  getIntents(deviceId: string): OfflineInboxIntent[];
  getCurrentIntent(deviceId: string, sessionId: string): OfflineInboxIntent | undefined;
  removeIntent(deviceId: string, sessionId: string): Promise<void>;
  isDeviceConnected(deviceId: string): boolean;
  getCachedFreshSession(deviceId: string, sessionId: string): Session | undefined;
  fetchFreshSession(deviceId: string, sessionId: string): Promise<Session | null>;
  isRunning(deviceId: string, sessionId: string): boolean;
  /** Authoritatively query the target host for active bound automation status. */
  checkActiveBoundAutomation(
    deviceId: string,
    sessionId: string,
  ): Promise<OfflineAutomationCheckResult>;
  /** Authoritatively query the target host for active owned shared-task status. */
  checkActiveOwnedSharedTask(
    deviceId: string,
    sessionId: string,
  ): Promise<OfflineSharedTaskCheckResult>;
  /** Authoritatively query the target host for worktree removal preflight status. */
  preflightWorktree(
    deviceId: string,
    sessionId: string,
  ): Promise<OfflineWorktreePreflightResult>;
  patchMeta(deviceId: string, sessionId: string, patch: Record<string, unknown>): Promise<Session>;
  applyPatchedSession(deviceId: string, sessionId: string, patch: Record<string, unknown>): void;
  markAutomationTaskRead(deviceId: string, sessionId: string): Promise<boolean>;
  notifyRejected(intent: OfflineInboxIntent, reason: OfflineInboxReplayRejectReason): void;
  notifySnoozeFailed(intent: OfflineInboxIntent): void;
  nowMs?: () => number;
}

function isNotFoundError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes('[NOT_FOUND]') || /\bNOT_FOUND\b/i.test(message);
}

function isUnsupportedChannelError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes('CHANNEL_NOT_ALLOWED') || message.includes('UNSUPPORTED_CAPABILITY');
}

function isTransientReplayError(err: unknown, connected: boolean): boolean {
  if (!connected) return true;
  const message = err instanceof Error ? err.message : String(err);
  return isTransientRemoteError(message) || /LINK_NOT_OPEN|DEVICE_UNRESPONSIVE/i.test(message);
}

function extractActiveScheduleTargetSessionIds(raw: unknown): Set<string> | null {
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as { schedules?: unknown }).schedules)
      ? (raw as { schedules: unknown[] }).schedules
      : null;
  if (!list) return null;
  const ids = new Set<string>();
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const record = item as { status?: unknown; targetSessionId?: unknown };
    if (record.status === 'active' && typeof record.targetSessionId === 'string' && record.targetSessionId) {
      ids.add(record.targetSessionId);
    }
  }
  return ids;
}

function rejectToastKey(reason: OfflineInboxReplayRejectReason): string {
  switch (reason) {
    case 'dirty-worktree':
      return 'ccAgent.sidebar.inbox.offlineCompleteRejectedDirty';
    case 'new-activity':
      return 'ccAgent.sidebar.inbox.offlineCompleteRejectedNewActivity';
    case 'running':
      return 'ccAgent.sidebar.inbox.offlineCompleteRejectedRunning';
    case 'attached':
      return 'ccAgent.sidebar.inbox.offlineCompleteRejectedAttached';
    case 'preflight-unknown':
      return 'ccAgent.sidebar.inbox.offlineCompleteRejectedPreflight';
  }
}

function isDeviceConnectedDefault(deviceId: string): boolean {
  return remoteProjectsStore.getDeviceList().some((d) => d.deviceId === deviceId && d.connected);
}

function createDefaultDepsForPass(): OfflineInboxReplayDeps {
  const scheduleLookupByDevice = new Map<
    string,
    Promise<{ ok: true; activeSessionIds: Set<string> } | { ok: false; transient: boolean }>
  >();

  const loadActiveScheduleTargets = (deviceId: string) => {
    const existing = scheduleLookupByDevice.get(deviceId);
    if (existing) return existing;
    const pending = (async (): Promise<
      { ok: true; activeSessionIds: Set<string> } | { ok: false; transient: boolean }
    > => {
      try {
        const raw = await window.electronAPI.deviceLink.invoke(deviceId, 'maker:schedule:list', [
          null,
          { sessionBindings: true },
        ]);
        const ids = extractActiveScheduleTargetSessionIds(raw);
        if (!ids) return { ok: false, transient: false };
        return { ok: true, activeSessionIds: ids };
      } catch (err) {
        if (isUnsupportedChannelError(err)) {
          return { ok: true, activeSessionIds: new Set<string>() };
        }
        return {
          ok: false,
          transient: isTransientReplayError(err, isDeviceConnectedDefault(deviceId)),
        };
      }
    })();
    scheduleLookupByDevice.set(deviceId, pending);
    return pending;
  };

  return {
    getIntents: getOfflineInboxIntentsForDevice,
    getCurrentIntent: getOfflineInboxIntent,
    removeIntent: removeOfflineInboxIntent,
    isDeviceConnected: isDeviceConnectedDefault,
    getCachedFreshSession: (deviceId, sessionId) =>
      remoteProjectsStore.getDeviceSessions(deviceId).find((session) => session.id === sessionId),
    fetchFreshSession: async (deviceId, sessionId) => {
      try {
        const result = (await window.electronAPI.deviceLink.invoke(
          deviceId,
          'local-db:sessions:get',
          [sessionId],
        )) as Session | null | undefined;
        return result && typeof result.id === 'string' ? result : null;
      } catch (err) {
        if (isNotFoundError(err)) return null;
        throw err;
      }
    },
    isRunning: (deviceId, sessionId) =>
      getRemoteSessionActivity(sessionId, deviceId)?.phase === 'running',
    checkActiveBoundAutomation: async (deviceId, sessionId) => {
      const result = await loadActiveScheduleTargets(deviceId);
      if (!result.ok) return result.transient ? 'transient' : 'unknown';
      return result.activeSessionIds.has(sessionId) ? 'active' : 'none';
    },
    checkActiveOwnedSharedTask: async (deviceId, sessionId) => {
      try {
        const result = (await window.electronAPI.deviceLink.invoke(
          deviceId,
          SHARED_TASK_HOST_CHANNEL,
          [{ action: 'state', sessionId }],
        )) as SharedTaskHostState | null | undefined;
        return result?.detail?.status === 'active' ? 'active' : 'inactive';
      } catch (err) {
        if (isUnsupportedChannelError(err)) return 'inactive';
        return isTransientReplayError(err, isDeviceConnectedDefault(deviceId))
          ? 'transient'
          : 'unknown';
      }
    },
    preflightWorktree: async (deviceId, sessionId) => {
      try {
        const preview = (await window.electronAPI.deviceLink.invoke(
          deviceId,
          'worktree:removal-preview',
          [sessionId],
        )) as { hasWorktree?: unknown; dirty?: unknown } | null | undefined;
        if (!preview || typeof preview !== 'object') return 'unknown';
        if (preview.hasWorktree !== true || preview.dirty !== true) return 'clean';
        return 'dirty';
      } catch (err) {
        if (isUnsupportedChannelError(err)) return 'unknown';
        return isTransientReplayError(err, isDeviceConnectedDefault(deviceId))
          ? 'transient'
          : 'unknown';
      }
    },
    patchMeta: (deviceId, sessionId, patch) =>
      window.electronAPI.deviceLink.invoke(deviceId, 'local-db:sessions:patch-meta', [
        sessionId,
        patch,
      ]) as Promise<Session>,
    applyPatchedSession: (deviceId, sessionId, patch) => {
      remoteProjectsStore.applyPatch(deviceId, sessionId, patch);
    },
    markAutomationTaskRead: async (deviceId, sessionId) => {
      clearSessionAttentionMany([sessionId], { intent: 'explicit' });
      try {
        const index = await readRemoteScheduleIndex(deviceId);
        const unreadRunIds = index.get(sessionId)?.unreadRunIds ?? [];
        const { failed, firstError } = await markScheduleRunsReadAndSync(unreadRunIds, deviceId);
        return failed.length === 0 && firstError === undefined;
      } catch (err) {
        if (isUnsupportedChannelError(err)) return true;
        throw err;
      }
    },
    notifyRejected: (intent, reason) => {
      const title = intent.sessionTitle || i18n.t('ccAgent.common.unnamedSession');
      toast.warning(i18n.t(rejectToastKey(reason), { title }));
    },
    notifySnoozeFailed: () => {
      toast.error(i18n.t('ccAgent.sidebar.inbox.snoozeFailed'));
    },
  };
}

const inFlightByDevice = new Map<string, Promise<void>>();

/**
 * Replay every queued offline inbox intent for `deviceId` in sequence.
 * Serialized per device; transient disconnect/timeout errors preserve the intent for the next reconnect.
 * Destructive `complete` replay fails closed on every host precondition check.
 */
export function replayOfflineInboxIntentsForDevice(
  deviceId: string,
  providedDeps?: OfflineInboxReplayDeps,
): Promise<void> {
  const existing = inFlightByDevice.get(deviceId);
  if (existing) return existing;
  const deps = providedDeps ?? createDefaultDepsForPass();
  const owner = getDataOwnerGeneration();
  const safeRemoveIntent = async (sessionId: string): Promise<void> => {
    try {
      await deps.removeIntent(deviceId, sessionId);
    } catch (err) {
      log.warn('offline inbox replay failed to clear settled intent', err);
    }
  };
  const run = (async () => {
    const intents = deps.getIntents(deviceId);
    if (intents.length === 0) return;

    const isStillCurrent = (intent: OfflineInboxIntent): boolean => {
      if (!isDataOwnerGenerationCurrent(owner) || !deps.isDeviceConnected(deviceId)) return false;
      const current = deps.getCurrentIntent(deviceId, intent.sessionId);
      return Boolean(current && current.createdAt === intent.createdAt && current.kind === intent.kind);
    };

    for (const intent of intents) {
      if (!isStillCurrent(intent)) continue;

      // For destructive `complete`, always fetch the single authoritative session from the target
      // host so `imAttached`, status, and activity anchors reflect real-time host state.
      let freshSession: Session | null =
        intent.kind === 'snooze'
          ? (deps.getCachedFreshSession(deviceId, intent.sessionId) ?? null)
          : null;
      if (!freshSession) {
        try {
          freshSession = await deps.fetchFreshSession(deviceId, intent.sessionId);
        } catch (err) {
          if (isTransientReplayError(err, deps.isDeviceConnected(deviceId))) continue;
          if (!isStillCurrent(intent)) continue;
          if (intent.kind === 'complete') {
            await safeRemoveIntent(intent.sessionId);
            deps.notifyRejected(intent, 'preflight-unknown');
          } else {
            log.debug('offline inbox replay session lookup failed', err);
          }
          continue;
        }
      }
      if (!isStillCurrent(intent)) continue;

      const decision = evaluateOfflineInboxIntentReplay(intent, freshSession, {
        isRunning: deps.isRunning(deviceId, intent.sessionId),
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
          if (!isStillCurrent(intent)) continue;
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
          if (isTransientReplayError(err, deps.isDeviceConnected(deviceId))) continue;
          await safeRemoveIntent(intent.sessionId);
          if (!isNotFoundError(err)) deps.notifySnoozeFailed(intent);
        }
        continue;
      }

      // decision.action === 'apply-complete'
      // Pinned tasks settle without archiving (task-inbox.md): mark read and preserve pin/worktree.
      const automationStatus =
        freshSession?.pinnedAt != null
          ? 'active'
          : await deps.checkActiveBoundAutomation(deviceId, intent.sessionId);
      if (!isStillCurrent(intent)) continue;
      if (automationStatus === 'transient') continue;
      if (automationStatus === 'unknown') {
        await safeRemoveIntent(intent.sessionId);
        deps.notifyRejected(intent, 'preflight-unknown');
        continue;
      }
      if (automationStatus === 'active') {
        try {
          const ok = await deps.markAutomationTaskRead(deviceId, intent.sessionId);
          if (ok && isStillCurrent(intent)) {
            await safeRemoveIntent(intent.sessionId);
          } else if (!ok && isStillCurrent(intent)) {
            await safeRemoveIntent(intent.sessionId);
            deps.notifyRejected(intent, 'preflight-unknown');
          }
        } catch (err) {
          if (isTransientReplayError(err, deps.isDeviceConnected(deviceId))) continue;
          log.warn('offline inbox replay mark-read failed', err);
          await safeRemoveIntent(intent.sessionId);
          deps.notifyRejected(intent, 'preflight-unknown');
        }
        continue;
      }

      const sharedTaskStatus = await deps.checkActiveOwnedSharedTask(deviceId, intent.sessionId);
      if (!isStillCurrent(intent)) continue;
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
      if (!isStillCurrent(intent)) continue;
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
        if (!isStillCurrent(intent)) continue;
        deps.applyPatchedSession(deviceId, intent.sessionId, {
          status: updated?.status ?? 'archived',
          pinnedAt: updated?.pinnedAt ?? null,
          snoozedUntil: null,
          snoozedAt: null,
        });
        await safeRemoveIntent(intent.sessionId);
      } catch (err) {
        if (isTransientReplayError(err, deps.isDeviceConnected(deviceId))) continue;
        await safeRemoveIntent(intent.sessionId);
        if (!isNotFoundError(err)) {
          log.warn('offline inbox replay archive failed', err);
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
