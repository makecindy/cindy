// @vitest-environment jsdom

/**
 * Unit: render the production bridge and preference hooks against an in-memory preload API.
 * User request/configuration-and-overrides §2/§4: synchronize explicit overrides, including resets,
 * without converting replay/defaults into edits or claiming another account's local projection.
 * Existing hook tests cover local persistence only. Minimal failures are a pin-only legacy mode,
 * one incoming snapshot, or switching owners while the first load/write remains unresolved.
 * This new file isolates the bridge's React/preload lifecycle from the existing pure storage tests.
 */
import { createElement, type ReactNode } from 'react';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ACCOUNT_PREFERENCE_KEYS, type AccountPreferenceValues } from '@cindy/device-link';

import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { LocaleProvider, useLocale } from '@/hooks/useLocale';
import { ThemeProvider, useTheme } from '@/hooks/useTheme';
import { useSidebarCardMode, useSidebarMainViewMode } from '@/hooks/useSidebarCardMode';
import { useSidebarFilter } from '@/features/cc-agent/hooks/useSidebarFilter';
import { useTaskInfoFields } from '@/features/cc-agent/hooks/useTaskInfoFields';
import type { AccountPreferencesSnapshot } from '../../../shared/accountPreferences';
import { notifyLocalPreferenceChanged, useAccountPreferencesSync } from '../accountPreferencesSync';
import { observeStoredLocale } from '../localePreference';

