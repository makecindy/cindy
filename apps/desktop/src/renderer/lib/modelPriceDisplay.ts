import type { CindyRegion } from '@cindy/maker-shared/brand-identity';
import type { ModelCost } from '@cindy/model-providers';

export const USD_TO_CNY_FIXED_RATE = 6.7;

export interface ModelDisplayPrice {
  currency: 'CNY' | 'USD';
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

function validAmount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * XD Gateway 的数值已经是当前区域价格，只换展示币种；其它来源以 USD 为基准，
 * CN 构建按固定汇率换成人民币，Global 构建保持美元。
 */
export function resolveModelDisplayPrice(args: {
  providerId: string | null | undefined;
  gatewayCost?: ModelCost;
  referenceUsdCost?: ModelCost;
  region: CindyRegion;
}): ModelDisplayPrice | null {
  const isGateway = args.providerId === 'xd';
  const source = isGateway ? args.gatewayCost : args.referenceUsdCost;
  if (!source || !validAmount(source.input) || !validAmount(source.output)) return null;

  const multiplier = !isGateway && args.region === 'cn' ? USD_TO_CNY_FIXED_RATE : 1;
  return {
    currency: args.region === 'cn' ? 'CNY' : 'USD',
    input: source.input * multiplier,
    output: source.output * multiplier,
    ...(validAmount(source.cacheRead) ? { cacheRead: source.cacheRead * multiplier } : {}),
    ...(validAmount(source.cacheWrite) ? { cacheWrite: source.cacheWrite * multiplier } : {}),
  };
}

export function formatModelPriceAmount(
  amount: number,
  currency: ModelDisplayPrice['currency'],
): string {
  const value = new Intl.NumberFormat('en-US', {
    maximumFractionDigits: amount > 0 && amount < 0.01 ? 4 : 2,
    useGrouping: false,
  }).format(amount);
  return `${currency === 'CNY' ? '¥' : '$'}${value}`;
}

export function formatModelPricePair(price: ModelDisplayPrice): string {
  return `${formatModelPriceAmount(price.input, price.currency)} / ${formatModelPriceAmount(
    price.output,
    price.currency,
  )}`;
}
