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
  costIsEstimate?: boolean;
  isUserTurnTotal?: boolean;
  finalSegment?: {
    costText?: string | null;
    costIsEstimate?: boolean;
  } | null;
  totalTokensText?: string | null;
  inputTokensText?: string | null;
  outputTokensText?: string | null;
  cacheLineText?: string | null;
  model?: string | null;
  perModelCost?: ReadonlyArray<{
    model: string;
    costText: string;
  }> | null;
  suggestionText?: string | null;
}

export interface QuotaHoverCardSessionUsage {
  costText: string;
  costIsEstimate?: boolean;
  actualCostText?: string | null;
  estimatedValueText?: string | null;
}

export interface QuotaHoverCardProps {
  snapshot: ClaudeSubscriptionUsageSnapshot | null;
  sessionUsage?: QuotaHoverCardSessionUsage | null;
  turnUsage?: QuotaHoverCardTurnUsage | null;
  dashboardLabel?: string | null;
  onOpenDashboard?: () => void;
  dashboardButtonRef?: React.Ref<HTMLButtonElement>;
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

/** 旧快照可能绕过类型边界；利用率不是有限数值时整窗不展示。 */
function isDisplayableWindow(value: unknown): value is ClaudeUsageWindow {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const utilization = (value as { utilization?: unknown }).utilization;
  return typeof utilization === 'number' && Number.isFinite(utilization);
}

const QUOTA_SEVERITY_RANK: Record<QuotaSeverity, number> = {
  normal: 0,
  warn: 1,
  crit: 2,
};

/**
 * 非字符串按缺失处理；字符串空值或 normal 才是无告警，未知非空值至少保留为 warn。
 * 这与共享告警谓词“任何非 normal severity 均告警”保持一致，
 * 避免新增的上游级别在卡片里被静默降成正常。
 */
function serverQuotaSeverity(value: unknown): QuotaSeverity {
  if (typeof value !== 'string') return 'normal';
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized === 'normal') return 'normal';
  if (normalized === 'warning') return 'warn';
  const parts = normalized.split(/[^a-z]+/).filter(Boolean);
  if (parts.includes('exceeded') || parts.includes('critical')) return 'crit';
  return 'warn';
}

function effectiveQuotaSeverity(window: ClaudeUsageWindow): QuotaSeverity {
  const localSeverity = quotaSeverity(window.utilization);
  const serverSeverity = serverQuotaSeverity(window.severity);
  return QUOTA_SEVERITY_RANK[serverSeverity] > QUOTA_SEVERITY_RANK[localSeverity]
    ? serverSeverity
    : localSeverity;
}

/** 未知套餐保留原始拼写，只补齐首字母大写；非字符串脏值按缺失处理。 */
function formatPlanType(subscriptionType: unknown): string | null {
  if (typeof subscriptionType !== 'string') return null;
  const trimmed = subscriptionType.trim();
  if (!trimmed) return null;

  const knownPlans: Record<string, string> = {
    max: 'Max',
    pro: 'Pro',
    team: 'Team',
    enterprise: 'Enterprise',
  };
  return (
    knownPlans[trimmed.toLowerCase()] ?? `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}`
  );
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
  const sameDay =
    resetDate.getFullYear() === nowDate.getFullYear() &&
    resetDate.getMonth() === nowDate.getMonth() &&
    resetDate.getDate() === nowDate.getDate();
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
  return <div aria-hidden="true" className="mx-4 my-1.5 h-px bg-[var(--border-default)]" />;
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
  const titleId = React.useId();
  const usedPercent = clampPercent(window.utilization);
  const severity = effectiveQuotaSeverity(window);
  const severityAnnouncement =
    severity === 'crit'
      ? t('quotaCard.limitRejected')
      : severity === 'warn'
        ? t('quotaCard.limitWarning')
        : null;
  const resetAt = formatResetAt(window.resetsAt, nowMs, locale);

  return (
    <section data-testid="quota-window" className="px-4 pb-1 pt-2">
      <div
        id={titleId}
        data-severity={severity}
        className={cn(
          'mb-2 text-sm font-medium tracking-[-0.005em]',
          severity === 'crit' ? 'text-[var(--quota-bar-crit)]' : 'text-[var(--text-primary)]',
        )}
      >
        {title}
        {severityAnnouncement !== null ? (
          // 告警不能只依赖颜色；标题与进度条共用对应级别的屏幕阅读器文案。
          <span className="sr-only">，{severityAnnouncement}</span>
        ) : null}
      </div>
      <QuotaBar usedPercent={window.utilization} severity={severity} aria-labelledby={titleId} />
      <div className="mt-[7px] flex items-baseline justify-between gap-3 tabular-nums">
        <span className="font-medium text-[var(--text-primary)]">
          {t('quotaCard.usedPercent', { percent: Math.round(usedPercent) })}
        </span>
        {resetAt !== null ? (
          <span className="text-xs text-[var(--text-secondary)]">
            {t('quotaCard.resetAt', { at: resetAt })}
          </span>
        ) : null}
      </div>
    </section>
  );
}

