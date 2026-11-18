import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import { useConfirmTaskArchive } from '../hooks/useConfirmTaskArchive';
import { loadActiveBoundScheduleNames } from '@/features/scheduler/lib/archiveScheduleWarning';
import { useSessionRunningStatus } from '@/hooks/useSessionRunningStatus';
import type { Session } from '@/lib/ccAgent.types';
import { createLogger } from '@/lib/logger';
import * as sessionService from '@/lib/sessionService';
import { toast } from '@/lib/toast';
import { resolveWorktreeRemovalPreflight } from '@/lib/worktreeRemovalWarning';

import { useSessionLifecycleActions } from '../hooks/useSessionLifecycleActions';

const log = createLogger('sessionHardwareTaskActions');

export function useSessionHardwareTaskActions({
  session,
  remoteWritesBlocked,
  onRemoteWriteBlocked,
  patchLocal,
}: {
  session: Session | null;
  remoteWritesBlocked: boolean;
  onRemoteWriteBlocked: () => void;
  patchLocal?: (sessionId: string, patch: Partial<Session>) => void;
}): {
  togglePin: () => Promise<void>;
  archive: () => Promise<void>;
} {
  const { t } = useTranslation();
  const confirmTaskArchive = useConfirmTaskArchive();
  const { runSessionAction } = useSessionLifecycleActions();
  const { runningSessionIds } = useSessionRunningStatus(session?.id);
  const sessionId = session?.id ?? null;
  const pinnedAt = session?.pinnedAt ?? null;
  const deviceLinkDeviceId = session?.deviceLinkDeviceId;

  const togglePin = useCallback(async () => {
    if (!sessionId) return;
    if (remoteWritesBlocked) {
      onRemoteWriteBlocked();
      return;
    }
    const newPinnedAt = pinnedAt ? null : new Date().toISOString();
    const oldSummary = session?.summary ?? null;
    patchLocal?.(
      sessionId,
      pinnedAt ? { pinnedAt: null, summary: null } : { pinnedAt: newPinnedAt },
    );
    try {
      await sessionService.patchMeta(sessionId, { pinnedAt: newPinnedAt });
    } catch (err) {
      log.error('[session pin]', err);
      toast.error(t('ccAgent.sidebar.pinFailed'));
      patchLocal?.(sessionId, pinnedAt ? { pinnedAt, summary: oldSummary } : { pinnedAt });
    }
  }, [onRemoteWriteBlocked, patchLocal, pinnedAt, remoteWritesBlocked, session, sessionId, t]);

  const archive = useCallback(async () => {
    if (!sessionId) return;
    if (remoteWritesBlocked) {
      onRemoteWriteBlocked();
      return;
    }
    if (runningSessionIds.has(sessionId)) {
      toast.warning(t('ccAgent.sidebar.archiveBlocked.running'));
      return;
    }
    await runSessionAction(sessionId, 'archive', {
      activeSessionId: sessionId,
      prepareArchive: async (isCurrent) => {
        const attached = await window.electronAPI.binding
          .resolveSession(sessionId)
          .then((binding) => binding.attached)
          .catch(() => false);
        if (attached) {
          toast.warning(t('ccAgent.sidebar.archiveBlocked.attached'));
          return false;
        }
        const scheduleNames =
          (await loadActiveBoundScheduleNames([{ id: sessionId, deviceLinkDeviceId }])).get(
            sessionId,
          ) ?? [];
        // 远程列表先乐观换桶；确认前保留详情，取消后恢复行。
        const preflight = await resolveWorktreeRemovalPreflight(sessionId, deviceLinkDeviceId);
        if (!isCurrent()) return false;
        return preflight === 'clean' && scheduleNames.length === 0
          ? true
          : confirmTaskArchive(preflight, scheduleNames);
      },
    });
  }, [
    confirmTaskArchive,
    deviceLinkDeviceId,
    onRemoteWriteBlocked,
    remoteWritesBlocked,
    runSessionAction,
    runningSessionIds,
    sessionId,
    t,
  ]);

  return { togglePin, archive };
}
