import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { ProviderView } from '@cindy/model-providers';
import { matchCodexBucketForModel } from '@cindy/maker-shared/codex-usage-buckets';
import { useCodexRateLimits } from '@/hooks/useCodexRateLimits';
import { useAccountUsage } from '@/hooks/useAccountUsage';
import { useClaudeSubscriptionUsage } from '@/hooks/useClaudeSubscriptionUsage';
import { useXaiSubscriptionUsage } from '@/hooks/useXaiSubscriptionUsage';
import { formatCompactTimeUntilReset } from '@/lib/compactQuotaCountdown';
import {
  formatClaudeSubscriptionPlanLabel,
  formatCodexPlanLabel,
} from '@/lib/subscriptionPlanLabel';
import { matchScopedWindowForModel } from '../../../shared/claudeSubscriptionUsage';
import { isXaiWeeklyUsageCurrent } from '../../../shared/xaiSubscriptionUsage';
import { CHATGPT_MODEL_PREFIX } from '../../../shared/subscriptionModels';
import { providerWeeklyQuotaSource } from './useProviderWeeklyQuota';

interface SourceUsage {
  source: 'codex' | 'claude' | 'xai';
  codex: ReturnType<typeof useCodexRateLimits>['snapshot'];
  web: ReturnType<typeof useAccountUsage>;
  claude: ReturnType<typeof useClaudeSubscriptionUsage>;
  xai: ReturnType<typeof useXaiSubscriptionUsage>;
}
const UsageContext = createContext<ReadonlyMap<string, SourceUsage>>(new Map());
const ClockContext = createContext(0);

/** One reader per connection, shared by all model/favorite/sizing rows. Existing
 * account-scoped hooks own fetching and invalidation; this context only composes views. */
function SourceUsageProvider({
  provider,
  source,
  children,
}: {
  provider: ProviderView;
  source: SourceUsage['source'];
  children: ReactNode;
}) {
  const parent = useContext(UsageContext);
  const { snapshot: codex } = useCodexRateLimits(source === 'codex', provider.id);
  const web = useAccountUsage(
    undefined,
    source === 'codex' ? 'codex' : undefined,
    'openai-web',
    undefined,
    provider.id,
  );
  const claude = useClaudeSubscriptionUsage(source === 'claude', provider.id);
  const xai = useXaiSubscriptionUsage(source === 'xai', provider.id);
  const value = useMemo(() => {
    const next = new Map(parent);
    next.set(provider.id, { source, codex, web, claude, xai });
    return next;
  }, [parent, provider.id, source, codex, web, claude, xai]);
  return <UsageContext.Provider value={value}>{children}</UsageContext.Provider>;
}

export function ModelSourceUsageProvider({
  providers,
  enabled,
  children,
}: {
  providers: readonly ProviderView[];
  enabled: boolean;
  children: ReactNode;
}) {
  const [nowMs, setNowMs] = useState(Date.now);
  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [enabled]);
  // Remote directories never mount local account readers, even for matching IDs.
  const content = enabled
    ? providers.reduce<ReactNode>((content, provider) => {
        if (provider.auth?.method !== 'oauth') return content;
        const source = providerWeeklyQuotaSource(provider);
        if (!source || provider.subscriptionAccount?.reconnectRequired) return content;
        return (
          <SourceUsageProvider key={provider.id} provider={provider} source={source}>
            {content}
          </SourceUsageProvider>
        );
      }, children)
    : children;
  return <ClockContext.Provider value={nowMs}>{content}</ClockContext.Provider>;
}

interface QuotaWindow {
  usedPercent: number;
  resetsAt?: number | null;
}

