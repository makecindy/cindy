import { useCallback, useMemo, useRef, useState } from 'react';
import { Alert } from 'react-native';
import { useTranslation } from 'react-i18next';
import { projectDraftSessionTitle } from '@cindy/maker-shared/session-title';
import { useDeviceLink } from '@/device-link/DeviceLinkContext';
import { humanizeRemoteError } from '@/device-link/remoteStatus';
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
  type SessionOptionAction,
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
}) {
  const animateListChange = options?.animateListChange;
  const preferredRpcDeviceId = options?.preferredRpcDeviceId;
  const { t } = useTranslation();
  const { invoke } = useDeviceLink();
  const swipeRegistry = useMemo(() => createSwipeRowRegistry(), []);
  const [actionSheetSession, setActionSheetSession] = useState<RemoteSession | null>(null);
  const [renameSessionTarget, setRenameSessionTarget] = useState<RemoteSession | null>(null);
  const [renameSessionDraft, setRenameSessionDraft] = useState('');
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
    const fields = Object.keys(patch);
    // 预检只取代旧预检、观察 status；取消时不能作废此前仍在重试的元数据写。
    let write = prepare
      ? sessionMetaWriteGuard.begin(session.id, ['archive-preflight'], ['status'])
      : sessionMetaWriteGuard.begin(session.id, writeGuardFields(patch));
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
      remoteSessionStore.applySessionPatch(shardId, session.id, patch);
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
        write = sessionMetaWriteGuard.begin(session.id, writeGuardFields(patch));
      }
      if (patch.status !== undefined || patch.pinnedAt !== undefined || patch.projectPinnedAt !== undefined) await updateList(applyOptimistic);
      else applyOptimistic();
      if (!applied) return;
      const updated = await withNewSessionCreationRemoval(session.id, rpcDeviceId, patch.status,
        () => sessionMetaWriteQueue.enqueue(session.id, fields, () => retryPatchWhileLatest(
        write.isLatest,
        (assertStillLatest) => invoke<RemoteSession>(
          rpcDeviceId,
          'local-db:sessions:patch-meta',
          [session.id, patch],
          { preSend: assertStillLatest },
        ),
      )), write.isLatest);
      if (updated && write.isLatest()) {
        const currentUpdatedAt = remoteSessionStore.getSessions()
          .find((s) => s.id === session.id)?.updatedAt ?? null;
        remoteSessionStore.applySessionPatch(
          shardId,
          session.id,
          pickWriteFields(updated, fields, currentUpdatedAt),
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
              pickWriteFields(session, fields, currentUpdatedAt),
            );
            remoteSessionStore.requestReseed(shardId);
          };
          // 置顶失败回滚同样会让行移位。
          if ((fields.includes('pinnedAt') || fields.includes('projectPinnedAt')) && animateListChange) animateListChange(rollback);
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

  // 归档预检提示 active 自动化后续会恢复原任务；沿用乐观归档事务，取消时恢复行。
  const runSwipeAction = useCallback((session: RemoteSession, action: Exclude<SessionSwipeAction, 'rename'>) => {
    void patchSession(session, swipeActionPatch(action), action === 'archive' ? async (isLatest) => {
      const devices = resolveSessionWriteDevices(session.id, session, preferredRpcDeviceId);
      const names = devices ? await loadActiveBoundScheduleNames({
        deviceId: devices.rpcDeviceId, invoke, sessionId: session.id, source: session.source,
      }) : [];
      return isLatest() && confirmArchiveWithSchedules(t, names);
    } : undefined).catch((err: unknown) => {
      swipeRegistry.closeOpenRow();
      Alert.alert(t('devices.list.alert.actionFailed'), humanizeRemoteError(err));
    });
  }, [invoke, patchSession, preferredRpcDeviceId, swipeRegistry, t]);

  const applySessionSheetAction = useCallback((session: RemoteSession, action: SessionOptionAction) => {
    if (action === 'pin-project' || action === 'unpin-project') {
      void patchSession(session, { projectPinnedAt: action === 'pin-project' ? new Date().toISOString() : null })
        .catch((err: unknown) => Alert.alert(t('devices.list.alert.actionFailed'), humanizeRemoteError(err)));
      return;
    }
    if (action === 'delete') {
      const title = projectDraftSessionTitle(session.title, t('session.menu.unnamedTitle')).trim()
        || t('devices.list.untitled');
      Alert.alert(t('devices.list.alert.deleteTitle'), t('devices.list.alert.deleteMessage', { title }), [
        { style: 'cancel', text: t('devices.common.cancel') },
        { onPress: () => runSwipeAction(session, 'delete'), style: 'destructive', text: t('devices.common.delete') },
      ]);
      return;
    }
    if (action === 'rename') {
      setRenameSessionDraft(projectDraftSessionTitle(session.title, t('session.menu.unnamedTitle')));
      setRenameSessionTarget(session);
      return;
    }
    runSwipeAction(session, action);
  }, [patchSession, runSwipeAction, t]);

  const handleSessionSheetAction = useCallback((action: SessionOptionAction) => {
    const session = actionSheetSession;
    setActionSheetSession(null);
    if (!session) return;
    if (action === 'rename' || action === 'delete' || action === 'archive') {
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

  const sessionSwipeControls = useMemo<SessionSwipeControls>(() => ({
    onMarkRead: markSessionRead,
    onArchive: archiveSession,
    onShowOptions: showSessionOptions,
    onTogglePin: toggleSessionPinned,
    registry: swipeRegistry,
  }), [archiveSession, markSessionRead, showSessionOptions, swipeRegistry, toggleSessionPinned]);

  return {
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
