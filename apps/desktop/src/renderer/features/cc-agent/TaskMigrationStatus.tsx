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
  useEffect(() => {
    setStatus(null);
    if (session.remoteHostId || isSharedTaskPeer(session.deviceLinkDeviceId ?? '')) return;
    const owner = getDataOwnerGeneration();
    let disposed = false,
      timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      try {
        const next = await window.electronAPI.deviceLink.taskMigration(
          session.deviceLinkDeviceId ?? null,
          { action: 'status', sessionId: session.id },
        );
        if (!disposed && isDataOwnerGenerationCurrent(owner)) setStatus(next);
      } catch {
        /* Old or disconnected hosts keep their existing connection UI. */
      }
      if (!disposed && isDataOwnerGenerationCurrent(owner))
        timer = setTimeout(() => void refresh(), 10_000);
    };
    void refresh();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [session.id, session.deviceLinkDeviceId, session.remoteHostId]);
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
        {t(`taskMigration.stages.${status.stage}`)}
      </Button>
      {open && <TaskMigrationDialog session={session} onDismiss={() => setOpen(false)} />}
    </>
  );
}
