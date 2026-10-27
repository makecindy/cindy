import { ChevronRight } from 'lucide-react';
import { Collapse } from '@/components/ui/collapse';
import { QuotaHoverCard } from '@/components/status/QuotaHoverCard';
import { CreditPoolRowView } from '@/features/billing/CreditPoolRowView';
import { formatBillingAmount } from '@/features/billing/money';
import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ProviderShareReceived } from '@cindy/device-link';
import { useOptionalAuthUser } from '@/contexts/AuthContext';
import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
} from '@/contexts/dataOwnerGeneration';
import { extractIpcError } from '@/utils/ipcError';
import type {
  ProviderShareInsights,
  ProviderShareQuotaAccount,
  ProviderShareUsageDetails,
} from '../../../shared/providerShareInsights';
import { quotaWindowLabel } from '@/components/status/usageCardModel';
import { ProviderUsageSection } from './ProviderUsageSection';
import { useShareTimeFormat } from './useShareTimeFormat';

/** 可见页面每五秒复核权限；不持久化数据，身份变化、失败与隐藏都丢弃旧结果。 */
export function ProviderShareInsightsSection({ share }: { share: ProviderShareReceived }) {
  useOptionalAuthUser();
  const owner = getDataOwnerGeneration();
  return (
    <InsightsView
      key={JSON.stringify([
        owner,
        share.shareId,
        share.memberId,
        share.status,
        share.hostOnline,
        share.hostCapable,
      ])}
      share={share}
    />
  );
}

