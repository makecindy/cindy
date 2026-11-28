/**
 * Restore-default actions (DESIGN.md §4 Desktop settings controls, "Restore default").
 *
 * - RestoreDefaultButton: one setting. 28px frameless square icon button with a `Tip`,
 *   placed to the left of the control and only while the value differs from its default
 *   (DefaultOverrideControls adds the "customized" badge in front of it).
 * - ResetGroupButton: a whole page or section. `secondary` `sm` Button with the RotateCcw
 *   icon and a text label, on the right of the page or section title. An optional `tip`
 *   explains what is reset; `loading` keeps the label width and accessible name.
 *
 * Both forward the remaining Button props (data-settings-search-action, data-setting-id,
 * disabled, loading, className for layout) so callers keep their settings-search contract.
 */

import * as React from 'react';
import { RotateCcw } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { Button, type ButtonProps } from './button';
import { Tip } from './tooltip';

type ResetButtonBaseProps = Omit<ButtonProps, 'variant' | 'tone' | 'size' | 'compact' | 'children'>;

export interface RestoreDefaultButtonProps extends ResetButtonBaseProps {
  /** Tooltip and accessible name; defaults to "Restore default". */
  label?: string;
}

export const RestoreDefaultButton = React.forwardRef<HTMLButtonElement, RestoreDefaultButtonProps>(
  function RestoreDefaultButton({ label, className, ...props }, ref) {
    const { t } = useTranslation();
    const text = label ?? t('settings.defaults.restore');
    return (
      <Tip text={text} side="top">
        <Button
          ref={ref}
          variant="secondary"
          tone="quiet"
          size="sm"
          className={cn('w-7 px-0', className)}
          aria-label={text}
          {...props}
        >
          <RotateCcw size={15} aria-hidden />
        </Button>
      </Tip>
    );
  },
);

export interface ResetGroupButtonProps extends ResetButtonBaseProps {
  /** Visible label, e.g. "Restore defaults". */
  label: string;
  /** Optional extra context shown in a Tip (what exactly is reset). */
  tip?: string;
}

export const ResetGroupButton = React.forwardRef<HTMLButtonElement, ResetGroupButtonProps>(
  function ResetGroupButton({ label, tip, ...props }, ref) {
    return (
      <Tip text={tip}>
        <Button ref={ref} variant="secondary" size="sm" compact {...props}>
          <RotateCcw size={14} aria-hidden />
          {label}
        </Button>
      </Tip>
    );
  },
);
