/**
 * 非 XD 渠道的参考报价投影。
 *
 * 数据只来自公共 Model Registry 与用户覆盖，用于 BYOK / 订阅价值估算。Cindy AI
 * Gateway 的模型与售价由 modelPricing.ts 独占维护，本模块显式拒绝 XD 数据。
 */

import { BrowserWindow } from 'electron';
import { notifyUsagePricingChanged } from './pricingChanges.js';
import { createLogger } from '../logger.js';
import type { AgentKind, Catalog } from '@cindy/model-providers';

import {
  getModelPriceQuote,
  modelPricingKey,
  registryPricingCatalog,
  subscriptionDirectPriceQuote,
} from '../../shared/modelPriceQuote.js';
import type { ModelPriceQuote, ModelPricingCatalog } from '../../shared/regionalMoney.js';
import { getByokPricing } from '../model-access/byokPricing.js';
import { getActiveCatalog } from '../maker-host/active-catalog.js';
import { accountReferencePriceQuote as providerReferencePriceQuote } from './accountReferencePrice.js';
import {
  applyModelPriceOverrides,
  mergeStoredModelPriceOverride,
  type ModelPriceOverridesSnapshot,
} from './modelPriceOverrideStore.js';

export type { ModelPriceOverridesSnapshot } from './modelPriceOverrideStore.js';
export { readModelPriceOverridesSnapshot } from './modelPriceOverrideStore.js';

export const REFERENCE_MODEL_PRICING_CHANGED_CHANNEL = 'usage:reference-model-pricing-changed';

const log = createLogger('referenceModelPricing');

/**
 * Catalog 刷新只重建非 XD 参考价；registryPricingCatalog 本身也会过滤 XD route。
 *
 * `at` 按那一天生效的注册表价目解析(历史用量估价)，与今天的目录同一套取价规则；连接自带的价格
 * 与 BYOK 价格不带生效期，照常加入。批量按天取价的调用方传同一份 `overrides` 快照。
 */
export function getReferenceModelPricing(
  options: {
    at?: string | Date;
    overrides?: ModelPriceOverridesSnapshot;
    /** Providers to quote per model; defaults to the active catalog's. */
    providers?: Catalog['providers'];
  } = {},
): ModelPricingCatalog {
  const { at } = options;
  const catalog = getActiveCatalog();
  const registry = catalog.modelRegistry;
  const pricing = registryPricingCatalog(registry, at);
  for (const provider of options.providers ?? catalog.providers) {
    // Connection-local prices belong to this account and engine, including OAuth
    // discovery quotes. Publishing only Registry routes dropped them all.
    if (provider.source === 'user' && provider.id !== 'xd') {
      for (const [agent, models] of Object.entries(provider.models)) {
        for (const model of models ?? []) {
          const cost = model.cost;
          if (cost?.input === undefined || cost.output === undefined) continue;
          if (![cost.input, cost.output].every(value => Number.isFinite(value) && value >= 0)) continue;
          (pricing[provider.id] ??= {})[modelPricingKey(model.id, agent as AgentKind)] = {
            providerId: provider.id, modelId: model.id, currency: 'USD',
            source: 'provider-reference', approximate: true,
            inputPerMtok: cost.input, outputPerMtok: cost.output,
            ...(cost.cacheRead !== undefined ? { cacheReadPerMtok: cost.cacheRead } : {}),
            ...(cost.cacheWrite !== undefined ? { cacheCreatePerMtok: cost.cacheWrite } : {}),
          };
        }
      }
    }
    if (provider.auth?.method !== 'oauth' || !provider.auth.native) continue;
    for (const [agent, models] of Object.entries(provider.models)) {
      for (const model of models ?? []) {
        const quote = providerReferencePriceQuote(provider.id, model.id, registry, { agent: agent as AgentKind, at, officialOnly: true });
        if (quote) (pricing[provider.id] ??= {})[modelPricingKey(model.id, agent as AgentKind)] = quote;
      }
    }
  }
  return {
    ...applyModelPriceOverrides(pricing, registry, undefined, { at, entries: options.overrides }),
    ...getByokPricing(),
  };
}

