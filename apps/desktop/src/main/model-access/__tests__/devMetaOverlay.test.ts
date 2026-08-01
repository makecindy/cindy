/**
 * Dev ModelRegistry overlay contract: live Gateway membership and prices stay
 * authoritative while the local registry can replace curated metadata.
 */
import { describe, expect, it, vi } from 'vitest';

import type { ModelRegistry, ModelRegistryEntry } from '@cindy/model-providers';

import { overlayModelRegistryMeta } from '../devMetaOverlay.js';
import type { ModelAccessGatewayModel } from '../../../shared/modelAccess.js';

const SERVER_MODEL: ModelAccessGatewayModel = {
  id: 'gpt-5.5',
  contextWindow: 272_000,
  maxOutputTokens: 32_000,
  agents: ['claude-code', 'codex'],
  name: 'GPT-5.5(server)',
  group: 'gpt',
  efforts: ['low', 'medium', 'high'],
  defaultEffort: 'high',
  sortOrder: 20,
  supportsFastMode: true,
};

const LOCAL_ENTRY: ModelRegistryEntry = {
  id: 'openai/gpt-5.5',
  name: 'GPT-5.5(local)',
  group: 'gpt-local',
  contextWindow: 999_000,
  maxOutputTokens: 64_000,
  efforts: ['low', 'high', 'xhigh'],
  defaultEffort: 'xhigh',
  sortOrder: 3,
  supportsFastMode: false,
  defaultEnabled: false,
  perAgent: { codex: { supportsFastMode: true } },
  routes: [{ providerId: 'xd', modelId: 'gpt-5.5', agents: ['codex'] }],
};

function registry(...entries: ModelRegistryEntry[]): ModelRegistry {
  return {
    schemaVersion: 1,
    updatedAt: '2026-07-31T00:00:00.000Z',
    models: entries,
  };
}

describe('overlayModelRegistryMeta', () => {
  it('同 id 路由整体替换元数据;Gateway 上报的窗口和输出上限保持权威', () => {
    const [model] = overlayModelRegistryMeta([SERVER_MODEL], registry(LOCAL_ENTRY));
    expect(model).toMatchObject({
      id: 'gpt-5.5',
      contextWindow: 272_000,
      maxOutputTokens: 32_000,
      agents: ['codex'],
      name: 'GPT-5.5(local)',
      group: 'gpt-local',
      efforts: ['low', 'high', 'xhigh'],
      defaultEffort: 'xhigh',
      sortOrder: 3,
      supportsFastMode: false,
      defaultEnabled: false,
      perAgent: { codex: { supportsFastMode: true } },
    });
  });

  it('Gateway 未提供窗口或输出上限时才用 registry 兜底', () => {
    const live: ModelAccessGatewayModel = {
      id: 'gpt-5.5',
      name: 'x',
      agents: ['claude-code'],
    };
    const [model] = overlayModelRegistryMeta([live], registry(LOCAL_ENTRY));
    expect(model.contextWindow).toBe(999_000);
    expect(model.maxOutputTokens).toBe(64_000);
  });

  it('元数据覆盖和 retired 路由都保留 Gateway 价格字段', () => {
    const priced: ModelAccessGatewayModel = {
      ...SERVER_MODEL,
      costDiscount: 0.2,
      inputCostPerToken: 0.000003,
      outputCostPerToken: 0.000015,
      tieredPricing: [
        {
          range: [0, 200_000],
          inputCostPerToken: 0.000003,
          outputCostPerToken: 0.000015,
        },
      ],
    };
    const [overridden] = overlayModelRegistryMeta([priced], registry(LOCAL_ENTRY));
    const [retired] = overlayModelRegistryMeta(
      [priced],
      registry({ ...LOCAL_ENTRY, status: 'retired' }),
    );

    for (const model of [overridden, retired]) {
      expect(model).toMatchObject({
        costDiscount: 0.2,
        inputCostPerToken: 0.000003,
        outputCostPerToken: 0.000015,
        tieredPricing: [
          {
            range: [0, 200_000],
            inputCostPerToken: 0.000003,
            outputCostPerToken: 0.000015,
          },
        ],
      });
    }
    expect(retired).toEqual({
      id: 'gpt-5.5',
      contextWindow: 272_000,
      maxOutputTokens: 32_000,
      costDiscount: 0.2,
      inputCostPerToken: 0.000003,
      outputCostPerToken: 0.000015,
      tieredPricing: [
        {
          range: [0, 200_000],
          inputCostPerToken: 0.000003,
          outputCostPerToken: 0.000015,
        },
      ],
    });
  });

  it('无 XD 路由不会覆盖，也不会凭 registry 增加可用模型', () => {
    const officialOnly: ModelRegistryEntry = {
      ...LOCAL_ENTRY,
      routes: [{ providerId: 'openai', modelId: 'gpt-5.5', agents: ['codex'] }],
    };
    const out = overlayModelRegistryMeta([SERVER_MODEL], registry(officialOnly));
    expect(out).toEqual([SERVER_MODEL]);
    expect(out).toHaveLength(1);
  });

  it('缺少 registry 时原样返回且不产生日志', () => {
    const info = vi.fn();
    expect(overlayModelRegistryMeta([SERVER_MODEL], undefined, { info, warn: vi.fn() })).toEqual([
      SERVER_MODEL,
    ]);
    expect(info).not.toHaveBeenCalled();
  });
});
