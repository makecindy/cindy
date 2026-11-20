/**
 * 非 XD 渠道的参考报价投影。
 *
 * 数据只来自公共 Model Registry 与用户覆盖，用于 BYOK / 订阅价值估算。Cindy AI
 * Gateway 的模型与售价由 modelPricing.ts 独占维护，本模块显式拒绝 XD 数据。
 *
 * Shared by Desktop and the Node Host. Moved verbatim from referenceModelPricing.ts, which keeps
 * the Desktop window broadcast (broadcastReferenceModelPricing) and re-exports this module.
 */

import type { AgentKind, Catalog, CatalogModel, Provider } from '@cindy/model-providers';

import {
  getModelPriceQuote,
  modelPricingKey,
  registryPricingCatalog,
  providerReferencePriceQuote as registryQuoteForModel,
  subscriptionDirectPriceQuote,
} from '../../shared/modelPriceQuote.js';
import type { ModelPriceQuote, ModelPricingCatalog } from '../../shared/regionalMoney.js';
import { getByokPricing } from '../model-access/byokPricing.js';
import { getActiveCatalog } from '../maker-host/active-catalog.js';
import {
  accountReferencePriceQuote as providerReferencePriceQuote,
  matchesTariffEndpoint,
  providerRegistryTariffEndedAt,
  providerSnapshotReferencePriceQuote,
} from './accountReferencePrice.js';
import { currentLedgerCurrency } from './ledgerCurrency.js';
import {
  applyModelPriceOverrides,
  currencyCanProjectToLedger,
  mergeStoredModelPriceOverride,
  type ModelPriceOverridesSnapshot,
} from './modelPriceOverrideStore.js';

export type { ModelPriceOverridesSnapshot } from './modelPriceOverrideStore.js';
export { readModelPriceOverridesSnapshot } from './modelPriceOverrideStore.js';

export const REFERENCE_MODEL_PRICING_CHANGED_CHANNEL = 'usage:reference-model-pricing-changed';

function modelCostQuote(
  providerId: string,
  model: CatalogModel,
): ModelPriceQuote | undefined {
  const cost = model.cost;
  if (cost?.input === undefined || cost.output === undefined) return undefined;
  if (![cost.input, cost.output].every(value => Number.isFinite(value) && value >= 0)) return undefined;
  const tiers = (cost.tiers ?? [])
    .filter(tier => Number.isFinite(tier.inputTokensAbove) && tier.inputTokensAbove >= 0)
    .sort((a, b) => a.inputTokensAbove - b.inputTokensAbove);
  const inputTokenPriceBands = tiers.length > 0
    ? [
        {
          minInputTokens: 0,
          maxInputTokens: tiers[0]!.inputTokensAbove + 1,
          inputPerMtok: cost.input,
          outputPerMtok: cost.output,
          ...(cost.cacheRead !== undefined ? { cacheReadPerMtok: cost.cacheRead } : {}),
          ...(cost.cacheWrite !== undefined ? { cacheCreatePerMtok: cost.cacheWrite } : {}),
        },
        ...tiers.map((tier, index) => ({
          minInputTokens: tier.inputTokensAbove + 1,
          ...(tiers[index + 1] ? { maxInputTokens: tiers[index + 1]!.inputTokensAbove + 1 } : {}),
          inputPerMtok: tier.input ?? cost.input,
          outputPerMtok: tier.output ?? cost.output,
          ...(tier.cacheRead !== undefined || cost.cacheRead !== undefined
            ? { cacheReadPerMtok: tier.cacheRead ?? cost.cacheRead }
            : {}),
          ...(tier.cacheWrite !== undefined || cost.cacheWrite !== undefined
            ? { cacheCreatePerMtok: tier.cacheWrite ?? cost.cacheWrite }
            : {}),
        })),
      ]
    : undefined;
  return {
    providerId,
    modelId: model.id,
    currency: 'USD',
    source: 'provider-reference',
    approximate: true,
    inputPerMtok: cost.input,
    outputPerMtok: cost.output,
    ...(cost.cacheRead !== undefined ? { cacheReadPerMtok: cost.cacheRead } : {}),
    ...(cost.cacheWrite !== undefined ? { cacheCreatePerMtok: cost.cacheWrite } : {}),
    ...(inputTokenPriceBands ? { inputTokenPriceBands } : {}),
  };
}

/** Retain dated public prices for removed models on engines still using that public channel.
 * Models currently configured on an engine are priced separately using their actual model route.
 */
