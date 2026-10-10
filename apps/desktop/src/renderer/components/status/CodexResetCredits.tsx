import { ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { MobileCodexRateLimitsResult } from '@cindy/maker-shared/device-link-contract';
import { Button } from '@/components/ui/button';
import { formatQuotaResetAt } from './usageCardModel';

/** The same available-reset list in provider settings and the task usage popover. */
export function CodexResetCredits({ snapshot, busy, canReset, onReset, collapsible = false, standalone = false }: {
  /** A dedicated dialog owns its own padding and frame. */
  standalone?: boolean;
  /** Settings starts closed so the model list remains visible. */
  collapsible?: boolean;
  snapshot: MobileCodexRateLimitsResult | null;
  busy: boolean;
  canReset: boolean;
  onReset: () => void;
}) {
  const { t, i18n } = useTranslation();
  const credits = snapshot?.rateLimitResetCredits;
  if (!credits) return null;
  const now = Date.now();
  const available = (credits.credits ?? [])
    .filter(credit => credit.status === 'available' && credit.resetType === 'codexRateLimits'
      && (credit.expiresAt === null || credit.expiresAt * 1000 > now))
    .sort((a, b) => (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity) || a.grantedAt - b.grantedAt);
  const locale = i18n?.resolvedLanguage ?? i18n?.language;
  const formatExpiry = (expiresAt: number | null) => {
    if (expiresAt === null) return t('codexResets.expiryUnknown');
    const date = new Date(expiresAt * 1000);
    if (!Number.isFinite(date.getTime())) return t('codexResets.expiryUnknown');
    return t('codexResets.expiresAt', { at: new Intl.DateTimeFormat(locale, {
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
    }).format(date) });
  };

  const earliestExpiresAt = available[0]?.expiresAt ?? snapshot?.resetOffer?.expiresAt;
  const earliestExpiry = earliestExpiresAt == null ? null : formatQuotaResetAt(earliestExpiresAt, now, locale);
  const count = (
    <div className="flex min-w-0 flex-wrap items-center justify-end gap-x-3 gap-y-1 text-12 text-[var(--text-secondary)]">
      <span className="shrink-0 text-12 tabular-nums text-[var(--text-secondary)]">
        {t('codexResets.available', { count: credits.availableCount })}
      </span>
      {collapsible && credits.availableCount > 0 && earliestExpiry ? (
        <span>{t('todaySpend.codex.resetCreditEarliestExpiryLine', { at: earliestExpiry })}</span>
      ) : null}
    </div>
  );
  const content = (
    <>
      {available.length > 0 && credits.availableCount > 0 ? (
        <ul className="mt-2 divide-y divide-[var(--border-default)]">
          {available.map((credit, index) => (
            <li key={`${credit.grantedAt}-${credit.expiresAt}-${index}`} className="py-2">
              <div className="text-13 text-[var(--text-primary)]">{credit.title || t('codexResets.fullReset')}</div>
              <div className="mt-0.5 text-12 text-[var(--text-secondary)]">{formatExpiry(credit.expiresAt)}</div>
            </li>
          ))}
        </ul>
      ) : null}
      {credits.availableCount === 0 ? (
        <p className="mt-2 text-12 text-[var(--text-secondary)]">{t('codexResets.noCredit')}</p>
      ) : (
        <>
          {available.length < credits.availableCount && (
            <p className="mt-2 text-12 text-[var(--text-secondary)]">{t('codexResets.detailsUnavailable')}</p>
          )}
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2 pb-2">
            <p className="min-w-0 flex-1 text-12 text-[var(--text-secondary)]">
              {t(canReset ? 'codexResets.earliestFirst' : 'codexResets.availableAtLimit')}
            </p>
            <Button size="sm" compact disabled={!canReset} loading={busy} onClick={onReset}>
              {t('codexResets.useReset')}
            </Button>
          </div>
        </>
      )}
    </>
  );

  return (
    <section className={standalone ? '' : 'mx-4 mt-2 border-t border-[var(--border-default)] pt-3'} aria-label={t('codexResets.title')}>
      {collapsible ? (
        <details className="group">
          <summary className="flex min-h-7 cursor-pointer list-none items-center justify-between gap-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)] [&::-webkit-details-marker]:hidden">
            <span className="flex items-center gap-1.5 text-14 font-medium text-[var(--text-primary)]">
              <ChevronRight className="h-3.5 w-3.5 shrink-0 group-open:rotate-90" aria-hidden="true" />
              {t('codexResets.title')}
            </span>
            {count}
          </summary>
          {content}
        </details>
      ) : (
        <>
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-14 font-medium text-[var(--text-primary)]">{t('codexResets.title')}</h3>
            {count}
          </div>
          {content}
        </>
      )}
    </section>
  );
}
