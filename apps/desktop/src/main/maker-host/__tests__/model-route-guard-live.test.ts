import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  catalog: { modelRegistry: {} },
  listProviders: vi.fn(),
  effectiveSourceIdForModel: vi.fn(),
  readDeviceProviderViews: vi.fn(),
}));


vi.mock('@cindy/model-providers', async (importOriginal) => ({
  findCatalogModel: (await importOriginal<typeof import('@cindy/model-providers')>()).findCatalogModel,
  connectedProvidersForAgent: (await importOriginal<typeof import('@cindy/model-providers')>()).connectedProvidersForAgent,
  effectiveSourceIdForModel: h.effectiveSourceIdForModel,
  getModel: vi.fn(() => null),
  isExclusiveXaiModelId: (model: string | null | undefined) =>
    typeof model === 'string'
    && (model.startsWith('grok') || model.startsWith('xai/grok')),
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

import {
  resolveDefaultScheduleRoute,
  resolveScheduledModelSelectionLive,
  resolveLenientSessionRoute,
  isAgentOneShotRouteDisabled,
} from '../model-route-guard-live.js';

// Native ZCode has no HTTP/oneShot transport. A title/helper must not fall back
// to another provider and spend its credentials. Unit: no catalog I/O required.
it('rejects native ZCode oneShot before resolving a default HTTP route', async () => {
  h.listProviders.mockClear();
  await expect(isAgentOneShotRouteDisabled('zcode')).resolves.toBe(true);
  await expect(isAgentOneShotRouteDisabled('zcode', 'native-model')).resolves.toBe(true);
  expect(h.listProviders).not.toHaveBeenCalled();
});

// Unit: use the remote authorized catalog even when the local provider has the
// same id. An offline/revoked share must fail before trying local credentials.
describe('scheduled remote model catalog', () => {
  it('resolves only the selected computer catalog and preserves its axes', async () => {
    vi.clearAllMocks();
    h.readDeviceProviderViews.mockResolvedValue([{ id: 'shared-provider', connected: true, agents: ['pi'], routing: { pi: {} },
      models: { pi: [{ id: 'remote-model', efforts: ['high'], defaultEffort: 'high', supportsFastMode: false }] } }]);
    const choice = { agentKind: 'pi' as const, agentDeviceId: 'shared:owner', model: 'remote-model',
      providerId: 'shared-provider', effort: 'ultra' as const, fastMode: true };
    await expect(resolveScheduledModelSelectionLive(choice, h.readDeviceProviderViews)).resolves.toMatchObject({ ...choice, effort: 'high', fastMode: false });
    expect(h.listProviders).not.toHaveBeenCalled();
    expect(h.readDeviceProviderViews).toHaveBeenCalledWith('shared:owner');
    h.readDeviceProviderViews.mockRejectedValueOnce(new Error('[REMOTE_AGENT_SHARE_REMOVED] removed'));
    await expect(resolveScheduledModelSelectionLive(choice, h.readDeviceProviderViews)).rejects.toThrow('REMOTE_AGENT_SHARE_REMOVED');
    expect(h.listProviders).not.toHaveBeenCalled();
  });
});

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
          agents: ['claude-code'], routing: { 'claude-code': {} },
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

describe('resolveLenientSessionRoute provider-list outage', () => {
  it('拒绝把裸 Grok 原样放行成 providerId=null', async () => {
    h.listProviders.mockRejectedValueOnce(new Error('provider list unavailable'));
    await expect(resolveLenientSessionRoute('claude-code', 'grok-4.6', null)).resolves.toEqual({
      model: undefined,
      providerId: null,
      degraded: true,
    });
  });
});


describe('scheduled selection uses the live source copy', () => {
  it('reads the current catalog without claiming credentials and preserves the requested route', async () => {
    const selection = { agentKind: 'pi' as const, model: 'same-model', providerId: 'selected', effort: 'ultra' as const, fastMode: true };
    h.listProviders.mockResolvedValue([
      { id: 'other', connected: true, agents: ['pi'], routing: { pi: {} }, models: { pi: [{ id: 'same-model', efforts: ['ultra'], defaultEffort: 'ultra', supportsFastMode: true }] } },
      { id: 'selected', connected: true, agents: ['pi'], routing: { pi: {} }, models: { pi: [{ id: 'same-model', efforts: ['medium'], defaultEffort: 'medium', supportsFastMode: false }] } },
    ]);
    await expect(resolveScheduledModelSelectionLive(selection)).resolves.toEqual({ ...selection, effort: 'medium', fastMode: false });
    expect(h.listProviders).toHaveBeenLastCalledWith({ allowSideEffects: false, catalog: h.catalog });
    expect(selection).toMatchObject({ effort: 'ultra', fastMode: true });
  });
});
