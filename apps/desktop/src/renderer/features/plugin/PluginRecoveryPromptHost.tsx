import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';

import { useAuth } from '@/contexts/AuthContext';
import { createLogger } from '@/lib/logger';
import { toast } from '@/lib/toast';

const log = createLogger('PluginRecoveryPromptHost');
const remindedOwners = new Set<string>();

/** One non-blocking reminder per owner and renderer run; decisions live on the Plugins page. */
export function PluginRecoveryPromptHost() {
  const { t } = useTranslation();
  const { canEnterApp, dataOwnerId, mode } = useAuth();

  useEffect(() => {
    if (!canEnterApp || !dataOwnerId || mode === 'signed-out') return undefined;
    const ownerKey = `${mode}:${dataOwnerId}`;
    let cancelled = false;

    const showIfNeeded = async (): Promise<void> => {
      if (cancelled || remindedOwners.has(ownerKey)) return;
      try {
        const status = await window.electronAPI.pluginMarket.recoveryStatus();
        const proposal = status.proposal;
        if (cancelled || !proposal || proposal.notificationMuted) return;
        remindedOwners.add(ownerKey);
        toast.warning(
          t('settings.ghosts.recovery.reminder', {
            count: proposal.totalCount,
          }),
          { duration: 8000 },
        );
      } catch (error) {
        log.warn('failed to read Plugin recovery status:', error);
      }
    };

    const unsubscribe = window.electronAPI.pluginMarket.onRecoveryAvailable(() => {
      void showIfNeeded();
    });
    void showIfNeeded();
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [canEnterApp, dataOwnerId, mode, t]);

  return null;
}
