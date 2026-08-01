/**
 * QuotaHoverCard — Claude 订阅额度的结构化悬浮卡片。
 *
 * 组件只负责展示调用方给出的快照与本轮明细，不读取 store，也不主动获取数据。
 */

import React from 'react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import type {
  ClaudeSubscriptionUsageSnapshot,
  ClaudeUsageWindow,
} from '../../../shared/claudeSubscriptionUsage';
import { QuotaBar, quotaSeverity, type QuotaSeverity } from './QuotaBar';

export interface QuotaHoverCardTurnUsage {
  costText?: string | null;
  totalTokensText?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheLineText?: string | null;
  model?: string | null;
  suggestionText?: string | null;
}

export interface QuotaHoverCardProps {
  snapshot: ClaudeSubscriptionUsageSnapshot | null;
  turnUsage?: QuotaHoverCardTurnUsage | null;
  dashboardLabel?: string | null;
  onOpenDashboard?: () => void;
  nowMs?: number;
}

interface DisplayWindow {
  key: string;
  title: string;
  window: ClaudeUsageWindow;
}

const STALE_AFTER_MS = 5 * 60_000;

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

const QUOTA_SEVERITY_RANK: Record<QuotaSeverity, number> = {
  normal: 0,
  warn: 1,
  crit: 2,
};

/** 只接纳已知服务端级别，未知值不改变本地阈值判定。 */
function serverQuotaSeverity(value: string | null | undefined): QuotaSeverity {
  const normalized = value?.trim().toLowerCase();
  if (normalized === 'warning') return 'warn';
  const parts = normalized?.split(/[^a-z]+/).filter(Boolean) ?? [];
  if (parts.includes('exceeded') || parts.includes('critical')) return 'crit';
  return 'normal';
}

function effectiveQuotaSeverity(window: ClaudeUsageWindow): QuotaSeverity {
  const localSeverity = quotaSeverity(window.utilization);
  const serverSeverity = serverQuotaSeverity(window.severity);
  return QUOTA_SEVERITY_RANK[serverSeverity] > QUOTA_SEVERITY_RANK[localSeverity]
    ? serverSeverity
    : localSeverity;
}

/** 未知套餐保留原始拼写，只补齐首字母大写。 */
function formatPlanType(subscriptionType: string | null | undefined): string | null {
  const trimmed = subscriptionType?.trim();
  if (!trimmed) return null;

  const knownPlans: Record<string, string> = {
    max: 'Max',
    pro: 'Pro',
    team: 'Team',
    enterprise: 'Enterprise',
  };
  return knownPlans[trimmed.toLowerCase()] ?? `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}`;
}

/** reset 时间按本地时区展示：当天仅时分，跨天补月日。 */
function formatResetAt(
  resetsAt: number | null | undefined,
  nowMs: number,
  locale: string | undefined,
): string | null {
  if (typeof resetsAt !== 'number' || !Number.isFinite(resetsAt) || resetsAt <= 0) {
    return null;
  }

  const resetDate = new Date(resetsAt * 1000);
  const nowDate = new Date(nowMs);
  const sameDay = resetDate.getFullYear() === nowDate.getFullYear()
    && resetDate.getMonth() === nowDate.getMonth()
    && resetDate.getDate() === nowDate.getDate();
  const time = new Intl.DateTimeFormat(locale, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(resetDate);

  if (sameDay) return time;
  const monthAndDay = new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
  }).format(resetDate);
  return `${monthAndDay} ${time}`;
}

function CardDivider() {
  return (
    <div
      aria-hidden="true"
      className="mx-4 my-1.5 h-px bg-[var(--quota-card-hairline,var(--border-default,rgba(0,0,0,0.08)))]"
    />
  );
}

function WindowBlock({
  title,
  window,
  nowMs,
  locale,
  t,
}: {
  title: string;
  window: ClaudeUsageWindow;
  nowMs: number;
  locale: string | undefined;
  t: TFunction;
}) {
  const usedPercent = clampPercent(window.utilization);
  const severity = effectiveQuotaSeverity(window);
  const resetAt = formatResetAt(window.resetsAt, nowMs, locale);

  return (
    <section data-testid="quota-window" className="px-4 pb-1 pt-2">
      <div
        data-severity={severity}
        className={cn(
          'mb-2 text-sm font-medium tracking-[-0.005em]',
          severity === 'crit'
            ? 'text-[var(--quota-bar-crit)]'
            : 'text-[var(--quota-card-text,var(--text-primary,#1D1D1F))]',
        )}
      >
        {title}
      </div>
      <QuotaBar usedPercent={window.utilization} severity={severity} />
      <div className="mt-[7px] flex items-baseline justify-between gap-3 tabular-nums">
        <span className="font-medium text-[var(--quota-card-text,var(--text-primary,#1D1D1F))]">
          {t('quotaCard.usedPercent', { percent: Math.round(usedPercent) })}
        </span>
        {resetAt !== null ? (
          <span className="text-xs text-[var(--quota-card-muted,var(--text-secondary,#7D7A76))]">
            {t('quotaCard.resetAt', { at: resetAt })}
          </span>
        ) : null}
      </div>
    </section>
  );
}

