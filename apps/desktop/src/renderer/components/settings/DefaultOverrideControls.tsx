import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { RestoreDefaultButton } from '@/components/ui/reset-buttons';

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
      {/* Per-setting reset (CONTROLS decision 3): shared 28px quiet icon button. */}
      <RestoreDefaultButton
        data-settings-search-action="Restore this setting to its default value"
        onClick={onReset}
        disabled={resetDisabled}
      />
    </div>
  );
}

/** A saved override and how to clear it, for a single-control row that offers a reset. */
export interface DefaultOverrideReset {
  customized: boolean;
  disabled?: boolean;
  onReset(): void;
}

/**
 * The row's control with DefaultOverrideControls in front of it. Without `reset` the control is
 * returned unchanged, so callers that do not pass one render the control exactly as given.
 */
export function withDefaultOverride(control: ReactNode, reset?: DefaultOverrideReset) {
  if (!reset) return control;
  return (
    <div className="flex shrink-0 items-center gap-2">
      <DefaultOverrideControls
        isCustomized={reset.customized}
        disabled={reset.disabled}
        onReset={reset.onReset}
      />
      {control}
    </div>
  );
}
