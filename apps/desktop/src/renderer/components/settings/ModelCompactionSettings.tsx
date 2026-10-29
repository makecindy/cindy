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
      <summary className="cursor-pointer text-12 font-medium text-[var(--text-secondary)]">
        {t(`${key}.title`)}
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
        <span className="shrink-0 rounded-full border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3 py-1.5 text-13 font-medium leading-none text-[var(--text-primary)]">
          {draft !== null || policy.isCustomized ? `${value}%` : t(`${key}.default`, { pct: value })}
        </span>
        <DefaultOverrideControls
          isCustomized={policy.isCustomized}
          disabled={disabled}
          alwaysVisible
          onReset={() => void commit(null)}
        />
      </div>
      <p className="mt-2 text-11 leading-relaxed text-[var(--text-secondary)]">
        {t(`${key}.timing`)}
      </p>
    </details>
  );
}
