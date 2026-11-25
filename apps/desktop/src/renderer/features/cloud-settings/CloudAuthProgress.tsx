import { useTranslation } from 'react-i18next';
import { Spinner } from '@/components/ui/spinner';
import { BlockReadFailure } from './blockRetry';

/**
 * The line under an authorization's buttons: what it is doing, or, once its progress could not be
 * read back, a notice whose reload reads it again without signing in again. Where the button
 * that started it is not this page's own (the local wizard and provider page), `checking` shows a
 * spinner without words while an unknown result is read back.
 */
export function CloudAuthProgress({
  text,
  unreadable,
  checking = false,
  disabled = false,
  className = 'text-13 text-[var(--text-secondary)]',
}: {
  text?: string;
  unreadable?: { reload(): void };
  checking?: boolean;
  disabled?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  if (unreadable)
    return (
      <BlockReadFailure
        title={t('cloudSettings.authProgressUnreadable')}
        disabled={disabled}
        onReload={unreadable.reload}
      />
    );
  if (text)
    return (
      <p role="status" className={className}>
        {text}
      </p>
    );
  return checking ? (
    <span role="status" aria-label={t('cloudSettings.authChecking')} className="inline-flex">
      <Spinner size={14} className="text-[var(--text-secondary)]" />
    </span>
  ) : null;
}
