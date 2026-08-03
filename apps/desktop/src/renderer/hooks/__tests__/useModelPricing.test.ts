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

let useGatewayModelPricing: typeof import('../useModelPricing').useGatewayModelPricing;
let useReferenceModelPricing: typeof import('../useModelPricing').useReferenceModelPricing;
let setDataOwnerGeneration: typeof import('../../contexts/dataOwnerGeneration').setDataOwnerGeneration;

describe('useModelPricing', () => {
  beforeEach(async () => {
    vi.resetModules();
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
    const ownerModule = await import('../../contexts/dataOwnerGeneration');
    ownerModule.__testing.reset();
    setDataOwnerGeneration = ownerModule.setDataOwnerGeneration;
    setDataOwnerGeneration('account-a');
    ({ useGatewayModelPricing, useReferenceModelPricing } = await import('../useModelPricing'));
  });

  it('does not let a stale initial IPC result overwrite a newer XD pricing push', async () => {
    const initialRead = deferred<ModelPricingCatalog | null>();
    const listeners = new Set<PricingListener>();
    const usage = {
      getModelPricing: vi.fn(() => initialRead.promise),
      onModelPricingChanged: vi.fn((listener: PricingListener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }),
    };
    (window as unknown as { electronAPI: { maker: { usage: typeof usage } } }).electronAPI = {
      maker: { usage },
    };
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

    const hook = renderHook(() => useGatewayModelPricing());
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

  it('keeps XD pricing when the reference catalog becomes invalid', async () => {
    const referenceListeners = new Set<PricingListener>();
    const gatewayPricing: ModelPricingCatalog = {
      xd: {
        model: {
          providerId: 'xd',
          modelId: 'model',
          currency: 'CNY',
          source: 'gateway',
          approximate: false,
          inputPerMtok: 3,
          outputPerMtok: 6,
        },
      },
    };
    const usage = {
      getModelPricing: vi.fn(async () => gatewayPricing),
      onModelPricingChanged: vi.fn(() => () => undefined),
      getReferenceModelPricing: vi.fn(async () => ({
        openai: {
          model: {
            providerId: 'openai',
            modelId: 'model',
            currency: 'USD',
            source: 'provider-reference',
            approximate: true,
            inputPerMtok: 1,
            outputPerMtok: 2,
          },
        },
      })),
      onReferenceModelPricingChanged: vi.fn((listener: PricingListener) => {
        referenceListeners.add(listener);
        return () => referenceListeners.delete(listener);
      }),
    };
    (window as unknown as { electronAPI: { maker: { usage: typeof usage } } }).electronAPI = {
      maker: { usage },
    };

    const hook = renderHook(() => ({
      gateway: useGatewayModelPricing(),
      reference: useReferenceModelPricing(),
    }));
    await waitFor(() => expect(hook.result.current.gateway).toEqual(gatewayPricing));

    act(() => {
      for (const listener of referenceListeners) listener({ xd: gatewayPricing.xd });
    });
    expect(hook.result.current.reference).toBeNull();
    expect(hook.result.current.gateway).toEqual(gatewayPricing);
  });

  it('accepts agent-scoped user overrides in the reference catalog', async () => {
    const referencePricing: ModelPricingCatalog = {
      anthropic: {
        ['claude-sonnet-5\u0000claude-code']: {
          providerId: 'anthropic',
          modelId: 'claude-sonnet-5',
          currency: 'USD',
          source: 'user-override',
          approximate: true,
          inputPerMtok: 3,
          outputPerMtok: 15,
        },
      },
    };
    const usage = {
      getReferenceModelPricing: vi.fn(async () => referencePricing),
      onReferenceModelPricingChanged: vi.fn(() => () => undefined),
    };
    (window as unknown as { electronAPI: { maker: { usage: typeof usage } } }).electronAPI = {
      maker: { usage },
    };

    const hook = renderHook(() => useReferenceModelPricing());
    await waitFor(() => expect(hook.result.current).toEqual(referencePricing));
  });

  it('reloads both pricing chains after the data owner changes', async () => {
    const gatewayA: ModelPricingCatalog = {
      xd: {
        model: {
          providerId: 'xd',
          modelId: 'model',
          currency: 'CNY',
          source: 'gateway',
          approximate: false,
          inputPerMtok: 1,
          outputPerMtok: 2,
        },
      },
    };
    const gatewayB: ModelPricingCatalog = {
      xd: {
        model: {
          providerId: 'xd',
          modelId: 'model',
          currency: 'USD',
          source: 'gateway',
          approximate: false,
          inputPerMtok: 3,
          outputPerMtok: 6,
        },
      },
    };
    const referenceA: ModelPricingCatalog = {
      openai: {
        model: {
          providerId: 'openai',
          modelId: 'model',
          currency: 'CNY',
          source: 'user-override',
          approximate: true,
          inputPerMtok: 10,
          outputPerMtok: 20,
        },
      },
    };
    const referenceB: ModelPricingCatalog = {
      openai: {
        model: {
          providerId: 'openai',
          modelId: 'model',
          currency: 'USD',
          source: 'provider-reference',
          approximate: true,
          inputPerMtok: 4,
          outputPerMtok: 8,
        },
      },
    };
    const usage = {
      getModelPricing: vi
        .fn<() => Promise<ModelPricingCatalog | null>>()
        .mockResolvedValueOnce(gatewayA)
        .mockResolvedValueOnce(gatewayB),
      onModelPricingChanged: vi.fn(() => () => undefined),
      getReferenceModelPricing: vi
        .fn<() => Promise<ModelPricingCatalog | null>>()
        .mockResolvedValueOnce(referenceA)
        .mockResolvedValueOnce(referenceB),
      onReferenceModelPricingChanged: vi.fn(() => () => undefined),
    };
    (window as unknown as { electronAPI: { maker: { usage: typeof usage } } }).electronAPI = {
      maker: { usage },
    };

    const first = renderHook(() => ({
      gateway: useGatewayModelPricing(),
      reference: useReferenceModelPricing(),
    }));
    await waitFor(() =>
      expect(first.result.current).toEqual({
        gateway: gatewayA,
        reference: referenceA,
      }),
    );
    first.unmount();

    setDataOwnerGeneration('account-b');
    const second = renderHook(() => ({
      gateway: useGatewayModelPricing(),
      reference: useReferenceModelPricing(),
    }));
    expect(second.result.current).toEqual({ gateway: null, reference: null });
    await waitFor(() =>
      expect(second.result.current).toEqual({
        gateway: gatewayB,
        reference: referenceB,
      }),
    );

    expect(usage.getModelPricing).toHaveBeenCalledTimes(2);
    expect(usage.getReferenceModelPricing).toHaveBeenCalledTimes(2);
  });

  it('ignores a pricing read that completes after the data owner changes', async () => {
    const staleRead = deferred<ModelPricingCatalog | null>();
    const freshPricing: ModelPricingCatalog = {
      xd: {
        model: {
          providerId: 'xd',
          modelId: 'model',
          currency: 'USD',
          source: 'gateway',
          approximate: false,
          inputPerMtok: 5,
          outputPerMtok: 10,
        },
      },
    };
    const stalePricing: ModelPricingCatalog = {
      xd: {
        model: {
          providerId: 'xd',
          modelId: 'model',
          currency: 'CNY',
          source: 'gateway',
          approximate: false,
          inputPerMtok: 1,
          outputPerMtok: 2,
        },
      },
    };
    const usage = {
      getModelPricing: vi
        .fn<() => Promise<ModelPricingCatalog | null>>()
        .mockImplementationOnce(() => staleRead.promise)
        .mockResolvedValueOnce(freshPricing),
      onModelPricingChanged: vi.fn(() => () => undefined),
    };
    (window as unknown as { electronAPI: { maker: { usage: typeof usage } } }).electronAPI = {
      maker: { usage },
    };

    const first = renderHook(() => useGatewayModelPricing());
    await waitFor(() => expect(usage.getModelPricing).toHaveBeenCalledOnce());
    first.unmount();

    setDataOwnerGeneration('account-b');
    const second = renderHook(() => useGatewayModelPricing());
    await waitFor(() => expect(second.result.current).toEqual(freshPricing));

    await act(async () => {
      staleRead.resolve(stalePricing);
      await staleRead.promise;
    });
    expect(second.result.current).toEqual(freshPricing);
  });
});
