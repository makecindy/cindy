import { useEffect } from 'react';

import { i18n } from '@/i18n';
import { createLogger } from '@/lib/logger';
import { isSecondaryWindow } from '@/lib/secondaryWindow';
import { toast } from '@/lib/toast';

const log = createLogger('usePluginUpgradeNoticeToast');

export function usePluginUpgradeNoticeToast(): void {
  useEffect(() => {
    if (isSecondaryWindow()) return undefined;
    let cancelled = false;
    const showIfPending = async (): Promise<void> => {
      try {
        const notice = await window.electronAPI.pluginMarket.consumeUpgradeNotice();
        if (cancelled || !notice) return;
        const permissions = notice.permissions
          ? new Intl.ListFormat(i18n.language, {
              type: 'conjunction',
              style: 'narrow',
            }).format(notice.permissions.map((permission) =>
              i18n.t(`settings.ghosts.perm.${permission.labelKey}`, permission.labelArgs),
            ))
          : undefined;
        const message =
          notice.count === 1 && notice.name
            ? notice.hasPermissionExpansion && permissions
              ? i18n.t('settings.ghosts.market.upgradeNotice.singleWithPermissions', {
                  name: notice.name,
                  permissions,
                })
              : i18n.t('settings.ghosts.market.upgradeNotice.single', { name: notice.name })
            : notice.hasPermissionExpansion
              ? i18n.t('settings.ghosts.market.upgradeNotice.multipleWithPermissions', {
                  count: notice.count,
                })
              : i18n.t('settings.ghosts.market.upgradeNotice.multiple', { count: notice.count });
        toast.info(message, { duration: 8000 });
      } catch (error) {
        log.warn('failed to consume plugin upgrade notice:', error);
      }
    };
    const unsubscribe = window.electronAPI.pluginMarket.onUpgradeNoticeAvailable(() => {
      void showIfPending();
    });
    void showIfPending();
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);
}
