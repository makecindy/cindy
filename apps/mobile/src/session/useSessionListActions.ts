import { taskSnoozeUntil } from '@cindy/maker-shared/live-task-priority';
import { patchSessionWithDeleteTarget } from '@cindy/maker-shared/device-link-contract';
import { useCallback, useMemo, useRef, useState } from 'react';
import { Alert } from 'react-native';
import { useTranslation } from 'react-i18next';
import { projectDraftSessionTitle } from '@cindy/maker-shared/session-title';
import { useDeviceLink } from '@/device-link/DeviceLinkContext';
import { humanizeRemoteError } from '@/device-link/remoteStatus';
import {
  getMobileOfflineInboxIntent,
  isOfflineInboxTransientError,
  queueMobileOfflineInboxComplete,
  queueMobileOfflineInboxSnooze,
  removeMobileOfflineInboxIntent,
} from '@/session/offlineInboxIntents';
import { isExplicitRemoteNotFoundError, isWorktreeChannelNotAllowedError } from '@/session/newSessionWorktree';
import { createMobileMakerTransport } from '@/device-link/mobileMakerTransport';
import { markSessionScheduleRunsRead } from '@/session/scheduleRunRead';
import { sessionMayHaveScheduleRuns } from '@/session/scheduleIndex';
import type { SessionMetaPatch } from '@/device-link/mobileMakerTransport';
import {
  remoteSessionStore,
  resolveSessionWriteDevices,
  sessionMetaWriteGuard,
  sessionMetaWriteQueue,
  sessionPendingWrites,
} from '@/session/remoteSessionStore';
import type { SessionSwipeControls } from '@/session/SwipeableSessionRow';
import {
  createSwipeRowRegistry,
  pickWriteFields,
  retryPatchWhileLatest,
  statusToggleAction,
  swipeActionPatch,
  writeGuardFields,
  type SessionSwipeAction,
} from '@/session/swipeRowRegistry';
import type { RemoteSession } from '@/session/types';
import { withNewSessionCreationRemoval } from '@/session/newSessionCreation';
import { confirmArchiveWithSchedules, loadActiveBoundScheduleNames } from '@/session/archiveScheduleConfirm';

/**
 * 首页与设备详情共用的任务行写回 / 滑动 / 选项菜单 / 重命名。
 * 写序契约与原先首页 patchHomeSession 一致:字段级 LatestWriteGuard + 串行队列 +
 * 乐观 patch + 失败按字段回滚。守卫与队列是 app 级单例,跨页共享。
 */
/**
 * animateListChange:列表页传入的过渡入口(listDisclosureTransition 的 run)。归档 / 置顶
 * 这类会让行移走或移位的乐观写入与失败回滚经它落地,行的移动与列表让位带动画;
 * 不传时直接写入。
 */
