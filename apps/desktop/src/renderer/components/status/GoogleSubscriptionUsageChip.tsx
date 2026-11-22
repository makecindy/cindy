import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useProviders } from '@/hooks/useProviders';
import { useAntigravityAccountsCache } from '@/hooks/useAntigravityUsage';
import { formatCompactTokens } from '@/lib/usageFormat';
import { QuotaHoverCard } from './QuotaHoverCard';
import { registerStatusBarCard, type StatusBarCardHandle } from '@/lib/statusBarCards';
import { ANTIGRAVITY_SUBSCRIPTION_PROVIDER_ID, summarizeAntigravityQuota } from '../../../shared/antigravityAccounts';
import { quotaWindowLabel } from './usageCardModel';

export const GOOGLE_QUOTA_GUIDE = 'https://antigravity.google/docs/cli/commands/usage/';

export function GoogleSubscriptionUsageChip({ context, turnTokens, readLocalQuota = true }: {
  context?: { used: number; size: number };
  turnTokens?: number;
  readLocalQuota?: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [nowMs, setNowMs] = useState(Date.now);
  const card = useRef<StatusBarCardHandle | null>(null);
  const externalClose = useRef(false);
  useEffect(() => {
    const handle = registerStatusBarCard('quota', () => { externalClose.current = true; setOpen(false); });
    card.current = handle;
    return () => { card.current = null; handle.unregister(); };
  }, []);
  useEffect(() => { if (open) { externalClose.current = false; card.current?.request(); } else card.current?.release(); }, [open]);
  const { providers } = useProviders();
  const provider = providers.find(row => row.id === ANTIGRAVITY_SUBSCRIPTION_PROVIDER_ID);
  const { accounts, refresh } = useAntigravityAccountsCache(readLocalQuota, { fetchUsage: true });
  const snapshot = readLocalQuota ? accounts : undefined;
  const activeAccount = snapshot?.accounts.find(account => account.id === snapshot.activeId);
  const groups = snapshot?.usage ?? [];
  const { primary, secondary } = summarizeAntigravityQuota(groups, Math.max(nowMs, Date.now()));
  const visibleWindows = [primary, secondary].filter(window => window !== null);
  const nextResetAt = Math.min(...visibleWindows.map(window => window.resetsAt && window.resetsAt > 0
    ? window.resetsAt * 1000 : Infinity));
  useEffect(() => {
    if (!Number.isFinite(nextResetAt)) return;
    const delay = Math.min(2_147_483_647, Math.max(1, nextResetAt - Date.now()));
    const timer = setTimeout(() => setNowMs(Date.now()), delay);
    return () => clearTimeout(timer);
  }, [nextResetAt, nowMs]);
  const segments = visibleWindows.map(window => t('todaySpend.codex.windowSegment', {
    label: quotaWindowLabel(window.windowMinutes, t),
    remaining: `${Math.round(100 - Math.max(0, Math.min(100, window.usedPercent)))}%`,
  }));
  const windows = groups.flatMap(group => (['primary', 'secondary'] as const).flatMap(key => {
    const window = group[key];
    if (typeof window?.usedPercent !== 'number' || !Number.isFinite(window.usedPercent)) return [];
    const duration = quotaWindowLabel(window.windowMinutes, t);
    return [{
      key: `${group.limitId}:${key}`,
      title: group.limitName ? `${group.limitName} · ${duration}` : duration,
      showRemaining: true,
      window: { utilization: window.usedPercent, resetsAt: window.resetsAt },
    }];
  }));
  const contextKnown = context && Number.isFinite(context.used) && context.used >= 0 && Number.isFinite(context.size) && context.size > 0;
  return (
    <Popover open={open} onOpenChange={next => {
      setOpen(next);
      if (next && readLocalQuota) void refresh('usage').catch(() => undefined);
    }}>
      <PopoverTrigger asChild>
        <button type="button" className="inline-flex h-5 items-center rounded-full border-0 bg-transparent p-0 text-12 font-medium tabular-nums text-[var(--msg-tool-card-chevron)] hover:text-foreground focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
          aria-label={t('googleSubscription.usage')} aria-description={segments.length ? segments.join(' · ') : undefined}>
          {segments.length ? segments.map((segment, index) => (
            <span key={index} className="inline-flex items-center whitespace-nowrap">
              {index > 0 && <span aria-hidden="true" className="mx-2 inline-block h-3 w-px bg-current opacity-30" />}
              {segment}
            </span>
          )) : t('googleSubscription.usage')}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-auto max-w-[calc(100vw-24px)] border-0 bg-transparent p-0 shadow-none" onOpenAutoFocus={event => event.preventDefault()}
        onCloseAutoFocus={event => { if (externalClose.current) event.preventDefault(); }}>
        <QuotaHoverCard
          account={{ title: 'Google AI · Antigravity', identity: activeAccount?.identity,
            planLabel: provider?.access?.kind === 'subscription' ? provider.access.product : null,
            windows, updatedAt: groups[0]?.updatedAt, emptyText: windows.length ? undefined : t('googleSubscription.quotaUnavailable'),
            details: [t('googleSubscription.moneyUnavailable')] }}
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
