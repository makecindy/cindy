import { describe, expect, it, vi } from 'vitest';
import { configureLinuxPasswordStore, linuxPasswordStoreRelaunchArgs } from '../linuxPasswordStore.js';

describe('Linux secure storage startup policy', () => {
  it('preserves the backend on relaunch without forwarding arbitrary arguments', () => {
    expect(linuxPasswordStoreRelaunchArgs('gnome-libsecret')).toEqual(['--password-store=gnome-libsecret']);
    expect(linuxPasswordStoreRelaunchArgs('kwallet6')).toEqual(['--password-store=kwallet6']);
    expect(linuxPasswordStoreRelaunchArgs('')).toEqual([]);
    expect(linuxPasswordStoreRelaunchArgs('gnome-libsecret --no-sandbox')).toEqual([]);
  });
});

function configure(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = 'linux',
  explicitStore?: string,
) {
  const switches = new Map<string, string>();
  if (explicitStore !== undefined) switches.set('password-store', explicitStore);
  const appendSwitch = vi.fn((name: string, value: string) => switches.set(name, value));
  configureLinuxPasswordStore({
    platform,
    env,
    commandLine: { hasSwitch: (name) => switches.has(name), appendSwitch },
  });
  return { switches, appendSwitch };
}

describe('Hyprland password store startup selection', () => {
  it.each([
    { XDG_CURRENT_DESKTOP: 'Hyprland' },
    { XDG_CURRENT_DESKTOP: 'Hyprland:wlroots' },
    { XDG_CURRENT_DESKTOP: ' hyprland ' },
    { XDG_SESSION_DESKTOP: 'Hyprland' },
    { DESKTOP_SESSION: 'hyprland' },
    { XDG_CURRENT_DESKTOP: ' ', XDG_SESSION_DESKTOP: 'Hyprland' },
  ])('selects libsecret for %j', (env) => {
    const { switches, appendSwitch } = configure(env);
    expect(switches.get('password-store')).toBe('gnome-libsecret');
    expect(appendSwitch).toHaveBeenCalledExactlyOnceWith('password-store', 'gnome-libsecret');
  });

  it.each(['kwallet', 'kwallet5', 'kwallet6', 'gnome-libsecret', 'basic', ''])(
    'preserves an explicit --password-store=%s, including an empty switch',
    (store) => {
      const { switches, appendSwitch } = configure(
        { XDG_CURRENT_DESKTOP: 'Hyprland' },
        'linux',
        store,
      );
      expect(switches.get('password-store')).toBe(store);
      expect(appendSwitch).not.toHaveBeenCalled();
    },
  );

  it.each([
    {},
    { XDG_CURRENT_DESKTOP: 'GNOME', DESKTOP_SESSION: 'hyprland' },
    { XDG_CURRENT_DESKTOP: 'KDE', XDG_SESSION_DESKTOP: 'Hyprland' },
    { XDG_CURRENT_DESKTOP: 'sway' },
    { XDG_CURRENT_DESKTOP: 'niri' },
    { XDG_CURRENT_DESKTOP: 'not-hyprland' },
    { XDG_SESSION_TYPE: 'wayland' },
  ])('leaves other or unknown desktops to Electron: %j', (env) => {
    expect(configure(env).appendSwitch).not.toHaveBeenCalled();
  });

  it.each(['darwin', 'win32'] as const)('leaves %s unchanged', (platform) => {
    expect(
      configure({ XDG_CURRENT_DESKTOP: 'Hyprland' }, platform).appendSwitch,
    ).not.toHaveBeenCalled();
  });
});