let displayProviders: (() => Catalog['providers']) | null = null;

/**
 * The catalog the model picker and settings list render from. An account provider's own
 * discovered models are projected onto it after the active catalog, so quoting only the
 * active catalog leaves exactly those models without a price.
 */
export function setReferencePricingDisplayProviders(source: (() => Catalog['providers']) | null): void {
  displayProviders = source;
}

/** Current reference prices for every model the renderer can list. */
export function getDisplayReferenceModelPricing(): ModelPricingCatalog {
  return getReferenceModelPricing({ providers: displayProviders?.() });
}

let lastBroadcastTable: string | null = null;
let followUpScheduled = false;

function publishReferenceModelPricing(pricing: ModelPricingCatalog, table: string): void {
  lastBroadcastTable = table;
  notifyUsagePricingChanged();
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      win.webContents.send(REFERENCE_MODEL_PRICING_CHANGED_CHANNEL, pricing);
    } catch {
      // Window teardown may race the broadcast; other windows still receive it.
    }
  }
}

export function broadcastReferenceModelPricing(): void {
  const pricing = getDisplayReferenceModelPricing();
  publishReferenceModelPricing(pricing, JSON.stringify(pricing));
}

/**
 * 供应商清单变化后跟进一次参考价。
 *
 * OAuth 账号供应商的报价按「当时这个账号名下的型号」逐个生成；账号发现在目录加载之后才
 * 补入新型号，那一刻没有人再广播，界面上这些型号就一直没有价格（独立订阅账号页上新型号
 * 缺价格档）。同一轮事件循环内的多次变化只重算一次；报价表没变就不广播，也不通知用量重算。
 */
export function followReferenceModelPricingAfterProviderChange(): void {
  if (followUpScheduled) return;
  followUpScheduled = true;
  setImmediate(() => {
    followUpScheduled = false;
    // Nothing awaits this callback: an escaping error would be an uncaughtException, which
    // shuts the app down. A missed price update is retried by the next provider change.
    try {
      const pricing = getDisplayReferenceModelPricing();
      const table = JSON.stringify(pricing);
      if (table === lastBroadcastTable) return;
      publishReferenceModelPricing(pricing, table);
    } catch (error) {
      log.warn('reference price follow-up failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

/** 按显式来源估算 Codex 订阅轮价值，不读取 XD Gateway 报价。 */
export function getCodexProviderSubscriptionValuePrice(
  providerId: string,
  modelId: string,
  pricing: ModelPricingCatalog | null | undefined,
  at?: string | Date,
  overrides?: ModelPriceOverridesSnapshot,
  agent: AgentKind = 'codex',
): ModelPriceQuote | undefined {
  if (providerId === 'xd') return undefined;
  const effective = getModelPriceQuote(pricing, providerId, modelId, agent);
  if (effective?.source === 'user-override') {
    return (
      mergeStoredModelPriceOverride(
        { providerId, agent, modelId: effective.modelId },
        providerReferencePriceQuote(
          providerId,
          effective.modelId,
          getActiveCatalog().modelRegistry,
          { agent, at, officialOnly: true },
        ),
        overrides,
      ) ?? effective
    );
  }
  const reference = providerReferencePriceQuote(
    providerId,
    modelId,
    getActiveCatalog().modelRegistry,
    { agent, at, officialOnly: true },
  );
  return reference ?? ((getActiveCatalog().modelRegistry?.schemaVersion ?? 0) < 5 && at === undefined ? effective : undefined);
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
  return getCodexProviderSubscriptionValuePrice(
    'anthropic', modelId, pricing, at, overrides, 'claude-code',
  );
}

export function getSubscriptionDirectValuePrice(
  modelId: string,
  agent?: AgentKind,
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
      ? agent === undefined
        ? effective
        : (mergeStoredModelPriceOverride(
            { providerId: effective.providerId, agent, modelId: effective.modelId },
            providerReferencePriceQuote(effective.providerId, effective.modelId, registry, {
              agent,
              at,
              officialOnly: true,
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
