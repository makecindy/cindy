// @vitest-environment jsdom
/**
 * Regression: plugin picks lost nonselected effort/Fast and wrote persistent
 * engine/favorite preferences even when cancelled. Mount the production plugin,
 * shared selector and preference hook; only native view/transport are replaced.
 * Minimal inputs: edit an ordinary row, edit the initial selection, cancel edits.
 * Observable results are the full host reply and zero persistent writes. Tier: unit.
 * Existing native-view tests replace ModelPickerSheet; unifiedMobilePicker tests
 * replace the preferences hook. This file needs both real layers in one environment.
 * Standalone wall time: 2.24s (2026-10-28).
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PluginModelPicker } from '@/plugins/PluginModelPicker';
import type { PluginModelPickerRequest } from '@cindy/device-link';

const state = vi.hoisted(() => ({
  view: null as any,
  setItem: vi.fn(async () => {}),
  saveFavorites: vi.fn(async () => {}),
  favorites: [] as any[],
  answer: vi.fn(async () => ({ handled: true, accepted: true })),
  maker: { getCapabilities: vi.fn(async () => ({ hasFastMode: true, availableModels: [] })) },
}));
vi.mock('react-native', () => ({ Platform: { OS: 'android' }, Alert: { alert: vi.fn() } }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'draft-favorite' }));
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: async () => null, setItem: state.setItem },
}));
vi.mock('@/auth/authOwnerGeneration', () => ({
  getMobileAuthOwner: () => ({ accountKey: 'owner' }), isMobileAuthOwnerCurrent: () => true,
}));
vi.mock('@/device-link/useDeviceProviders', () => ({
  useDeviceProviders: () => ({ ready: true, providers: [{ id: 'account', name: 'Account', connected: true, models: {} }] }),
}));
vi.mock('@/device-link/useMobileMakerTransport', () => ({ useMobileMakerTransport: () => state.maker }));
vi.mock('@/session/ModelPickerSheet', async () => {
  const { UnifiedModelPickerSheet } = await import('@/session/UnifiedModelPickerSheet');
  return { ModelPickerSheet: (props: any) => createElement(UnifiedModelPickerSheet, props) };
});
vi.mock('@/session/UnifiedModelPickerView', () => ({
  UnifiedModelPickerView: (props: any) => { state.view = props; return null; },
}));
vi.mock('@/session/useRemoteMobileFavorites', () => ({
  useRemoteMobileFavorites: () => ({ ready: true, items: state.favorites, save: state.saveFavorites }),
}));
vi.mock('@/session/useMobileModelQuotas', () => ({ useMobileModelQuotas: () => ({ quotas: {}, now: 0 }) }));
vi.mock('@/session/providerModelSections', () => ({ buildMobileModelSections: () => ({ activeSourceId: 'account' }) }));
vi.mock('@/session/draftModelMemory', () => ({ useDraftModelMemoryVersion: () => 0 }));
vi.mock('@/session/sessionModelMirror', () => ({ useSessionModelMirrorVersion: () => 0 }));
vi.mock('@/session/modelPickerRows', () => ({ budgetRowDisabled: () => false, presentPickerPrice: () => null }));
vi.mock('@/session/unifiedMobileModels', async (original) => ({
  ...await original<any>(),
  mobileUnifiedEntries: () => [{
    providerId: 'account', modelId: 'model', displayName: 'Model', candidates: ['codex', 'claude-code'],
    recommended: 'codex', nativeAgent: 'codex',
    capabilities: {
      codex: { wireModelId: 'codex/model', efforts: ['medium', 'high'], defaultEffort: 'medium', supportsFastMode: true },
      'claude-code': { wireModelId: 'model', efforts: ['medium', 'high'], defaultEffort: 'medium', supportsFastMode: true },
    },
  }],
}));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
const request: PluginModelPickerRequest = {
  requestId: 'request', ghostId: 'plugin', ghostName: 'Plugin', expiresAt: Date.now() + 90_000,
};
beforeEach(() => {
  state.setItem.mockClear();
  state.saveFavorites.mockClear();
  state.answer.mockClear();
  state.favorites = [];
  root = createRoot(document.createElement('div'));
});
afterEach(() => act(() => root.unmount()));
async function mount(initial?: PluginModelPickerRequest['initial'], key = 'request') {
  await act(async () => root.render(createElement(PluginModelPicker, {
    key, request: { ...request, requestId: key, initial }, deviceId: 'host', onAnswer: state.answer,
  })));
}
const ordinaryRow = () => state.view.groups.flatMap((group: any) => group.rows).find((row: any) => !row.favorite);
function expectNoWrites() {
  expect(state.setItem).not.toHaveBeenCalled();
  expect(state.saveFavorites).not.toHaveBeenCalled();
}
it('returns the effort and Fast edited on an initially unselected row', async () => {
  await mount();
  await act(async () => state.view.onOptions(ordinaryRow()));
  await act(async () => state.view.options.onChange({ ...state.view.options.row.config, effort: 'high', fast: true }));
  expect(ordinaryRow().config).toMatchObject({ effort: 'high', fast: true });
  expect(state.answer).not.toHaveBeenCalled();
  await act(async () => state.view.onSelect(ordinaryRow()));
  expect(state.answer).toHaveBeenCalledExactlyOnceWith({
    agentKind: 'codex', providerId: 'account', model: 'codex/model', effort: 'high', fastMode: true,
  });
  expectNoWrites();
});
it('edits an initial selection without answering until the user selects the row', async () => {
  await mount({ agentKind: 'codex', providerId: 'account', model: 'codex/model', effort: 'medium', fastMode: false });
  await act(async () => state.view.onOptions(ordinaryRow()));
  await act(async () => state.view.options.onChange({ ...state.view.options.row.config, effort: 'high', fast: true }));
  expect(state.answer).not.toHaveBeenCalled();
  expect(ordinaryRow().config).toMatchObject({ effort: 'high', fast: true });
  await act(async () => state.view.onSelect(ordinaryRow()));
  expect(state.answer).toHaveBeenCalledExactlyOnceWith({
    agentKind: 'codex', providerId: 'account', model: 'codex/model', effort: 'high', fastMode: true,
  });
  expectNoWrites();
});
it('discards engine and favorite edits on cancellation and starts the next request cleanly', async () => {
  await mount();
  await act(async () => state.view.onOptions(ordinaryRow()));
  await act(async () => state.view.options.onChange({
    ...state.view.options.row.config, agent: 'claude-code', modelId: 'model', effort: 'high',
  }));
  expect(ordinaryRow().config).toMatchObject({ agent: 'claude-code', effort: 'high' });
  await act(async () => state.view.options.onFavorite());
  expect(state.view.groups[0].key).toBe('favorites');
  await act(async () => state.view.onClose());
  expect(state.answer).toHaveBeenCalledExactlyOnceWith(null);
  expectNoWrites();
  await mount(undefined, 'next-request');
  expect(ordinaryRow().config).toMatchObject({ agent: 'codex', effort: 'medium', fast: false });
  expect(state.view.groups.some((group: any) => group.key === 'favorites')).toBe(false);
  expectNoWrites();
});
