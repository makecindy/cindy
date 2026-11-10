// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppPreferenceRequest } from '../../../shared/appPreferenceControl';

const state = vi.hoisted(() => ({ current: true, families: ['old-local'], refresh: vi.fn(), reply: vi.fn() }));
vi.mock('@/contexts/dataOwnerGeneration', () => ({ isDataOwnerPushStampCurrent: () => state.current }));
vi.mock('@/themes/local-themes', () => ({ refreshLocalThemes: state.refresh }));
vi.mock('@/themes/families', () => ({ getThemeFamilies: () => state.families.map(id => ({ id })), tryGetFamily: () => ({}) }));
vi.mock('@/state/modelVisibilityPrefs', () => ({ setModelVisibility: vi.fn(), resetModelVisibilities: vi.fn(), isModelEnabled: vi.fn(), isModelVisibilityCustomized: vi.fn() }));
vi.mock('@/lib/memorySettingsStore', () => ({ setMakerMemoryEnabled: vi.fn() }));
vi.mock('@/hooks/useTheme', () => ({ useTheme: () => ({ theme: 'system', familyId: 'old-local' }) }));
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

let receive: (request: AppPreferenceRequest) => Promise<void>;
const request = (): AppPreferenceRequest => ({ requestId: 'refresh', operation: 'refresh-themes',
  ownerStamp: {} as AppPreferenceRequest['ownerStamp'], expiresAt: Date.now() + 5000 });
beforeEach(() => {
  state.current = true;
  state.families = ['old-local'];
  state.reply.mockReset();
  state.refresh.mockReset();
  window.electronAPI = { appPreferenceControl: {
    onSettingsChanged: () => () => {},
    onRequest: (listener: typeof receive) => { receive = listener; return () => {}; }, reply: state.reply,
  } } as never;
  render(<AppPreferenceControl />);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

/** Unit: real mounted host-request bridge, not a view snapshot. Screenshot
 * regression: Agent installation did not refresh the theme cache. Existing
 * palette tests cannot prove refresh confirmation or stale-owner rejection.
 * Minimum input is one refresh request; deferred promises exercise its lifetime. */
describe('theme refresh confirmation', () => {
  it('waits for the cache and returns fresh families while retaining the selection', async () => {
    state.refresh.mockImplementationOnce(async () => { state.families.push('new-local'); return { success: true }; });
    await receive(request());
    expect(state.reply).toHaveBeenCalledWith(expect.objectContaining({ ok: true,
      state: expect.objectContaining({ theme: 'system', themeFamily: 'old-local' }), themeFamilies: ['old-local', 'new-local'] }));
  });

  it('does not confirm a failed refresh as installed in the current view', async () => {
    state.refresh.mockResolvedValueOnce({ success: false });
    await receive(request());
    expect(state.reply).toHaveBeenCalledWith({ requestId: 'refresh', ok: false });
  });

  it.each(['owner', 'deadline'] as const)('rejects a %s change while refresh is pending', async changed => {
    let finish!: (result: { success: boolean }) => void;
    state.refresh.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const input = request();
    const pending = receive(input);
    if (changed === 'owner') state.current = false;
    else vi.spyOn(Date, 'now').mockReturnValue(input.expiresAt + 1);
    finish({ success: true });
    await pending;
    expect(state.reply).toHaveBeenCalledWith({ requestId: 'refresh', ok: false });
  });
});
