/**
 * QuotaHoverCard — 所有渠道共用的用量卡片。
 *
 * 组件只负责展示调用方给出的快照与本轮明细，不读取 store，也不主动获取数据。
 */

import React from 'react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';

import { computeQuotaPace, type QuotaPace } from '@/lib/quotaPace';
import { cn } from '@/lib/utils';
import { formatQuotaResetAt, type UsageCardAccount, type UsageCardWindow } from './usageCardModel';
import { QuotaBar, quotaSeverity, type QuotaSeverity } from './QuotaBar';

export interface QuotaHoverCardTurnUsage {
  costText?: string | null;
  costIsEstimate?: boolean;
  isUserTurnTotal?: boolean;
  totalTokensText?: string | null;
  inputTokensText?: string | null;
  outputTokensText?: string | null;
  outputRateText?: string | null;
  turnDurationText?: string | null;
  cacheLineText?: string | null;
  model?: string | null;
  perModelCost?: ReadonlyArray<{
    model: string;
    costText: string;
  }> | null;
  suggestionText?: string | null;
}

export interface QuotaHoverCardSessionUsage {
  costText?: string | null;
  tokensText?: string | null;
  costIsEstimate?: boolean;
  actualCostText?: string | null;
  estimatedValueText?: string | null;
}

export interface QuotaHoverCardProps {
  account: UsageCardAccount;
  sessionUsage?: QuotaHoverCardSessionUsage | null;
  turnUsage?: QuotaHoverCardTurnUsage | null;
  dashboardLabel?: string | null;
  onOpenDashboard?: () => void;
  dashboardButtonRef?: React.Ref<HTMLButtonElement>;
  nowMs?: number;
}

const STALE_AFTER_MS = 5 * 60_000;
/** 产品定档：±5 个百分点内视为正常节奏。 */
const PACE_TREND_DELTA_PERCENT = 5;

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
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

function effectiveQuotaSeverity(window: UsageCardWindow['window']): QuotaSeverity {
  const localSeverity = quotaSeverity(window.utilization);
  const serverSeverity = serverQuotaSeverity(window.severity);
  return QUOTA_SEVERITY_RANK[serverSeverity] > QUOTA_SEVERITY_RANK[localSeverity]
    ? serverSeverity
    : localSeverity;
}

function CardDivider() {
  return <div aria-hidden="true" className="mx-4 my-1.5 h-px bg-[var(--border-default)]" />;
}

/** 将 pace 偏差映射成不承诺精确耗尽时间的粗略趋势。 */
function formatPaceLine(pace: QuotaPace, t: TFunction): string {
  const { deltaPercent } = pace;
  if (deltaPercent > PACE_TREND_DELTA_PERCENT) {
    return t('quotaCard.paceTrendFast');
  }
  if (deltaPercent < -PACE_TREND_DELTA_PERCENT) {
    return t('quotaCard.paceTrendSlow');
  }
  return t('quotaCard.paceTrendNormal');
}

