import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isSharedTaskPeer, type TaskMigrationView } from '@cindy/device-link';
import type { Session } from '@/lib/ccAgent.types';
import { Button } from '@/components/ui/button';
import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
} from '@/contexts/dataOwnerGeneration';
import { TaskMigrationDialog } from './sidebar/TaskMigrationDialog';

/** Observe only mounted task details or open menus/editors, never idle sidebar rows. */
export function useTaskMigrationStatus(session: Session) {
  const [status, setStatus] = useState<TaskMigrationView | null>(null);
  // Reset for a different task/source, not a change in connection readiness.
  useEffect(() => {
    setStatus(null);
  }, [session.id, session.deviceLinkDeviceId, session.remoteHostId]);
  useEffect(() => {
    if (
      session.remoteHostId ||
      isSharedTaskPeer(session.deviceLinkDeviceId ?? '') ||
      (session.deviceLinkDeviceId && session.deviceLinkConnectionStatus === 'disconnected')
    )
      return;
    const owner = getDataOwnerGeneration();
    let disposed = false,
      timer: ReturnType<typeof setTimeout> | undefined;
    let online = false;
    let connectionGeneration = 0;
    let receivedStatusPush = false;
    const current = () => !disposed && isDataOwnerGenerationCurrent(owner);
    const canPoll = (generation: number) =>
      current() && online && generation === connectionGeneration;
    const refresh = async (generation: number) => {
      if (!canPoll(generation)) return;
      try {
        const next = await window.electronAPI.deviceLink.taskMigration(
          session.deviceLinkDeviceId ?? null,
          { action: 'status', sessionId: session.id },
        );
        if (canPoll(generation)) setStatus(next);
      } catch {
        /* Old or disconnected hosts keep their existing connection UI. */
      }
      if (canPoll(generation)) timer = setTimeout(() => void refresh(generation), 10_000);
    };
    const updateConnection = (nextOnline: boolean) => {
      if (!current() || online === nextOnline) return;
      online = nextOnline;
      connectionGeneration += 1;
      clearTimeout(timer);
      // Retain the last snapshot so a transient disconnect cannot unmount an open dialog.
      if (online) void refresh(connectionGeneration);
    };
    // Local mode has a machine ID but no relay identity. Observe readiness before
    // querying task-copy, and let pushes win over a delayed initial snapshot.
    const offStatus = window.electronAPI.deviceLink.onStatusChanged(({ status }) => {
      receivedStatusPush = true;
      updateConnection(status === 'online');
    });
    const readConnection = async () => {
      if (!current() || receivedStatusPush) return;
      try {
        const state = await window.electronAPI.deviceLink.getState();
        if (!receivedStatusPush) updateConnection(state.linkStatus === 'online');
      } catch {
        // Retry only the readiness read if bootstrap failed; never assume online.
        if (current() && !receivedStatusPush)
          timer = setTimeout(() => void readConnection(), 10_000);
      }
    };
    void readConnection();
    return () => {
      disposed = true;
      offStatus();
      clearTimeout(timer);
    };
  }, [
    session.id,
    session.deviceLinkDeviceId,
    session.deviceLinkConnectionStatus,
    session.remoteHostId,
  ]);
  return status;
}

export function TaskMigrationStatus({ session }: { session: Session }) {
  const { t } = useTranslation();
  const status = useTaskMigrationStatus(session);
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [session.id, session.deviceLinkDeviceId]);
  if (!status?.stage || ['active', 'cancelled'].includes(status.stage)) return null;
  return (
    <>
      <Button
        size="sm"
        variant="secondary"
        className="max-w-64 truncate [-webkit-app-region:no-drag]"
        onClick={() => setOpen(true)}
      >
        {status.stage === 'complete' && status.skipped
          ? t('taskMigration.completeWithSkipped', { count: status.skipped.total })
          : t(`taskMigration.stages.${status.stage}`)}
      </Button>
      {open && (
        <TaskMigrationDialog
          session={session}
          initialStatus={status}
          onDismiss={() => setOpen(false)}
        />
      )}
    </>
  );
}
