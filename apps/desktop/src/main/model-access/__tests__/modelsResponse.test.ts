import { describe, expect, it } from 'vitest';

import {
  isStrictlyResolvedGatewayModels,
  normalizeGatewayModelsPayload,
} from '../modelsResponse.js';

const MODEL = {
  id: 'gpt-5.5',
  currency: 'USD',
  agents: ['codex'],
  name: 'GPT-5.5',
  contextWindow: 272_000,
  efforts: ['low', 'medium', 'high'],
  defaultEffort: 'high',
};

// 服务端 /models 富化后按 v2 下发的真实条目形状:网关权威字段(定价 / perAgent)+
// 知识库富化补的 capabilities / modalities。跨仓契约锁:v2 严格解析必须整条透传保留,
// 不能因定价等字段而拒收(否则客户端会清空网关模型列表)。
const ENRICHED_V2_MODEL = {
  id: 'deepseek-v4-pro',
  currency: 'CNY',
  agents: ['claude-code', 'codex'],
  name: 'DeepSeek V4 Pro',
  group: 'deepseek',
  contextWindow: 1_000_000,
  maxOutputTokens: 65_536,
  efforts: ['low', 'medium', 'high'],
  defaultEffort: 'high',
  sortOrder: 44,
  supportsFastMode: false,
  defaultEnabled: true,
  newSessionDefault: ['claude-code', 'codex'],
  capabilities: { attachment: true, reasoning: true },
  modalities: { input: ['text', 'image'], output: ['text'] },
  costDiscount: 0,
  inputCostPerToken: 0.00000027,
  outputCostPerToken: 0.0000011,
  perAgent: { 'claude-code': { contextWindow: 1_000_000 } },
};

function v2(models: unknown[]) {
  return { schemaVersion: 2, models };
}

describe('normalizeGatewayModelsPayload', () => {
  it('strictly parses a v2 response and preserves additive fields', () => {
    expect(normalizeGatewayModelsPayload(v2([MODEL]))).toEqual([MODEL]);
  });

  it('returns null for structurally invalid v2 responses so callers keep the snapshot', () => {
    expect(normalizeGatewayModelsPayload(v2([{ ...MODEL, agents: [] }]))).toBeNull();
    expect(normalizeGatewayModelsPayload(v2([{ ...MODEL, currency: 'EUR' }]))).toBeNull();
  });

  it('uses the tolerant unversioned envelope during the transition', () => {
    expect(normalizeGatewayModelsPayload({ models: [MODEL, { bad: true }] })).toEqual([
      { ...MODEL, currency: 'USD' },
    ]);
  });

  it('keeps successful empty arrays distinct from parse failures', () => {
    expect(normalizeGatewayModelsPayload(v2([]))).toEqual([]);
    expect(normalizeGatewayModelsPayload({ models: [] })).toEqual([]);
  });

  it('trusts explicit currency and keeps a missing or invalid legacy currency unknown', () => {
    expect(
      normalizeGatewayModelsPayload({ models: [{ ...MODEL, currency: 'CNY' }] }),
    ).toMatchObject([{ currency: 'CNY' }]);
    const { currency: _currency, ...withoutCurrency } = MODEL;
    expect(normalizeGatewayModelsPayload({ models: [withoutCurrency] })).toEqual([withoutCurrency]);
    expect(
      normalizeGatewayModelsPayload({ models: [{ ...withoutCurrency, currency: 'EUR' }] }),
    ).toEqual([withoutCurrency]);
  });

  it('parses a realistic enriched v2 model (capabilities + modalities + pricing + perAgent) intact', () => {
    const result = normalizeGatewayModelsPayload(v2([ENRICHED_V2_MODEL]));
    expect(result).not.toBeNull();
    // 整条透传:capabilities / modalities / 定价 / perAgent 全部保留,currency 已合法不回退。
    expect(result).toEqual([ENRICHED_V2_MODEL]);
  });

  it('marks strictly-parsed v2 models as resolved but not the tolerant envelope', () => {
    const strict = normalizeGatewayModelsPayload(v2([ENRICHED_V2_MODEL]));
    expect(strict).not.toBeNull();
    expect(isStrictlyResolvedGatewayModels(strict!)).toBe(true);

    const tolerant = normalizeGatewayModelsPayload({ models: [ENRICHED_V2_MODEL] });
    expect(tolerant).not.toBeNull();
    expect(isStrictlyResolvedGatewayModels(tolerant!)).toBe(false);
  });
});