function WindowBlock({
  title,
  window,
  paceWindowMinutes,
  detail,
  breakdown,
  nowMs,
  paceNowMs,
  locale,
  t,
}: {
  title: string;
  window: UsageCardWindow['window'];
  paceWindowMinutes?: number;
  detail?: string;
  breakdown?: UsageCardWindow['breakdown'];
  nowMs: number;
  paceNowMs: number | null;
  locale: string | undefined;
  t: TFunction;
}) {
  const titleId = React.useId();
  const usedPercent = clampPercent(window.utilization);
  const severity = effectiveQuotaSeverity(window);
  const severityAnnouncement =
    severity === 'crit'
      ? t('quotaCard.usageCritical')
      : severity === 'warn'
        ? t('quotaCard.usageWarning')
        : null;
  const resetAt = formatQuotaResetAt(window.resetsAt, nowMs, locale);
  // 窗口已过重置点，旧观测的节奏失真，待新快照。
  const resetPassed =
    typeof window.resetsAt === 'number' &&
    Number.isFinite(window.resetsAt) &&
    nowMs > window.resetsAt * 1000;
  const pace =
    paceWindowMinutes === undefined || paceNowMs === null || resetPassed
      ? null
      : computeQuotaPace({
          utilization: window.utilization,
          resetsAt: window.resetsAt,
          windowMinutes: paceWindowMinutes,
          nowMs: paceNowMs,
        });
  const paceLine = pace === null ? null : formatPaceLine(pace, t);

  return (
    <section data-testid="quota-window" className="px-4 pb-1 pt-2">
      <div
        id={titleId}
        data-severity={severity}
        className={cn(
          'mb-2 text-14 font-medium tracking-[-0.005em]',
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
          <span className="text-12 text-[var(--text-secondary)]">
            {t('quotaCard.resetAt', { at: resetAt })}
          </span>
        ) : null}
      </div>
      {detail ? <div className="mt-1 text-12 text-[var(--text-secondary)]">{detail}</div> : null}
      {breakdown?.length ? (
        <dl
          data-testid="quota-window-breakdown"
          className="mt-2 space-y-1 text-12 text-[var(--text-secondary)]"
        >
          {breakdown.map(({ label, value }, index) => (
            <div key={index} className="flex items-baseline justify-between gap-3">
              <dt className="min-w-0 break-words">{label}</dt>
              <dd className="shrink-0 tabular-nums">{value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {paceLine !== null ? (
        <div
          data-testid="quota-pace"
          className="mt-[3px] text-12 tabular-nums text-[var(--text-secondary)]"
        >
          {paceLine}
        </div>
      ) : null}
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
    <div
      className={
        costText != null
          ? 'text-14 font-medium text-[var(--text-primary)]'
          : 'text-12 text-[var(--text-secondary)]'
      }
    >
      {costText != null
        ? t(isEstimate ? 'quotaCard.valueLine' : 'quotaCard.costLine', { cost: costText })
        : t(unavailableKey)}
    </div>
  );

  return (
    <section data-testid="quota-turn-usage" className="px-4 pb-1 pt-2">
      {turnUsage.isUserTurnTotal ? (
        <div className="mb-[3px] text-12 font-medium text-[var(--text-secondary)]">
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

      {showModelCostBreakdown ? (
        <div data-testid="quota-model-cost-breakdown" className="mt-2">
          <div className="mb-[3px] text-12 font-medium text-[var(--text-secondary)]">
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
          <span className="min-w-0 break-words text-right font-medium text-[var(--text-primary)]">
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
          <span className="min-w-0 break-words text-right font-medium text-[var(--text-primary)]">
            {turnUsage.cacheLineText}
          </span>
        </div>
      ) : null}

      {turnUsage.turnDurationText != null || turnUsage.outputRateText != null ? (
        <dl data-testid="quota-performance" className="mt-[5px] space-y-[5px] tabular-nums">
          {turnUsage.turnDurationText != null ? (
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-[var(--text-secondary)]">{t('quotaCard.timeLabel')}</dt>
              <dd className="min-w-0 break-words text-right font-medium text-[var(--text-primary)]">
                {turnUsage.turnDurationText}
              </dd>
            </div>
          ) : null}
          {turnUsage.outputRateText != null ? (
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-[var(--text-secondary)]">{t('quotaCard.speedLabel')}</dt>
              <dd className="min-w-0 break-words text-right font-medium text-[var(--text-primary)]">
                {t('quotaCard.rateValue', { rate: turnUsage.outputRateText })}
              </dd>
            </div>
          ) : null}
        </dl>
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
          className="mt-2.5 flex items-start gap-[7px] rounded-lg bg-[var(--warning-bg-soft)] px-2.5 py-[7px] text-12 text-[var(--text-primary)]"
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
      {sessionUsage.costText ? (
        <div className="text-14 font-medium text-[var(--text-primary)]">
          {t(totalKey, { cost: sessionUsage.costText })}
        </div>
      ) : null}
      {sessionUsage.tokensText ? (
        <div
          className={
            sessionUsage.costText
              ? 'mt-1 text-12 text-[var(--text-secondary)]'
              : 'text-14 font-medium text-[var(--text-primary)]'
          }
        >
          {t('todaySpend.codex.sessionTokensLine', { tokens: sessionUsage.tokensText })}
        </div>
      ) : null}
      {hasMixedBreakdown ? (
        <div className="mt-1 space-y-0.5 text-12 text-[var(--text-secondary)]">
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

/** 套餐、配额、任务合计与本轮明细按同一信息层级渲染；供应商差异只来自 account。 */
export function QuotaHoverCard({
  account,
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
  const { title, planLabel, windows, details = [], notices = [], emptyText, updatedAt } = account;
  // Use observation time for pace so a stale snapshot cannot drift as the card renders.
  const paceNowMs = typeof updatedAt === 'number' && Number.isFinite(updatedAt) ? updatedAt : null;
  const staleMinutes =
    paceNowMs !== null && nowMs - paceNowMs > STALE_AFTER_MS
      ? Math.floor((nowMs - paceNowMs) / 60_000)
      : null;

  return (
    <div
      data-testid="quota-hover-card"
      className="flex max-h-[min(calc(100vh-16px),var(--radix-popover-content-available-height,100vh))] w-[340px] max-w-[calc(100vw-16px)] select-none flex-col overflow-hidden rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] pb-2 text-13 leading-5 text-[var(--text-primary)]"
      style={{ boxShadow: 'var(--shadow-menu)' }}
    >
      <div
        data-testid="quota-hover-card-scroll-content"
        role="region"
        aria-label={t('quotaCard.windowsRegionLabel')}
        tabIndex={0}
        className="min-h-0 overflow-y-auto pt-[6px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)]"
      >
        {title ? (
          <>
            <div className="flex items-center gap-2 px-4 pb-2 pt-3 text-12 text-[var(--text-secondary)]">
              <span className="min-w-0 break-words font-medium">{title}</span>
              {planLabel ? (
                <span
                  data-testid="quota-plan-badge"
                  className="ml-auto max-w-[65%] break-words rounded-full border border-[var(--border-default)] px-[7px] py-px text-11 font-medium"
                >
                  {planLabel}
                </span>
              ) : null}
            </div>
          </>
        ) : null}
        {title && (windows.length > 0 || emptyText) ? <CardDivider /> : null}
        {windows.map(({ key, ...displayWindow }) => (
          <WindowBlock
            key={key}
            {...displayWindow}
            nowMs={nowMs}
            paceNowMs={paceNowMs}
            locale={locale}
            t={t}
          />
        ))}
        {emptyText ? (
          <div className="px-4 py-2 text-[var(--text-secondary)]">{emptyText}</div>
        ) : null}
        {notices.map((notice, index) => (
          <React.Fragment key={index}>
            <CardDivider />
            <div
              data-testid="quota-status"
              className={cn(
                'px-4 py-2 font-medium',
                notice.tone === 'crit'
                  ? 'text-[var(--quota-bar-crit)]'
                  : 'text-[var(--quota-bar-warn)]',
              )}
            >
              {notice.text}
            </div>
          </React.Fragment>
        ))}
        {details.length ? (
          <>
            <CardDivider />
            <section className="space-y-1 px-4 py-2 text-12 tabular-nums text-[var(--text-secondary)]">
              {details.map((detail, index) => (
                <div key={index}>{detail}</div>
              ))}
            </section>
          </>
        ) : null}

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
            className="mx-2 mt-0.5 flex w-[calc(100%_-_16px)] items-center gap-[9px] rounded-full px-2 py-[7px] text-left font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface-elevated)] active:scale-[0.98]"
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
          <div className="px-4 py-1.5 text-12 tabular-nums text-[var(--text-secondary)]">
            {t('quotaCard.staleData', { minutes: staleMinutes })}
          </div>
        </>
      ) : null}
    </div>
  );
}
