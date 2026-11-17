import { RotateCcw } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { Tip } from '@/components/ui/tooltip';

export function DefaultOverrideControls({
  isCustomized,
  disabled,
  alwaysVisible = false,
  showCustomizedBadge = isCustomized,
  onReset,
}: {
  isCustomized: boolean;
  disabled?: boolean;
  /** 保留还原入口占位；无覆盖时按钮禁用，避免设置行宽度跳动。 */
  alwaysVisible?: boolean;
  /** Draft-only settings can keep the reset action without claiming a saved override. */
  showCustomizedBadge?: boolean;
  onReset: () => void;
}) {
  const { t } = useTranslation();
  if (!isCustomized && !alwaysVisible) return null;

  const resetDisabled = disabled || !isCustomized;

  return (
    <div className="flex shrink-0 items-center gap-2">
      {isCustomized && showCustomizedBadge ? (
        <span className="whitespace-nowrap rounded-full bg-[var(--surface-chip)] px-2 py-1 text-11 font-medium leading-none text-[var(--text-secondary)]">
          {t('settings.defaults.customizedBadge')}
        </span>
      ) : null}
      {/* Per-setting reset (CONTROLS decision 3): 28px quiet pill icon button on the shared Button. */}
      <Tip text={t('settings.defaults.restore')} side="top">
        <Button
          data-settings-search-action="Restore this setting to its default value"
          variant="secondary"
          tone="quiet"
          size="sm"
          className="w-7 px-0"
          onClick={onReset}
          disabled={resetDisabled}
          aria-label={t('settings.defaults.restore')}
        >
          <RotateCcw size={15} aria-hidden />
        </Button>
      </Tip>
    </div>
  );
}
