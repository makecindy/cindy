/**
 * DingTalkSteerSetting —— 「钉钉账号」方式下，任务进行中到达的新消息是否直接插话
 * （插进当前一轮）而不是排队。缺省关闭；只在任务处于「完全访问」时生效。
 */

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Switch } from '@/components/ui/switch';
import { createLogger } from '@/lib/logger';

const log = createLogger('DingTalkSteerSetting');

export function DingTalkSteerSetting() {
  const { t } = useTranslation();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void window.electronAPI.dingtalkBot
      .getAccess()
      .then((value) => {
        if (!cancelled) setEnabled(value.steerWhileBusy);
      })
      .catch((error) => {
        log.error('getAccess failed:', error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const toggle = useCallback(async (next: boolean) => {
    setSaving(true);
    try {
      const saved = await window.electronAPI.dingtalkBot.setAccess({ steerWhileBusy: next });
      setEnabled(saved.steerWhileBusy);
    } catch (error) {
      log.error('setAccess failed:', error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }, []);

  if (enabled === null) return null;

  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <div className="text-13 font-medium text-[var(--settings-section-title)]">
          {t('settings.dingtalkBot.steerWhileBusy.label')}
        </div>
        <div className="mt-1 text-12 leading-[1.6] text-[var(--settings-section-desc)]">
          {t('settings.dingtalkBot.steerWhileBusy.description')}
        </div>
      </div>
      <Switch
        checked={enabled}
        disabled={saving}
        onCheckedChange={(next) => void toggle(next)}
        aria-label={t('settings.dingtalkBot.steerWhileBusy.label')}
      />
    </div>
  );
}