function TurnUsageSection({ turnUsage, t }: { turnUsage: QuotaHoverCardTurnUsage; t: TFunction }) {
  const hasTokenBreakdown = turnUsage.inputTokensText != null && turnUsage.outputTokensText != null;
  const showModelCostBreakdown = (turnUsage.perModelCost?.length ?? 0) >= 2;

  const renderCostLine = (
    costText: string | null | undefined,
    isEstimate: boolean | undefined,
    unavailableKey: string,
  ) => (
    <div className="text-sm font-medium text-[var(--text-primary)]">
      {costText != null
        ? t(isEstimate ? 'quotaCard.valueLine' : 'quotaCard.costLine', { cost: costText })
        : t(unavailableKey)}
    </div>
  );

  return (
    <section data-testid="quota-turn-usage" className="px-4 pb-1 pt-2">
      {turnUsage.isUserTurnTotal ? (
        <div className="mb-[3px] text-xs font-medium text-[var(--text-secondary)]">
          {t('quotaCard.latestMessageTitle')}
        </div>
      ) : null}
      <div className="tabular-nums">
        {renderCostLine(
          turnUsage.costText,
          turnUsage.costIsEstimate,
          'quotaCard.turnCostUnavailable',
        )}
      </div>

      {turnUsage.finalSegment ? (
        <div className="mt-2">
          <div className="mb-[3px] text-xs font-medium text-[var(--text-secondary)]">
            {t('chat.messageActionBar.userTurnCostDetailsTitle')}
          </div>
          <div className="tabular-nums">
            {renderCostLine(
              turnUsage.finalSegment.costText,
              turnUsage.finalSegment.costIsEstimate,
              'quotaCard.noBilledCost',
            )}
          </div>
        </div>
      ) : null}

      {showModelCostBreakdown ? (
        <div data-testid="quota-model-cost-breakdown" className="mt-2">
          <div className="mb-[3px] text-xs font-medium text-[var(--text-secondary)]">
            {t('usageDetails.costBreakdownHeader')}
          </div>
          <div className="space-y-0.5 tabular-nums text-[var(--text-primary)]">
            {turnUsage.perModelCost?.map((entry, index) => (
              <div key={`${entry.model}-${index}`}>
                {t('usageDetails.modelCostLine', {
                  model: entry.model,
                  cost: entry.costText,
                })}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {turnUsage.totalTokensText != null ? (
        <div className="mt-[5px] flex items-baseline justify-between gap-3 tabular-nums">
          <span className="text-[var(--text-secondary)]">{t('quotaCard.tokenLabel')}</span>
          <span className="text-right font-medium text-[var(--text-primary)]">
            {turnUsage.totalTokensText}
            {hasTokenBreakdown ? (
              <span className="font-normal text-[var(--text-secondary)]">
                {t('quotaCard.tokenBreakdown', {
                  input: turnUsage.inputTokensText,
                  output: turnUsage.outputTokensText,
                })}
              </span>
            ) : null}
          </span>
        </div>
      ) : null}

      {turnUsage.cacheLineText != null ? (
        <div className="mt-[5px] flex items-baseline justify-between gap-3 tabular-nums">
          <span className="text-[var(--text-secondary)]">{t('quotaCard.cacheLabel')}</span>
          <span className="text-right font-medium text-[var(--text-primary)]">
            {turnUsage.cacheLineText}
          </span>
        </div>
      ) : null}

      {!showModelCostBreakdown && turnUsage.model != null ? (
        <div className="mt-[5px] flex items-baseline justify-between gap-3">
          <span className="text-[var(--text-secondary)]">{t('quotaCard.modelLabel')}</span>
          <span className="min-w-0 break-words text-right font-medium text-[var(--text-primary)]">
            {turnUsage.model}
          </span>
        </div>
      ) : null}

      {turnUsage.suggestionText != null ? (
        <div
          data-testid="quota-suggestion"
          className="mt-2.5 flex items-start gap-[7px] rounded-lg bg-[var(--warning-bg-soft)] px-2.5 py-[7px] text-xs text-[var(--text-primary)]"
        >
          <span aria-hidden="true" className="shrink-0 text-[var(--quota-bar-warn)]">
            ●
          </span>
          <span>{turnUsage.suggestionText}</span>
        </div>
      ) : null}
    </section>
  );
}

/** 会话合计含真实费用与价值估算时，保留两条构成供用户核对。 */
function SessionUsageSection({
  sessionUsage,
  t,
}: {
  sessionUsage: QuotaHoverCardSessionUsage;
  t: TFunction;
}) {
  const hasMixedBreakdown = Boolean(sessionUsage.actualCostText && sessionUsage.estimatedValueText);
  const totalKey = hasMixedBreakdown
    ? 'todaySpend.sessionCostLabel'
    : sessionUsage.costIsEstimate
      ? 'todaySpend.codex.sessionValueLabel'
      : 'todaySpend.tooltip.sessionUsed';

  return (
    <section data-testid="quota-session-usage" className="px-4 pb-1 pt-2 tabular-nums">
      <div className="text-sm font-medium text-[var(--text-primary)]">
        {t(totalKey, { cost: sessionUsage.costText })}
      </div>
      {hasMixedBreakdown ? (
        <div className="mt-1 space-y-0.5 text-xs text-[var(--text-secondary)]">
          <div>{t('todaySpend.tooltip.sessionUsed', { cost: sessionUsage.actualCostText })}</div>
          <div>
            {t('todaySpend.codex.sessionValueLabel', {
              cost: sessionUsage.estimatedValueText,
            })}
          </div>
        </div>
      ) : null}
    </section>
  );
}

/** 按冻结的 v6 信息层级渲染 Claude 额度卡片。 */
export function QuotaHoverCard({
  snapshot,
  sessionUsage = null,
  turnUsage = null,
  dashboardLabel = null,
  onOpenDashboard,
  dashboardButtonRef,
  nowMs = Date.now(),
}: QuotaHoverCardProps) {
  const { t, i18n } = useTranslation();
  // 测试可只注入 t；运行时再优先跟随应用当前语言格式化日期。
  const locale = i18n?.resolvedLanguage ?? i18n?.language;
  const planLabel = formatPlanType(snapshot?.subscriptionType);

  const windows: DisplayWindow[] = [];
  if (isDisplayableWindow(snapshot?.fiveHour)) {
    windows.push({
      key: 'five-hour',
      title: t('quotaCard.fiveHourLabel'),
      window: snapshot.fiveHour,
    });
  }
  if (isDisplayableWindow(snapshot?.sevenDay)) {
    windows.push({
      key: 'seven-day',
      title: t('quotaCard.weeklyLabel'),
      window: snapshot.sevenDay,
    });
  }
  // 持久化旧快照可能把 scoped 写成非数组；脏容器按缺失处理，避免 .entries() 崩溃。
  const scopedWindows = Array.isArray(snapshot?.scoped) ? snapshot.scoped : [];
  for (const [index, scoped] of scopedWindows.entries()) {
    if (!isDisplayableWindow(scoped)) continue;
    windows.push({
      key: `scoped-${scoped.modelId ?? scoped.modelDisplayName}-${index}`,
      title: t('quotaCard.modelWeeklyLabel', { model: scoped.modelDisplayName }),
      window: scoped,
    });
  }

  const rawRateLimitStatus = snapshot?.rateLimitStatus;
  const normalizedStatus =
    typeof rawRateLimitStatus === 'string' ? rawRateLimitStatus.trim().toLowerCase() : undefined;
  const status =
    normalizedStatus === 'rejected'
      ? { key: 'quotaCard.limitRejected', tone: 'crit' as const }
      : normalizedStatus === 'allowed_warning'
        ? { key: 'quotaCard.limitWarning', tone: 'warn' as const }
        : null;
  const showExtraUsage = snapshot?.extraUsage?.isEnabled === true;
  const staleMinutes =
    snapshot &&
    typeof snapshot.updatedAt === 'number' &&
    Number.isFinite(snapshot.updatedAt) &&
    nowMs - snapshot.updatedAt > STALE_AFTER_MS
      ? Math.floor((nowMs - snapshot.updatedAt) / 60_000)
      : null;

  return (
    <div
      data-testid="quota-hover-card"
      className="flex max-h-[calc(100vh-16px)] w-[340px] select-none flex-col overflow-hidden rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] pb-2 text-[13px] leading-5 text-[var(--text-primary)]"
      style={{ boxShadow: 'var(--shadow-menu)' }}
    >
      <div
        data-testid="quota-hover-card-scroll-content"
        role="region"
        aria-label={t('quotaCard.windowsRegionLabel')}
        tabIndex={0}
        className="min-h-0 overflow-y-auto pt-[6px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)]"
      >
        {snapshot ? (
          <>
            <div className="flex items-center gap-2 px-4 pb-2 pt-3 text-xs text-[var(--text-secondary)]">
              <span className="font-medium">Claude</span>
              {planLabel ? (
                <span
                  data-testid="quota-plan-badge"
                  className="ml-auto rounded-full border border-[var(--border-default)] px-[7px] py-px text-[11px] font-medium"
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
              <div className="px-4 py-2 text-[var(--text-secondary)]">
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
                <div className="px-4 py-2 text-[var(--text-secondary)]">
                  {t('quotaCard.extraUsageEnabled')}
                </div>
              </>
            ) : null}
          </>
        ) : (
          <div className="px-4 py-2 text-[var(--text-secondary)]">{t('quotaCard.waiting')}</div>
        )}

        {sessionUsage ? (
          <>
            <CardDivider />
            <SessionUsageSection sessionUsage={sessionUsage} t={t} />
          </>
        ) : null}

        {turnUsage ? (
          <>
            <CardDivider />
            <TurnUsageSection turnUsage={turnUsage} t={t} />
          </>
        ) : null}
      </div>

      {dashboardLabel ? (
        <>
          <CardDivider />
          <button
            ref={dashboardButtonRef}
            type="button"
            onClick={onOpenDashboard}
            className="mx-2 mt-0.5 flex w-[calc(100%_-_16px)] items-center gap-[9px] rounded-full px-2 py-[7px] text-left font-medium transition-colors hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface-elevated)] active:scale-[0.98]"
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
          <div className="px-4 py-1.5 text-xs tabular-nums text-[var(--text-secondary)]">
            {t('quotaCard.staleData', { minutes: staleMinutes })}
          </div>
        </>
      ) : null}
    </div>
  );
}
