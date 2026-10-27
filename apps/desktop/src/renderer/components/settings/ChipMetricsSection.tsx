/**
 * ChipMetricsSection — Settings → 个性化 里的"用量指示器"区块。
 *
 * 每个 Switch 控制右下角 TodaySpendChip (Claude 形态) 直接显示哪些指标 (候选项以
 * CHIP_METRIC_KEYS 为准)。未选中的进 tooltip, 始终可 hover 查看。
 * 详见 TodaySpendChip.tsx / useChipMetricPreferences.ts。
 *
 * 卡片样式与 NotificationSection 对齐 (rounded 12 / Card bg / 1px Board / padding 20)。
 */

import { useTranslation } from 'react-i18next';

import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { useChipMetricPreferences, CHIP_METRIC_KEYS } from '@/hooks/useChipMetricPreferences';

export function ChipMetricsSection() {
  const { t } = useTranslation();
  const { isSelected, toggle } = useChipMetricPreferences();

  return (
    <div className="flex flex-col gap-[14px]">
      <h2 className="text-16 font-medium leading-[1.2] text-[var(--settings-section-title)]">
        {t('settings.chipMetrics.title')}
      </h2>

      <div
        className={cn(
          'flex flex-col rounded-xl',
          'bg-[var(--settings-theme-card-bg)]',
          'border border-[var(--settings-theme-card-border)]',
        )}
      >
        <p
          className="px-5 pt-5 pb-2 text-12 leading-[1.4] text-[var(--text-secondary)]"
        >
          {t('settings.chipMetrics.description')}
        </p>

        {CHIP_METRIC_KEYS.map((key, i) => (
          <div
            key={key}
            className={cn(
              'flex items-center justify-between gap-3 px-5 py-4',
              i < CHIP_METRIC_KEYS.length - 1 && 'border-b border-[var(--settings-theme-card-border)]',
            )}
          >
            <div className="flex min-w-0 flex-col gap-1">
              <p
                className="text-13 font-medium text-[var(--settings-section-sublabel)]"
                style={{ letterSpacing: '0.12px' }}
              >
                {t(`settings.chipMetrics.metrics.${key}.label`)}
              </p>
              <p className="text-12 leading-[1.4] text-[var(--text-secondary)]">
                {t(`settings.chipMetrics.metrics.${key}.hint`)}
              </p>
            </div>

            <Switch
              checked={isSelected(key)}
              onCheckedChange={() => toggle(key)}
              aria-label={t('settings.chipMetrics.toggleAria', { metric: key })}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

