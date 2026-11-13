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
import { themeService } from '../../themes/theme-service';
import { DEFAULT_APPEARANCE_SETTINGS } from '../../../shared/appearanceSettings';

vi.mock('../../lib/toast', () => ({ toast: { error: vi.fn() } }));
vi.mock('../../i18n', () => ({ default: { t: (key: string) => key } }));

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
    let pending!: Promise<void>;
    act(() => { pending = receive(input); });
    expect(state.reply).toHaveBeenCalledTimes(1); // Builtins retain the synchronous request path.
    await pending;
    expect(state.reply).toHaveBeenCalledWith(expect.objectContaining({ ok: true,
      state: expect.objectContaining({ theme: 'dark', themeFamily: 'default' }) }));
    expect(localStorage.getItem('theme')).toBe('dark');
    expect(localStorage.getItem('theme.familyId')).toBe('default');
  });

  // Unit through the mounted Agent bridge and real ThemeProvider: a mixed
  // mode/family update must wait before either write, then return its actual
  // result. Old persistence-only coverage confirmed a rejected package too early.
  // One deferred preparation also covers owner/deadline cancellation at commit.
  it.each(['success', 'failure', 'owner', 'deadline', 'superseded'] as const)(
    'confirms package preparation before committing an Agent update (%s)', async outcome => {
      const selectTheme = vi.fn().mockResolvedValue(DEFAULT_APPEARANCE_SETTINGS);
      let complete!: (value: typeof DEFAULT_APPEARANCE_SETTINGS) => void;
      let reject!: (error: Error) => void;
      selectTheme.mockImplementationOnce(() => new Promise((resolve, fail) => { complete = resolve; reject = fail; }));
      Object.assign(window.electronAPI, { appearanceSettings: { selectTheme,
        getSync: () => DEFAULT_APPEARANCE_SETTINGS, onChanged: () => () => {},
      } });
      window.electronAPI.localThemes.listSync = () => ({ ...payload(), themes: [
        ...payload().themes,
        ...(['light', 'dark'] as const).map(type => ({ id: `paper-${type}-local`, family: 'paper',
          name: 'Paper', type, colors: {}, packageSha256: 'a'.repeat(64), appearance: { density: 0.9 } })),
      ] });
      bootstrapLocalThemesSync();
      const originalTheme = themeService.getCurrentTheme();
      const writes = vi.spyOn(Storage.prototype, 'setItem');
      const input = { ...request(), operation: 'update' as const,
        patch: { theme: 'dark' as const, themeFamily: 'paper-local' } };
      let pending!: Promise<void>;
      act(() => { pending = receive(input); });
      expect(state.reply).not.toHaveBeenCalled();
      expect(writes).not.toHaveBeenCalled();
      expect(localStorage.getItem('theme')).toBe('system');
      expect(localStorage.getItem('theme.familyId')).toBe('old-local');
      expect(themeService.getCurrentTheme()).toBe(originalTheme);
      if (outcome === 'owner') state.current = false;
      if (outcome === 'deadline') vi.spyOn(Date, 'now').mockReturnValue(input.expiresAt + 1);
      if (outcome === 'superseded') {
        await act(async () => { await receive({ ...request(), requestId: 'newer', operation: 'update',
          patch: { themeFamily: 'default' } }); });
        state.reply.mockClear();
      }
      await act(async () => {
        if (outcome === 'failure') reject(new Error('Invalid theme resource'));
        else complete(DEFAULT_APPEARANCE_SETTINGS);
        await pending;
      });
      const success = outcome === 'success';
      expect(state.reply).toHaveBeenCalledExactlyOnceWith(success ? expect.objectContaining({
        requestId: input.requestId, ok: true,
        state: expect.objectContaining({ theme: 'dark', themeFamily: 'paper-local' }),
      }) : { requestId: input.requestId, ok: false });
      expect(localStorage.getItem('theme')).toBe(success ? 'dark' : 'system');
      expect(localStorage.getItem('theme.familyId')).toBe(success ? 'paper-local' : outcome === 'superseded' ? 'default' : 'old-local');
      if (!success && outcome !== 'superseded') expect(writes).not.toHaveBeenCalled();
      if (outcome === 'owner' || outcome === 'deadline') expect(selectTheme).toHaveBeenLastCalledWith(null);
      if (outcome === 'failure') expect(themeService.getCurrentTheme()).toBe(originalTheme);
    },
  );

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
