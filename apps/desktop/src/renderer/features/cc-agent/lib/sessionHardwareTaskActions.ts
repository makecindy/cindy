import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
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
  const { confirm: confirmDialog } = useConfirmDialog();
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
    const attached = await window.electronAPI.binding
      .resolveSession(sessionId)
      .then((binding) => binding.attached)
      .catch(() => false);
    if (attached) {
      toast.warning(t('ccAgent.sidebar.archiveBlocked.attached'));
      return;
    }
    const preflight = await resolveWorktreeRemovalPreflight(sessionId, deviceLinkDeviceId);
    if (preflight !== 'clean') {
      const ok = await confirmDialog({
        title: t('ccAgent.sidebar.confirmArchive.title'),
        description:
          t('ccAgent.sidebar.confirmArchive.description') +
          (preflight === 'dirty'
            ? ' ' + t('ccAgent.sidebar.confirmArchive.dirtyWorktreeWarning')
            : ''),
        confirmText: t('ccAgent.sidebar.confirmArchive.confirm'),
        cancelText: t('ccAgent.sidebar.confirmArchive.cancel'),
      });
      if (!ok) return;
    }
    await runSessionAction(sessionId, 'archive', { activeSessionId: sessionId });
  }, [
    confirmDialog,
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