function InsightsView({ share }: { share: ProviderShareReceived }) {
  const { t, i18n } = useTranslation();
  const owner = getDataOwnerGeneration();
  const identity = JSON.stringify([
    share.shareId,
    share.memberId,
    share.status,
    share.hostOnline,
    share.hostCapable,
  ]);
  const [result, setResult] = useState<{
    identity: string;
    owner: typeof owner;
    view: ProviderShareInsights | null;
    error: string | null;
  } | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [usageFailed, setUsageFailed] = useState(false);
  const available = share.status === 'active' && share.hostOnline && share.hostCapable;
  const valid = useRef(available);
  const expandedRef = useRef(false);
  const generation = useRef(0);
  useEffect(() => {
    let alive = true;
    let reading = false;
    const clear = (error: string | null) => {
      setResult({ identity, owner, view: null, error });
      expandedRef.current = false;
      setUsageFailed(false);
      setExpanded(false);
    };
    const load = async () => {
      if (
        !alive ||
        !valid.current ||
        reading ||
        !isDataOwnerGenerationCurrent(owner) ||
        document.visibilityState === 'hidden'
      )
        return;
      reading = true;
      const current = ++generation.current;
      try {
        const view = await window.electronAPI.providerShare.command({
          action: 'insights',
          shareId: share.shareId,
          includeUsage: expanded && expandedRef.current,
        });
        if (alive && current === generation.current && isDataOwnerGenerationCurrent(owner)) {
          setResult({ identity, owner, view, error: null });
          if (!view.capabilities.usage) setUsageFailed(false);
          else if (expanded && expandedRef.current)
            setUsageFailed(view.status.usage === 'unavailable');
          if (!view.capabilities.usage || view.status.usage === 'unavailable') {
            expandedRef.current = false;
            setExpanded(false);
          }
        }
      } catch (reason) {
        if (!alive || current !== generation.current || !isDataOwnerGenerationCurrent(owner))
          return;
        const code = extractIpcError(reason)?.code;
        clear(
          code === 'UNSUPPORTED_CAPABILITY'
            ? 'needs-update'
            : code === 'PERMISSION_DENIED' || code === 'REMOTE_AGENT_SHARE_UNAVAILABLE'
              ? 'denied'
              : code === 'DEVICE_LINK_DEVICE_OFFLINE' || code === 'DEVICE_LINK_NOT_CONNECTED'
                ? 'offline'
                : 'unavailable',
        );
      } finally {
        reading = false;
      }
    };
    void load();
    const off = window.electronAPI.providerShare.onReceivedChanged((shares) => {
      const latest = shares.find((item) => item.shareId === share.shareId);
      const next =
        latest &&
        JSON.stringify([
          latest.shareId,
          latest.memberId,
          latest.status,
          latest.hostOnline,
          latest.hostCapable,
        ]);
      if (next !== identity) {
        valid.current = false;
        generation.current++;
        clear('denied');
      } else if (!valid.current) {
        valid.current = available;
        void load();
      }
    });
    const visibility = () => {
      generation.current++;
      clear(null);
      if (document.visibilityState !== 'hidden') void load();
    };
    document.addEventListener('visibilitychange', visibility);
    const timer = window.setInterval(() => {
      void load();
    }, 5_000);
    return () => {
      alive = false;
      generation.current++;
      off();
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [available, expanded, identity, owner, share.shareId]);
  const current =
    result?.identity === identity && isDataOwnerGenerationCurrent(result.owner) ? result : null;
  const view = available ? current?.view : null;
  const error = !available
    ? !share.hostOnline
      ? 'offline'
      : !share.hostCapable
        ? 'needs-update'
        : 'denied'
    : current?.error;
  const stamp = (value: number) =>
    new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }).format(
      value,
    );
  return (
    <section
      className="shrink-0 border-t border-[var(--border-default)] px-5 py-4"
      data-testid="provider-share-insights"
    >
      <h3 className="text-13 font-medium leading-[1.5] text-[var(--text-primary)]">
        {t('providerShare.insights.quotaTitle')}
      </h3>
      <p className="mt-1 text-12 leading-[1.5] text-[var(--text-secondary)]">
        {t('providerShare.insights.quotaNote')}
      </p>
      {error ? (
        <p role="status" className="mt-3 text-12 text-[var(--text-secondary)]">
          {t(`providerShare.insights.${error}`)}
        </p>
      ) : view ? (
        <>
          {view.status.quota !== 'ready' || !view.quota ? (
            <p className="mt-3 text-12 text-[var(--text-secondary)]">
              {t(`providerShare.insights.${view.capabilities.quota ? 'unavailable' : 'notShared'}`)}
            </p>
          ) : (
            <div className="mt-3 space-y-3">
              {view.quota.group && (
                <p className="text-12 leading-[1.5] text-[var(--text-secondary)]">
                  {t('providerShare.insights.groupNote')}
                </p>
              )}
              {view.quota.accounts.map((account, index) => (
                <QuotaAccount
                  key={index}
                  account={account}
                  title={
                    view.quota!.group
                      ? t('providerShare.insights.account', { number: index + 1 })
                      : null
                  }
                  stamp={stamp}
                />
              ))}
              {view.quota.accounts.length === 0 && (
                <p className="text-12 text-[var(--text-secondary)]">
                  {t('providerShare.insights.noOwnAccounts')}
                </p>
              )}
            </div>
          )}
          {view.capabilities.usage ? (
            <SharedUsageDetails
              key={JSON.stringify([share.shareId, share.memberId, owner])}
              providerId={share.providerId}
              usage={expanded ? view.usage : null}
              failed={usageFailed}
              expanded={expanded}
              onExpandedChange={(next) => {
                generation.current++;
                expandedRef.current = next;
                if (next) setUsageFailed(false);
                setExpanded(next);
                // 收起即丢弃明细；保留额度，切换查询范围不闪空整个卡片。
                if (!next)
                  setResult((previous) =>
                    previous?.view
                      ? {
                          ...previous,
                          view: {
                            ...previous.view,
                            usage: null,
                            status: { ...previous.view.status, usage: 'not-requested' },
                          },
                        }
                      : previous,
                  );
              }}
            />
          ) : (
            <p className="mt-6 text-12 leading-[1.5] text-[var(--text-secondary)]">
              {t(
                view.capabilities.usage
                  ? 'providerShare.insights.usageUnavailable'
                  : 'providerShare.insights.usageNotShared',
              )}
            </p>
          )}
        </>
      ) : null}
    </section>
  );
}

