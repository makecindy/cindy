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
  type SdkCostPresentation,
} from '../../shared/regionalMoney';
import { useSessionEstimatedValue } from './useSessionEstimatedValue';
import { useSessionSpend } from './useSessionSpend';

export interface SessionUsageMoney {
  actualMoney: RegionalMoney | null;
  estimatedValueMoney: RegionalMoney | null;
  totalMoney: RegionalMoney | null;
}

export function subtractExcludedActualMoney(
  actualMoney: RegionalMoney | null,
  excludedActualMoney: RegionalMoney | null,
): RegionalMoney | null {
  if (!actualMoney || actualMoney.amount <= 0) return null;
  if (!excludedActualMoney || excludedActualMoney.currency !== actualMoney.currency) {
    return actualMoney;
  }
  const amount = Math.max(0, actualMoney.amount - excludedActualMoney.amount);
  return amount > 0 ? { ...actualMoney, amount } : null;
}

export function projectSessionActualMoney(
  actualMoney: RegionalMoney | null,
  excludedActualMoney: RegionalMoney | null,
  authoritative: boolean,
): RegionalMoney | null {
  if (!authoritative) return null;
  return subtractExcludedActualMoney(actualMoney, excludedActualMoney);
}

export function combineSessionUsageMoney(
  actualMoney: RegionalMoney | null,
  estimatedValueMoney: RegionalMoney | null,
): SessionUsageMoney {
  // 历史 turnCostUsd 的真实来源可能是 USD，也可能是曾被误标的 Gateway CNY。
  // 只兼容与当前会话账本同币种的值；无法确定换算关系时直接丢弃，不猜测或强转。
  const preferredCurrency = actualMoney?.currency ?? DEFAULT_USAGE_CURRENCY;
  const compatibleEstimatedValueMoney =
    estimatedValueMoney?.currency === preferredCurrency ? estimatedValueMoney : null;
  const values = [actualMoney, compatibleEstimatedValueMoney].filter(
    (money): money is RegionalMoney => Boolean(money && money.amount > 0),
  );
  return {
    actualMoney,
    estimatedValueMoney: compatibleEstimatedValueMoney,
    totalMoney: values.length > 0 ? addCompatibleRegionalMoney(values, preferredCurrency) : null,
  };
}

export function useSessionUsageMoney(
  sessionId: string | undefined,
  initialMoney: RegionalMoney | null | undefined,
  initialCostUsd: number | null | undefined,
  presentation: SdkCostPresentation = 'regular',
  showSdkEstimate: boolean = presentation === 'estimate',
): SessionUsageMoney {
  const persistedActualMoney = useSessionSpend(sessionId, initialMoney, initialCostUsd);
  const { estimatedValueMoney, excludedActualMoney, authoritative } = useSessionEstimatedValue(
    sessionId,
    Boolean(sessionId),
    presentation,
    showSdkEstimate,
  );
  const actualMoney = projectSessionActualMoney(
    persistedActualMoney,
    excludedActualMoney,
    authoritative,
  );

  return useMemo(
    () => combineSessionUsageMoney(actualMoney, estimatedValueMoney),
    [actualMoney, estimatedValueMoney],
  );
}
