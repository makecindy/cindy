import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Slider } from '@/components/ui/slider';
import {
  MAX_MODEL_COMPACTION_PCT,
  MIN_MODEL_COMPACTION_PCT,
  type ModelContextLimitView,
} from '../../../shared/modelContextLimit';
import { DefaultOverrideControls } from './DefaultOverrideControls';

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
  // Drag preview stays local; only the released value is persisted.
  const [draft, setDraft] = useState<number | null>(null);
  const value = draft ?? policy.pct;
  const commit = async (pct: number | null) => {
    await onChange(pct);
    // Fall back to whatever main committed (or rolled back to).
    setDraft((current) => (current === pct ? null : current));
  };
  return (
    <details
      className="mt-3 border-t border-[var(--settings-theme-card-border)] pt-3"
      data-model-compaction
    >
      {/* 状态标记挂在标题行：它出现/消失时不会挤压下面的滑杆，滑杆宽度保持恒定。 */}
      <summary className="cursor-pointer text-12 font-medium text-[var(--text-secondary)]">
        {t(`${key}.title`)}
        <span className="ml-2 inline-flex items-center rounded-full bg-[var(--surface-chip)] px-2 py-0.5 align-middle text-11 font-medium leading-none text-[var(--text-secondary)]">
          {policy.isCustomized ? t('settings.defaults.customizedBadge') : t(`${key}.defaultBadge`)}
        </span>
      </summary>
      <p className="mt-2 text-12 leading-relaxed text-[var(--text-secondary)]">
        {t(`${key}.hint`)}
      </p>
      <div className="mt-2 flex items-center gap-[14px]">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <Slider
            value={[value]}
            min={MIN_MODEL_COMPACTION_PCT}
            max={MAX_MODEL_COMPACTION_PCT}
            step={1}
            disabled={disabled}
            onValueChange={(next: number[]) => {
              const pct = next[0];
              if (typeof pct === 'number') setDraft(pct);
            }}
            onValueCommit={(next: number[]) => {
              const pct = next[0];
              if (typeof pct === 'number') void commit(pct);
            }}
            aria-label={t(`${key}.sliderAria`)}
          />
          <div className="flex items-center justify-between text-11 leading-none text-[var(--text-tertiary)]">
            <span>{MIN_MODEL_COMPACTION_PCT}%</span>
            <span>{MAX_MODEL_COMPACTION_PCT}%</span>
          </div>
        </div>
        {/* 定宽数值块：50%–95% 数字位数相同，滑杆不会随数值长短跳动。 */}
        <span className="w-[52px] shrink-0 text-center text-13 font-medium leading-none tabular-nums text-[var(--text-primary)]">
          {value}%
        </span>
        <DefaultOverrideControls
          isCustomized={policy.isCustomized}
          disabled={disabled}
          alwaysVisible
          showCustomizedBadge={false}
          onReset={() => void commit(null)}
        />
      </div>
      <p className="mt-2 text-11 leading-relaxed text-[var(--text-secondary)]">
        {t(`${key}.timing`)}
      </p>
    </details>
  );
}
