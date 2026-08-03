/**
 * 非 XD 渠道的参考报价投影。
 *
 * 数据只来自公共 Model Registry 与用户覆盖，用于 BYOK / 订阅价值估算。Cindy AI
 * Gateway 的模型与售价由 modelPricing.ts 独占维护，本模块显式拒绝 XD 数据。
 */

import { BrowserWindow } from 'electron';

import {
  getModelPriceQuote,
  providerReferencePriceQuote,
  registryPricingCatalog,
  subscriptionDirectPriceQuote,
} from '../../shared/modelPriceQuote.js';
import type { ModelPriceQuote, ModelPricingCatalog } from '../../shared/regionalMoney.js';
import { getActiveCatalog } from '../maker-host/active-catalog.js';
import {
  applyModelPriceOverrides,
  mergeStoredModelPriceOverride,
  type ModelPriceOverridesSnapshot,
} from './modelPriceOverrideStore.js';

export type { ModelPriceOverridesSnapshot } from './modelPriceOverrideStore.js';
export { readModelPriceOverridesSnapshot } from './modelPriceOverrideStore.js';

export const REFERENCE_MODEL_PRICING_CHANGED_CHANNEL = 'usage:reference-model-pricing-changed';

/** Catalog 刷新只重建非 XD 参考价；registryPricingCatalog 本身也会过滤 XD route。 */
export function getReferenceModelPricing(): ModelPricingCatalog {
  const registry = getActiveCatalog().modelRegistry;
  return applyModelPriceOverrides(registryPricingCatalog(registry), registry);
}

export function broadcastReferenceModelPricing(): void {
  const pricing = getReferenceModelPricing();
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(REFERENCE_MODEL_PRICING_CHANGED_CHANNEL, pricing);
    }
  }
}

/** 按显式来源估算 Codex 订阅轮价值，不读取 XD Gateway 报价。 */
export function getCodexProviderSubscriptionValuePrice(
  providerId: string,
  modelId: string,
  pricing: ModelPricingCatalog | null | undefined,
  at?: string | Date,
  overrides?: ModelPriceOverridesSnapshot,
): ModelPriceQuote | undefined {
  if (providerId === 'xd') return undefined;
  const effective = getModelPriceQuote(pricing, providerId, modelId, 'codex');
  if (effective?.source === 'user-override') {
    if (at === undefined) return effective;
    return (
      mergeStoredModelPriceOverride(
        { providerId, agent: 'codex', modelId: effective.modelId },
        providerReferencePriceQuote(
          providerId,
          effective.modelId,
          getActiveCatalog().modelRegistry,
          { agent: 'codex', at },
        ),
        overrides,
      ) ?? effective
    );
  }
  const reference = providerReferencePriceQuote(
    providerId,
    modelId,
    getActiveCatalog().modelRegistry,
    { agent: 'codex', at },
  );
  return reference ?? (at === undefined ? effective : undefined);
}

export function getCodexSubscriptionValuePrice(
  modelId: string,
  pricing: ModelPricingCatalog | null | undefined,
  at?: string | Date,
  overrides?: ModelPriceOverridesSnapshot,
): ModelPriceQuote | undefined {
  return getCodexProviderSubscriptionValuePrice('openai', modelId, pricing, at, overrides);
}

export function getClaudeSubscriptionValuePrice(
  modelId: string,
  pricing: ModelPricingCatalog | null | undefined,
  at?: string | Date,
  overrides?: ModelPriceOverridesSnapshot,
): ModelPriceQuote | undefined {
  const effective = getModelPriceQuote(pricing, 'anthropic', modelId, 'claude-code');
  if (effective?.source === 'user-override') {
    if (at === undefined) return effective;
    return (
      mergeStoredModelPriceOverride(
        { providerId: 'anthropic', agent: 'claude-code', modelId: effective.modelId },
        providerReferencePriceQuote(
          'anthropic',
          effective.modelId,
          getActiveCatalog().modelRegistry,
          { agent: 'claude-code', at },
        ),
        overrides,
      ) ?? effective
    );
  }
  const reference = providerReferencePriceQuote(
    'anthropic',
    modelId,
    getActiveCatalog().modelRegistry,
    { agent: 'claude-code', at },
  );
  return reference ?? (at === undefined ? effective : undefined);
}

export function getSubscriptionDirectValuePrice(
  modelId: string,
  agent?: 'claude-code' | 'codex',
  pricing?: ModelPricingCatalog | null,
  at?: string | Date,
  overrides?: ModelPriceOverridesSnapshot,
): ModelPriceQuote | undefined {
  const registry = getActiveCatalog().modelRegistry;
  const fallback = subscriptionDirectPriceQuote(modelId, registry, agent, at);
  const routingQuote = fallback ?? subscriptionDirectPriceQuote(modelId, registry, agent);
  if (!routingQuote || routingQuote.providerId === 'xd') return undefined;
  const effective = getModelPriceQuote(pricing, routingQuote.providerId, modelId, agent);
  const quote =
    effective?.source === 'user-override'
      ? at === undefined || agent === undefined
        ? effective
        : (mergeStoredModelPriceOverride(
            { providerId: effective.providerId, agent, modelId: effective.modelId },
            providerReferencePriceQuote(effective.providerId, effective.modelId, registry, {
              agent,
              at,
            }),
            overrides,
          ) ?? effective)
      : fallback;
  if (!quote) return undefined;
  return {
    ...quote,
    modelId,
    source: quote.source === 'provider-reference' ? 'subscription-reference' : quote.source,
  };
}