function historicalAccountPrices(
  provider: Provider, catalog: Catalog, publicPrices: Record<string, ModelPriceQuote> | undefined,
  at: string | Date | undefined,
): Record<string, ModelPriceQuote> {
  const prices: Record<string, ModelPriceQuote> = Object.create(null);
  if (!publicPrices) return prices;
  const preset = catalog.presets?.find(candidate => candidate.id === provider.id);
  if (!preset) return prices;
  const engines = Object.entries(provider.routing);
  const official = engines.flatMap(([engine, routing]) => {
    const agent = engine as AgentKind;
    const runtime = preset.runtimes[agent];
    if (!runtime || routing.disabled) return [];
    const defaultWire = agent === 'pi' ? 'openai-chat' : agent === 'codex' ? 'openai-responses' : 'anthropic-messages';
    const matches = (url: string, wire = runtime.wireProtocol, path = runtime.requestPath) =>
      matchesTariffEndpoint(
        { baseUrl: routing.upstream, wireProtocol: routing.wireProtocol ?? defaultWire, requestPath: routing.requestPath },
        { baseUrl: url, wireProtocol: wire ?? defaultWire, requestPath: path },
      );
    const defaultRoute = matches(runtime.baseUrl);
    // A preset can also declare a separate native endpoint for individual models (e.g. Gemini).
    const nativeModels = defaultRoute ? undefined : new Set(runtime.models
      .filter(model => model.route && matches(model.route.baseUrl, model.route.wireProtocol, model.route.requestPath))
      .map(model => model.id));
    if (nativeModels?.size === 0) return [];
    return [{ agent, nativeModels, current: new Set(provider.models[agent]?.map(model => model.id)) }];
  });
  if (!official.length) return prices;
  for (const [modelId, publicQuote] of Object.entries(publicPrices)) {
    let quoted = 0;
    for (const { agent, nativeModels, current } of official) {
      if (current.has(modelId) || (nativeModels && !nativeModels.has(modelId))) continue;
      const quote = registryQuoteForModel(provider.id, modelId, catalog.modelRegistry, { agent, at });
      if (quote) {
        prices[modelPricingKey(modelId, agent)] = quote;
        quoted++;
      }
    }
    if (quoted === engines.length) prices[modelId] = publicQuote;
  }
  return prices;
}

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
  const ledgerCurrency = currentLedgerCurrency();
  const pricing = registryPricingCatalog(registry, at);
  for (const provider of options.providers ?? catalog.providers) {
    if (provider.id === 'xd') continue;
    // Prefer dated, tiered Model Registry tariffs whenever this connection's route
    // declares one, so stale static `provider-models.json` `model.cost` entries never
    // shadow scheduled price transitions, long-context tiers, priority rates or
    // deprecation cutoffs. Fall back to connection-local/discovered `model.cost` only
    // when the active tariff cannot be used on this ledger or the route has no tariff.
    if (provider.source === 'user') {
      // A local account can have the same ID as a public route. Rebuild its bucket
      // from verified engine/model quotes so an unmatched relay cannot inherit the generic price.
      if (provider.auth.method === 'apiKey') {
        const publicPrices = Object.hasOwn(pricing, provider.id) ? pricing[provider.id] : undefined;
        pricing[provider.id] = historicalAccountPrices(provider, catalog, publicPrices, at);
      }
      const nativeOAuth = provider.auth?.method === 'oauth' && Boolean(provider.auth.native);
      for (const [agent, models] of Object.entries(provider.models)) {
        const agentKind = agent as AgentKind;
        for (const model of models ?? []) {
          const registryQuote = providerSnapshotReferencePriceQuote(
            provider,
            model.id,
            registry,
            { agent: agentKind, at, ...(nativeOAuth ? { officialOnly: true } : {}) },
          );
          if (registryQuote && currencyCanProjectToLedger(registryQuote.currency, ledgerCurrency)) {
            (pricing[provider.id] ??= {})[modelPricingKey(model.id, agentKind)] = registryQuote;
            continue;
          }
          if (!registryQuote && providerRegistryTariffEndedAt(provider, provider.id, model.id, registry, at, agentKind)) {
            continue;
          }
          const localQuote = modelCostQuote(provider.id, model);
          if (localQuote) {
            (pricing[provider.id] ??= {})[modelPricingKey(model.id, agentKind)] = localQuote;
          }
        }
      }
      continue;
    }
    if (provider.auth?.method !== 'oauth' || !provider.auth.native) continue;
    for (const [agent, models] of Object.entries(provider.models)) {
      for (const model of models ?? []) {
        const quote = providerSnapshotReferencePriceQuote(provider, model.id, registry, { agent: agent as AgentKind, at, officialOnly: true });
        if (quote) (pricing[provider.id] ??= {})[modelPricingKey(model.id, agent as AgentKind)] = quote;
      }
    }
  }
  return {
    ...applyModelPriceOverrides(pricing, registry, ledgerCurrency, { at, entries: options.overrides }),
    ...getByokPricing(),
  };
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
