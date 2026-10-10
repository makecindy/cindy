import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BUNDLED_CATALOG, type Catalog, type ProviderView } from '@cindy/model-providers';

const state = vi.hoisted(() => ({
  owner: 'cursor-route-owner',
  suspended: false,
  disabled: false,
  listProviders: vi.fn(),
}));
vi.mock('../../appSessionState.js', () => ({ activeOwnerScopeKey: () => state.owner }));
vi.mock('../active-catalog.js', () => ({
  getActiveCatalog: () => BUNDLED_CATALOG,
  isXdGatewayPaymentRequiredRoute: () => false,
}));
vi.mock('../createDesktopProviderService.js', () => ({
  getDesktopProviderService: () => ({ listProviders: state.listProviders }),
}));
vi.mock('../model-disable-store.js', () => ({ readModelDisableOverrides: () => ({}) }));

import { clearCursorDiscoveredModels, setCursorDiscoveredModels } from '../cursor-model-catalog.js';
import { pinExclusiveSessionProvider, verdictForModelRoute } from '../model-route-guard-live.js';

describe('Cursor native model route admission', () => {
  beforeEach(() => {
    state.suspended = false;
    state.disabled = false;
    clearCursorDiscoveredModels();
    setCursorDiscoveredModels([{
      id: 'native-cursor-model', displayName: 'Native Cursor model', contextWindow: 0,
      efforts: [], defaultEffort: null,
    }], state.owner);
    state.listProviders.mockImplementation(async ({ catalog }: { catalog: Catalog }): Promise<ProviderView[]> => {
      const cursor = catalog.providers.find(provider => provider.id === 'cursor')!;
      return [{ ...cursor, connected: true, suspended: state.suspended,
        models: { cursor: (cursor.models.cursor ?? []).map(model => ({ ...model, disabled: state.disabled })) } }];
    });
  });

  it('uses discovered membership when applying a suspended Cursor connection', async () => {
    state.suspended = true;
    await expect(verdictForModelRoute('cursor', 'native-cursor-model', 'cursor'))
      .resolves.toEqual({ kind: 'reject', reason: 'explicit-source-disabled' });
    await expect(verdictForModelRoute('cursor', 'native-cursor-model', null))
      .resolves.toEqual({ kind: 'reject', reason: 'model-disabled' });
  });

  it('rejects a disabled native model and permits it after re-enabling', async () => {
    state.disabled = true;
    await expect(verdictForModelRoute('cursor', 'native-cursor-model', 'cursor'))
      .resolves.toEqual({ kind: 'reject', reason: 'explicit-source-disabled' });
    state.disabled = false;
    await expect(verdictForModelRoute('cursor', 'native-cursor-model', 'cursor'))
      .resolves.toEqual({ kind: 'pass' });
  });

  it('keeps existing-session resume separate from new-route admission', async () => {
    state.suspended = true;
    await expect(pinExclusiveSessionProvider('cursor', 'native-cursor-model', 'cursor'))
      .resolves.toBeUndefined();
  });
  it('continues accepting the historical default alias while enforcing its native source state', async () => {
    await expect(verdictForModelRoute('cursor', 'cursor-default', 'cursor')).resolves.toEqual({ kind: 'pass' });
    state.suspended = true;
    await expect(verdictForModelRoute('cursor', 'cursor-default', 'cursor'))
      .resolves.toEqual({ kind: 'reject', reason: 'explicit-source-disabled' });
  });
});
