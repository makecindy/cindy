import type { TFunction } from 'i18next';

import type { TurnUsageDetails } from '../../shared/turnUsageDetails';
import type { RegionalMoney } from '../../shared/regionalMoney';
import {
  formatCompactTokens,
  formatModelShort,
  formatTurnCostMoney,
  formatTurnCostUsd,
} from '@/lib/usageFormat';

export interface TurnUsageTooltipInput {
  details: TurnUsageDetails;
  t: TFunction;
  money?: RegionalMoney;
  /** 旧消息兼容；新链路使用 money。 */
  costUsd?: number;
  isEstimate?: boolean;
  title?: string;
}

function formatPercent(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) return null;
  const pct = Math.min(100, Math.max(0, value * 100));
  if (Math.abs(pct - Math.round(pct)) < 0.05) return `${Math.round(pct)}%`;
  return `${pct.toFixed(1).replace(/\.0$/, '')}%`;
}

function formatTokens(value: number): string {
  return formatCompactTokens(Math.max(0, Math.floor(value)));
}

export function formatOutputTokenRate(details: TurnUsageDetails): string | null {
  const durationMs = details.durationMs;
  if (
    details.outputTokens <= 0 ||
    typeof durationMs !== 'number' ||
    !Number.isFinite(durationMs) ||
    durationMs <= 0
  ) {
    return null;
  }
  const rate = (details.outputTokens * 1000) / durationMs;
  if (!Number.isFinite(rate) || rate <= 0) return null;
  if (rate < 0.1) return '<0.1';
  return rate >= 100 ? rate.toFixed(0) : rate.toFixed(1).replace(/\.0$/, '');
}

export function formatTurnDuration(durationMs: number, t?: TFunction): string | null {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return null;
  const seconds = durationMs / 1000;
  if (seconds < 60) {
    const precision = seconds >= 10 ? 1 : 2;
    const rounded = Number(seconds.toFixed(precision));
    if (rounded < 60) {
      return t
        ? t('usageDetails.durationSeconds', { value: String(rounded) })
        : `${rounded}s`;
    }
  }
  const roundedSeconds = Math.round(seconds);
  const minutes = Math.floor(roundedSeconds / 60);
  const remainder = roundedSeconds % 60;
  const paddedSeconds = String(remainder).padStart(2, '0');
  return t
    ? t('usageDetails.durationMinutesSeconds', {
        minutes: String(minutes),
        seconds: paddedSeconds,
      })
    : `${minutes}m ${paddedSeconds}s`;
}

function modelLabel(details: TurnUsageDetails, t: TFunction): string | null {
  if (details.model) return details.model;
  if (details.models && details.models.length === 1) return details.models[0];
  if (details.models && details.models.length > 1) {
    return t('usageDetails.multipleModels', { count: details.models.length });
  }
  return null;
}

// 建议行只在「对用户非常有价值」时出现——即真金白银的浪费且可行动。
// 唯一保留的信号: 大量输入上下文几乎没吃到 prompt cache (通常意味着缓存被
// 打断: 会话中途改上下文 / 重启 / MCP 变更), 用户看到后可以避免重复触发。
// 曾有的 largeTurn (总量大) / outputHeavy (输出多) 已删: 总量大头是缓存读、
// 命中率高时反而是健康状态; 大输出多为用户主动要的产出, 二者均不可行动。
const LOW_CACHE_MIN_INPUT_TOKENS = 50_000;
const LOW_CACHE_MAX_HIT_RATE = 0.2;

export function getTurnUsageSuggestion(details: TurnUsageDetails, t: TFunction): string | null {
  const inputTotal = details.inputTokens + details.cacheReadTokens + details.cacheCreateTokens;
  if (
    inputTotal >= LOW_CACHE_MIN_INPUT_TOKENS &&
    details.cacheHitRate !== null &&
    details.cacheHitRate < LOW_CACHE_MAX_HIT_RATE
  ) {
    return t('usageDetails.suggestion.lowCache');
  }
  return null;
}

export function buildTurnUsageTooltipLines({
  details,
  t,
  money,
  costUsd,
  isEstimate = false,
  title,
}: TurnUsageTooltipInput): string[] {
  const lines: string[] = [];
  if (title) lines.push(title);
  const formattedCost = money && money.amount > 0
    ? formatTurnCostMoney(money)
    : typeof costUsd === 'number' && Number.isFinite(costUsd) && costUsd > 0
      ? formatTurnCostUsd(costUsd)
      : null;
  if (formattedCost) {
    lines.push(t(isEstimate ? 'usageDetails.valueLine' : 'usageDetails.costLine', {
      cost: formattedCost,
    }));
  }
  // 按模型成本明细: 仅在 ≥2 个模型时展开 (单模型已由下方 modelLine 表达)。
  // 让用户一眼看到「主 agent + subagent (如 Task 工具跑的 Haiku) 各花了多少」。
  const perModelCost = details.perModelCost;
  const showBreakdown = Array.isArray(perModelCost) && perModelCost.length >= 2;
  if (showBreakdown) {
    lines.push(t('usageDetails.costBreakdownHeader'));
    for (const m of perModelCost) {
      lines.push(t('usageDetails.modelCostLine', {
        model: formatModelShort(m.model),
        cost: formatTurnCostMoney(m.money),
      }));
    }
  }
  lines.push(t('usageDetails.tokenLine', {
    total: formatTokens(details.totalTokens),
    input: formatTokens(details.inputTokens),
    output: formatTokens(details.outputTokens),
  }));
  const hitRate = formatPercent(details.cacheHitRate);
  lines.push(t(hitRate ? 'usageDetails.cacheLine' : 'usageDetails.cacheLineNoRate', {
    read: formatTokens(details.cacheReadTokens),
    create: formatTokens(details.cacheCreateTokens),
    rate: hitRate ?? '',
  }));
  const outputRate = formatOutputTokenRate(details);
  const turnDuration = typeof details.turnDurationMs === 'number'
    ? formatTurnDuration(details.turnDurationMs, t)
    : null;
  if (outputRate && turnDuration) {
    lines.push(t('usageDetails.performanceLine', {
      rate: outputRate,
      duration: turnDuration,
    }));
  } else if (outputRate) {
    lines.push(t('usageDetails.performanceRateLine', { rate: outputRate }));
  } else if (turnDuration) {
    lines.push(t('usageDetails.timeLine', { duration: turnDuration }));
  }
  // 已展开按模型明细时不再重复笼统的「N 个模型」行。
  if (!showBreakdown) {
    const model = modelLabel(details, t);
    if (model) lines.push(t('usageDetails.modelLine', { model }));
  }
  const suggestionText = getTurnUsageSuggestion(details, t);
  if (suggestionText) {
    lines.push(t('usageDetails.suggestionLine', { suggestion: suggestionText }));
  }
  // 无金额时交代一句,避免「只有 token、没有钱」被读成事实缺失；这一层不猜测具体原因。
  if (!formattedCost) {
    lines.push(t('usageDetails.noBilledCost'));
  }
  return lines;
}