export function useSessionListActions(options?: {
  animateListChange?: (apply: () => void) => void;
  preferredRpcDeviceId?: string;
  /** Whether an active automation is bound to the task (inbox Done then only marks it read). */
  hasActiveAutomation?: (session: RemoteSession) => boolean;
  /** Enables offline queuing for inbox Complete / Snooze actions when the owning computer is offline. */
  inboxMode?: boolean;
  /** Optional live getter when caller declares inbox mode after this hook. */
  isInboxMode?: () => boolean;
  /** Signed-in user ID used to persist queued offline inbox intents per account. */
  userId?: string;
  /** Returns true when the task's owning computer is currently known to be offline. */
  isDeviceOffline?: (deviceId: string) => boolean;
}) {
  const animateListChange = options?.animateListChange;
  const hasActiveAutomationRef = useRef(options?.hasActiveAutomation);
  hasActiveAutomationRef.current = options?.hasActiveAutomation;
  const isInboxModeRef = useRef<() => boolean>(() => false);
  isInboxModeRef.current = options?.isInboxMode ?? (() => options?.inboxMode === true);
  const userIdRef = useRef(options?.userId ?? '');
  userIdRef.current = options?.userId ?? '';
  const isDeviceOfflineRef = useRef(options?.isDeviceOffline);
  isDeviceOfflineRef.current = options?.isDeviceOffline;
  const preferredRpcDeviceId = options?.preferredRpcDeviceId;
  const { t } = useTranslation();
  const { invoke } = useDeviceLink();
  const swipeRegistry = useMemo(() => createSwipeRowRegistry(), []);
  const [actionSheetSession, setActionSheetSession] = useState<RemoteSession | null>(null);
  const [renameSessionTarget, setRenameSessionTarget] = useState<RemoteSession | null>(null);
  const [renameSessionDraft, setRenameSessionDraft] = useState('');
  const [snoozeSessionTarget, setSnoozeSessionTarget] = useState<RemoteSession | null>(null);
  const pendingSnoozeActionRef = useRef<(() => void) | null>(null);
  const pendingSheetActionRef = useRef<(() => void) | null>(null);

  const patchSession = useCallback(async (
    session: RemoteSession,
    patch: SessionMetaPatch,
    prepare?: (isLatest: () => boolean) => Promise<boolean>,
    onApplied?: () => void,
  ) => {
    const devices = resolveSessionWriteDevices(session.id, session, preferredRpcDeviceId);
    if (!devices) throw new Error(t('devices.list.error.sessionDeviceNotFound'));
    const { rpcDeviceId, shardId } = devices;
    // Snooze and archive timestamps are host-derived; mask, settle and roll them back with status.
    const localPatch = patch.status !== undefined
      ? {
          ...patch,
          snoozedUntil: null,
          snoozedAt: null,
          archivedAt:
            patch.status === 'archived'
              ? (session.status === 'archived' && session.archivedAt
                  ? session.archivedAt
                  : new Date().toISOString())
              : null,
        }
      : patch.snoozedUntil !== undefined
        ? { ...patch, snoozedAt: patch.snoozedUntil === null ? null : new Date().toISOString() }
        : patch;
    const fields = Object.keys(localPatch);
    // 预检只取代旧预检、观察 status；取消时不能作废此前仍在重试的元数据写。
    let write = prepare
      ? sessionMetaWriteGuard.begin(session.id, ['archive-preflight'], ['status'])
      : sessionMetaWriteGuard.begin(session.id, writeGuardFields(localPatch));
    let rollbackSession = session;
    let applied = false;
    let finishPreview: (() => void) | undefined;
    const updateList = (apply: () => void): Promise<void> => new Promise((resolve, reject) => {
      const commit = () => {
        try { apply(); resolve(); } catch (err) { reject(err); }
      };
      if (animateListChange) animateListChange(commit);
      else commit();
    });
    const applyOptimistic = () => {
      if (!write.isLatest()) return;
      rollbackSession = remoteSessionStore.getSessions().find((s) => s.id === session.id) ?? session;
      onApplied?.();
      remoteSessionStore.applySessionPatch(shardId, session.id, localPatch);
      applied = true;
    };
    const releasePending = sessionPendingWrites.track(session.id, fields);
    const restoreSession = () => {
      const shardName = remoteSessionStore.getSessions()
        .find((s) => s.deviceLinkDeviceId === shardId)?.deviceLinkDeviceName
        ?? session.deviceLinkDeviceName
        ?? shardId;
      releasePending();
      const rollback = () => {
        remoteSessionStore.upsertDeviceSession(shardId, shardName, rollbackSession);
        remoteSessionStore.requestReseed(shardId);
      };
      if (animateListChange) animateListChange(rollback);
      else rollback();
    };
    try {
      if (prepare) {
        await updateList(() => {
          if (write.isLatest()) finishPreview = remoteSessionStore.beginSessionListRemovalPreview(session.id);
        });
        if (!write.isLatest()) return;
        const confirmed = await prepare(write.isLatest);
        if (!write.isLatest()) return;
        if (!confirmed) {
          releasePending();
          remoteSessionStore.requestReseed(shardId);
          return;
        }
        // 只有确认后才取代全部元数据写，并真正移除详情/清理消息。
        write = sessionMetaWriteGuard.begin(session.id, writeGuardFields(localPatch));
      }
      if (patch.status !== undefined || patch.pinnedAt !== undefined || patch.snoozedUntil !== undefined) await updateList(applyOptimistic);
      else applyOptimistic();
      if (!applied) return;
      const deleteTarget = patch.status === 'deleted'
        ? session.sideChatPromoted ? 'task' : session.source === 'side-chat' ? 'side-chat' : undefined
        : undefined;
      const updated = await withNewSessionCreationRemoval(session.id, rpcDeviceId, patch.status,
        () => sessionMetaWriteQueue.enqueue(session.id, fields, () => retryPatchWhileLatest(
        write.isLatest,
        (assertStillLatest) => patchSessionWithDeleteTarget(patch, deleteTarget, body => invoke<RemoteSession>(
          rpcDeviceId,
          'local-db:sessions:patch-meta',
          [session.id, body],
          { preSend: assertStillLatest },
        )),
        deleteTarget ? 1 : undefined,
      )), write.isLatest);
      if (patch.snoozedUntil !== undefined && write.isLatest() && updated?.snoozedUntil !== patch.snoozedUntil) {
        throw new Error('UNSUPPORTED_CAPABILITY');
      }
      if (updated && write.isLatest()) {
        const currentUpdatedAt = remoteSessionStore.getSessions()
          .find((s) => s.id === session.id)?.updatedAt ?? null;
        const settled = pickWriteFields(updated, fields, currentUpdatedAt);
        if (patch.status !== undefined && !Object.prototype.hasOwnProperty.call(updated, 'archivedAt')) {
          settled.archivedAt = null;
        }
        remoteSessionStore.applySessionPatch(
          shardId,
          session.id,
          settled,
        );
        if (sessionPendingWrites.consumeMaskedPush(session.id, fields)) {
          remoteSessionStore.requestReseed(shardId);
        }
      }
    } catch (err) {
      if (!applied) {
        releasePending();
        remoteSessionStore.requestReseed(shardId);
      } else if (write.isLatest()) {
        if (fields.includes('status')) {
          if (isExplicitRemoteNotFoundError(err)) {
            remoteSessionStore.applySessionPatch(shardId, session.id, { status: 'deleted' });
            remoteSessionStore.requestReseed(shardId);
            return;
          }
          // 先释放本笔在途登记:upsertDeviceSession 会挡掉 status 在途、已被乐观移出的行。
          restoreSession();
        } else {
          const rollback = () => {
            const currentUpdatedAt = remoteSessionStore.getSessions()
              .find((s) => s.id === session.id)?.updatedAt ?? null;
            remoteSessionStore.applySessionPatch(
              shardId,
              session.id,
              pickWriteFields(rollbackSession, fields, currentUpdatedAt),
            );
            remoteSessionStore.requestReseed(shardId);
          };
          // 置顶失败回滚同样会让行移位。
          if (fields.includes('pinnedAt') && animateListChange) animateListChange(rollback);
          else rollback();
        }
      } else {
        remoteSessionStore.requestReseed(shardId);
      }
      throw err;
    } finally {
      releasePending();
      if (finishPreview) await updateList(finishPreview);
    }
  }, [animateListChange, invoke, preferredRpcDeviceId, t]);

  const applyOfflineInboxAction = useCallback((
    session: RemoteSession,
    kind: 'complete' | 'snooze' | 'undo-complete',
    snoozedUntil?: string | null,
  ): boolean => {
    const devices = resolveSessionWriteDevices(session.id, session, preferredRpcDeviceId);
    if (!devices) return false;
    const rawHostSession =
      remoteSessionStore.getSessions().find((row) => row.id === session.id) ?? session;
    const run = () => {
      const promise =
        kind === 'undo-complete'
          ? removeMobileOfflineInboxIntent(userIdRef.current, devices.rpcDeviceId, session.id)
          : kind === 'complete'
            ? queueMobileOfflineInboxComplete(
                userIdRef.current,
                devices.rpcDeviceId,
                session.id,
                rawHostSession,
              )
            : queueMobileOfflineInboxSnooze(
                userIdRef.current,
                devices.rpcDeviceId,
                session.id,
                rawHostSession,
                snoozedUntil ?? null,
              );
      void promise.catch(() => {
        if (kind === 'snooze') {
          Alert.alert(t('devices.list.alert.actionFailed'), t('devices.list.menu.inbox.snoozeFailed'));
        } else {
          Alert.alert(t('devices.list.alert.actionFailed'));
        }
      });
    };
    if (animateListChange) animateListChange(run);
    else run();
    return true;
  }, [animateListChange, preferredRpcDeviceId, t]);

  const isSessionHostOffline = useCallback((session: RemoteSession): boolean => {
    const devices = resolveSessionWriteDevices(session.id, session, preferredRpcDeviceId);
    return Boolean(devices && isDeviceOfflineRef.current?.(devices.rpcDeviceId));
  }, [preferredRpcDeviceId]);

  // 归档预检提示 active 自动化后续会恢复原任务；沿用乐观归档事务，取消时恢复行。
  const runSwipeAction = useCallback((
    session: RemoteSession,
    action: Exclude<SessionSwipeAction, 'rename' | 'snooze' | 'wake'>,
    options: { skipScheduleConfirm?: boolean; inboxComplete?: boolean } = {},
  ) => {
    if (action === 'restore') {
      const devices = resolveSessionWriteDevices(session.id, session, preferredRpcDeviceId);
      if (
        devices &&
        getMobileOfflineInboxIntent(devices.rpcDeviceId, session.id)?.kind === 'complete' &&
        isSessionHostOffline(session)
      ) {
        applyOfflineInboxAction(session, 'undo-complete');
        return;
      }
    }
    if (action === 'archive' && options.inboxComplete && isSessionHostOffline(session)) {
      applyOfflineInboxAction(session, 'complete');
      return;
    }
    // Inbox Done is one tap: it archives without the automation reminder (quiet runs re-archive).
    void patchSession(session, swipeActionPatch(action), action === 'archive' && !options.skipScheduleConfirm ? async (isLatest) => {
      const devices = resolveSessionWriteDevices(session.id, session, preferredRpcDeviceId);
      const names = devices ? await loadActiveBoundScheduleNames({
        deviceId: devices.rpcDeviceId, invoke, sessionId: session.id, source: session.source,
      }) : [];
      return isLatest() && confirmArchiveWithSchedules(t, names);
    } : undefined).catch((err: unknown) => {
      if (
        action === 'archive' &&
        (options.inboxComplete || isInboxModeRef.current()) &&
        isOfflineInboxTransientError(err) &&
        applyOfflineInboxAction(session, 'complete')
      ) {
        swipeRegistry.closeOpenRow();
        return;
      }
      swipeRegistry.closeOpenRow();
      Alert.alert(t('devices.list.alert.actionFailed'), humanizeRemoteError(err));
    });
  }, [applyOfflineInboxAction, invoke, isSessionHostOffline, patchSession, preferredRpcDeviceId, swipeRegistry, t]);

  const applySessionSheetAction = useCallback((session: RemoteSession, action: SessionSwipeAction) => {
    if (action === 'delete') {
      const title = projectDraftSessionTitle(session.title, t('session.menu.unnamedTitle')).trim()
        || t('devices.list.untitled');
      Alert.alert(t('devices.list.alert.deleteTitle'), t('devices.list.alert.deleteMessage', { title }), [
        { style: 'cancel', text: t('devices.common.cancel') },
        { onPress: () => runSwipeAction(session, 'delete'), style: 'destructive', text: t('devices.common.delete') },
      ]);
      return;
    }
    if (action === 'snooze' || action === 'wake') {
      const write = (until: string | null) => {
        if (isInboxModeRef.current() && isSessionHostOffline(session)) {
          applyOfflineInboxAction(session, 'snooze', until);
          return;
        }
        void patchSession(session, { snoozedUntil: until }).catch((err: unknown) => {
          if (isInboxModeRef.current() && isOfflineInboxTransientError(err)) {
            applyOfflineInboxAction(session, 'snooze', until);
            return;
          }
          Alert.alert(t('devices.list.alert.actionFailed'), t('devices.list.menu.inbox.snoozeFailed'));
        });
      };
      if (action === 'wake') write(null);
      else setSnoozeSessionTarget(session);
      return;
    }
    if (action === 'rename') {
      setRenameSessionDraft(projectDraftSessionTitle(session.title, t('session.menu.unnamedTitle')));
      setRenameSessionTarget(session);
      return;
    }
    runSwipeAction(session, action);
  }, [applyOfflineInboxAction, isSessionHostOffline, patchSession, runSwipeAction, t]);

  const handleSessionSheetAction = useCallback((action: SessionSwipeAction) => {
    const session = actionSheetSession;
    setActionSheetSession(null);
    if (!session) return;
    if (action === 'rename' || action === 'delete' || action === 'archive' || action === 'snooze' || action === 'wake') {
      // Android Compose BottomSheet、iOS Expo BottomSheet、系统 Alert 都不能在 Sheet
      // dismiss 过程中再 present,否则会被吞掉或压在后面。归档可能弹自动化确认,同样延后。
      pendingSheetActionRef.current = () => applySessionSheetAction(session, action);
      return;
    }
    applySessionSheetAction(session, action);
  }, [actionSheetSession, applySessionSheetAction]);

  const handleSessionSheetClosed = useCallback(() => {
    const pending = pendingSheetActionRef.current;
    pendingSheetActionRef.current = null;
    pending?.();
  }, []);

  const closeRenameSession = useCallback(() => {
    setRenameSessionTarget(null);
  }, []);

  const confirmRenameSession = useCallback(() => {
    const target = renameSessionTarget;
    const title = renameSessionDraft.trim();
    if (!target || !title) return;
    setRenameSessionTarget(null);
    if (title === (target.title ?? '')) return;
    if (title === projectDraftSessionTitle(target.title, t('session.menu.unnamedTitle'))) return;
    void patchSession(target, { title }).catch((err: unknown) => {
      Alert.alert(t('devices.list.alert.renameFailed'), humanizeRemoteError(err));
    });
  }, [patchSession, renameSessionDraft, renameSessionTarget, t]);

  const toggleSessionPinned = useCallback((session: RemoteSession) => {
    runSwipeAction(session, session.pinnedAt ? 'unpin' : 'pin');
  }, [runSwipeAction]);

  const archiveSession = useCallback((session: RemoteSession) => {
    const { action } = statusToggleAction(session.status);
    runSwipeAction(session, action);
  }, [runSwipeAction]);

  const showSessionOptions = useCallback((session: RemoteSession) => {
    setActionSheetSession(session);
  }, []);

  const snoozeSession = useCallback((session: RemoteSession) => {
    swipeRegistry.closeOpenRow();
    const until = taskSnoozeUntil(session);
    applySessionSheetAction(session, until > Date.now() ? 'wake' : 'snooze');
  }, [applySessionSheetAction, swipeRegistry]);

  const confirmSnooze = useCallback((until: string) => {
    const session = snoozeSessionTarget;
    if (!session) return;
    setSnoozeSessionTarget(null);
    // Present any save error only after the native sheet has finished dismissing.
    pendingSnoozeActionRef.current = () => {
      if (isInboxModeRef.current() && isSessionHostOffline(session)) {
        applyOfflineInboxAction(session, 'snooze', until);
        return;
      }
      void patchSession(session, { snoozedUntil: until }).catch((err: unknown) => {
        if (isInboxModeRef.current() && isOfflineInboxTransientError(err)) {
          applyOfflineInboxAction(session, 'snooze', until);
          return;
        }
        Alert.alert(t('devices.list.alert.actionFailed'), t('devices.list.menu.inbox.snoozeFailed'));
      });
    };
  }, [applyOfflineInboxAction, isSessionHostOffline, snoozeSessionTarget, patchSession, t]);
  const closeSnooze = useCallback(() => setSnoozeSessionTarget(null), []);
  const handleSnoozeClosed = useCallback(() => {
    const pending = pendingSnoozeActionRef.current;
    pendingSnoozeActionRef.current = null;
    pending?.();
  }, []);

  const markSessionRead = useCallback((session: RemoteSession) => {
    const devices = resolveSessionWriteDevices(session.id, session, preferredRpcDeviceId);
    if (!devices) {
      Alert.alert(t('devices.list.alert.actionFailed'), t('devices.list.error.sessionDeviceNotFound'));
      return;
    }
    const activityAtSwipe = remoteSessionStore.getSessionLiveActivity(session.id);
    const runAtSwipe = remoteSessionStore.getSessionRunStatus(session.id);
    const superseded = new Error('RECEIPT_SUPERSEDED');
    const isCurrent = () => remoteSessionStore.getSessionLiveActivity(session.id) === activityAtSwipe
      && remoteSessionStore.getSessionRunStatus(session.id) === runAtSwipe;
    const maker = createMobileMakerTransport({
      deviceId: devices.rpcDeviceId,
      invoke: (deviceId, channel, args) => channel !== 'notification:clear-session-attention'
        && channel !== 'maker:schedule:mark-run-read'
        ? invoke(deviceId, channel, args)
        : invoke(deviceId, channel, args, { preSend: () => {
          // Recheck after reconnect/backpressure. A new run invalidates even an identical completion label.
          if (!isCurrent()) throw superseded;
        } }),
    });
    const scheduleRead = sessionMayHaveScheduleRuns(devices.rpcDeviceId, session.id, session.source)
      ? markSessionScheduleRunsRead(maker, session.id, devices.rpcDeviceId, isCurrent).catch((err: unknown) => {
        if (!isCurrent()) throw superseded;
        throw err;
      }) : Promise.resolve();
    // Clear attention last: its normal relay echo must not invalidate this gesture's schedule reads.
    // A schedule lookup failure still permits the independent attention write, and remains reportable.
    const attentionRead = scheduleRead.catch(() => undefined)
      .then(() => maker.clearSessionAttention(session.id, 'explicit')).catch((err: unknown) => {
        // Older Hosts lack this channel; schedule-read has already been attempted.
        if (err !== superseded && !isWorktreeChannelNotAllowedError(err)) throw err;
      });
    void Promise.all([scheduleRead, attentionRead]).catch((err: unknown) => {
      if (err === superseded) return;
      Alert.alert(t('devices.list.alert.actionFailed'), humanizeRemoteError(err));
    });
  }, [invoke, preferredRpcDeviceId, t]);

  // Done settles this round without archiving a pinned task or recycling an automation's worktree.
  const completeSession = useCallback((session: RemoteSession) => {
    if (isSessionHostOffline(session)) {
      swipeRegistry.closeOpenRow();
      applyOfflineInboxAction(session, 'complete');
      return;
    }
    if (session.pinnedAt || hasActiveAutomationRef.current?.(session)) {
      swipeRegistry.closeOpenRow();
      markSessionRead(session);
      return;
    }
    runSwipeAction(session, 'archive', { skipScheduleConfirm: true, inboxComplete: true });
  }, [applyOfflineInboxAction, isSessionHostOffline, markSessionRead, runSwipeAction, swipeRegistry]);

  const sessionSwipeControls = useMemo<SessionSwipeControls>(() => ({
    onSnooze: snoozeSession,
    onMarkRead: markSessionRead,
    onArchive: archiveSession,
    onComplete: completeSession,
    onShowOptions: showSessionOptions,
    onTogglePin: toggleSessionPinned,
    registry: swipeRegistry,
  }), [archiveSession, completeSession, markSessionRead, showSessionOptions, snoozeSession, swipeRegistry, toggleSessionPinned]);

  return {
    snoozeSessionTarget, confirmSnooze, closeSnooze, handleSnoozeClosed,
    patchSession,
    actionSheetSession,
    archiveSession,
    closeRenameSession,
    confirmRenameSession,
    handleSessionSheetAction,
    handleSessionSheetClosed,
    renameSessionDraft,
    renameSessionTarget,
    sessionSwipeControls,
    setActionSheetSession,
    setRenameSessionDraft,
    showSessionOptions,
    swipeRegistry,
    toggleSessionPinned,
  };
}
