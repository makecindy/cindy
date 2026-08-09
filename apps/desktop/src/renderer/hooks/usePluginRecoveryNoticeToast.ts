import { useEffect } from 'react';

import { i18n } from '@/i18n';
import { createLogger } from '@/lib/logger';
import { isSecondaryWindow } from '@/lib/secondaryWindow';
import { toast } from '@/lib/toast';

const log = createLogger('usePluginRecoveryNoticeToast');

export function usePluginRecoveryNoticeToast(): void {
  useEffect(() => {
    if (isSecondaryWindow()) return undefined;

    let cancelled = false;
    const showIfPending = async (): Promise<void> => {
      try {
        const notice = await window.electronAPI.pluginMarket.consumeRecoveryNotice();
        if (cancelled || !notice) return;
        const message =
          notice.count === 1 && notice.name
            ? i18n.t('settings.ghosts.recovery.notice.single', { name: notice.name })
            : i18n.t('settings.ghosts.recovery.notice.multiple', {
                count: notice.count,
              });
        toast.info(message, { duration: 8000 });
      } catch (error) {
        log.warn('failed to consume Plugin recovery notice:', error);
      }
    };

    const unsubscribe = window.electronAPI.pluginMarket.onRecoveryNoticeAvailable(() => {
      void showIfPending();
    });
    void showIfPending();
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);
}