function SharedUsageDetails({
  providerId,
  usage,
  failed,
  expanded,
  onExpandedChange,
}: {
  providerId: string;
  usage: ProviderShareUsageDetails | null;
  failed: boolean;
  expanded: boolean;
  onExpandedChange(value: boolean): void;
}) {
  const { t } = useTranslation();
  const time = useShareTimeFormat();
  const id = useId();
  return (
    <div className="mt-4 border-t border-[var(--border-default)] pt-2">
      <button
        type="button"
        id={`${id}-trigger`}
        aria-expanded={expanded}
        aria-controls={`${id}-content`}
        onClick={() => onExpandedChange(!expanded)}
        className="flex min-h-9 w-full items-center gap-1.5 text-left text-13 font-medium text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)]"
      >
        <ChevronRight
          className={`h-3.5 w-3.5 shrink-0 ${expanded ? 'rotate-90' : ''}`}
          aria-hidden="true"
        />
        {t('providerShare.insights.usageTitle')}
      </button>
      {failed && (
        <p role="status" className="mt-2 text-12 text-[var(--text-secondary)]">
          {t('providerShare.insights.usageUnavailable')}
        </p>
      )}
      <Collapse
        open={expanded}
        id={`${id}-content`}
        role="region"
        aria-labelledby={`${id}-trigger`}
      >
        <p className="mt-2 text-12 leading-[1.5] text-[var(--text-secondary)]">
          {t('providerShare.insights.usageNote')}
        </p>
        {usage?.parties.some((party) => party.isRelay) && (
          <p className="mt-1 text-12 leading-[1.5] text-[var(--text-secondary)]">
            {t('providerShare.insights.relayNote')}
          </p>
        )}
        {!usage ? (
          <p role="status" className="mt-2 text-12 text-[var(--text-tertiary)]">
            {t('providerShare.manage.loading')}
          </p>
        ) : (
          <ProviderUsageSection
            providerId={providerId}
            sharedUsage={usage}
            history={null}
            status="ready"
            legacyOwn={null}
            members={[]}
            selfDeviceName={null}
            groupConfig={null}
            time={time}
          />
        )}
      </Collapse>
    </div>
  );
}

function QuotaAccount({
  account,
  title,
  stamp,
}: {
  account: ProviderShareQuotaAccount;
  title: string | null;
  stamp(value: number): string;
}) {
  const { t, i18n } = useTranslation();
  const money = (value: number, currency: string) =>
    formatBillingAmount(String(value), currency, i18n.resolvedLanguage ?? i18n.language);
  const balance = account.balance;
  const balanceRow = (label: string, remaining: number, total: number | null) => {
    const percent =
      total === null || total < 0 || remaining < 0
        ? null
        : total === 0
          ? remaining === 0
            ? 0
            : null
          : Math.min(100, (remaining / total) * 100);
    return (
      <CreditPoolRowView
        key={label}
        label={label}
        remaining={money(remaining, balance!.currency)}
        percent={percent}
        progressLayout="full-width"
        detail={
          total === null
            ? t('billing.usage.historyUnavailable')
            : t('billing.usage.poolDetail', {
                used: money(Math.max(0, total - remaining), balance!.currency),
                total: money(total, balance!.currency),
              })
        }
      />
    );
  };
  return (
    <div className="overflow-hidden rounded-xl border border-[var(--settings-theme-card-border)] bg-[var(--settings-theme-card-bg)]">
      {title && (
        <h4 className="px-5 pt-3 text-13 font-medium text-[var(--text-primary)]">{title}</h4>
      )}
      {account.state !== 'ready' ? (
        <p className="px-5 py-3 text-12 text-[var(--text-secondary)]">
          {t(`providerShare.insights.${account.state}`)}
        </p>
      ) : (
        <>
          {balance && (
            <>
              {balance.pools.length > 0 ? (
                <>
                  <p className="px-5 pt-3 text-20 font-medium leading-[1.3] tracking-[-0.02em] tabular-nums text-[var(--text-primary)]">
                    {money(balance.remaining, balance.currency)}
                  </p>
                  {balance.pools.map((pool) =>
                    balanceRow(t(`billing.balance.${pool.kind}`), pool.remaining, pool.total),
                  )}
                </>
              ) : (
                balanceRow(t('billing.balance.title'), balance.remaining, balance.total)
              )}
              {balance.resetsAt !== null && (
                <p className="px-5 pb-2 text-12 text-[var(--text-secondary)]">
                  {t('providerShare.insights.resets', { time: stamp(balance.resetsAt) })}
                </p>
              )}
            </>
          )}
          {account.windows.length > 0 && (
            <QuotaHoverCard
              variant="embedded"
              hideIdentity
              account={{
                windows: account.windows.map((window, index) => ({
                  key: String(index),
                  title:
                    window.label ||
                    (window.windowMinutes
                      ? quotaWindowLabel(window.windowMinutes, t)
                      : t(`providerShare.insights.${window.kind}`)),
                  showRemaining: true,
                  window: {
                    utilization: 100 - window.remainingPercent,
                    resetsAt: window.resetsAt === null ? null : window.resetsAt / 1000,
                  },
                })),
              }}
            />
          )}
        </>
      )}
      {account.updatedAt !== null && (
        <p className="px-5 pb-3 text-11 leading-[1.5] text-[var(--text-tertiary)]">
          {t('providerShare.insights.updated', { time: stamp(account.updatedAt) })}
        </p>
      )}
    </div>
  );
}
