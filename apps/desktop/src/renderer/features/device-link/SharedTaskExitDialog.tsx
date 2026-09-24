import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useAuth } from '@/contexts/AuthContext';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { resetRemoteDataOwnerPushFence } from '@/lib/remoteDataOwnerPushFence';
import { toast } from '@/lib/toast';
import { remoteProjectsStore } from './remoteProjectsStore';
import { sharedTaskErrorKey } from './sharedTaskCompatibility';
import { closeOwnedSharedTask } from './closeOwnedSharedTask';

export type SharedTaskExitTarget =
  | { kind: 'close'; sharedTaskId: string; title: string; hostDeviceId?: string }
  | { kind: 'leave'; sharedTaskId: string; title: string; peer: string };

/** A single confirmation for menu actions and joined-task management. */
export function SharedTaskExitDialog({ target, onDismiss, onComplete }: {
  target: SharedTaskExitTarget;
  onDismiss(): void;
  onComplete(): void;
}) {
  const { t } = useTranslation();
  const { dataOwnerId } = useAuth();
  const [owner] = useState(getDataOwnerGeneration);
  const ownerGeneration = getDataOwnerGeneration().generation;
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    if (!isDataOwnerGenerationCurrent(owner)) onDismiss();
  }, [dataOwnerId, ownerGeneration, owner, onDismiss]);
  const current = () => mounted.current && isDataOwnerGenerationCurrent(owner);
  const leaving = target.kind === 'leave';
  const confirm = async () => {
    if (pending.current || !current()) return;
    pending.current = true; setBusy(true);
    try {
      if (target.kind === 'leave') {
        await window.electronAPI.sharedTask.account({ action: 'leave', sharedTaskId: target.sharedTaskId });
      } else {
        const closed = await closeOwnedSharedTask(target.sharedTaskId, target.hostDeviceId, current);
        if (!current()) return;
        if (!closed) {
          toast.error(t('sharedTask.closeFailedToast', { count: 1 }));
          return;
        }
      }
      if (!current()) return;
      window.dispatchEvent(new Event('cindy:shared-task-owned-changed'));
      onComplete();
      if (target.kind === 'leave') {
        resetRemoteDataOwnerPushFence(target.peer);
        void window.electronAPI.deviceLink.closeLink(target.peer).catch(() => undefined);
        remoteProjectsStore.removeDevice(target.peer);
      }
    } catch (error) {
      if (current()) toast.error(t(sharedTaskErrorKey(error)));
    } finally {
      if (current()) { pending.current = false; setBusy(false); }
    }
  };
  return <ConfirmDialog presentation="standard" cancelFirst
    open={owner.dataOwnerId === dataOwnerId && current()}
    onOpenChange={(open) => { if (!open && !pending.current) onDismiss(); }}
    title={t(leaving ? 'sharedTask.leaveTitle' : 'sharedTask.cancelTitle')}
    description={t(leaving ? 'sharedTask.leaveBody' : 'sharedTask.closeOneBody')}
    content={<div><p className="break-words text-13 font-medium">{target.title}</p>
      <p className="mt-3 text-12 text-[var(--text-secondary)]">{t(leaving ? 'sharedTask.othersUnaffected' : 'sharedTask.recordsKept')}</p></div>}
    cancelText={t(leaving ? 'sharedTask.leaveKeep' : 'sharedTask.closeAllKeep')}
    confirmText={t(leaving ? 'sharedTask.leaveShort' : 'sharedTask.cancelSharing')}
    confirmVariant="destructive" loading={busy} zIndex={10002} maxWidth={440}
    onConfirm={() => void confirm()} />;
}
