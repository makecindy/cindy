/**
 * OpenAI 订阅账号的「自动使用重置」开关（默认关）。挂在设置页该账号的用量卡片下方；
 * 规则在 main/usage/codexResetCreditAutoUse.ts，这里只读写开关，并列出最近一次自动
 * 使用——重置用掉不可撤回，每次自动使用都要让用户看得到。
 *
 * 「恢复默认」删除这个账号的显式设置，重新跟随默认值。
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Switch } from '@/components/ui/switch';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { toast } from '@/lib/toast';
import type { CodexResetCreditAutoUseState } from '../../../shared/codexResetCreditAutoUse';
import { DefaultOverrideControls } from './DefaultOverrideControls';

const LAST_AUTO_USE_REFRESH_MS = 60_000;

export function CodexResetAutoUseRow({ providerId }: { providerId: string }) {
  const { t, i18n } = useTranslation();
  const [state, setState] = useState<CodexResetCreditAutoUseState | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const owner = getDataOwnerGeneration();
    setState(null);
    // 旧版 preload 没有这个入口：不显示开关。
    const read = window.electronAPI?.maker?.usage?.getCodexResetAutoUse;
    if (!read) return;
    const load = () =>
      void read(providerId)
        .then((next) => {
          if (!cancelled && isDataOwnerGenerationCurrent(owner)) setState(next);
        })
        .catch(() => undefined);
    load();
    // 自动使用发生在后台：停留在设置页时定期重读，最近一次记录能跟上。
    const timer = window.setInterval(load, LAST_AUTO_USE_REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [providerId]);

  const save = useCallback(
    async (enabled: boolean | null) => {
      const owner = getDataOwnerGeneration();
      setSaving(true);
      try {
        const next = await window.electronAPI.maker.usage.setCodexResetAutoUse(providerId, enabled);
        if (!isDataOwnerGenerationCurrent(owner)) return;
        setState(next);
        toast.success(
          enabled === null
            ? t('settings.defaults.restored')
            : enabled
              ? t('settings.providers.codexResetAutoUse.enabledToast')
              : t('settings.providers.codexResetAutoUse.disabledToast'),
        );
      } catch {
        toast.error(t('settings.providers.codexResetAutoUse.saveFailed'));
      } finally {
        setSaving(false);
      }
    },
    [providerId, t],
  );

  if (!state) return null;
  const labelId = `codex-reset-auto-use-${providerId}`;
  const lastAutoUse = state.lastAutoUse;
  const lastAutoUseAt = lastAutoUse
    ? new Intl.DateTimeFormat(i18n?.resolvedLanguage ?? i18n?.language, {
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(new Date(lastAutoUse.atMs))
    : null;
  return (
    <div
      data-testid="provider-codex-reset-auto-use"
      className="flex items-center justify-between gap-3 border-t px-4 py-3"
      style={{ borderColor: 'var(--settings-theme-card-border)' }}
    >
      <div className="flex min-w-0 flex-col gap-1">
        <span id={labelId} className="text-13 text-[var(--settings-section-sublabel)]">
          {t('settings.providers.codexResetAutoUse.label')}
        </span>
        <p className="text-12 leading-[1.4] text-[var(--settings-section-sublabel)] opacity-70">
          {t('settings.providers.codexResetAutoUse.description')}
        </p>
        {lastAutoUse && lastAutoUseAt ? (
          <p
            data-testid="provider-codex-reset-last-auto-use"
            className="text-12 leading-[1.4] text-[var(--settings-section-sublabel)]"
          >
            {t(
              lastAutoUse.kind === 'expiring'
                ? 'settings.providers.codexResetAutoUse.lastAutoUseExpiring'
                : 'settings.providers.codexResetAutoUse.lastAutoUseUsageLimit',
              { at: lastAutoUseAt },
            )}
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <DefaultOverrideControls
          isCustomized={state.isCustomized}
          disabled={saving}
          onReset={() => void save(null)}
        />
        <Switch
          checked={state.enabled}
          disabled={saving}
          onCheckedChange={(next) => void save(next)}
          aria-labelledby={labelId}
        />
      </div>
    </div>
  );
}