function TurnUsageSection({ turnUsage, t }: {
  turnUsage: QuotaHoverCardTurnUsage;
  t: TFunction;
}) {
  const hasTokenBreakdown = turnUsage.inputTokens != null && turnUsage.outputTokens != null;

  return (
    <section data-testid="quota-turn-usage" className="px-4 pb-1 pt-2">
      <div className="flex items-baseline justify-between gap-3 tabular-nums">
        <span className="text-sm font-medium text-[var(--quota-card-text,var(--text-primary,#1D1D1F))]">
          {t('quotaCard.turnCost')}
        </span>
        {turnUsage.costText != null ? (
          <span className="text-right text-sm font-medium text-[var(--quota-card-text,var(--text-primary,#1D1D1F))]">
            {turnUsage.costText}
          </span>
        ) : null}
      </div>

      {turnUsage.totalTokensText != null ? (
        <div className="mt-[5px] flex items-baseline justify-between gap-3 tabular-nums">
          <span className="text-[var(--quota-card-muted,var(--text-secondary,#7D7A76))]">
            {t('quotaCard.tokenLabel')}
          </span>
          <span className="text-right font-medium text-[var(--quota-card-text,var(--text-primary,#1D1D1F))]">
            {turnUsage.totalTokensText}
            {hasTokenBreakdown ? (
              <span className="font-normal text-[var(--quota-card-muted,var(--text-secondary,#7D7A76))]">
                {t('quotaCard.tokenBreakdown', {
                  input: turnUsage.inputTokens,
                  output: turnUsage.outputTokens,
                })}
              </span>
            ) : null}
          </span>
        </div>
      ) : null}

      {turnUsage.cacheLineText != null ? (
        <div className="mt-[5px] flex items-baseline justify-between gap-3 tabular-nums">
          <span className="text-[var(--quota-card-muted,var(--text-secondary,#7D7A76))]">
            {t('quotaCard.cacheLabel')}
          </span>
          <span className="text-right font-medium text-[var(--quota-card-text,var(--text-primary,#1D1D1F))]">
            {turnUsage.cacheLineText}
          </span>
        </div>
      ) : null}

      {turnUsage.model != null ? (
        <div className="mt-[5px] flex items-baseline justify-between gap-3">
          <span className="text-[var(--quota-card-muted,var(--text-secondary,#7D7A76))]">
            {t('quotaCard.modelLabel')}
          </span>
          <span className="min-w-0 break-words text-right font-medium text-[var(--quota-card-text,var(--text-primary,#1D1D1F))]">
            {turnUsage.model}
          </span>
        </div>
      ) : null}

      {turnUsage.suggestionText != null ? (
        <div
          data-testid="quota-suggestion"
          className="mt-2.5 flex items-start gap-[7px] rounded-lg bg-[var(--quota-card-callout-bg,var(--warning-bg-soft,rgba(224,154,47,0.12)))] px-2.5 py-[7px] text-xs text-[var(--quota-card-text,var(--text-primary,#1D1D1F))]"
        >
          <span
            aria-hidden="true"
            className="shrink-0 text-[var(--quota-bar-warn)]"
          >
            ●
          </span>
          <span>{turnUsage.suggestionText}</span>
        </div>
      ) : null}
    </section>
  );
}

