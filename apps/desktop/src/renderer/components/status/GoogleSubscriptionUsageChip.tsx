import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useProviders } from '@/hooks/useProviders';
import { formatCompactTokens } from '@/lib/usageFormat';
import { QuotaHoverCard } from './QuotaHoverCard';
import { registerStatusBarCard, type StatusBarCardHandle } from '@/lib/statusBarCards';
import {
  getDataOwnerGeneration, isDataOwnerGenerationCurrent, subscribeDataOwnerGeneration,
} from '@/contexts/dataOwnerGeneration';
import { ANTIGRAVITY_SUBSCRIPTION_PROVIDER_ID, type AntigravityAccountsView } from '../../../shared/antigravityAccounts';
import { quotaWindowLabel } from './usageCardModel';

export const GOOGLE_QUOTA_GUIDE = 'https://antigravity.google/docs/cli/commands/usage/';

export function GoogleSubscriptionUsageChip({ context, turnTokens, readLocalQuota = true }: {
  context?: { used: number; size: number };
  turnTokens?: number;
  readLocalQuota?: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const owner = useSyncExternalStore(subscribeDataOwnerGeneration, getDataOwnerGeneration);
  const [quota, setQuota] = useState<{ owner: typeof owner; value: AntigravityAccountsView }>();
  const card = useRef<StatusBarCardHandle | null>(null);
  const externalClose = useRef(false);
  useEffect(() => {
    const handle = registerStatusBarCard('quota', () => { externalClose.current = true; setOpen(false); setQuota(undefined); });
    card.current = handle;
    return () => { card.current = null; handle.unregister(); };
  }, []);
  useEffect(() => { if (open) { externalClose.current = false; card.current?.request(); } else card.current?.release(); }, [open]);
  const { providers } = useProviders();
  const provider = providers.find(row => row.id === ANTIGRAVITY_SUBSCRIPTION_PROVIDER_ID);
  const api = window.electronAPI?.antigravityAccounts;
  const auth = window.electronAPI?.maker?.auth;
  useEffect(() => {
    if (!open || !readLocalQuota || !api || !owner.dataOwnerId || !isDataOwnerGenerationCurrent(owner)) return;
    let active = true;
    let sequence = 0;
    const refresh = () => {
      if (!active || !isDataOwnerGenerationCurrent(owner)) return;
      const request = ++sequence;
      setQuota(undefined);
      void api({ action: 'usage' }, { dataOwnerId: owner.dataOwnerId, ownerGeneration: owner.generation })
        .then(value => {
          if (active && request === sequence && isDataOwnerGenerationCurrent(owner)) setQuota({ owner, value });
        })
        .catch(() => undefined);
    };
    const unsubscribe = auth?.onStateChanged?.(state => {
      if (state.agentKind === 'antigravity') refresh();
    });
    refresh();
    return () => { active = false; unsubscribe?.(); };
  }, [open, readLocalQuota, api, auth, owner]);
  const snapshot = readLocalQuota && quota && isDataOwnerGenerationCurrent(quota.owner) ? quota.value : undefined;
  const activeAccount = snapshot?.accounts.find(account => account.id === snapshot.activeId);
  const groups = snapshot?.usage ?? [];
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
    <Popover open={open} onOpenChange={next => { if (!next) setQuota(undefined); setOpen(next); }}>
      <PopoverTrigger asChild>
        <button type="button" className="inline-flex h-5 items-center rounded-full border-0 bg-transparent p-0 text-12 font-medium text-[var(--msg-tool-card-chevron)] hover:text-foreground focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]" aria-label={t('googleSubscription.usage')}>
          {t('googleSubscription.usage')}
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
