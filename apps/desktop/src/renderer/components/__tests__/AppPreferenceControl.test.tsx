// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppPreferenceRequest } from '../../../shared/appPreferenceControl';

const state = vi.hoisted(() => ({ current: true, families: ['old-local'], refresh: vi.fn(), reply: vi.fn() }));
vi.mock('@/contexts/dataOwnerGeneration', () => ({ isDataOwnerPushStampCurrent: () => state.current }));
vi.mock('@/state/modelVisibilityPrefs', () => ({ setModelVisibility: vi.fn(), resetModelVisibilities: vi.fn(), isModelEnabled: vi.fn(), isModelVisibilityCustomized: vi.fn() }));
vi.mock('@/lib/memorySettingsStore', () => ({ setMakerMemoryEnabled: vi.fn() }));
vi.mock('@/hooks/useLocale', () => ({ useLocale: () => ({ locale: 'zh-CN' }) }));
vi.mock('@/hooks/useNotificationSettings', () => ({ useNotificationSettings: () => ({ enabled: true }) }));
vi.mock('@/hooks/useComposerSendShortcutPreference', () => ({ useComposerSendShortcutPreference: () => ({ preference: 'enter' }) }));
vi.mock('@/hooks/useLinkOpenPreference', () => ({ useLinkOpenPreference: () => ({ preference: 'external' }) }));
vi.mock('@/hooks/useStreamFadePreference', () => ({ useStreamFadePreference: () => ({ preference: 'on' }) }));
vi.mock('@/hooks/useMessageNavRailPreference', () => ({ useMessageNavRailPreference: () => ({ enabled: true }) }));
vi.mock('@/hooks/useFileBrowserPreference', () => ({ useFileBrowserPreference: () => ({ showIgnoredDirs: false }) }));
vi.mock('@/hooks/useHomeUsageDashboardPreference', () => ({ useHomeUsageDashboardPreference: () => ({ enabled: true }) }));
vi.mock('@/hooks/usePromptRecommendationPreference', () => ({ usePromptRecommendationPreference: () => ({ enabled: true }) }));

import { AppPreferenceControl } from '../AppPreferenceControl';
import { ThemeProvider, __resetLoginFirstLaunchLightGateForTest } from '../../hooks/useTheme';
import { bootstrapLocalThemesSync } from '../../themes/local-themes';
import { getThemeFamilies } from '../../themes/families';

let receive: (request: AppPreferenceRequest) => Promise<void>;
const request = (): AppPreferenceRequest => ({ requestId: 'refresh', operation: 'refresh-themes',
  ownerStamp: {} as AppPreferenceRequest['ownerStamp'], expiresAt: Date.now() + 5000 });
const payload = () => ({ success: true as const, diagnostics: [], themes: state.families.map(id => ({
  id, name: id, type: 'light' as const, colors: {},
})) });
beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('theme', 'system');
  localStorage.setItem('theme.familyId', 'old-local');
  __resetLoginFirstLaunchLightGateForTest();
  state.current = true;
  state.families = ['old-local'];
  state.reply.mockReset();
  state.refresh.mockReset();
  window.electronAPI = { localThemes: {
    listSync: payload, list: state.refresh, onChanged: () => () => {},
  }, appPreferenceControl: {
    onSettingsChanged: () => () => {},
    onRequest: (listener: typeof receive) => { receive = listener; return () => {}; }, reply: state.reply,
  } } as never;
  bootstrapLocalThemesSync();
  render(<ThemeProvider syncWindowVibrancy={false}><AppPreferenceControl /></ThemeProvider>);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

/** Unit: real mounted host-request bridge, not a view snapshot. Screenshot
 * regression: Agent installation did not refresh the theme cache. Existing
 * palette tests cannot prove refresh confirmation or stale-owner rejection.
 * Minimum input is one refresh request; deferred promises exercise its lifetime. */
describe('theme refresh confirmation', () => {
  // Compatibility contract: real renderer setters remain the authority, even
  // when the Agent initiates a change. Minimum input: one builtin update; unit.
  it('applies an Agent selection through the original setters and confirms browser storage', async () => {
    const input = { ...request(), operation: 'update' as const, patch: { theme: 'dark' as const, themeFamily: 'default' } };
    await act(async () => { await receive(input); });
    expect(state.reply).toHaveBeenCalledWith(expect.objectContaining({ ok: true,
      state: expect.objectContaining({ theme: 'dark', themeFamily: 'default' }) }));
    expect(localStorage.getItem('theme')).toBe('dark');
    expect(localStorage.getItem('theme.familyId')).toBe('default');
  });

  it('does not confirm a theme write when original browser storage rejects it', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Quota exceeded'); });
    const input = { ...request(), operation: 'update' as const, patch: { theme: 'dark' as const } };
    await act(async () => { await receive(input); });
    expect(state.reply).toHaveBeenCalledExactlyOnceWith({ requestId: input.requestId, ok: false });
    expect(localStorage.getItem('theme')).toBe('system');
  });

  it('waits for the cache and returns fresh families while retaining the selection', async () => {
    state.refresh.mockImplementationOnce(async () => { state.families.push('new-local'); return payload(); });
    await act(async () => { await receive(request()); });
    expect(state.reply).toHaveBeenCalledWith(expect.objectContaining({ ok: true,
      state: expect.objectContaining({ theme: 'system', themeFamily: 'old-local' }),
      themeFamilies: getThemeFamilies().map(family => family.id) }));
    expect(getThemeFamilies().map(family => family.id)).toEqual(expect.arrayContaining(['old-local', 'new-local']));
  });

  it('does not confirm a failed refresh as installed in the current view', async () => {
    state.refresh.mockResolvedValueOnce({ success: false });
    await act(async () => { await receive(request()); });
    expect(state.reply).toHaveBeenCalledWith({ requestId: 'refresh', ok: false });
  });

  it.each(['owner', 'deadline'] as const)('rejects a %s change while refresh is pending', async changed => {
    let finish!: (result: ReturnType<typeof payload>) => void;
    state.refresh.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const input = request();
    const pending = receive(input);
    if (changed === 'owner') state.current = false;
    else vi.spyOn(Date, 'now').mockReturnValue(input.expiresAt + 1);
    await act(async () => { finish(payload()); await pending; });
    expect(state.reply).toHaveBeenCalledWith({ requestId: 'refresh', ok: false });
  });
});
