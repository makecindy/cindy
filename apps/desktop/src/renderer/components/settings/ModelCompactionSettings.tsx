import { useTranslation } from 'react-i18next';
import { Select } from '@/components/ui/select';
import type { ModelContextLimitView } from '../../../shared/modelContextLimit';

/** One supplier/model preference shared by every harness. */
export function ModelCompactionSettings({
  policy,
  disabled,
  onChange,
}: {
  policy: NonNullable<ModelContextLimitView['compaction']>;
  disabled: boolean;
  onChange: (pct: number | null) => Promise<void>;
}) {
  const { t } = useTranslation();
  const key = 'settings.providers.models.advanced.compaction';
  const value = policy.isCustomized ? String(policy.pct) : 'default';
  const values = [...new Set([50, 60, 70, 80, 85, 90, policy.pct])].sort((a, b) => a - b);
  return (
    <details
      className="mt-3 border-t border-[var(--settings-theme-card-border)] pt-3"
      data-model-compaction
    >
      <summary className="cursor-pointer text-12 font-medium text-[var(--text-secondary)]">
        {t(`${key}.title`)}
      </summary>
      <p className="mt-2 text-12 leading-relaxed text-[var(--text-secondary)]">
        {t(`${key}.hint`)}
      </p>
      {/* Selecting the default option removes the override (restores the default). */}
      <Select data-settings-search-action="Choose the automatic compaction threshold for this model"
        label={t(`${key}.title`)}
        size="compact"
        width="sm"
        className="mt-2"
        value={value}
        disabled={disabled}
        onValueChange={(next) => {
          void onChange(next === 'default' ? null : Number(next));
        }}
        options={[
          // The view only knows the default percentage while no override is set.
          {
            value: 'default',
            label: policy.isCustomized
              ? t('settings.providers.models.advanced.restoreDefault')
              : t(`${key}.default`, { pct: policy.pct }),
          },
          ...values.map((pct) => ({ value: String(pct), label: `${pct}%` })),
        ]}
      />
      <p className="mt-2 text-11 leading-relaxed text-[var(--text-secondary)]">
        {t(`${key}.timing`)}
      </p>
    </details>
  );
}
