// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModelPricingCatalog } from '../../../shared/regionalMoney';

type PricingListener = (pricing: ModelPricingCatalog | null) => void;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

let useModelPricing: typeof import('../useModelPricing').useModelPricing;

describe('useModelPricing', () => {
  beforeEach(async () => {
    vi.resetModules();
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
    ({ useModelPricing } = await import('../useModelPricing'));
  });

  it('does not let a stale initial IPC result overwrite a newer pricing push', async () => {
    const initialRead = deferred<ModelPricingCatalog | null>();
    const listeners = new Set<PricingListener>();
    const usage = {
      getModelPricing: vi.fn(() => initialRead.promise),
      onModelPricingChanged: vi.fn((listener: PricingListener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }),
    };
    (
      window as unknown as {
        electronAPI: { maker: { usage: typeof usage } };
      }
    ).electronAPI = { maker: { usage } };
    const pricing: ModelPricingCatalog = {
      xd: {
        'early-model': {
          providerId: 'xd',
          modelId: 'early-model',
          currency: 'CNY',
          source: 'gateway',
          approximate: false,
          inputPerMtok: 1,
          outputPerMtok: 2,
        },
      },
    };

    const hook = renderHook(() => useModelPricing());
    await waitFor(() => expect(listeners.size).toBe(1));

    act(() => {
      for (const listener of listeners) listener(pricing);
    });
    expect(hook.result.current).toEqual(pricing);

    await act(async () => {
      initialRead.resolve(null);
      await initialRead.promise;
    });

    expect(hook.result.current).toEqual(pricing);
    expect(usage.getModelPricing).toHaveBeenCalledOnce();
  });
});