vi.mock('@/i18n', () => ({ i18n: { changeLanguage: vi.fn() } }));
vi.mock('../../themes/theme-service', () => ({ themeService: { applyTheme: vi.fn() } }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

let snapshot: AccountPreferencesSnapshot;
let listeners: Array<(value: AccountPreferencesSnapshot) => void>;
let api: ElectronAPI['accountPreferences'];

function nextSnapshot(values: AccountPreferenceValues): AccountPreferencesSnapshot {
  return { dataOwnerId: 'owner-a', ownerGeneration: 1, legacyImportAllowed: false, values };
}

function emit(value: AccountPreferencesSnapshot) {
  snapshot = value;
  listeners.forEach(listener => listener(value));
}

function wrapper({ children }: { children: ReactNode }) {
  return createElement(ThemeProvider, { syncWindowVibrancy: false,
    children: createElement(LocaleProvider, null, children) });
}

function useSyncedPreferences(ownerId = 'owner-a', generation = 1) {
  useAccountPreferencesSync(ownerId, generation);
  const sidebar = useSidebarFilter(new Set(), {
    dataOwnerId: ownerId, ownerGeneration: generation,
    pinnedOrder: [], pinnedOrderIsAuthoritative: true, hiddenProjectKeys: [], hiddenMainViewGhostIds: [],
  });
  return {
    theme: useTheme(), locale: useLocale(), card: useSidebarCardMode(), main: useSidebarMainViewMode(),
    sidebar, taskInfo: useTaskInfoFields(),
  };
}

beforeEach(() => {
  localStorage.clear();
  observeStoredLocale(null);
  for (const key of ACCOUNT_PREFERENCE_KEYS) {
    const event = new Event('storage');
    Object.defineProperties(event, { key: { value: key }, newValue: { value: null } });
    window.dispatchEvent(event);
  }
  listeners = [];
  snapshot = nextSnapshot({});
  setDataOwnerGeneration('owner-a', 1);
  api = {
    load: vi.fn(async () => snapshot),
    set: vi.fn(async request => {
      const next = { ...snapshot, values: { ...snapshot.values, [request.key]: request.value } };
      emit(next);
      return next;
    }),
    importLegacy: vi.fn(async request => {
      const next = { ...snapshot, legacyImportAllowed: false,
        values: { ...request.values, ...snapshot.values } };
      emit(next);
      return next;
    }),
    onChanged: listener => {
      listeners.push(listener);
      return () => { listeners = listeners.filter(entry => entry !== listener); };
    },
  };
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    preferredSystemLocale: 'en', platform: 'linux', accountPreferences: api,
    sidebarSettings: {
      loadSnapshot: () => ({ ...nextSnapshot({}), pinnedOrder: [], pinnedOrderIsAuthoritative: true }),
      claimLegacyRendererOwner: () => ({ dataOwnerId: 'owner-a', ownerGeneration: 1, claimed: false }),
      onPinnedOrderChanged: () => () => {},
    },
  };
});

afterEach(cleanup);

describe('account preference renderer projection', () => {
  it('claims only explicit legacy values and preserves the old mode/task-info migrations', async () => {
    snapshot.legacyImportAllowed = true;
    localStorage.setItem('sidebar.cardMode', 'true');
    localStorage.setItem('cc-agent.sidebar.filter.taskInfo', '{"version":1,"fields":["cost","tags","cost","pr"]}');
    localStorage.setItem('theme.familyId', 'default');
    const view = renderHook(() => useSyncedPreferences(), { wrapper });

    await waitFor(() => expect(view.result.current.card.mode).toBe('card'));

    expect(api.importLegacy).toHaveBeenCalledExactlyOnceWith({
      dataOwnerId: 'owner-a', ownerGeneration: 1,
      values: { 'sidebar.cardMode': 'card', 'sidebar.mainListMode': 'list',
        'cc-agent.sidebar.filter.taskInfo': '["cost","pr"]' },
    });
    expect(view.result.current.taskInfo.fields).toEqual(['cost', 'pr']);
    expect(localStorage.getItem('theme.familyId')).toBe('default');
    expect(api.set).not.toHaveBeenCalled();
  });

  it('projects all nine incoming preferences and reset tombstones into mounted consumers without echo', async () => {
    const view = renderHook(() => useSyncedPreferences(), { wrapper });
    await act(async () => {});
    act(() => emit(nextSnapshot({
      theme: 'dark', language: 'ja', 'sidebar.cardMode': 'card', 'sidebar.mainListMode': 'text',
      'cc-agent.sidebar.filter.groupBy': 'flat', 'cc-agent.sidebar.filter.groupDialogue': 'false',
      'cc-agent.sidebar.filter.groupDevice': 'false', 'cc-agent.sidebar.filter.sortBy': 'priority',
      'cc-agent.sidebar.filter.taskInfo': '["cost","pr"]',
    })));
    expect(view.result.current.theme.theme).toBe('dark');
    expect(view.result.current.locale.effectiveLocale).toBe('ja');
    expect(document.documentElement.lang).toBe('ja');
    expect(view.result.current.card.mode).toBe('card');
    expect(view.result.current.main.mode).toBe('text');
    expect(view.result.current.sidebar).toMatchObject({ groupBy: 'flat', groupDialogue: false,
      groupDevice: false, sortBy: 'priority' });
    expect(view.result.current.taskInfo.fields).toEqual(['cost', 'pr']);

    act(() => emit(nextSnapshot(Object.fromEntries(ACCOUNT_PREFERENCE_KEYS.map(key => [key, null])))));
    expect(view.result.current.theme.theme).toBe('system');
    expect(view.result.current.locale.locale).toBe('system');
    expect(view.result.current.card.mode).toBe('text');
    expect(view.result.current.sidebar).toMatchObject({ groupBy: 'project', groupDialogue: true,
      groupDevice: true, sortBy: 'recency' });
    expect(view.result.current.taskInfo.fields).toEqual(['time']);
    expect(ACCOUNT_PREFERENCE_KEYS.every(key => localStorage.getItem(key) === null)).toBe(true);
    expect(api.set).not.toHaveBeenCalled();
  });

  it('submits explicit edits from each existing setter with the current owner stamp', async () => {
    const view = renderHook(() => useSyncedPreferences(), { wrapper });
    await act(async () => {});
    act(() => {
      view.result.current.theme.setTheme('dark');
      view.result.current.locale.setLocale('ja');
      view.result.current.card.setMode('card');
      view.result.current.main.setMode('text');
      view.result.current.sidebar.setGroupBy('flat');
      view.result.current.sidebar.setGroupDialogue(false);
      view.result.current.sidebar.setGroupDevice(false);
      view.result.current.sidebar.setSortBy('priority');
      view.result.current.taskInfo.toggleField('cost');
    });
    await waitFor(() => expect(api.set).toHaveBeenCalledTimes(9));
    expect(vi.mocked(api.set).mock.calls.map(([request]) => request.key)).toEqual(ACCOUNT_PREFERENCE_KEYS);
    expect(vi.mocked(api.set).mock.calls.every(([request]) => request.dataOwnerId === 'owner-a'
      && request.ownerGeneration === 1)).toBe(true);
    expect(snapshot.values['cc-agent.sidebar.filter.taskInfo']).toBe('["time","cost"]');
    expect(view.result.current.theme.theme).toBe('dark');
  });

  it('discards an old load, queued edit and late push when changing accounts, without importing the old projection', async () => {
    const oldLoad = deferred<AccountPreferencesSnapshot>();
    vi.mocked(api.load).mockImplementationOnce(() => oldLoad.promise);
    localStorage.setItem('theme', 'dark');
    localStorage.setItem('accountPreferences.projectionOwner.v1', 'owner-a');
    const view = renderHook(({ ownerId, generation }) => useSyncedPreferences(ownerId, generation), {
      initialProps: { ownerId: 'owner-a', generation: 1 }, wrapper,
    });
    const stalePush = listeners[0];
    act(() => view.result.current.theme.setTheme('light'));
    snapshot = { dataOwnerId: 'owner-b', ownerGeneration: 2, values: {}, legacyImportAllowed: true };
    act(() => {
      setDataOwnerGeneration('owner-b', 2);
      view.rerender({ ownerId: 'owner-b', generation: 2 });
    });
    await act(async () => {
      oldLoad.resolve(nextSnapshot({ theme: 'dark' }));
      stalePush(nextSnapshot({ theme: 'dark' }));
    });
    await waitFor(() => expect(api.importLegacy).toHaveBeenCalledOnce());
    expect(api.importLegacy).toHaveBeenCalledWith({ dataOwnerId: 'owner-b', ownerGeneration: 2, values: {} });
    expect(localStorage.getItem('theme')).toBeNull();
    expect(view.result.current.theme.theme).toBe('system');
    expect(api.set).not.toHaveBeenCalled();
  });

  it('preserves an explicit local reset while an older write snapshot is replayed', async () => {
    snapshot = nextSnapshot({ theme: 'dark' });
    const view = renderHook(() => useSyncedPreferences(), { wrapper });
    await act(async () => {});
    const saved = deferred<AccountPreferencesSnapshot>();
    vi.mocked(api.set).mockImplementationOnce(() => saved.promise);
    act(() => {
      localStorage.removeItem('theme');
      notifyLocalPreferenceChanged('theme', null);
      emit(nextSnapshot({ theme: 'dark' }));
    });
    expect(localStorage.getItem('theme')).toBeNull();
    expect(view.result.current.theme.theme).toBe('system');
    await act(async () => saved.resolve(nextSnapshot({ theme: null })));
    expect(api.set).toHaveBeenCalledExactlyOnceWith({
      dataOwnerId: 'owner-a', ownerGeneration: 1, key: 'theme', value: null,
    });
    expect(view.result.current.theme.theme).toBe('system');
  });

  it('cannot apply an already-sent write reply or send its queued successor across an owner generation', async () => {
    const view = renderHook(({ generation }) => useSyncedPreferences('owner-a', generation), {
      initialProps: { generation: 1 }, wrapper,
    });
    await act(async () => {});
    const saved = deferred<AccountPreferencesSnapshot>();
    vi.mocked(api.set).mockImplementationOnce(() => saved.promise);
    act(() => {
      view.result.current.theme.setTheme('dark');
      view.result.current.locale.setLocale('ja');
    });
    await waitFor(() => expect(api.set).toHaveBeenCalledOnce());
    snapshot = { dataOwnerId: 'owner-a', ownerGeneration: 2,
      legacyImportAllowed: false, values: { theme: 'light', language: 'en' } };
    act(() => {
      setDataOwnerGeneration('owner-a', 2);
      view.rerender({ generation: 2 });
    });
    await act(async () => saved.resolve(nextSnapshot({ theme: 'dark' })));
    expect(view.result.current.theme.theme).toBe('light');
    expect(view.result.current.locale.effectiveLocale).toBe('en');
    expect(localStorage.getItem('theme')).toBe('light');
    expect(api.set).toHaveBeenCalledOnce();
  });
});
