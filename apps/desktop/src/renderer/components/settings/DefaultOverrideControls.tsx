import { RotateCcw } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Tip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

export function DefaultOverrideControls({
  isCustomized,
  disabled,
  alwaysVisible = false,
  onReset,
}: {
  isCustomized: boolean;
  disabled?: boolean;
  /** 保留还原入口占位；无覆盖时按钮禁用，避免设置行宽度跳动。 */
  alwaysVisible?: boolean;
  onReset: () => void;
}) {
  const { t } = useTranslation();
  if (!isCustomized && !alwaysVisible) return null;

  const resetDisabled = disabled || !isCustomized;

  return (
    <div className="flex shrink-0 items-center gap-2">
      {isCustomized ? (
        <span className="whitespace-nowrap rounded-full bg-[var(--surface-chip)] px-2 py-1 text-11 font-medium leading-none text-[var(--text-secondary)]">
          {t('settings.defaults.customizedBadge')}
        </span>
      ) : null}
      <Tip text={t('settings.defaults.restore')} side="top">
        <button
          type="button"
          onClick={onReset}
          disabled={resetDisabled}
          aria-label={t('settings.defaults.restore')}
          className={cn(
            'flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-lg',
            'text-[var(--settings-section-desc)] transition-colors',
            'hover:bg-[var(--settings-input-bg)] hover:text-[var(--settings-section-title)]',
            'disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent',
          )}
        >
          <RotateCcw size={15} />
        </button>
      </Tip>
    </div>
  );
}
