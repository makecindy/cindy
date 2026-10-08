/**
 * DingTalkGuestAccessSetting —— 「钉钉账号」方式下，群任务处于「完全访问」时
 * 是否也放行群成员（非主人）。缺省关闭；打开前必须二次确认风险。
 */

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { Switch } from '@/components/ui/switch';
import { createLogger } from '@/lib/logger';

const log = createLogger('DingTalkGuestAccessSetting');

export function DingTalkGuestAccessSetting() {
  const { t } = useTranslation();
  const { confirm } = useConfirmDialog();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void window.electronAPI.dingtalkBot
      .getAccess()
      .then((value) => {
        if (!cancelled) setEnabled(value.guestFullAccess);
      })
      .catch((error) => {
        log.error('getAccess failed:', error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const toggle = useCallback(
    async (next: boolean) => {
      if (next) {
        const confirmed = await confirm({
          title: t('settings.dingtalkBot.guestFullAccess.confirm.title'),
          description: t('settings.dingtalkBot.guestFullAccess.confirm.description'),
          confirmText: t('settings.dingtalkBot.guestFullAccess.confirm.confirm'),
          cancelText: t('settings.dingtalkBot.guestFullAccess.confirm.cancel'),
          confirmVariant: 'destructive',
        });
        if (!confirmed) return;
      }
      setSaving(true);
      try {
        const saved = await window.electronAPI.dingtalkBot.setAccess({ guestFullAccess: next });
        setEnabled(saved.guestFullAccess);
      } catch (error) {
        log.error('setAccess failed:', error instanceof Error ? error.message : String(error));
      } finally {
        setSaving(false);
      }
    },
    [confirm, t],
  );

  if (enabled === null) return null;

  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <div className="text-13 font-medium text-[var(--settings-section-title)]">
          {t('settings.dingtalkBot.guestFullAccess.label')}
        </div>
        <div className="mt-1 text-12 leading-[1.6] text-[var(--settings-section-desc)]">
          {t('settings.dingtalkBot.guestFullAccess.description')}
        </div>
      </div>
      <Switch
        checked={enabled}
        disabled={saving}
        onCheckedChange={(next) => void toggle(next)}
        aria-label={t('settings.dingtalkBot.guestFullAccess.label')}
      />
    </div>
  );
}
