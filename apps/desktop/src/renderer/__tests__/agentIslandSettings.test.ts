// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

import {
  AGENT_ISLAND_SOUND_OPTIONS,
  DEFAULT_AGENT_ISLAND_SOUND_SETTINGS,
} from '../../shared/agentIsland';
import {
  getAgentIslandDisplayTarget,
  getAgentIslandEnabled,
  getAgentIslandSubtleReminders,
  setAgentIslandSubtleReminders,
  resetAgentIslandSubtleReminders,
  getAgentIslandSoundSettings,
  isAgentIslandSoundSettingsCustomized,
  isAgentIslandSupported,
  loadAgentIslandDisplayOptions,
  resetAgentIslandSoundSettings,
  setAgentIslandDisplayTarget,
  setAgentIslandEnabled,
  syncAgentIslandEnabledToMain,
  useResyncAgentIslandSettingsAfterLogin,
  useAgentIslandSettings,
} from '@/hooks/useAgentIslandSettings';

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ warn: vi.fn() }),
}));

function installElectronApi(
  agentIsland: Record<string, unknown>,
  options: { platform?: string; osRelease?: string } = {},
): void {
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      platform: options.platform ?? 'darwin',
      osRelease: options.osRelease ?? '23.0.0',
      agentIsland,
    },
  });
}

