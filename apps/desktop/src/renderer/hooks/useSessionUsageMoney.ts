/**
 * 会话金额的统一展示投影。
 *
 * actual-cost 由 sessions 账本持有，value-estimate 由消息明细重建。二者是不同
 * 的事实源，但“本对话”展示需要稳定地汇总两者，不能由当前模型/provider 决定
 * 只读取其中一条链路。
 */

import { useMemo } from 'react';

import {
  addCompatibleRegionalMoney,
  DEFAULT_USAGE_CURRENCY,
  type RegionalMoney,
} from '../../shared/regionalMoney';
import { useSessionEstimatedValue } from './useSessionEstimatedValue';
import { useSessionSpend } from './useSessionSpend';

export interface SessionUsageMoney {
  actualMoney: RegionalMoney | null;
  estimatedValueMoney: RegionalMoney | null;
  totalMoney: RegionalMoney | null;
}

export function combineSessionUsageMoney(
  actualMoney: RegionalMoney | null,
  estimatedValueMoney: RegionalMoney | null,
): SessionUsageMoney {
  // 旧 turnCostUsd 没有可靠币种，继续沿用原有兼容边界；仅结构化估值可独立展示。
  const legacyCurrency = actualMoney?.currency ?? DEFAULT_USAGE_CURRENCY;
  const displayedEstimate =
    estimatedValueMoney?.estimateReasons?.includes('legacy-usd') &&
    estimatedValueMoney.currency !== legacyCurrency
      ? null
      : estimatedValueMoney;
  // 零费用只是占位，不能用它的区域币种过滤实际存在的订阅估值。
  // 异币种保留各自金额供 UI 分别展示，不换算、不伪造合计。
  const values = [actualMoney, displayedEstimate].filter((money): money is RegionalMoney =>
    Boolean(money && money.amount > 0),
  );
  const currency = values[0]?.currency;
  return {
    actualMoney,
    estimatedValueMoney: displayedEstimate,
    totalMoney:
      currency && values.every((money) => money.currency === currency)
        ? addCompatibleRegionalMoney(values, currency)
        : null,
  };
}

export function useSessionUsageMoney(
  sessionId: string | undefined,
  initialMoney: RegionalMoney | null | undefined,
  initialCostUsd: number | null | undefined,
): SessionUsageMoney {
  const actualMoney = useSessionSpend(sessionId, initialMoney, initialCostUsd);
  const estimatedValueMoney = useSessionEstimatedValue(sessionId, Boolean(sessionId));

  return useMemo(
    () => combineSessionUsageMoney(actualMoney, estimatedValueMoney),
    [actualMoney, estimatedValueMoney],
  );
}
