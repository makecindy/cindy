import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/contexts/AuthContext';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { makerChatStore } from '@/lib/makerChatStore';
import { sessionsStore } from '@/lib/sessionsStore';
import { observeHostRecovery, type HostRecoveryView } from '@/lib/hostConnectionRecovery';
import { ErrorNotice } from '@/components/ui/error-notice';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';

/** Mounted outside the task router: a dropped connection never unmounts the
 * editor. Ordinary desktop mode produces no Host connection notifications. */
export function HostConnectionNotice() {
  const { dataOwnerId, dataOwnerGeneration, canEnterApp } = useAuth();
  const [view, setView] = useState<HostRecoveryView>();
  const observer = useRef<ReturnType<typeof observeHostRecovery> | undefined>(undefined);
  useEffect(() => {
    const api = window.electronAPI?.hostConnection;
    if (!api) return;
    observer.current = observeHostRecovery({
      api,
      onView: setView,
      recover: async isConnected => {
        if (!canEnterApp || !dataOwnerId) return;
        const owner = getDataOwnerGeneration();
        const current = () => isConnected() && isDataOwnerGenerationCurrent(owner);
        await Promise.all([
          sessionsStore.forceRefreshAll(current),
          makerChatStore.reconcileHostConnection(current),
        ]);
      },
    });
    return () => observer.current?.dispose();
  }, [dataOwnerId, dataOwnerGeneration, canEnterApp]);
  return <HostConnectionBanner client={window.electronAPI?.hostConnection?.client} view={view} onRetry={() => observer.current?.retry()} />;
}

export function HostConnectionBanner({ view, onRetry, client = 'browser' }: { view?: HostRecoveryView; onRetry: () => void; client?: 'browser' | 'desktop' }) {
  const { t } = useTranslation();
  if (!view || (view.status === 'connected' && !view.restoring && !view.failed)) return null;
  const needsPairing = view.status === 'authorization-required';
  const title = needsPairing ? 'pairing' : view.failed ? 'retrying' : view.restoring ? 'restoring' : 'connecting';
  return (
    <div className="pointer-events-none fixed inset-x-3 top-14 z-50 mx-auto max-w-xl">
      <ErrorNotice
        className="pointer-events-auto"
        role="status"
        aria-live="polite"
        message={t(`hostConnection.${title}`)}
        description={t(needsPairing ? (client === 'desktop' ? 'hostConnection.desktopAuthHelp' : 'hostConnection.pairingHelp') : 'hostConnection.keepDraft')}
        icon={!needsPairing && !view.failed ? <Spinner className="text-[var(--text-secondary)]" /> : undefined}
        actions={<Button size="sm" compact tone="quiet" onClick={onRetry}>{t('hostConnection.retry')}</Button>}
      />
    </div>
  );
}