describe('agent island settings', () => {
  afterEach(() => {
    localStorage.clear();
    Reflect.deleteProperty(window, 'electronAPI');
    vi.restoreAllMocks();
  });

  // Unit: new local preference; existing tests do not cover its persistence or
  // bootstrap delivery. A saved true value must reach main before the island opens.
  it('persists subtle reminders only after main accepts them and restores them before enabling', async () => {
    const setSubtleReminders = vi.fn(async () => ({ ok: true as const }));
    const setEnabled = vi.fn(async () => ({ ok: true as const }));
    installElectronApi({ setSubtleReminders, setEnabled });
    expect(getAgentIslandSubtleReminders()).toBe(false);
    await expect(setAgentIslandSubtleReminders(true)).resolves.toBe(true);
    expect(getAgentIslandSubtleReminders()).toBe(true);
    syncAgentIslandEnabledToMain();
    await vi.waitFor(() => expect(setEnabled).toHaveBeenCalled());
    expect(setSubtleReminders).toHaveBeenLastCalledWith(true);
    expect(setSubtleReminders.mock.invocationCallOrder.at(-1)).toBeLessThan(setEnabled.mock.invocationCallOrder[0]);
    setSubtleReminders.mockRejectedValueOnce(new Error('unavailable'));
    await expect(setAgentIslandSubtleReminders(false)).resolves.toBe(false);
    expect(getAgentIslandSubtleReminders()).toBe(true);
  });

  it('does not persist a disabled state when the preload API is stale', async () => {
    installElectronApi({});
    localStorage.setItem('notifications.agentIslandEnabled', 'true');

    await expect(setAgentIslandEnabled(false)).resolves.toBe(false);

    expect(getAgentIslandEnabled()).toBe(true);
    expect(localStorage.getItem('notifications.agentIslandEnabled')).toBe('true');
  });

  // Unit, configuration contract §4 / review #8848: resetting must remove the
  // override, not pin false. Existing switch coverage only tested saved booleans.
  it.each([true, false])('clears a subtle reminder override (%s) and updates mounted settings', async (override) => {
    const setSubtleReminders = vi.fn(async () => ({ ok: true as const }));
    installElectronApi({ setSubtleReminders });
    localStorage.setItem('notifications.agentIslandSubtleReminders', String(override));
    const { result, unmount } = renderHook(() => useAgentIslandSettings());
    expect(result.current.subtleRemindersCustomized).toBe(true);

    await act(async () => {
      await expect(result.current.resetSubtleReminders()).resolves.toBe(true);
    });
    expect(setSubtleReminders).toHaveBeenLastCalledWith(false);
    expect(localStorage.getItem('notifications.agentIslandSubtleReminders')).toBeNull();
    expect(result.current.subtleReminders).toBe(false);
    expect(result.current.subtleRemindersCustomized).toBe(false);
    unmount();
  });

  it.each(['main', 'storage'] as const)('keeps the subtle reminder override when reset fails in %s', async (failure) => {
    const setSubtleReminders = vi.fn(async () => ({ ok: true as const }));
    installElectronApi({ setSubtleReminders });
    localStorage.setItem('notifications.agentIslandSubtleReminders', 'true');
    if (failure === 'main') setSubtleReminders.mockRejectedValueOnce(new Error('unavailable'));
    else vi.spyOn(Storage.prototype, 'removeItem').mockImplementationOnce(() => { throw new Error('unavailable'); });

    await expect(resetAgentIslandSubtleReminders()).resolves.toBe(false);
    expect(localStorage.getItem('notifications.agentIslandSubtleReminders')).toBe('true');
    expect(getAgentIslandSubtleReminders()).toBe(true);
    if (failure === 'storage') expect(setSubtleReminders.mock.calls).toEqual([[false], [true]]);
  });

  it('persists the switch only after main accepts the enabled change', async () => {
    const setEnabled = vi.fn(async () => ({ ok: true as const }));
    installElectronApi({ setEnabled });
    localStorage.setItem('notifications.agentIslandEnabled', 'true');

    await expect(setAgentIslandEnabled(false)).resolves.toBe(true);

    expect(setEnabled).toHaveBeenCalledWith(false);
    expect(getAgentIslandEnabled()).toBe(false);
    expect(localStorage.getItem('notifications.agentIslandEnabled')).toBe('false');
  });

  it('syncs the persisted value to main on app bootstrap', async () => {
    const setEnabled = vi.fn(async () => ({ ok: true as const }));
    installElectronApi({ setEnabled });
    localStorage.setItem('notifications.agentIslandEnabled', 'false');

    syncAgentIslandEnabledToMain();

    await vi.waitFor(() => expect(setEnabled).toHaveBeenCalledWith(false));
  });

  it('defaults Agent Island to disabled until the user opts in', () => {
    expect(getAgentIslandEnabled()).toBe(false);
  });

  it('syncs saved preferences before enabling main', async () => {
    const setEnabled = vi.fn(async () => ({ ok: true as const }));
    const setSoundSettings = vi.fn(async () => ({ ok: true as const }));
    const setMascotSkin = vi.fn(async () => ({ ok: true as const }));
    const setDisplayTarget = vi.fn(async () => ({ ok: true as const }));
    installElectronApi({
      setEnabled,
      setSoundSettings,
      setMascotSkin,
      setDisplayTarget,
    });
    const soundSettings = {
      enabled: false,
      sounds: {
        start: { type: 'builtin', id: 'none' },
        attention: { type: 'custom', path: '/tmp/attention.wav', name: 'attention.wav' },
        complete: { type: 'custom', path: '/tmp/complete.wav', name: 'complete.wav' },
        error: { type: 'custom', path: '/tmp/error.wav', name: 'error.wav' },
        select: { type: 'custom', path: '/tmp/select.wav', name: 'select.wav' },
      },
    };
    localStorage.setItem('notifications.agentIslandEnabled', 'true');
    localStorage.setItem('notifications.agentIslandSoundSettings', JSON.stringify(soundSettings));
    localStorage.setItem('notifications.agentIslandMascotSkin', 'tarara');
    localStorage.setItem('notifications.agentIslandDisplayTarget', JSON.stringify({ mode: 'display', displayId: 7 }));

    syncAgentIslandEnabledToMain();

    await vi.waitFor(() => expect(setEnabled).toHaveBeenCalledWith(true));
    expect(setSoundSettings).toHaveBeenCalledWith(soundSettings);
    expect(setMascotSkin).toHaveBeenCalledWith('tarara');
    expect(setDisplayTarget).toHaveBeenCalledWith({ mode: 'display', displayId: 7 });
    expect(setSoundSettings.mock.invocationCallOrder[0]).toBeLessThan(setEnabled.mock.invocationCallOrder[0]);
    expect(setMascotSkin.mock.invocationCallOrder[0]).toBeLessThan(setEnabled.mock.invocationCallOrder[0]);
    expect(setDisplayTarget.mock.invocationCallOrder[0]).toBeLessThan(setEnabled.mock.invocationCallOrder[0]);
  });

  it('keeps built-in Agent Island sounds enabled by default', () => {
    expect(AGENT_ISLAND_SOUND_OPTIONS).toEqual([
      'none',
      'startup-chime',
      'ring-chime',
      'item-found',
      'gem-collect',
      'item-fanfare',
      'victory-fanfare',
      'error-buzz',
      'secret-chime',
    ]);
    expect(DEFAULT_AGENT_ISLAND_SOUND_SETTINGS).toMatchObject({
      enabled: true,
      sounds: {
        start: { type: 'builtin', id: 'startup-chime' },
        attention: { type: 'builtin', id: 'secret-chime' },
        complete: { type: 'builtin', id: 'gem-collect' },
        error: { type: 'builtin', id: 'error-buzz' },
        select: { type: 'builtin', id: 'none' },
      },
    });
  });

  it('loads persisted built-in sound ids without falling back to silent defaults', () => {
    localStorage.setItem('notifications.agentIslandSoundSettings', JSON.stringify({
      enabled: true,
      sounds: {
        start: { type: 'builtin', id: 'startup-chime' },
        attention: { type: 'builtin', id: 'secret-chime' },
        complete: { type: 'builtin', id: 'gem-collect' },
        error: { type: 'builtin', id: 'error-buzz' },
        select: { type: 'builtin', id: 'none' },
      },
    }));

    expect(getAgentIslandSoundSettings().sounds).toMatchObject({
      start: { type: 'builtin', id: 'startup-chime' },
      attention: { type: 'builtin', id: 'secret-chime' },
      complete: { type: 'builtin', id: 'gem-collect' },
      error: { type: 'builtin', id: 'error-buzz' },
      select: { type: 'builtin', id: 'none' },
    });
  });

  it('migrates legacy branded built-in sound ids to the renamed neutral ids', () => {
    localStorage.setItem('notifications.agentIslandSoundSettings', JSON.stringify({
      enabled: true,
      sounds: {
        start: { type: 'builtin', id: 'sonic-ring' },
        attention: { type: 'builtin', id: 'zelda-secret' },
        complete: { type: 'builtin', id: 'ff-victory' },
        error: { type: 'builtin', id: 'mario-incorrect' },
        select: { type: 'builtin', id: 'pokemon-item-found' },
      },
    }));

    expect(getAgentIslandSoundSettings().sounds).toEqual({
      start: { type: 'builtin', id: 'ring-chime' },
      attention: { type: 'builtin', id: 'secret-chime' },
      complete: { type: 'builtin', id: 'victory-fanfare' },
      error: { type: 'builtin', id: 'error-buzz' },
      select: { type: 'builtin', id: 'item-found' },
    });
  });

  it('falls back from removed built-in sound ids to current defaults', () => {
    localStorage.setItem('notifications.agentIslandSoundSettings', JSON.stringify({
      enabled: true,
      sounds: {
        start: { type: 'builtin', id: 'removed-start-sound' },
        attention: { type: 'builtin', id: 'removed-attention-sound' },
        complete: { type: 'builtin', id: 'removed-complete-sound' },
        error: { type: 'builtin', id: 'removed-error-sound' },
        select: { type: 'builtin', id: 'removed-select-sound' },
      },
    }));

    expect(getAgentIslandSoundSettings().sounds).toEqual(DEFAULT_AGENT_ISLAND_SOUND_SETTINGS.sounds);
  });

  it('marks malformed sound settings as customized so users can restore defaults', () => {
    localStorage.setItem('notifications.agentIslandSoundSettings', '{bad json');

    expect(getAgentIslandSoundSettings()).toEqual(DEFAULT_AGENT_ISLAND_SOUND_SETTINGS);
    expect(isAgentIslandSoundSettingsCustomized()).toBe(true);
  });

  it('clears the sound override when restoring defaults', async () => {
    const setSoundSettings = vi.fn(async () => ({ ok: true as const }));
    installElectronApi({ setSoundSettings });
    localStorage.setItem('notifications.agentIslandSoundSettings', JSON.stringify({
      enabled: false,
      sounds: {
        start: { type: 'builtin', id: 'none' },
        attention: { type: 'builtin', id: 'none' },
        complete: { type: 'builtin', id: 'none' },
        error: { type: 'builtin', id: 'none' },
        select: { type: 'builtin', id: 'none' },
      },
    }));

    expect(isAgentIslandSoundSettingsCustomized()).toBe(true);

    await expect(resetAgentIslandSoundSettings()).resolves.toBe(true);

    expect(setSoundSettings).toHaveBeenCalledWith(DEFAULT_AGENT_ISLAND_SOUND_SETTINGS);
    expect(localStorage.getItem('notifications.agentIslandSoundSettings')).toBeNull();
    expect(isAgentIslandSoundSettingsCustomized()).toBe(false);
    expect(getAgentIslandSoundSettings()).toEqual(DEFAULT_AGENT_ISLAND_SOUND_SETTINGS);
  });

  it('resyncs the persisted value after relogin', async () => {
    const setEnabled = vi.fn(async () => ({ ok: true as const }));
    installElectronApi({ setEnabled });
    localStorage.setItem('notifications.agentIslandEnabled', 'false');

    const { rerender } = renderHook(
      ({ isAuthenticated }: { isAuthenticated: boolean }) =>
        useResyncAgentIslandSettingsAfterLogin(isAuthenticated),
      { initialProps: { isAuthenticated: false } },
    );

    await Promise.resolve();
    expect(setEnabled).not.toHaveBeenCalled();

    rerender({ isAuthenticated: true });

    await vi.waitFor(() => expect(setEnabled).toHaveBeenCalledWith(false));
  });

  it('syncs the persisted value when bootstrap is already authenticated', async () => {
    const setEnabled = vi.fn(async () => ({ ok: true as const }));
    installElectronApi({ setEnabled });
    localStorage.setItem('notifications.agentIslandEnabled', 'false');

    renderHook(
      ({ isAuthenticated }: { isAuthenticated: boolean }) =>
        useResyncAgentIslandSettingsAfterLogin(isAuthenticated),
      { initialProps: { isAuthenticated: true } },
    );

    await vi.waitFor(() => expect(setEnabled).toHaveBeenCalledWith(false));
  });

  it('does not expose or sync Agent Island before macOS 14', async () => {
    const setEnabled = vi.fn(async () => ({ ok: true as const }));
    installElectronApi({ setEnabled }, { osRelease: '22.6.0' });
    localStorage.setItem('notifications.agentIslandEnabled', 'true');

    expect(isAgentIslandSupported()).toBe(false);
    syncAgentIslandEnabledToMain();
    await Promise.resolve();

    expect(setEnabled).not.toHaveBeenCalled();
  });

  it('does not persist a display target when the preload API is stale', async () => {
    installElectronApi({});
    localStorage.setItem('notifications.agentIslandDisplayTarget', JSON.stringify({ mode: 'display', displayId: 2 }));

    await expect(setAgentIslandDisplayTarget({ mode: 'display', displayId: 3 })).resolves.toBe(false);

    expect(getAgentIslandDisplayTarget()).toEqual({ mode: 'display', displayId: 2 });
    expect(localStorage.getItem('notifications.agentIslandDisplayTarget')).toBe(JSON.stringify({
      mode: 'display',
      displayId: 2,
    }));
  });

  it('persists the display target only after main accepts it', async () => {
    const setDisplayTarget = vi.fn(async () => ({ ok: true as const }));
    installElectronApi({ setDisplayTarget });

    await expect(setAgentIslandDisplayTarget({ mode: 'display', displayId: 2 })).resolves.toBe(true);

    expect(setDisplayTarget).toHaveBeenCalledWith({ mode: 'display', displayId: 2 });
    expect(getAgentIslandDisplayTarget()).toEqual({ mode: 'display', displayId: 2 });
  });

  it('syncs the persisted display target to main on app bootstrap', async () => {
    const setEnabled = vi.fn(async () => ({ ok: true as const }));
    const setDisplayTarget = vi.fn(async () => ({ ok: true as const }));
    installElectronApi({ setEnabled, setDisplayTarget });
    localStorage.setItem('notifications.agentIslandDisplayTarget', JSON.stringify({ mode: 'display', displayId: 2 }));

    syncAgentIslandEnabledToMain();
    await vi.waitFor(() => expect(setDisplayTarget).toHaveBeenCalledWith({ mode: 'display', displayId: 2 }));
  });

  it('loads display option names from main', async () => {
    const getDisplayOptions = vi.fn(async () => ({
      ok: true as const,
      options: [{
        id: 2,
        index: 1,
        name: 'Studio Display',
        isPrimary: true,
        internal: false,
        bounds: { x: 0, y: 0, width: 1512, height: 982 },
      }],
    }));
    installElectronApi({ getDisplayOptions });

    await expect(loadAgentIslandDisplayOptions()).resolves.toEqual([{
      id: 2,
      index: 1,
      name: 'Studio Display',
      isPrimary: true,
      internal: false,
      bounds: { x: 0, y: 0, width: 1512, height: 982 },
    }]);
  });

  it('persists the display target resolved by main after display re-enumeration', async () => {
    const getDisplayOptions = vi.fn(async () => ({
      ok: true as const,
      options: [],
      target: {
        mode: 'display' as const,
        displayId: 7,
        displayName: 'Studio Display',
        displayIndex: 2,
        displayInternal: false,
        displayBounds: { x: 0, y: 0, width: 1512, height: 982 },
      },
    }));
    installElectronApi({ getDisplayOptions });

    await loadAgentIslandDisplayOptions();

    expect(getAgentIslandDisplayTarget()).toMatchObject({
      mode: 'display',
      displayId: 7,
      displayName: 'Studio Display',
    });
  });

  it('does not rewrite or notify when main returns the unchanged display target', async () => {
    const target = {
      mode: 'display' as const,
      displayId: 7,
      displayName: 'Studio Display',
      displayIndex: 2,
      displayInternal: false,
      displayBounds: { x: 0, y: 0, width: 1512, height: 982 },
    };
    localStorage.setItem('notifications.agentIslandDisplayTarget', JSON.stringify(target));
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const getDisplayOptions = vi.fn(async () => ({
      ok: true as const,
      options: [],
      target,
    }));
    installElectronApi({ getDisplayOptions });

    await loadAgentIslandDisplayOptions();

    expect(setItem).not.toHaveBeenCalled();
  });
});
