/**
 * ChipMetricsSection — Settings → 个性化 里的"用量指示器"区块。
 *
 * 每个 Switch 控制右下角 TodaySpendChip (Claude 形态) 直接显示哪些指标 (候选项以
 * CHIP_METRIC_KEYS 为准)。未选中的进 tooltip, 始终可 hover 查看。
 * 详见 TodaySpendChip.tsx / useChipMetricPreferences.ts。
 *
 * 分区、卡片与行用 settings-rows (SettingsSection / SettingsCard / SettingsRow)。
 */

import { useTranslation } from 'react-i18next';

import { Switch } from '@/components/ui/switch';
import { SettingsCard, SettingsRow, SettingsSection } from '@/components/ui/settings-rows';
import { useChipMetricPreferences, CHIP_METRIC_KEYS } from '@/hooks/useChipMetricPreferences';

export function ChipMetricsSection() {
  const { t } = useTranslation();
  const { isSelected, toggle } = useChipMetricPreferences();

  return (
    <SettingsSection title={t('settings.chipMetrics.title')} description={t('settings.chipMetrics.description')}>
      <SettingsCard>
        {CHIP_METRIC_KEYS.map((key) => (
          <SettingsRow
            key={key}
            title={t(`settings.chipMetrics.metrics.${key}.label`)}
            hint={t(`settings.chipMetrics.metrics.${key}.hint`)}
            trailing={
              <Switch
                checked={isSelected(key)}
                onCheckedChange={() => toggle(key)}
                aria-label={t('settings.chipMetrics.toggleAria', { metric: key })}
              />
            }
          />
        ))}
      </SettingsCard>
    </SettingsSection>
  );
}
