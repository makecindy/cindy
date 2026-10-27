import { useTranslation } from 'react-i18next';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from '@/components/ui/dropdown-menu';
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
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            disabled={disabled}
            className="mt-2 inline-flex min-h-7 items-center gap-2 rounded-full border border-[var(--settings-theme-card-border)] px-3 text-12 disabled:opacity-50"
          >
            {policy.isCustomized ? `${policy.pct}%` : t(`${key}.default`, { pct: policy.pct })}
            <span aria-hidden="true">⌄</span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="z-[10003]" align="start">
          <DropdownMenuRadioGroup
            value={value}
            onValueChange={(next) => {
              void onChange(next === 'default' ? null : Number(next));
            }}
          >
            <DropdownMenuRadioItem value="default">
              {t('settings.providers.models.advanced.restoreDefault')}
            </DropdownMenuRadioItem>
            {values.map((pct) => (
              <DropdownMenuRadioItem key={pct} value={String(pct)}>
                {pct}%
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <p className="mt-2 text-11 leading-relaxed text-[var(--text-secondary)]">
        {t(`${key}.timing`)}
      </p>
    </details>
  );
}
