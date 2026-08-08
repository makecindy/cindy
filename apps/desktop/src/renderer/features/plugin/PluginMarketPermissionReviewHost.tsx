import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';

import { GhostPermissionList, GhostUpdateReview } from '@/cindy-brain/GhostPermissionList';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { ghostPermissionItems } from '../../../shared/ghost';

/**
 * 市场安装事务的真实包权限确认入口。
 *
 * Main 下载并检查真实包后把事务暂停在调用栈内，只向发起窗口投递这一张确认卡。
 * 无论确认、取消、Esc、遮罩关闭还是渲染异常，finally 都会把答案回给 Main；
 * Main 随后继续安装或取消事务，并在自己的 finally 中删除临时包。
 */
export function PluginMarketPermissionReviewHost() {
  const { t } = useTranslation();
  const { confirm } = useConfirmDialog();

  useEffect(() => {
    return window.electronAPI.pluginMarket.onPackagePermissionReview((review) => {
      if (!review || typeof review.requestId !== 'string') return;
      void (async () => {
        let confirmed = false;
        try {
          const isUpdate = review.isUpdate;
          confirmed = await confirm({
            title: isUpdate
              ? t('settings.ghosts.updateConfirm.title', { name: review.manifest.name })
              : t('settings.ghosts.market.installConfirmTitle', {
                  name: review.manifest.name,
                }),
            description: isUpdate
              ? t('settings.ghosts.market.updateConfirmDescription')
              : t(
                  review.sourceType === 'server'
                    ? 'settings.ghosts.market.installConfirmDescription'
                    : 'settings.ghosts.market.customInstallConfirmDescription',
                ),
            content: review.permissionDiff ? (
              <GhostUpdateReview diff={review.permissionDiff} />
            ) : (
              <GhostPermissionList items={ghostPermissionItems(review.manifest)} />
            ),
            maxWidth: 520,
            confirmText: isUpdate
              ? t('settings.ghosts.updateConfirm.confirm')
              : t('settings.ghosts.market.install'),
            cancelText: isUpdate
              ? t('settings.ghosts.updateConfirm.cancel')
              : t('settings.ghosts.installConfirm.cancel'),
            autoFocusConfirm: true,
          });
        } finally {
          try {
            await window.electronAPI.pluginMarket.resolvePackagePermissionReview(
              review.requestId,
              confirmed,
            );
          } catch {
            // 窗口销毁时 Main 会把等待中的事务按取消结算。
          }
        }
      })();
    });
  }, [confirm, t]);

  return null;
}
