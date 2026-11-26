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
import {
  isDirtyWorktree,
  resolveWorktreeRemovalPreflight,
  type WorktreeRemovalPreflight,
} from '@/lib/worktreeRemovalWarning';
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

export interface OfflineInboxReplayDeps {
  getIntents(deviceId: string): OfflineInboxIntent[];
  getCurrentIntent(deviceId: string, sessionId: string): OfflineInboxIntent | undefined;
  removeIntent(deviceId: string, sessionId: string): Promise<void>;
  isDeviceConnected(deviceId: string): boolean;
  getCachedFreshSession(deviceId: string, sessionId: string): Session | undefined;
  fetchFreshSession(deviceId: string, sessionId: string): Promise<Session | null>;
  isRunning(deviceId: string, sessionId: string): boolean;
  isAttached(sessionId: string): Promise<boolean>;
  hasActiveBoundAutomation(deviceId: string, sessionId: string): boolean;
  hasActiveOwnedSharedTask(deviceId: string, sessionId: string): Promise<boolean>;
  preflightWorktree(deviceId: string, sessionId: string): Promise<WorktreeRemovalPreflight>;
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

const defaultDeps: OfflineInboxReplayDeps = {
  getIntents: getOfflineInboxIntentsForDevice,
  getCurrentIntent: getOfflineInboxIntent,
  removeIntent: removeOfflineInboxIntent,
  isDeviceConnected: (deviceId) =>
    remoteProjectsStore.getDeviceList().some((d) => d.deviceId === deviceId && d.connected),
  getCachedFreshSession: (deviceId, sessionId) =>
    remoteProjectsStore.getDeviceSessions(deviceId).find((session) => session.id === sessionId),
  fetchFreshSession: async (deviceId, sessionId) => {
    try {
      const result = (await window.electronAPI.deviceLink.invoke(deviceId, 'local-db:sessions:get', [
        sessionId,
      ])) as Session | null | undefined;
      return result && typeof result.id === 'string' ? result : null;
    } catch (err) {
      if (isNotFoundError(err)) return null;
      throw err;
    }
  },
  isRunning: (deviceId, sessionId) =>
    getRemoteSessionActivity(sessionId, deviceId)?.phase === 'running',
  isAttached: async (sessionId) => {
    try {
      const binding = await window.electronAPI.binding.resolveSession(sessionId);
      return binding?.attached === true;
    } catch {
      return false;
    }
  },
  hasActiveBoundAutomation: (deviceId, sessionId) =>
    remoteProjectsStore
      .getSessionScheduleBindings(deviceId, sessionId)
      .some((binding) => binding.status === 'active'),
  hasActiveOwnedSharedTask: async (deviceId, sessionId) => {
    try {
      const result = (await window.electronAPI.deviceLink.invoke(
        deviceId,
        SHARED_TASK_HOST_CHANNEL,
        [{ action: 'state', sessionId }],
      )) as SharedTaskHostState | null | undefined;
      return result?.detail?.status === 'active';
    } catch {
      return false;
    }
  },
  preflightWorktree: (deviceId, sessionId) => resolveWorktreeRemovalPreflight(sessionId, deviceId),
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

const inFlightByDevice = new Map<string, Promise<void>>();

/**
 * Replay every queued offline inbox intent for `deviceId` in sequence.
 * Serialized per device; transient disconnect/timeout errors preserve the intent for the next reconnect.
 */
export function replayOfflineInboxIntentsForDevice(
  deviceId: string,
  deps: OfflineInboxReplayDeps = defaultDeps,
): Promise<void> {
  const existing = inFlightByDevice.get(deviceId);
  if (existing) return existing;
  const owner = getDataOwnerGeneration();
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

      let freshSession: Session | null = deps.getCachedFreshSession(deviceId, intent.sessionId) ?? null;
      if (!freshSession) {
        try {
          freshSession = await deps.fetchFreshSession(deviceId, intent.sessionId);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (isTransientRemoteError(message) || !deps.isDeviceConnected(deviceId)) continue;
          log.debug('offline inbox replay session lookup failed', err);
          continue;
        }
      }
      if (!isStillCurrent(intent)) continue;

      const attached = intent.kind === 'complete' ? await deps.isAttached(intent.sessionId) : false;
      if (!isStillCurrent(intent)) continue;

      const decision = evaluateOfflineInboxIntentReplay(intent, freshSession, {
        isRunning: deps.isRunning(deviceId, intent.sessionId),
        isAttached: attached,
        nowMs: deps.nowMs?.(),
      });

      if (decision.action === 'drop') {
        await deps.removeIntent(deviceId, intent.sessionId);
        continue;
      }

      if (decision.action === 'reject') {
        await deps.removeIntent(deviceId, intent.sessionId);
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
            await deps.removeIntent(deviceId, intent.sessionId);
            deps.notifySnoozeFailed(intent);
            continue;
          }
          deps.applyPatchedSession(deviceId, intent.sessionId, {
            snoozedUntil: updated.snoozedUntil ?? null,
            snoozedAt: updated.snoozedAt ?? null,
          });
          await deps.removeIntent(deviceId, intent.sessionId);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (isTransientRemoteError(message) || !deps.isDeviceConnected(deviceId)) continue;
          await deps.removeIntent(deviceId, intent.sessionId);
          if (!isNotFoundError(err)) deps.notifySnoozeFailed(intent);
        }
        continue;
      }

      // decision.action === 'apply-complete'
      if (deps.hasActiveBoundAutomation(deviceId, intent.sessionId)) {
        try {
          const ok = await deps.markAutomationTaskRead(deviceId, intent.sessionId);
          if (ok && isStillCurrent(intent)) {
            await deps.removeIntent(deviceId, intent.sessionId);
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (isTransientRemoteError(message) || !deps.isDeviceConnected(deviceId)) continue;
          log.warn('offline inbox replay mark-read failed', err);
          await deps.removeIntent(deviceId, intent.sessionId);
        }
        continue;
      }

      if (await deps.hasActiveOwnedSharedTask(deviceId, intent.sessionId)) {
        if (!isStillCurrent(intent)) continue;
        await deps.removeIntent(deviceId, intent.sessionId);
        deps.notifyRejected(intent, 'attached');
        continue;
      }
      if (!isStillCurrent(intent)) continue;

      const preflight = await deps.preflightWorktree(deviceId, intent.sessionId);
      if (!isStillCurrent(intent)) continue;
      if (isDirtyWorktree(preflight)) {
        await deps.removeIntent(deviceId, intent.sessionId);
        deps.notifyRejected(intent, 'dirty-worktree');
        continue;
      }
      if (preflight !== 'clean') {
        if (!deps.isDeviceConnected(deviceId)) continue;
        await deps.removeIntent(deviceId, intent.sessionId);
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
        await deps.removeIntent(deviceId, intent.sessionId);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (isTransientRemoteError(message) || !deps.isDeviceConnected(deviceId)) continue;
        await deps.removeIntent(deviceId, intent.sessionId);
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