/** 按冻结的 v6 信息层级渲染 Claude 额度卡片。 */
export function QuotaHoverCard({
  snapshot,
  turnUsage = null,
  dashboardLabel = null,
  onOpenDashboard,
  nowMs = Date.now(),
}: QuotaHoverCardProps) {
  const { t, i18n } = useTranslation();
  // 测试可只注入 t；运行时再优先跟随应用当前语言格式化日期。
  const locale = i18n?.resolvedLanguage ?? i18n?.language;
  const planLabel = formatPlanType(snapshot?.subscriptionType);

  const windows: DisplayWindow[] = [];
  if (snapshot?.fiveHour) {
    windows.push({
      key: 'five-hour',
      title: t('quotaCard.fiveHourLabel'),
      window: snapshot.fiveHour,
    });
  }
  if (snapshot?.sevenDay) {
    windows.push({
      key: 'seven-day',
      title: t('quotaCard.weeklyLabel'),
      window: snapshot.sevenDay,
    });
  }
  for (const [index, scoped] of (snapshot?.scoped ?? []).entries()) {
    windows.push({
      key: `scoped-${scoped.modelId ?? scoped.modelDisplayName}-${index}`,
      title: t('quotaCard.modelWeeklyLabel', { model: scoped.modelDisplayName }),
      window: scoped,
    });
  }

  const normalizedStatus = snapshot?.rateLimitStatus?.trim().toLowerCase();
  const status = normalizedStatus === 'rejected'
    ? { key: 'quotaCard.limitRejected', tone: 'crit' as const }
    : normalizedStatus === 'allowed_warning'
      ? { key: 'quotaCard.limitWarning', tone: 'warn' as const }
      : null;
  const showExtraUsage = snapshot?.extraUsage?.isEnabled === true;
  const staleMinutes = snapshot
    && typeof snapshot.updatedAt === 'number'
    && Number.isFinite(snapshot.updatedAt)
    && nowMs - snapshot.updatedAt > STALE_AFTER_MS
    ? Math.floor((nowMs - snapshot.updatedAt) / 60_000)
    : null;

  return (
    <div
      data-testid="quota-hover-card"
      className="w-[340px] select-none overflow-hidden rounded-2xl border border-[var(--quota-card-border,var(--border-default,rgba(0,0,0,0.10)))] bg-[var(--quota-card-bg,var(--surface-elevated,#FFFFFF))] pb-2 pt-[6px] text-[13px] leading-5 text-[var(--quota-card-text,var(--text-primary,#1D1D1F))]"
      style={{
        boxShadow: 'var(--quota-card-shadow, var(--shadow-menu, 0 18px 40px rgba(30, 20, 12, 0.14), 0 2px 8px rgba(30, 20, 12, 0.08)))',
      }}
    >
      {snapshot ? (
        <>
          <div className="flex items-center gap-2 px-4 pb-2 pt-3 text-xs text-[var(--quota-card-muted,var(--text-secondary,#7D7A76))]">
            <span className="font-medium">Claude</span>
            {planLabel ? (
              <span
                data-testid="quota-plan-badge"
                className="ml-auto rounded-full border border-[var(--quota-card-hairline,var(--border-default,rgba(0,0,0,0.08)))] px-[7px] py-px text-[11px] font-medium"
              >
                {planLabel}
              </span>
            ) : null}
          </div>

          <CardDivider />

          {windows.length > 0 ? (
            <div>
              {windows.map((displayWindow) => (
                <WindowBlock
                  key={displayWindow.key}
                  title={displayWindow.title}
                  window={displayWindow.window}
                  nowMs={nowMs}
                  locale={locale}
                  t={t}
                />
              ))}
            </div>
          ) : (
            <div className="px-4 py-2 text-[var(--quota-card-muted,var(--text-secondary,#7D7A76))]">
              {t('quotaCard.noWindows')}
            </div>
          )}

          {status ? (
            <>
              <CardDivider />
              <div
                data-testid="quota-status"
                className={cn(
                  'px-4 py-2 font-medium',
                  status.tone === 'crit'
                    ? 'text-[var(--quota-bar-crit)]'
                    : 'text-[var(--quota-bar-warn)]',
                )}
              >
                {t(status.key)}
              </div>
            </>
          ) : null}

          {showExtraUsage ? (
            <>
              <CardDivider />
              <div className="px-4 py-2 text-[var(--quota-card-muted,var(--text-secondary,#7D7A76))]">
                {t('quotaCard.extraUsageEnabled')}
              </div>
            </>
          ) : null}
        </>
      ) : (
        <div className="px-4 py-2 text-[var(--quota-card-muted,var(--text-secondary,#7D7A76))]">
          {t('quotaCard.waiting')}
        </div>
      )}

      {turnUsage ? (
        <>
          <CardDivider />
          <TurnUsageSection turnUsage={turnUsage} t={t} />
        </>
      ) : null}

      {dashboardLabel ? (
        <>
          <CardDivider />
          <button
            type="button"
            onClick={onOpenDashboard}
            className="mx-2 mt-0.5 flex w-[calc(100%_-_16px)] items-center gap-[9px] rounded-lg px-2 py-[7px] text-left font-medium transition-colors hover:bg-[var(--quota-card-hover-bg,var(--surface-hover,rgba(0,0,0,0.05)))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring,#417CDD)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--quota-card-bg,var(--surface-elevated,#FFFFFF))] active:scale-[0.98]"
          >
            <svg
              aria-hidden="true"
              width="14"
              height="14"
              viewBox="0 0 14 14"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              className="shrink-0 opacity-75"
            >
              <path d="M2 12V7M7 12V2M12 12V5" />
            </svg>
            <span>{dashboardLabel}</span>
          </button>
        </>
      ) : null}

      {staleMinutes !== null ? (
        <>
          <CardDivider />
          <div className="px-4 py-1.5 text-xs tabular-nums text-[var(--quota-card-muted,var(--text-secondary,#7D7A76))]">
            {t('quotaCard.staleData', { minutes: staleMinutes })}
          </div>
        </>
      ) : null}
    </div>
  );
}
