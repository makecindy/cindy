import { useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { useAgentIslandActivity } from '@/state/agentIslandActivity';
import { useRemoteSessionActivity } from '@/features/device-link/remoteSessionActivityStore';
import { getSessionDeviceId, remoteProjectsStore } from '@/features/device-link/remoteProjectsStore';
import type { ReactNode } from 'react';

/** Resolve the execution owner before reading its phase; remote IDs are not local sessions. */
export function TeammateProcessStatus({ sessionId, children }: { sessionId?: string; children: ReactNode }) {
  const { t } = useTranslation();
  const deviceId = useSyncExternalStore(remoteProjectsStore.subscribe,
    () => sessionId ? getSessionDeviceId(sessionId) : undefined);
  const local = useAgentIslandActivity(deviceId ? '' : sessionId ?? '');
  const remote = useRemoteSessionActivity(sessionId ?? '', deviceId);
  const live = deviceId ? remote : local;
  if (!deviceId && local?.gracefulStopState && local.gracefulStopState !== 'none') return <>{t('bots.groupChat.progress.stopping')}</>;
  if (live?.phase === 'needs-interaction') return <>{t('agentIsland.native.awaitingQuestion')}</>;
  return <>{children}</>;
}
