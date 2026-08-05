/** renderer 侧 provider-scoped 模型价格快照。 */

import { useEffect, useState } from 'react';

import type {
  ModelPriceQuote,
  ModelPricingCatalog,
} from '../../shared/regionalMoney';

let cache: ModelPricingCatalog | null = null;
let cacheLoaded = false;
let inflight: Promise<ModelPricingCatalog | null> | null = null;
let cacheRevision = 0;

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isValidQuote(
  value: unknown,
  providerId: string,
  modelId: string,
): value is ModelPriceQuote {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const quote = value as Partial<ModelPriceQuote>;
  return (
    quote.providerId === providerId &&
    quote.modelId === modelId &&
    (quote.currency === 'CNY' || quote.currency === 'USD') &&
    quote.source === 'gateway' &&
    quote.approximate === false &&
    isNonNegativeFinite(quote.inputPerMtok) &&
    isNonNegativeFinite(quote.outputPerMtok) &&
    (quote.cacheReadPerMtok === undefined ||
      isNonNegativeFinite(quote.cacheReadPerMtok)) &&
    (quote.cacheCreatePerMtok === undefined ||
      isNonNegativeFinite(quote.cacheCreatePerMtok))
  );
}

function isValidCatalog(v: unknown): v is ModelPricingCatalog {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  return Object.entries(v as Record<string, unknown>).every(
    ([providerId, rawModels]) =>
      !!providerId &&
      !!rawModels &&
      typeof rawModels === 'object' &&
      !Array.isArray(rawModels) &&
      Object.entries(rawModels as Record<string, unknown>).every(
        ([modelId, quote]) => isValidQuote(quote, providerId, modelId),
      ),
  );
}

function load(): Promise<ModelPricingCatalog | null> {
  if (cacheLoaded) return Promise.resolve(cache);
  if (!inflight) {
    const revisionAtStart = cacheRevision;
    inflight = window.electronAPI.maker.usage
      .getModelPricing()
      .then((res) => {
        // A push received after this read started is newer than its snapshot.
        // Keep the pushed value instead of letting a stale startup `null`
        // remove prices until the next application restart.
        if (cacheRevision !== revisionAtStart) return cache;
        cacheLoaded = true;
        cache = isValidCatalog(res) ? res : null;
        return cache;
      })
      .catch(() => {
        if (cacheRevision !== revisionAtStart) return cache;
        cacheLoaded = true;
        cache = null;
        return null;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

export function useModelPricing(): ModelPricingCatalog | null {
  const [pricing, setPricing] = useState<ModelPricingCatalog | null>(cache);

  useEffect(() => {
    let active = true;
    const unsubscribe =
      window.electronAPI.maker.usage.onModelPricingChanged((next) => {
        cacheRevision += 1;
        cacheLoaded = true;
        cache = isValidCatalog(next) ? next : null;
        if (active) setPricing(cache);
      });
    void load().then((res) => {
      if (active) setPricing(res);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  return pricing;
}
