import { useCallback, useMemo, type RefObject } from 'react';
import { Alert } from 'react-native';
import type { useRouter } from 'expo-router';
import type { TFunction } from 'i18next';
import { getMobileAuthOwner, isMobileAuthOwnerCurrent } from '@/auth/authOwnerGeneration';
import { formatRemoteError } from '@/device-link/remoteStatus';
import { getCurrentMobileOutboxRecords, mobileDurableOutbox } from './mobileDurableOutbox';
import { isDurableOutboxUnsent } from './durableOutbox';
import { remoteSessionStore } from './remoteSessionStore';
import type { PendingSendBubbleActions } from './PendingSendBubble';
import type { QueuedRemoteMessage } from './types';

/** Keep outbox callbacks stable without capturing records from an earlier task. */
export function usePendingOutboxActions({
  deviceId, deviceName, sessionId, router, outboxSessionAliveRef,
  setError, setQueueSelectedClientId, t,
}: {
  deviceId: string;
  deviceName: string;
  sessionId: string;
  router: Pick<ReturnType<typeof useRouter>, 'push'>;
  outboxSessionAliveRef: RefObject<string | null>;
  setError(error: string): void;
  setQueueSelectedClientId(clientId: string | null): void;
  t: TFunction;
}) {
  const findDurableOutboxRecord = useCallback((clientId: string) => getCurrentMobileOutboxRecords().find((r) =>
    r.deviceId === deviceId && r.item.sessionId === sessionId && r.item.clientId === clientId), [deviceId, sessionId]);
  const retryOutboxItem = useCallback((clientId: string) => {
    const record = findDurableOutboxRecord(clientId);
    if (!record || record.state !== 'failed') return;
    if (record.creation && !record.prepared && !record.template) {
      const owner = getMobileAuthOwner();
      void mobileDurableOutbox.update(record, { suspended: true }).then(() => {
        if (isMobileAuthOwnerCurrent(owner) && outboxSessionAliveRef.current === sessionId) {
          router.push({ pathname: '/sessions/new', params: { recoverySessionId: sessionId, deviceId, deviceName } });
        }
      }).catch((err) => setError(formatRemoteError(err)));
      return;
    }
    setQueueSelectedClientId(null);
    void mobileDurableOutbox.update(record, {
      state: record.prepared ? 'confirming' : 'queued', error: undefined,
    }).catch((err) => setError(formatRemoteError(err)));
  }, [deviceId, deviceName, findDurableOutboxRecord, outboxSessionAliveRef, router, sessionId, setError, setQueueSelectedClientId]);
  const removeOutboxItem = useCallback((clientId: string) => {
    const record = findDurableOutboxRecord(clientId);
    if (!record) return;
    // Until creation succeeds, this row also owns the recovery form for every later message.
    if (record.creation && !record.prepared && !record.template) {
      setError(t('session.outbox.creationRecoveryRequired'));
      return;
    }
    // 删除发送失败的消息不可撤销:先确认(破坏性按钮),确认后才真正移除。
    const confirmRemove = () => {
      setQueueSelectedClientId(null);
      const owner = getMobileAuthOwner();
      const remove = async () => {
        if (isDurableOutboxUnsent(record)) {
          await mobileDurableOutbox.update(record, { state: 'host-owned', cleanupOutcome: 'cancelled', cancelRequested: true, error: undefined });
        } else await mobileDurableOutbox.update(record, { cancelRequested: true, state: 'confirming' });
      };
      void remove().catch((err) => {
        if (isMobileAuthOwnerCurrent(owner) && outboxSessionAliveRef.current === sessionId) setError(formatRemoteError(err));
      });
    };
    Alert.alert(
      t('session.outbox.deleteConfirmTitle'),
      t('session.outbox.deleteConfirmBody'),
      [
        { text: t('session.common.cancel'), style: 'cancel' },
        { text: t('session.common.delete'), style: 'destructive', onPress: confirmRemove },
      ],
    );
  }, [findDurableOutboxRecord, outboxSessionAliveRef, sessionId, setError, setQueueSelectedClientId, t]);
  return { findDurableOutboxRecord, retryOutboxItem, removeOutboxItem };
}

/** Shared action object for message rows; look up queue entries when clicked. */
export function usePendingSendActions({
  beginQueueEdit, moveQueueItem, queueBusy, queueSelectedClientId,
  removeQueueItem, removeOutboxItem, retryOutboxItem, sessionId,
  setQueueSelectedClientId, steerQueueItem,
}: {
  beginQueueEdit(item: QueuedRemoteMessage): void;
  moveQueueItem: PendingSendBubbleActions['onMove'];
  queueBusy: boolean;
  queueSelectedClientId: string | null;
  removeQueueItem: PendingSendBubbleActions['onRemove'];
  removeOutboxItem: PendingSendBubbleActions['onRemoveOutbox'];
  retryOutboxItem: PendingSendBubbleActions['onRetryOutbox'];
  sessionId: string;
  setQueueSelectedClientId: PendingSendBubbleActions['onSelect'];
  steerQueueItem(item: QueuedRemoteMessage): void;
}) {
  return useMemo<PendingSendBubbleActions>(
    () => ({
      busy: queueBusy,
      selectedClientId: queueSelectedClientId,
      onSelect: setQueueSelectedClientId,
      onRemove: (clientId: string) => {
        setQueueSelectedClientId(null);
        removeQueueItem(clientId);
      },
      onBeginEdit: (clientId: string) => {
        const target = remoteSessionStore.getInputProjection(sessionId).pendingQueue
          .find((entry) => entry.clientId === clientId);
        if (target) beginQueueEdit(target);
      },
      onSteer: (clientId: string) => {
        const target = remoteSessionStore.getInputProjection(sessionId).pendingQueue
          .find((entry) => entry.clientId === clientId);
        if (!target) return;
        setQueueSelectedClientId(null);
        steerQueueItem(target);
      },
      onMove: moveQueueItem,
      onRetryOutbox: retryOutboxItem,
      onRemoveOutbox: removeOutboxItem,
    }),
    [beginQueueEdit, setQueueSelectedClientId, moveQueueItem, queueBusy, queueSelectedClientId, removeQueueItem, removeOutboxItem, retryOutboxItem, sessionId, steerQueueItem],
  );
}
