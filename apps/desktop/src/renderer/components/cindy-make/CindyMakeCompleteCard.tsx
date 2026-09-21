import type { ReactNode } from 'react';
import { Check, CircleAlert, CircleHelp } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { Spinner } from '@/components/ui/spinner';

/** The same verified completion facts, in history or in the input-area test handoff. */
export function CindyMakeCompleteCard({
  data,
  composer = false,
  heading,
  description,
  detail,
  busy,
  failed,
  needsCheck,
  children,
}: {
  data?: Record<string, unknown>;
  composer?: boolean;
  heading?: string;
  description?: string;
  detail?: ReactNode;
  busy?: boolean;
  failed?: boolean;
  needsCheck?: boolean;
  children?: ReactNode;
}) {
  const { t, i18n } = useTranslation();
  const changedFiles = typeof data?.changedFiles === 'number' ? data.changedFiles : undefined;
  const commit =
    typeof data?.commit === 'string' && data.commit ? data.commit.slice(0, 12) : undefined;
  const reportedAt =
    typeof data?.reportedAt === 'number' && Number.isFinite(data.reportedAt)
      ? data.reportedAt
      : undefined;
  const time =
    reportedAt !== undefined
      ? new Intl.DateTimeFormat(i18n?.resolvedLanguage ?? i18n?.language, {
          dateStyle: 'medium',
          timeStyle: 'short',
        }).format(reportedAt)
      : undefined;
  const branch = typeof data?.branch === 'string' && data.branch ? data.branch : undefined;
  const meta = [
    changedFiles !== undefined
      ? t('cindyMake.complete.changedFiles', { count: changedFiles })
      : null,
    branch ? t('cindyMake.complete.branch', { branch }) : null,
    commit ? t('cindyMake.complete.commit', { commit }) : null,
    time ?? null,
  ].filter((part): part is string => typeof part === 'string' && part.length > 0);
  const border = composer ? 'border-[var(--chat-input-border)]' : 'border-[var(--border-default)]';
  return (
    <section
      className={cn(
        'w-full rounded-xl border text-14 text-[var(--text-primary)]',
        border,
        composer ? 'bg-[var(--chat-input-bg)]' : 'bg-[var(--surface-elevated)]',
      )}
      aria-label={t(composer ? 'cindyMake.test.title' : 'cindyMake.complete.title')}
    >
      <div className="flex items-start gap-3 px-4 py-4">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--surface-chip)]">
          {busy ? (
            <Spinner size={18} />
          ) : failed ? (
            <CircleAlert size={18} className="text-[var(--error-fg)]" aria-hidden />
          ) : needsCheck ? (
            <CircleHelp size={18} className="text-[var(--text-secondary)]" aria-hidden />
          ) : (
            <Check size={18} className="text-[var(--status-success)]" aria-hidden />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div role={composer ? 'status' : undefined}>
            <p className="text-16 font-medium">{heading ?? t('cindyMake.complete.title')}</p>
            <p className="mt-0.5 text-13 text-[var(--text-secondary)]">
              {description ?? t('cindyMake.complete.description')}
            </p>
          </div>
          {detail}
          {meta.length > 0 && (
            <p className="mt-2 break-words text-12 text-[var(--text-secondary)]">
              {meta.join(' · ')}
            </p>
          )}
        </div>
      </div>
      {children && <div className={cn('space-y-3 border-t px-4 py-3', border)}>{children}</div>}
    </section>
  );
}
