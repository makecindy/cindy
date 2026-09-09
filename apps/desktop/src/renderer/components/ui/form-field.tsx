import { useId, type ReactNode } from 'react';

import { cn } from '@/lib/utils';

export interface FormFieldControlProps {
  id: string;
  'aria-describedby'?: string;
  'aria-invalid'?: true;
  'aria-required'?: true;
  error: boolean;
}

export interface FormFieldProps {
  id?: string;
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  /** Existing descriptions outside this field remain associated. */
  describedBy?: string;
  labelAction?: ReactNode;
  className?: string;
  /** Dense dynamic rows can retain a label for assistive technology. */
  hideLabel?: boolean;
  /** Reserve feedback space only for fields that can fail validation. */
  reserveFeedback?: boolean;
  children: (control: FormFieldControlProps) => ReactNode;
}

/** Label/description/error relationships only; values and validation belong to the form. */
export function FormField({
  id,
  label,
  hint,
  error,
  required,
  describedBy,
  labelAction,
  className,
  hideLabel,
  reserveFeedback,
  children,
}: FormFieldProps) {
  const generatedId = useId();
  const controlId = id ?? generatedId;
  const hintId = `${controlId}-hint`;
  const errorId = `${controlId}-error`;
  const description = [describedBy, hint && hintId, error && errorId].filter(Boolean).join(' ');
  return (
    <div className={cn('flex min-w-0 flex-col gap-2', className)}>
      <div className={cn('flex items-center justify-between gap-2', hideLabel && 'sr-only')}>
        <label
          htmlFor={controlId}
          className="text-13 font-medium text-[var(--settings-section-title)]"
        >
          {label}
        </label>
        {labelAction}
      </div>
      {children({
        id: controlId,
        'aria-describedby': description || undefined,
        'aria-invalid': error ? true : undefined,
        'aria-required': required ? true : undefined,
        error: Boolean(error),
      })}
      {(hint || error || reserveFeedback) && (
        <div
          className={cn(
            'text-12 leading-snug [overflow-wrap:anywhere]',
            reserveFeedback && '[&>p:last-child]:min-h-[2.5em]',
          )}
        >
          {hint && (
            <p id={hintId} className="text-[var(--text-tertiary)]">
              {hint}
            </p>
          )}
          <p id={errorId} aria-live="polite" className="text-[var(--error-fg)]">
            {error}
          </p>
        </div>
      )}
    </div>
  );
}
