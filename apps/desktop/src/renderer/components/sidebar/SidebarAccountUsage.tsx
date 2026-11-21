import { ChartColumn, CircleDollarSign } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { useOptionalDataOwnerGeneration } from '@/contexts/AuthContext';
import { billingApi } from '@/features/billing/api';
import { BILLING_CURRENCY, formatBillingAmount } from '@/features/billing/money';
import { useModelAccessCreditUsageResult } from '@/hooks/useModelAccessCreditUsage';
import { useUsageHistory } from '@/hooks/useUsageHistory';
import { formatCompactTokens } from '@/lib/usageFormat';

const pendingFallbackBalances = new Map<string, ReturnType<typeof billingApi.getBalance>>();

interface SidebarAccountUsageProps {
  ownerId: string | null;
  showBilling: boolean;
  onSelect: (tab: 'usage' | 'billing') => void;
}

interface UsageMenuRow {
  tab: 'usage' | 'billing';
  label: string;
  Icon: typeof ChartColumn;
  caption: string;
  value: string | null;
  exactValue?: string;
}

/** The dropdown mounts these rows together with Settings, including during its exit animation. */
export function SidebarAccountUsage({ ownerId, showBilling, onSelect }: SidebarAccountUsageProps) {
  const { t, i18n } = useTranslation();
  const ownerGeneration = useOptionalDataOwnerGeneration();
  const accountScope = ownerId ? `${ownerGeneration}:${ownerId}` : null;
  const { history } = useUsageHistory({ userId: ownerId, days: 1, modelDays: 1, paused: true, allowPendingEstimates: true });
  const { usage, loading } = useModelAccessCreditUsageResult(showBilling, { poll: false });
  const [fallbackBalance, setFallbackBalance] = useState<{ accountScope: string; available: string } | null>(null);
  useEffect(() => {
    if (!showBilling || !accountScope || loading || usage) return;
    let cancelled = false;
    // Reopening the menu can rejoin the same login's pending basic-balance read.
    let request = pendingFallbackBalances.get(accountScope);
    if (!request) {
      request = billingApi.getBalance().finally(() => pendingFallbackBalances.delete(accountScope));
      pendingFallbackBalances.set(accountScope, request);
    }
    void request.then(({ available }) => {
      if (!cancelled) setFallbackBalance({ accountScope, available });
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [showBilling, accountScope, loading, usage]);
  const balance = usage?.available ?? (fallbackBalance?.accountScope === accountScope ? fallbackBalance.available : null);
  const locale = i18n?.resolvedLanguage ?? i18n?.language;
  const today = new Date().toLocaleDateString('sv-SE');
  const todayTokens = history?.todayKey === today ? history.totals.todayTokens : undefined;
  const tokenCount = typeof todayTokens === 'number' && Number.isFinite(todayTokens) && todayTokens >= 0 ? todayTokens : null;
  const rows: UsageMenuRow[] = [
    {
      tab: 'usage', label: t('settings.tabs.usage'), Icon: ChartColumn,
      caption: `${t('usageHistory.stats.todayTokens')} · ${t('usageHistory.device.self')}`,
      value: tokenCount === null ? null : formatCompactTokens(tokenCount),
      exactValue: tokenCount === null ? undefined : new Intl.NumberFormat(locale).format(tokenCount),
    },
    ...(showBilling ? [{
      tab: 'billing' as const, label: t('settings.tabs.billing'), Icon: CircleDollarSign,
      caption: t('billing.balance.title'),
      value: balance == null ? null : formatBillingAmount(balance, BILLING_CURRENCY, locale),
    }] : []),
  ];

  return rows.map(({ tab, label, Icon, caption, value, exactValue }) => (
    <DropdownMenuItem key={tab} textValue={label} onSelect={() => onSelect(tab)}
      onPointerUp={(event) => event.preventDefault()} className="gap-2 py-2">
      <Icon className="mr-2 h-4 w-4 shrink-0" aria-hidden="true" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="[overflow-wrap:anywhere] leading-tight">{label}</span>
        <span className="[overflow-wrap:anywhere] text-12 leading-tight text-[var(--text-secondary)]">{caption}</span>
      </span>
      <span className="min-w-[5ch] max-w-[50%] shrink-0 [overflow-wrap:anywhere] text-right text-13 font-medium tabular-nums"
        title={exactValue ?? value ?? undefined}>
        {value ?? '—'}
      </span>
    </DropdownMenuItem>
  ));
}
