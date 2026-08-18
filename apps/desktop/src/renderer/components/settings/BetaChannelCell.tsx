/**
 * BetaChannelCell — Settings → 实验功能区块下的 "Beta 测试渠道" 卡片。
 *
 * 设备级开关:落盘 userData/update-channel-settings.json,登出/换号不清。
 * 与 canary(账号级、服务端下发)不同,beta 是本地设置;优先级 canary > beta > release,
 * 由 main 侧 manifestService 的 resolveUpdateChannel 收敛。
 *
 * 开关本身即时落盘,但 manifest 通道只在后台轮询(30min)或重启后才切换;
 * 打开后引导用户立即重启(app.relaunch),关闭则仅提示重启后生效。
 */

import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { useBetaChannelSettings } from '@/hooks/useBetaChannelSettings';
import { mapIpcErrorToI18nKey } from '@/utils/ipcError';

export function BetaChannelCell() {
  const { t } = useTranslation();
  const { confirm } = useConfirmDialog();
  const { state, setEnableBeta } = useBetaChannelSettings();
  const [pending, setPending] = useState(false);

  const handleToggle = useCallback(
    async (next: boolean) => {
      setPending(true);
      try {
        if (next) {
          // 预检:CDN 尚未部署 manifest-{platform}-beta.json 时拒绝开启。
          // 否则用户开了 beta 却连 agent 二进制都拉不到(beta 失败不回落 stable)。
          const { available } = await window.electronAPI.probeBetaChannel();
          if (!available) {
            toast.error(t('settings.betaChannel.unavailable'));
            return; // 不落盘,开关保持关闭
          }
        }
        await setEnableBeta(next);
        if (next) {
          const restart = await confirm({
            title: t('settings.betaChannel.restartTitle'),
            description: t('settings.betaChannel.restartDescription'),
            confirmText: t('settings.betaChannel.restartNow'),
            cancelText: t('settings.betaChannel.restartLater'),
            autoFocusConfirm: true,
          });
          if (!restart) return;
          // 与 UpdateBanner 同一口径:重启会杀掉 in-flight turn / 后台活动 / Ghost
          // card-action,属于不可撤销动作。探针失败 = 无法确认 → 按「有任务在跑」保守
          // 处理,多要一次确认,而不是静默打断用户任务。
          let hasInFlight = true;
          try {
            hasInFlight = await window.electronAPI.anyActivityBlockingRelaunch();
          } catch {
            hasInFlight = true;
          }
          if (hasInFlight) {
            const confirmed = await confirm({
              title: t('settings.betaChannel.restartTitle'),
              description: t('settings.betaChannel.restartBusyDescription'),
              confirmText: t('settings.betaChannel.restartNow'),
              cancelText: t('settings.betaChannel.restartLater'),
            });
            if (!confirmed) return;
          }
          await window.electronAPI.relaunchForChannelChange();
        } else {
          toast.success(t('settings.betaChannel.toast.disabled'));
        }
      } catch (err) {
        toast.error(
          t(mapIpcErrorToI18nKey(err, { fallback: 'settings.betaChannel.toast.toggleFailed' })),
        );
      } finally {
        setPending(false);
      }
    },
    [confirm, setEnableBeta, t],
  );

  return (
    <div
      className={cn(
        'flex flex-col gap-3 rounded-xl p-5',
        'bg-[var(--settings-theme-card-bg)]',
        'border border-[var(--settings-theme-card-border)]',
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <p
            className="text-13 font-medium text-[var(--settings-section-sublabel)]"
            style={{ letterSpacing: '0.12px' }}
          >
            {t('settings.betaChannel.title')}
          </p>
          <p className="text-12 leading-[1.4] text-[var(--settings-section-sublabel)] opacity-70">
            {t('settings.betaChannel.description')}
          </p>
        </div>

        <Switch
          checked={state.enableBeta}
          disabled={pending || state.loading}
          onCheckedChange={(v) => void handleToggle(v)}
          aria-label={t('settings.betaChannel.toggleAria')}
        />
      </div>
    </div>
  );
}
