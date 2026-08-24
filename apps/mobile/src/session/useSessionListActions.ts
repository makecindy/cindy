import { useCallback, useMemo, useRef, useState } from 'react';
import { Alert } from 'react-native';
import { useTranslation } from 'react-i18next';
import { projectDraftSessionTitle } from '@cindy/maker-shared/session-title';
import { useDeviceLink } from '@/device-link/DeviceLinkContext';
import { humanizeRemoteError } from '@/device-link/remoteStatus';
import type { SessionMetaPatch } from '@/device-link/mobileMakerTransport';
import { configureCollapseAnimation } from '@/utils/collapseAnimation';
import {
  remoteSessionStore,
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

/**
 * 首页与设备详情共用的任务行写回 / 滑动 / 选项菜单 / 重命名。
 * 写序契约与原先首页 patchHomeSession 一致:字段级 LatestWriteGuard + 串行队列 +
 * 乐观 patch + 失败按字段回滚。守卫与队列是 app 级单例,跨页共享。
 */
export function useSessionListActions() {
  const { t } = useTranslation();
  const { invoke } = useDeviceLink();
  const swipeRegistry = useMemo(() => createSwipeRowRegistry(), []);
  const [actionSheetSession, setActionSheetSession] = useState<RemoteSession | null>(null);
  const [renameSessionTarget, setRenameSessionTarget] = useState<RemoteSession | null>(null);
  const [renameSessionDraft, setRenameSessionDraft] = useState('');
  const pendingSheetActionRef = useRef<(() => void) | null>(null);

  const patchSession = useCallback(async (session: RemoteSession, patch: SessionMetaPatch) => {
    const rpcDeviceId = session.canonicalDeviceId ?? session.deviceLinkDeviceId
      ?? remoteSessionStore.getSessionDeviceId(session.id);
    if (!rpcDeviceId) throw new Error(t('devices.list.error.sessionDeviceNotFound'));
    const shardId = session.deviceLinkDeviceId ?? remoteSessionStore.getSessionDeviceId(session.id) ?? rpcDeviceId;
    const fields = Object.keys(patch);
    const write = sessionMetaWriteGuard.begin(session.id, writeGuardFields(patch));
    if (patch.status !== undefined || patch.pinnedAt !== undefined) {
      configureCollapseAnimation();
    }
    remoteSessionStore.applySessionPatch(shardId, session.id, patch);
    const releasePending = sessionPendingWrites.track(session.id, fields);
    try {
      const updated = await sessionMetaWriteQueue.enqueue(session.id, fields, () => retryPatchWhileLatest(
        write.isLatest,
        (assertStillLatest) => invoke<RemoteSession>(
          rpcDeviceId,
          'local-db:sessions:patch-meta',
          [session.id, patch],
          { preSend: assertStillLatest },
        ),
      ));
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
      if (write.isLatest()) {
        if (fields.includes('status')) {
          const shardName = remoteSessionStore.getSessions()
            .find((s) => s.deviceLinkDeviceId === shardId)?.deviceLinkDeviceName
            ?? session.deviceLinkDeviceName
            ?? shardId;
          configureCollapseAnimation();
          remoteSessionStore.upsertDeviceSession(shardId, shardName, session);
          remoteSessionStore.requestReseed(shardId);
        } else {
          const currentUpdatedAt = remoteSessionStore.getSessions()
            .find((s) => s.id === session.id)?.updatedAt ?? null;
          remoteSessionStore.applySessionPatch(
            shardId,
            session.id,
            pickWriteFields(session, fields, currentUpdatedAt),
          );
          remoteSessionStore.requestReseed(shardId);
        }
      } else {
        remoteSessionStore.requestReseed(shardId);
      }
      throw err;
    } finally {
      releasePending();
    }
  }, [invoke, t]);

  const runSwipeAction = useCallback((session: RemoteSession, action: Exclude<SessionSwipeAction, 'rename'>) => {
    void patchSession(session, swipeActionPatch(action)).catch((err: unknown) => {
      swipeRegistry.closeOpenRow();
      Alert.alert(t('devices.list.alert.actionFailed'), humanizeRemoteError(err));
    });
  }, [patchSession, swipeRegistry, t]);

  const handleSessionSheetAction = useCallback((action: SessionSwipeAction) => {
    const session = actionSheetSession;
    setActionSheetSession(null);
    if (!session) return;
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
      pendingSheetActionRef.current = () => {
        setRenameSessionDraft(projectDraftSessionTitle(session.title, t('session.menu.unnamedTitle')));
        setRenameSessionTarget(session);
      };
      return;
    }
    runSwipeAction(session, action);
  }, [actionSheetSession, runSwipeAction, t]);

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
    runSwipeAction(session, statusToggleAction(session.status).action);
  }, [runSwipeAction]);

  const showSessionOptions = useCallback((session: RemoteSession) => {
    setActionSheetSession(session);
  }, []);

  const sessionSwipeControls = useMemo<SessionSwipeControls>(() => ({
    onArchive: archiveSession,
    onShowOptions: showSessionOptions,
    onTogglePin: toggleSessionPinned,
    registry: swipeRegistry,
  }), [archiveSession, showSessionOptions, swipeRegistry, toggleSessionPinned]);

  return {
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
