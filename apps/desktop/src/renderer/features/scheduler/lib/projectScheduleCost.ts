import type { ScheduleRunMoney } from '@cindy/maker-scheduler';

import type { RegionalMoney } from '../../../../shared/regionalMoney';

type MoneyLike = Pick<RegionalMoney, 'amount' | 'currency' | 'approximate' | 'kind' | 'estimateReasons'>;

export function subtractSdkEstimatedValue<Money extends MoneyLike>(
  estimatedValueMoney: Money | null | undefined,
  sdkEstimatedValueMoney: Money | null | undefined,
  showSdkEstimate: boolean,
): Money | null {
  if (!estimatedValueMoney) return null;
  if (showSdkEstimate || !sdkEstimatedValueMoney) {
    return estimatedValueMoney;
  }
  if (estimatedValueMoney.currency !== sdkEstimatedValueMoney.currency) {
    return estimatedValueMoney;
  }
  const amount = Math.max(0, estimatedValueMoney.amount - sdkEstimatedValueMoney.amount);
  if (amount <= 0) return null;
  return {
    ...estimatedValueMoney,
    amount,
    estimateReasons: estimatedValueMoney.estimateReasons?.filter(
      (reason) => reason !== 'sdk-estimate',
    ),
  };
}

export function projectScheduleRunSdkEstimate(
  run: {
    estimatedValueMoney?: ScheduleRunMoney;
    sdkEstimatedValueMoney?: ScheduleRunMoney;
  },
  showSdkEstimate: boolean,
): ScheduleRunMoney | null {
  return subtractSdkEstimatedValue(
    run.estimatedValueMoney,
    run.sdkEstimatedValueMoney,
    showSdkEstimate,
  );
}
