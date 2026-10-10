import { useId, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { MobileCodexRateLimitResetCredit, MobileCodexRateLimitsResult } from '@cindy/maker-shared/device-link-contract';
import { Button } from '@/components/ui/button';
import { Collapse } from '@/components/ui/collapse';
import { formatQuotaResetAt } from './usageCardModel';

/** Shared reset list for provider settings and the usage dialog. */
export function CodexResetCredits({ snapshot, busy, canReset, onReset, variant }: {
  variant: 'embedded' | 'dialog';
  snapshot: MobileCodexRateLimitsResult | null;
  busy: boolean;
  canReset: boolean;
  onReset: (credit?: MobileCodexRateLimitResetCredit) => void;
}) {
  const { t, i18n } = useTranslation();
  const embedded = variant === 'embedded';
  const [expanded, setExpanded] = useState(false);
  const triggerId = useId();
  const panelId = useId();
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
    <span className="flex min-w-0 flex-wrap items-center justify-end gap-x-3 gap-y-1 text-12 text-[var(--text-secondary)]">
      <span className="shrink-0 text-12 tabular-nums text-[var(--text-secondary)]">
        {t('codexResets.available', { count: credits.availableCount })}
      </span>
      {embedded && credits.availableCount > 0 && earliestExpiry ? (
        <span>{t('todaySpend.codex.resetCreditEarliestExpiryLine', { at: earliestExpiry })}</span>
      ) : null}
    </span>
  );
  const content = (
    <>
      {!canReset && credits.availableCount > 0 ? (
        <p className="mt-2 text-12 text-[var(--text-secondary)]">{t('codexResets.availableAtLimit')}</p>
      ) : null}
      {available.length > 0 && credits.availableCount > 0 ? (
        <ul className="mt-2 divide-y divide-[var(--border-default)]">
          {available.map((credit, index) => (
            <li key={`${credit.grantedAt}-${credit.expiresAt}-${index}`} className="flex items-center justify-between gap-3 py-3">
              <div className="min-w-0">
                <div className="text-13 text-[var(--text-primary)]">{credit.title || t('codexResets.fullReset')}</div>
                <div className="mt-0.5 text-12 text-[var(--text-secondary)]">{formatExpiry(credit.expiresAt)}</div>
              </div>
              <Button size="sm" compact variant="secondary" disabled={!canReset || !credit.resetOffer}
                loading={busy} onClick={() => onReset(credit)}>
                {t('codexResets.useReset')}
              </Button>
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
          {available.length === 0 ? (
            <Button className="mt-2" size="sm" compact disabled={!canReset} loading={busy} onClick={() => onReset()}>
              {t('codexResets.useReset')}
            </Button>
          ) : null}
        </>
      )}
    </>
  );

  return (
    <section className={embedded ? 'mx-4 mt-2 border-t border-[var(--border-default)] pt-3' : undefined} aria-label={t('codexResets.title')}>
      {embedded ? (
        <>
          <button type="button" id={triggerId} aria-expanded={expanded} aria-controls={panelId}
            onClick={() => setExpanded(value => !value)}
            className="flex min-h-7 w-full items-center justify-between gap-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)]">
            <span className="flex items-center gap-1.5 text-14 font-medium text-[var(--text-primary)]">
              <ChevronRight className={`h-3.5 w-3.5 shrink-0 ${expanded ? 'rotate-90' : ''}`} aria-hidden="true" />
              {t('codexResets.title')}
            </span>
            {count}
          </button>
          <Collapse open={expanded} id={panelId} role="region" aria-labelledby={triggerId}>
            {content}
          </Collapse>
        </>
      ) : (
        <>
          <div className="flex items-center justify-between gap-3 pr-8">
            <h3 className="text-18 font-medium text-[var(--confirm-title)]">{t('codexResets.title')}</h3>
            {count}
          </div>
          {content}
        </>
      )}
    </section>
  );
}