function modelSourceQuota(
  usage: SourceUsage | undefined,
  modelId: string,
  nowMs: number,
): {
  plan: string | null;
  windows: QuotaWindow[];
} {
  if (!usage) return { plan: null, windows: [] };
  if (usage.source === 'codex') {
    const data = usage.codex;
    // ChatGPT bridge and Codex CLI consume different slots; never cross-fallback.
    const bucket = modelId.startsWith(CHATGPT_MODEL_PREFIX)
      ? usage.web
      : data
        ? matchCodexBucketForModel(
            data.rateLimitsByLimitId ?? {
              [data.rateLimits.limitId ?? 'codex']: data.rateLimits,
            },
            modelId,
            nowMs,
          )
        : null;
    return {
      plan: formatCodexPlanLabel(bucket?.planType ?? data?.account.planType),
      windows: [bucket?.primary, bucket?.secondary].filter((w): w is NonNullable<typeof w> => !!w),
    };
  }
  if (usage.source === 'claude') {
    const data = usage.claude;
    const weekly = data && (matchScopedWindowForModel(data.scoped, modelId) ?? data.sevenDay);
    return {
      plan: formatClaudeSubscriptionPlanLabel(data?.subscriptionType),
      windows: [data?.fiveHour, weekly]
        .filter((w): w is NonNullable<typeof w> => !!w)
        .map((w) => ({ usedPercent: w.utilization, resetsAt: w.resetsAt })),
    };
  }
  const data = usage.xai;
  return {
    plan: data?.planLabel ?? null,
    windows:
      data && isXaiWeeklyUsageCurrent(data, nowMs) && typeof data.creditUsagePercent === 'number'
        ? [{ usedPercent: data.creditUsagePercent, resetsAt: data.resetsAt }]
        : [],
  };
}

export function ModelSourceDetails({
  providerId,
  label,
  modelId,
}: {
  providerId: string;
  label: string;
  modelId: string;
}) {
  const { t } = useTranslation();
  const usages = useContext(UsageContext);
  const nowMs = useContext(ClockContext);
  const { plan, windows } = modelSourceQuota(usages.get(providerId), modelId, nowMs);
  const parts = windows
    .filter((window) => Number.isFinite(window.usedPercent))
    .map((window) => {
      const countdown = formatCompactTimeUntilReset(window.resetsAt, nowMs, t);
      // Do not present the previous period's percentage as a fresh quota.
      const pending =
        typeof window.resetsAt === 'number' &&
        window.resetsAt > 0 &&
        window.resetsAt * 1000 <= nowMs;
      const remaining = Math.round(100 - Math.max(0, Math.min(100, window.usedPercent)));
      return {
        text: pending ? t('quotaCard.resetPending') : `${countdown ?? '—'} ${remaining}%`,
        title: pending
          ? t('quotaCard.resetPending')
          : [countdown, t('quotaCard.remainingPercent', { percent: remaining })]
              .filter(Boolean)
              .join(' · '),
        used: pending ? 0 : window.usedPercent,
      };
    });
  const source = [label, plan].filter(Boolean).join(' · ');
  return (
    <div
      data-model-source-details
      title={[source, ...parts.map((part) => part.title)].join(' · ')}
      className="flex w-0 min-w-full items-center gap-1 whitespace-nowrap pl-[26px] pt-px text-12 leading-[1.4] text-[var(--text-secondary)]"
    >
      <span className="min-w-0 truncate">{source}</span>
      {parts.length > 0 && (
        <span aria-hidden className="shrink-0">
          ·
        </span>
      )}
      {parts.length > 0 && (
        <span className="flex shrink-0 items-center gap-1 tabular-nums">
          {parts.map((part, index) => (
            <span key={index} className="inline-flex items-center gap-1">
              {index > 0 && <span aria-hidden>/</span>}
              <span
                className={
                  part.used >= 90
                    ? 'text-[var(--quota-bar-crit)]'
                    : part.used > 70
                      ? 'text-[var(--quota-bar-warn)]'
                      : undefined
                }
              >
                {part.text}
              </span>
            </span>
          ))}
        </span>
      )}
    </div>
  );
}
