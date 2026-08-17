import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  catalog: { modelRegistry: {} },
  listProviders: vi.fn(),
  effectiveSourceIdForModel: vi.fn(),
}));

vi.mock('@cindy/model-providers', () => ({
  connectedProvidersForAgent: vi.fn(() => []),
  effectiveSourceIdForModel: h.effectiveSourceIdForModel,
  getModel: vi.fn(() => null),
  isModelDisabled: vi.fn(() => false),
  isModelSelectableForNewRoute: vi.fn(() => true),
  isProviderDisabled: vi.fn(() => false),
  modelSupportsFastMode: vi.fn(() => false),
  nativeDefaultSourceId: vi.fn(() => null),
  sourcesForModel: vi.fn(() => []),
}));

vi.mock('../createDesktopProviderService.js', () => ({
  getDesktopProviderService: () => ({ listProviders: h.listProviders }),
}));

vi.mock('../active-catalog.js', () => ({
  getActiveCatalog: () => h.catalog,
}));

vi.mock('../model-disable-store.js', () => ({
  readModelDisableOverrides: vi.fn(() => ({})),
}));

vi.mock('../model-plane/modelPlanePolicy.js', () => ({
  isRegistryTombstoneForConsumer: vi.fn(() => false),
  MODEL_PLANE_POLICIES: new Map(),
}));

import { resolveDefaultScheduleRoute } from '../model-route-guard-live.js';

describe('resolveDefaultScheduleRoute', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.listProviders.mockImplementation(async (opts: { getCatalog?: () => unknown }) => {
      // Simulate the native claim/discovery side effect completing before the provider service
      // evaluates its lazy full-catalog getter.
      const dynamicModel = {
        id: 'claude-first-fire',
        supportsFastMode: false,
      };
      h.catalog = { modelRegistry: { revision: 'fresh-after-claim' } };
      const freshCatalog = opts.getCatalog?.();
      expect(freshCatalog).toBe(h.catalog);
      return [
        {
          id: 'anthropic',
          name: 'Anthropic',
          connected: true,
          source: 'bundled',
          models: { 'claude-code': [dynamicModel] },
        },
      ];
    });
    h.effectiveSourceIdForModel.mockImplementation(
      (
        views: Array<{ id: string; models: Record<string, Array<{ id: string }>> }>,
        _preferred: unknown,
        model: string,
      ) =>
        views.some((provider) =>
          Object.values(provider.models).some((models) =>
            models.some((entry) => entry.id === model),
          ),
        )
          ? 'anthropic'
          : null,
    );
  });

  it('uses a trusted provider snapshot so scheduler fire can claim native subscriptions', async () => {
    await expect(
      resolveDefaultScheduleRoute('claude-code', null, 'claude-first-fire'),
    ).resolves.toEqual({ model: 'claude-first-fire', providerId: 'anthropic' });

    expect(h.listProviders).toHaveBeenCalledWith({
      allowSideEffects: true,
      waitForDiscovery: true,
      getCatalog: expect.any(Function),
    });
    expect(h.effectiveSourceIdForModel).toHaveBeenCalledWith(
      [expect.objectContaining({ id: 'anthropic' })],
      null,
      'claude-first-fire',
      'claude-code',
    );
  });

  it('keeps the legacy null-provider fallback for a catalog-unknown Claude model', async () => {
    h.effectiveSourceIdForModel.mockReturnValue(null);

    await expect(
      resolveDefaultScheduleRoute('claude-code', null, 'claude-from-future'),
    ).resolves.toEqual({
      model: 'claude-from-future',
      providerId: null,
      catalogKnown: false,
    });
  });

  it('does not turn a catalog-known but unavailable model into a null-provider route', async () => {
    h.effectiveSourceIdForModel.mockReturnValue(null);

    await expect(
      resolveDefaultScheduleRoute('claude-code', null, 'claude-first-fire'),
    ).resolves.toBeNull();
  });
});
