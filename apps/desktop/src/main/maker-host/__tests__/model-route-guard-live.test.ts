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
    h.listProviders.mockResolvedValue([]);
    h.effectiveSourceIdForModel.mockReturnValue('anthropic');
  });

  it('uses a trusted provider snapshot so scheduler fire can claim native subscriptions', async () => {
    await expect(
      resolveDefaultScheduleRoute('claude-code', null, 'claude-sonnet-4-6'),
    ).resolves.toEqual({ model: 'claude-sonnet-4-6', providerId: 'anthropic' });

    expect(h.listProviders).toHaveBeenCalledWith({
      catalog: h.catalog,
      allowSideEffects: true,
    });
    expect(h.effectiveSourceIdForModel).toHaveBeenCalledWith(
      [],
      null,
      'claude-sonnet-4-6',
      'claude-code',
    );
  });
});
