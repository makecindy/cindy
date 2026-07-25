/**
 * Host-rendered model preferences for Cindy abilities declared by a Plugin.
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Sparkles } from 'lucide-react';

import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';

/** 跟随默认在 select 里的哨兵值(覆盖表里"没有这项"= 跟随默认)。 */
const FOLLOW_DEFAULT_VALUE = '__default__';

/**
 * Ghost 申请的每项 Cindy 能力一行,可钉后端(供应商×模型)。
 * Settings 详情与 Plugin 详情共用这一份实现,避免两个入口产生不同配置口径。
 */
export function CindyCapabilityPrefs({
  ghostId,
  capabilities,
  appearance = 'settings',
}: {
  ghostId: string;
  /** 能力键全名列表(image.generate / video.edit …,来自身份卡详单)。 */
  capabilities: readonly string[];
  /** Plugin detail aligns the fallback editor with the shared Plugin surface. */
  appearance?: 'settings' | 'plugin';
}) {
  const { t } = useTranslation();
  const [prefs] = useState(() => window.electronAPI.ghosts.cindyPrefsSync(ghostId));
  const [overrides, setOverrides] = useState<Record<string, string>>(prefs.overrides);

  const handleChange = useCallback(
    async (capability: string, value: string) => {
      const model = value === FOLLOW_DEFAULT_VALUE ? null : value;
      const prev = overrides;
      setOverrides((current) => {
        const next = { ...current };
        if (model === null) delete next[capability];
        else next[capability] = model;
        return next;
      });
      try {
        const result = await window.electronAPI.ghosts.setCindyPref(ghostId, capability, model);
        setOverrides(result.overrides);
      } catch {
        setOverrides(prev);
        toast.error(t('settings.ghosts.errors.generic'));
      }
    },
    [ghostId, overrides, t],
  );

  return (
    <div
      className={cn(
        'cindy-capability-prefs min-w-0 max-w-full flex flex-col gap-3 rounded-xl border px-5 py-4',
        appearance === 'plugin'
          ? 'border-[color-mix(in_srgb,var(--border-default)_72%,transparent)] bg-[color-mix(in_srgb,var(--surface-elevated)_82%,var(--surface))]'
          : 'border-[var(--settings-theme-card-border)] bg-[var(--settings-theme-card-bg)]',
      )}
    >
      <div className="flex items-center gap-2">
        <Sparkles size={14} className="text-[var(--text-tertiary)]" />
        <p
          className={cn(
            'font-medium text-[var(--text-primary)]',
            appearance === 'plugin' ? 'text-14 leading-[22px]' : 'text-13',
          )}
        >
          {t('settings.ghosts.detail.cindyPrefs.title')}
        </p>
      </div>
      <p
        className={cn(
          'text-[var(--text-tertiary)]',
          appearance === 'plugin' ? 'text-13 leading-5' : 'text-12',
        )}
      >
        {t('settings.ghosts.detail.cindyPrefs.desc')}
      </p>
      {capabilities.map((capability) => {
        const kind = capability.startsWith('video.') ? prefs.video : prefs.image;
        return (
          <div
            key={capability}
            className="cindy-capability-row flex min-w-0 items-center justify-between gap-4"
          >
            <span
              className={cn(
                'min-w-0 text-[var(--text-secondary)]',
                appearance === 'plugin' ? 'text-13 leading-5' : 'text-12',
              )}
            >
              {t(`settings.ghosts.detail.cindyPrefs.cap.${capability}`)}
            </span>
            <select
              value={
                overrides[capability] && overrides[capability] !== kind.defaultModel.id
                  ? overrides[capability]
                  : FOLLOW_DEFAULT_VALUE
              }
              onChange={(event) => void handleChange(capability, event.target.value)}
              aria-label={t(`settings.ghosts.detail.cindyPrefs.cap.${capability}`)}
              className={cn(
                'cindy-capability-select h-8 w-[300px] max-w-[60%] min-w-0 shrink appearance-none rounded-full border border-[var(--settings-input-border)] bg-[var(--settings-input-bg)] py-0 pl-3 pr-8 text-[var(--settings-input-text)] outline-none focus:ring-2 focus:ring-[var(--focus-ring-soft)]',
                appearance === 'plugin' ? 'text-13 leading-5' : 'text-12',
              )}
            >
              {kind.options.map((option) => {
                const isDefault = option.id === kind.defaultModel.id;
                return (
                  <option key={option.id} value={isDefault ? FOLLOW_DEFAULT_VALUE : option.id}>
                    {isDefault
                      ? t('settings.ghosts.detail.cindyPrefs.defaultOption', {
                          model: option.label,
                        })
                      : option.label}
                  </option>
                );
              })}
            </select>
          </div>
        );
      })}
    </div>
  );
}
