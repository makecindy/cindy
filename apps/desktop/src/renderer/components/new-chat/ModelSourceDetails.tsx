import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { ProviderView } from '@cindy/model-providers';
import { matchCodexBucketForModel } from '@cindy/maker-shared/codex-usage-buckets';
import {
  FIVE_HOUR_WINDOW_MINUTES,
  formatCompactTimeUntilReset,
  WEEKLY_WINDOW_MINUTES,
} from '@/lib/compactQuotaCountdown';
import {
  formatClaudeSubscriptionPlanLabel,
  formatCodexPlanLabel,
} from '@/lib/subscriptionPlanLabel';
import { matchScopedWindowForModel } from '../../../shared/claudeSubscriptionUsage';
import { isXaiWeeklyUsageCurrent } from '../../../shared/xaiSubscriptionUsage';
import { CHATGPT_MODEL_PREFIX } from '../../../shared/subscriptionModels';
import { RESET_PENDING_MAX_MS } from '../status/quotaResetRollup';
import {
  providerWeeklyQuotaSource,
  useProviderUsageSnapshots,
  type ProviderUsageScope,
  type ProviderUsageSnapshots,
} from './useProviderWeeklyQuota';

type SourceUsage = ProviderUsageSnapshots & {
  source: NonNullable<ProviderUsageSnapshots['source']>;
};
const UsageContext = createContext<ReadonlyMap<string, SourceUsage>>(new Map());
const ClockContext = createContext(0);

/** One reader per connection, shared by all model/favorite/sizing rows. Existing
 * account-scoped hooks own fetching and invalidation; this context only composes views. */
function SourceUsageProvider({
  provider,
  scope,
  children,
}: {
  provider: ProviderView;
  scope: ProviderUsageScope;
  children: ReactNode;
}) {
  const parent = useContext(UsageContext);
  const { source, codex, claude, xai } = useProviderUsageSnapshots(provider, scope, { web: true });
  const value = useMemo(() => {
    if (!source) return parent;
    const next = new Map(parent);
    next.set(provider.id, { source, codex, claude, xai });
    return next;
  }, [parent, provider.id, source, codex, claude, xai]);
  return <UsageContext.Provider value={value}>{children}</UsageContext.Provider>;
}

export function ModelSourceUsageProvider({
  providers,
  scope,
  children,
}: {
  providers: readonly ProviderView[];
  /** null: this directory may not show any account's usage. */
  scope: ProviderUsageScope | null;
  children: ReactNode;
}) {
  const [nowMs, setNowMs] = useState(Date.now);
  const enabled = scope !== null;
  const deviceId = scope?.deviceId ?? null;
  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [enabled]);
  // Readers follow the directory's owner: remote directories read the device's mirrors,
  // never this desktop's accounts, even for matching IDs.
  const content = enabled
    ? providers.reduce<ReactNode>((content, provider) => {
        if (provider.auth?.method !== 'oauth') return content;
        const source = providerWeeklyQuotaSource(provider);
        if (!source || provider.subscriptionAccount?.reconnectRequired) return content;
        return (
          <SourceUsageProvider
            key={`${deviceId ?? ''}:${provider.id}`}
            provider={provider}
            scope={{ deviceId }}
          >
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
  windowMinutes?: number | null;
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
      ? data?.web
      : matchCodexBucketForModel(data?.buckets, modelId, nowMs);
    return {
      plan: formatCodexPlanLabel(
        modelId.startsWith(CHATGPT_MODEL_PREFIX)
          ? bucket?.planType
          : (bucket?.planType ?? data?.planType),
      ),
      windows: [bucket?.primary, bucket?.secondary].filter((w): w is NonNullable<typeof w> => !!w),
    };
  }
  if (usage.source === 'claude') {
    const data = usage.claude;
    const weekly = data && (matchScopedWindowForModel(data.scoped, modelId) ?? data.sevenDay);
    return {
      plan: formatClaudeSubscriptionPlanLabel(data?.subscriptionType),
      windows: [
        data?.fiveHour && { window: data.fiveHour, windowMinutes: FIVE_HOUR_WINDOW_MINUTES },
        weekly && { window: weekly, windowMinutes: WEEKLY_WINDOW_MINUTES },
      ]
        .filter((w): w is NonNullable<typeof w> => !!w)
        .map(({ window, windowMinutes }) => ({
          usedPercent: window.utilization,
          resetsAt: window.resetsAt,
          windowMinutes,
        })),
    };
  }
  const data = usage.xai;
  // xAI resetsAt may fall back to a non-weekly period end, so it is not capped.
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
      const countdown = formatCompactTimeUntilReset(
        window.resetsAt,
        nowMs,
        t,
        window.windowMinutes,
      );
      // Do not present the previous period's percentage as a fresh quota.
      const expired =
        typeof window.resetsAt === 'number' &&
        window.resetsAt > 0 &&
        window.resetsAt * 1000 <= nowMs;
      const pending = expired && nowMs - window.resetsAt! * 1000 < RESET_PENDING_MAX_MS;
      const remaining = Math.round(100 - Math.max(0, Math.min(100, window.usedPercent)));
      return {
        countdown: pending ? t('quotaCard.resetPending') : (countdown ?? '—'),
        percentage: expired ? null : `${remaining}%`,
        title: expired
          ? pending
            ? t('quotaCard.resetPending')
            : '—'
          : [countdown, t('quotaCard.remainingPercent', { percent: remaining })]
              .filter(Boolean)
              .join(' · '),
        // Expired windows rank below every live one, even a live window at 0% used.
        used: expired ? -1 : window.usedPercent,
      };
    });
  // The row only has room for one window: show the tightest live one (later window wins
  // ties); the title keeps every window.
  const tightest = parts.reduce<(typeof parts)[number] | undefined>(
    (best, part) => (!best || part.used >= best.used ? part : best),
    undefined,
  );
  const source = [label, plan].filter(Boolean).join(' · ');
  return (
    <div
      data-model-source-details
      title={[source, ...parts.map((part) => part.title)].join(' · ')}
      className="flex w-0 min-w-full items-center gap-1 whitespace-nowrap pl-[26px] pt-px text-12 font-normal leading-[1.4] text-[var(--text-secondary)]"
    >
      <span className="min-w-0 truncate">{source}</span>
      {tightest && (
        <span aria-hidden className="shrink-0">
          ·
        </span>
      )}
      {tightest && (
        <span className="min-w-0 max-w-[70%] truncate tabular-nums">
          <span>
            {tightest.countdown}
            {tightest.percentage !== null && (
              <>
                {' '}
                <span
                  className={
                    tightest.used >= 90
                      ? 'text-[var(--quota-bar-crit)]'
                      : tightest.used > 70
                        ? 'text-[var(--quota-bar-warn)]'
                        : undefined
                  }
                >
                  {tightest.percentage}
                </span>
              </>
            )}
          </span>
        </span>
      )}
    </div>
  );
}
