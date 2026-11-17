import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useProviders } from '@/hooks/useProviders';
import { formatCompactTokens } from '@/lib/usageFormat';
import { QuotaHoverCard } from './QuotaHoverCard';
import { registerStatusBarCard, type StatusBarCardHandle } from '@/lib/statusBarCards';

export const GOOGLE_QUOTA_GUIDE = 'https://antigravity.google/docs/cli/commands/usage/';

/** ACP context receipts are not account quota, credits or cash charges. */
export function GoogleSubscriptionUsageChip({ context, turnTokens }: {
  context?: { used: number; size: number };
  turnTokens?: number;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const card = useRef<StatusBarCardHandle | null>(null);
  const externalClose = useRef(false);
  useEffect(() => {
    const handle = registerStatusBarCard('quota', () => { externalClose.current = true; setOpen(false); });
    card.current = handle;
    return () => { card.current = null; handle.unregister(); };
  }, []);
  useEffect(() => { if (open) { externalClose.current = false; card.current?.request(); } else card.current?.release(); }, [open]);
  const { providers } = useProviders();
  const provider = providers.find(row => row.id === 'google-antigravity-subscription');
  const contextKnown = context && Number.isFinite(context.used) && context.used >= 0 && Number.isFinite(context.size) && context.size > 0;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className="inline-flex h-5 items-center rounded-full border-0 bg-transparent p-0 text-12 font-medium text-[var(--msg-tool-card-chevron)] hover:text-foreground focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]" aria-label={t('googleSubscription.usage')}>
          {t('googleSubscription.usage')}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-auto max-w-[calc(100vw-24px)] border-0 bg-transparent p-0 shadow-none" onOpenAutoFocus={event => event.preventDefault()}
        onCloseAutoFocus={event => { if (externalClose.current) event.preventDefault(); }}>
        <QuotaHoverCard
          account={{ title: 'Google AI · Antigravity', planLabel: provider?.access?.kind === 'subscription' ? provider.access.product : null,
            windows: [], emptyText: t('googleSubscription.quotaUnavailable'), details: [t('googleSubscription.quotaGuide'), t('googleSubscription.moneyUnavailable')] }}
          dashboardLabel={t('googleSubscription.openQuotaGuide')}
          onOpenDashboard={() => { void window.electronAPI.openExternal(GOOGLE_QUOTA_GUIDE); }}
        >
          <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-2 px-4 py-3 text-12">
            <dt>{t('googleSubscription.context')}</dt>
            <dd className="tabular-nums">{contextKnown ? `${formatCompactTokens(context.used)} / ${formatCompactTokens(context.size)}` : t('googleSubscription.unavailable')}</dd>
            <dt>{t('googleSubscription.lastTurnTokens')}</dt>
            <dd className="tabular-nums">{typeof turnTokens === 'number' && Number.isFinite(turnTokens) && turnTokens > 0 ? formatCompactTokens(turnTokens) : t('googleSubscription.unavailable')}</dd>
          </dl>
        </QuotaHoverCard>
      </PopoverContent>
    </Popover>
  );
}
