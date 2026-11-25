import { beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';

// The app window keeps these preferences; the app preference broker is the only boundary replaced here.
const window = vi.hoisted(() => ({
  prefs: {} as Record<string, unknown>,
  updates: [] as Array<Record<string, unknown>>,
  failing: false,
}));
vi.mock('electron', () => ({ app: { getPath: () => path.join('/nonexistent', 'desktop-preference-domains') }, net: { fetch: vi.fn() } }));
vi.mock('../../logger.js', () => ({ createLogger: () => ({ info() {}, warn() {}, error() {}, debug() {} }) }));
vi.mock('../../maker-host/logger-adapter.js', () => ({ desktopMakerLogger: { child: () => ({ info() {}, warn() {}, error() {}, debug() {} }) } }));
vi.mock('../../appSessionState.js', () => ({
  activeOwnerScopeKey: () => 'owner:1', peekCommittedAppSession: () => ({ mode: 'cloud', dataOwnerId: 'fixture-owner', generation: 1 }),
  isAppSessionBoundaryPending: () => false, dataOwnerStorageKey: () => 'fixture-owner',
  ownerScopedUserDataPath: (...segments: string[]) => path.join('/nonexistent', ...segments),
}));
vi.mock('../../app-settings/preferences.js', () => ({
  manageAppPreferences: async (operation: string, patch?: Record<string, unknown>) => {
    if (window.failing) throw new Error('PREFERENCE_WINDOW_NOT_READY');
    if (operation === 'update') { window.updates.push(patch!); Object.assign(window.prefs, patch); }
    return { value: { ...window.prefs }, themeFamilies: ['cindy', 'ocean'] };
  },
}));
vi.mock('../additionalRuntime.js', () => ({
  additionalSettingsRuntime: () => null,
  additionalNativeOperations: () => ({ themeChoices: () => [{ value: 'cindy', label: 'Cindy' }, { value: 'ocean', label: 'Ocean' }] }),
}));
import { getHostSettings, updateHostSettings } from '../index.js';

const caller = { id: 'cloud-page', assertCurrent() {} };
const defaults = { theme: 'system', themeFamily: 'cindy', language: 'system', notifications: true, sendShortcut: 'enter',
  webLinks: 'external', localLinks: 'sidebar', streamFade: 'on', messageNavigation: true, showIgnoredDirectories: false,
  homeUsageDashboard: true, promptRecommendations: true, sidebarPinned: 'text', sidebarTasks: 'list',
  feishuNotifications: false, swallowActivationClick: false, networkDebug: false };
async function read(domain: 'desktopGeneral' | 'desktopChat' | 'desktopNotifications') {
  const state = await getHostSettings(caller, domain);
  if (state.status !== 'ready') throw new Error(state.status);
  return state;
}

beforeEach(() => { window.prefs = { ...defaults }; window.updates = []; window.failing = false; });

describe('cloud desktop preferences through the app preferences section', () => {
  it('reads the window preferences under the cloud field names, customized by value', async () => {
    Object.assign(window.prefs, { language: 'ja', sidebarPinned: 'card', feishuNotifications: true });
    expect(await read('desktopGeneral')).toMatchObject({
      value: { themeFamilyId: 'cindy', theme: 'system', locale: 'ja', sidebarPinnedMode: 'card', sidebarMainMode: 'list', ghostPanelRestoreMode: 'bubble' },
      customizedKeys: ['locale', 'sidebarPinnedMode'], choices: { themeFamilyId: [{ value: 'cindy' }, { value: 'ocean' }] },
    });
    expect(await read('desktopNotifications')).toMatchObject({
      value: { notificationsEnabled: true, feishuNotificationsEnabled: true, swallowActivationClick: false, networkDebugEnabled: false },
      customizedKeys: ['feishuNotificationsEnabled'],
    });
  });

  it('saves through the section, and restoring a default writes the default value', async () => {
    let state = await read('desktopChat');
    let receipt = await updateHostSettings(caller, { domain: 'desktopChat', operationId: state.operationId, expectedRevision: state.revision,
      set: { streamFadePreference: 'off', messageNavRailEnabled: false } });
    expect(receipt).toMatchObject({ saved: true, application: 'applied' });
    expect(window.updates).toEqual([{ streamFade: 'off', messageNavigation: false }]);
    state = await read('desktopChat');
    expect(state.customizedKeys).toEqual(['streamFadePreference', 'messageNavRailEnabled']);
    receipt = await updateHostSettings(caller, { domain: 'desktopChat', operationId: state.operationId, expectedRevision: state.revision,
      clear: ['streamFadePreference'] });
    expect(window.updates.at(-1)).toEqual({ streamFade: 'on' });
    expect((await read('desktopChat')).customizedKeys).toEqual(['messageNavRailEnabled']);
  });

  it('refuses a stale revision, an unknown theme and the fixed ghost panel field without writing', async () => {
    const state = await read('desktopGeneral');
    window.prefs.theme = 'dark';
    await expect(updateHostSettings(caller, { domain: 'desktopGeneral', operationId: state.operationId, expectedRevision: state.revision,
      set: { theme: 'light' } })).resolves.toMatchObject({ saved: false, code: 'CONFLICT' });
    const fresh = await read('desktopGeneral');
    await expect(updateHostSettings(caller, { domain: 'desktopGeneral', operationId: fresh.operationId, expectedRevision: fresh.revision,
      set: { themeFamilyId: 'missing' } })).resolves.toMatchObject({ saved: false, code: 'UNSUPPORTED_CAPABILITY' });
    const again = await read('desktopGeneral');
    await expect(updateHostSettings(caller, { domain: 'desktopGeneral', operationId: again.operationId, expectedRevision: again.revision,
      set: { ghostPanelRestoreMode: 'sidebar' } })).resolves.toMatchObject({ saved: false, code: 'UNSUPPORTED_CAPABILITY' });
    expect(window.updates).toEqual([]);
  });

  it('leaves the group unreadable while the app window does not answer', async () => {
    window.failing = true;
    expect(await getHostSettings(caller, 'desktopGeneral')).toEqual({ status: 'unreadable', revision: null });
  });
});
