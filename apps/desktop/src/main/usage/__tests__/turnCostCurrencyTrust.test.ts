import { describe, expect, it, afterEach } from 'vitest';

import { __resetActiveLedgerCurrencyForTesting } from '../ledgerCurrency';
import { detectOutputLag, type ModelUsageDeltaEntry } from '../modelUsageDelta';
import {
  computePriceQuoteTurnMoney,
  normalizeModelIdForPricing,
  resolveTurnCost,
  type TurnPricingContext,
} from '../turnCostCalculator';
import type { ModelPriceQuote, ModelPricingCatalog } from '../../../shared/regionalMoney';

const XD_GATEWAY: TurnPricingContext = {
  providerId: 'xd',
  billingRoute: 'xd-gateway',
  region: 'global',
};

const TOKENS = {
  inputTokens: 1_000,
  outputTokens: 1_000,
  cacheReadTokens: 0,
  cacheCreateTokens: 0,
};

function gatewayQuote(modelId: string, overrides: Partial<ModelPriceQuote> = {}): ModelPriceQuote {
  return {
    providerId: 'xd',
    modelId,
    currency: 'USD',
    source: 'gateway',
    approximate: false,
    inputPerMtok: 10,
    outputPerMtok: 50,
    ...overrides,
  };
}

function catalog(...quotes: ModelPriceQuote[]): ModelPricingCatalog {
  const xd: Record<string, ModelPriceQuote> = {};
  for (const quote of quotes) xd[quote.modelId] = quote;
  return { xd };
}

afterEach(() => {
  __resetActiveLedgerCurrencyForTesting();
});

describe('inferred currency downgrades the money to an estimate', () => {
  it('marks money approximate when the quote currency was guessed locally', () => {
    // 报价数值来自服务端、币种由本地推断时,这一笔能不能和账单对上取决于猜得对不对。
    // 金额仍是真实计费(kind 保持 actual-cost,否则会被并进订阅价值统计),但不能再
    // 自称精确。
    const money = computePriceQuoteTurnMoney(
      TOKENS,
      gatewayQuote('claude-fable-5', { currencyInferred: true }),
      'USD',
    );
    expect(money).toMatchObject({
      currency: 'USD',
      approximate: true,
      kind: 'actual-cost',
    });
    expect(money?.estimateReasons).toContain('inferred-currency');
  });

  it('keeps a server-declared currency exact', () => {
    const money = computePriceQuoteTurnMoney(TOKENS, gatewayQuote('claude-fable-5'), 'USD');
    expect(money).toMatchObject({ approximate: false, kind: 'actual-cost' });
    expect(money?.estimateReasons).toBeUndefined();
  });
});

describe('long-context turns pick the right pricing band', () => {
  // 定档只看本轮实际 input token 落进哪个 band，不看模型 id 的 `[1m]` 后缀 ——
  // 后缀只说明会话开了大窗口，不代表这一轮真的超过阈值。
  const BANDED = gatewayQuote('claude-fable-5', {
    inputTokenPriceBands: [
      { minInputTokens: 200_001, inputPerMtok: 20, outputPerMtok: 75, cacheReadPerMtok: 2 },
    ],
  });

  it('charges the long-context band once the turn crosses the threshold', () => {
    // 实测形态：40 万 token 上下文的轮次此前一律按 200K 档标准价记账。
    const resolved = resolveTurnCost({
      rawModel: 'claude-fable-5[1m]',
      tokens: {
        inputTokens: 1_000,
        outputTokens: 1_000,
        cacheReadTokens: 400_000,
        cacheCreateTokens: 0,
      },
      pricing: catalog(BANDED),
      context: XD_GATEWAY,
    });
    // 1000*20 + 1000*75 + 400000*2 = 895_000 → 0.895
    expect(resolved.money?.amount).toBeCloseTo(0.895, 10);
  });

  it('stays on the baseline for a short turn of the same model', () => {
    const resolved = resolveTurnCost({
      rawModel: 'claude-fable-5[1m]',
      tokens: TOKENS,
      pricing: catalog(BANDED),
      context: XD_GATEWAY,
    });
    // 1000*10 + 1000*50 = 60_000 → 0.06，与不带后缀的同轮一致。
    expect(resolved.money?.amount).toBeCloseTo(0.06, 10);
  });

  it('normalizes the variant suffix away for catalog lookup', () => {
    const resolved = resolveTurnCost({
      rawModel: 'claude-fable-5[1m]',
      tokens: TOKENS,
      pricing: catalog(gatewayQuote('claude-fable-5')),
      context: XD_GATEWAY,
    });
    expect(resolved.model).toBe('claude-fable-5');
    expect(resolved.money?.approximate).toBe(false);
    expect(normalizeModelIdForPricing('claude-fable-5[1m]')).toBe('claude-fable-5');
  });
});

describe('output lag detection', () => {
  function delta(overrides: Partial<ModelUsageDeltaEntry>): ModelUsageDeltaEntry {
    return {
      model: 'claude-fable-5[1m]',
      costUsdDelta: 0,
      inputTokensDelta: 0,
      outputTokensDelta: 0,
      cacheReadTokensDelta: 0,
      cacheCreateTokensDelta: 0,
      ...overrides,
    };
  }

  it('flags a huge input turn that reports almost no output', () => {
    // 实测形态:40 万 token 的上下文写进 cache,output 只报 7 —— 真实的长回复被上游
    // 结算延后到了下一轮。
    expect(
      detectOutputLag(
        [delta({ inputTokensDelta: 131, cacheCreateTokensDelta: 404_534, outputTokensDelta: 7 })],
        'msg_vrtx_1',
      ),
    ).toBe(true);
  });

  it('does not flag a normal turn', () => {
    expect(
      detectOutputLag([delta({ cacheReadTokensDelta: 404_771, outputTokensDelta: 3_202 })]),
    ).toBe(false);
  });

  it('does not flag a genuinely tiny turn', () => {
    expect(detectOutputLag([delta({ inputTokensDelta: 120, outputTokensDelta: 4 })])).toBe(false);
  });

  it('does not flag a concise high-context reply without Vertex evidence', () => {
    expect(
      detectOutputLag([delta({ cacheReadTokensDelta: 404_771, outputTokensDelta: 7 })]),
    ).toBe(false);
  });
});
