/** Renderer 侧相互独立的 XD 实际报价与非 XD Catalog 参考价快照。 */

import { useEffect, useState } from 'react';

import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
  type DataOwnerGeneration,
} from '@/contexts/dataOwnerGeneration';
import type { ModelPriceQuote, ModelPricingCatalog } from '../../shared/regionalMoney';

type PricingKind = 'gateway' | 'reference';

interface PricingState {
  owner: DataOwnerGeneration | null;
  cache: ModelPricingCatalog | null;
  loaded: boolean;
  inflight: Promise<ModelPricingCatalog | null> | null;
  revision: number;
}

interface PricingSnapshot {
  ownerGeneration: number;
  pricing: ModelPricingCatalog | null;
}

const gatewayState: PricingState = {
  owner: null,
  cache: null,
  loaded: false,
  inflight: null,
  revision: 0,
};
const referenceState: PricingState = {
  owner: null,
  cache: null,
  loaded: false,
  inflight: null,
  revision: 0,
};

function stateBelongsToOwner(state: PricingState, owner: DataOwnerGeneration): boolean {
  return (
    state.owner?.dataOwnerId === owner.dataOwnerId && state.owner.generation === owner.generation
  );
}

function stateFor(kind: PricingKind, owner: DataOwnerGeneration): PricingState {
  const state = kind === 'gateway' ? gatewayState : referenceState;
  if (!stateBelongsToOwner(state, owner)) {
    state.owner = owner;
    state.cache = null;
    state.loaded = false;
    state.inflight = null;
    state.revision += 1;
  }
  return state;
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isValidQuote(
  value: unknown,
  providerId: string,
  catalogKey: string,
  kind: PricingKind,
): value is ModelPriceQuote {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const quote = value as Partial<ModelPriceQuote>;
  const modelId = kind === 'reference' ? catalogKey.split('\u0000', 1)[0] : catalogKey;
  const sourceMatches =
    kind === 'gateway'
      ? providerId === 'xd' && quote.source === 'gateway' && quote.approximate === false
      : providerId !== 'xd' && quote.source !== 'gateway' && quote.approximate === true;
  return (
    quote.providerId === providerId &&
    quote.modelId === modelId &&
    (quote.currency === 'CNY' || quote.currency === 'USD') &&
    sourceMatches &&
    isNonNegativeFinite(quote.inputPerMtok) &&
    isNonNegativeFinite(quote.outputPerMtok) &&
    (quote.cacheReadPerMtok === undefined || isNonNegativeFinite(quote.cacheReadPerMtok)) &&
    (quote.cacheCreatePerMtok === undefined || isNonNegativeFinite(quote.cacheCreatePerMtok))
  );
}

function isValidCatalog(value: unknown, kind: PricingKind): value is ModelPricingCatalog {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.entries(value as Record<string, unknown>).every(
    ([providerId, rawModels]) =>
      !!providerId &&
      !!rawModels &&
      typeof rawModels === 'object' &&
      !Array.isArray(rawModels) &&
      Object.entries(rawModels as Record<string, unknown>).every(([modelId, quote]) =>
        isValidQuote(quote, providerId, modelId, kind),
      ),
  );
}

/**
 * 报价读写都经过这一层防御性取值:preload 面缺这几个方法时**降级为「没有报价」**,
 * 而不是让整个消费页崩掉。
 *
 * 为什么必须在这里挡:`load()` 下面那个 `.catch` 抓不到 —— 直接解引用
 * `usage.getModelPricing` 是**同步抛出**,发生在 `.then` 链建立之前。同理
 * `subscribePricing` 一抛就会打断 effect,连卸载清理都不会注册。
 *
 * 什么时候真会缺:升级窗口期的旧 preload,以及只投影部分能力的宿主。同一条哲学见
 * `useCodexRateLimits` 的 `readCodexRateLimitsSafely`(「Missing/older preload ...
 * degrade to no extra tooltip rows」)——价格是**装饰性信息**,拿不到就不显示,
 * 不该把它的缺失升级成页面级故障。
 */
function pricingApi(): {
  getModelPricing?: () => Promise<unknown>;
  getReferenceModelPricing?: () => Promise<unknown>;
  onModelPricingChanged?: (listener: (pricing: unknown) => void) => () => void;
  onReferenceModelPricingChanged?: (listener: (pricing: unknown) => void) => () => void;
} | null {
  return (
    (
      window as unknown as {
        electronAPI?: { maker?: { usage?: ReturnType<typeof pricingApi> } };
      }
    ).electronAPI?.maker?.usage ?? null
  );
}

function readPricing(kind: PricingKind): Promise<unknown> {
  const api = pricingApi();
  const read = kind === 'gateway' ? api?.getModelPricing : api?.getReferenceModelPricing;
  if (typeof read !== 'function') return Promise.resolve(null);
  try {
    return Promise.resolve(read.call(api));
  } catch {
    return Promise.resolve(null);
  }
}

function subscribePricing(kind: PricingKind, listener: (pricing: unknown) => void): () => void {
  const api = pricingApi();
  const subscribe =
    kind === 'gateway' ? api?.onModelPricingChanged : api?.onReferenceModelPricingChanged;
  if (typeof subscribe !== 'function') return () => {};
  try {
    return subscribe.call(api, listener) ?? (() => {});
  } catch {
    return () => {};
  }
}

function load(
  kind: PricingKind,
  state: PricingState,
  owner: DataOwnerGeneration,
): Promise<ModelPricingCatalog | null> {
  if (!stateBelongsToOwner(state, owner) || !isDataOwnerGenerationCurrent(owner)) {
    return Promise.resolve(null);
  }
  if (state.loaded) return Promise.resolve(state.cache);
  if (!state.inflight) {
    const revisionAtStart = state.revision;
    const flight = readPricing(kind)
      .then((result) => {
        if (
          !stateBelongsToOwner(state, owner) ||
          !isDataOwnerGenerationCurrent(owner)
        ) {
          return null;
        }
        if (state.revision !== revisionAtStart) return state.cache;
        state.loaded = true;
        state.cache = isValidCatalog(result, kind) ? result : null;
        return state.cache;
      })
      .catch(() => {
        if (
          !stateBelongsToOwner(state, owner) ||
          !isDataOwnerGenerationCurrent(owner)
        ) {
          return null;
        }
        if (state.revision !== revisionAtStart) return state.cache;
        state.loaded = true;
        state.cache = null;
        return null;
      });
    state.inflight = flight;
    void flight.finally(() => {
      if (state.inflight === flight) state.inflight = null;
    });
  }
  return state.inflight;
}

function usePricing(kind: PricingKind): ModelPricingCatalog | null {
  const owner = getDataOwnerGeneration();
  const source = stateFor(kind, owner);
  const [snapshot, setSnapshot] = useState<PricingSnapshot>(() => ({
    ownerGeneration: owner.generation,
    pricing: source.cache,
  }));

  useEffect(() => {
    let active = true;
    setSnapshot({ ownerGeneration: owner.generation, pricing: source.cache });
    const unsubscribe = subscribePricing(kind, (next) => {
      if (!stateBelongsToOwner(source, owner) || !isDataOwnerGenerationCurrent(owner)) return;
      source.revision += 1;
      source.loaded = true;
      source.cache = isValidCatalog(next, kind) ? next : null;
      if (active) {
        setSnapshot({ ownerGeneration: owner.generation, pricing: source.cache });
      }
    });
    void load(kind, source, owner).then((result) => {
      if (active && stateBelongsToOwner(source, owner) && isDataOwnerGenerationCurrent(owner)) {
        setSnapshot({ ownerGeneration: owner.generation, pricing: result });
      }
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [kind, owner, source]);

  return snapshot.ownerGeneration === owner.generation ? snapshot.pricing : source.cache;
}

/** Cindy AI `/models` 下发的实际报价。 */
export function useGatewayModelPricing(): ModelPricingCatalog | null {
  return usePricing('gateway');
}

/** 非 XD Provider 的 Catalog 参考价与用户覆盖。 */
export function useReferenceModelPricing(): ModelPricingCatalog | null {
  return usePricing('reference');
}
