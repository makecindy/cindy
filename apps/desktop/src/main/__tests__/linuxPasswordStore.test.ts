import { describe, expect, it, vi } from 'vitest';
import {
  configureLinuxPasswordStore,
  linuxCredentialFailureFields,
  linuxPasswordStoreRelaunchArgs,
} from '../linuxPasswordStore.js';

describe('Linux secure storage startup policy', () => {
  it('preserves the backend on relaunch without forwarding arbitrary arguments', () => {
    expect(linuxPasswordStoreRelaunchArgs('gnome-libsecret')).toEqual([
      '--password-store=gnome-libsecret',
    ]);
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

describe('Linux password store startup selection', () => {
  it.each([
    { XDG_CURRENT_DESKTOP: 'Hyprland' },
    { XDG_CURRENT_DESKTOP: 'Hyprland:wlroots' },
    { XDG_CURRENT_DESKTOP: ' hyprland ' },
    { XDG_SESSION_DESKTOP: 'Hyprland' },
    { DESKTOP_SESSION: 'hyprland' },
    { XDG_CURRENT_DESKTOP: ' ', XDG_SESSION_DESKTOP: 'Hyprland' },
    { XDG_CURRENT_DESKTOP: 'labwc' },
    { XDG_CURRENT_DESKTOP: 'labwc:wlroots' },
    { XDG_CURRENT_DESKTOP: ' Labwc ' },
    { XDG_SESSION_DESKTOP: 'labwc' },
    {},
    { XDG_CURRENT_DESKTOP: ' ' },
    { XDG_SESSION_TYPE: 'wayland' },
  ])('selects libsecret when Chromium would miss Secret Service: %j', (env) => {
    const { switches, appendSwitch } = configure(env);
    expect(switches.get('password-store')).toBe('gnome-libsecret');
    expect(appendSwitch).toHaveBeenCalledExactlyOnceWith('password-store', 'gnome-libsecret');
  });

  it.each(['kwallet', 'kwallet5', 'kwallet6', 'gnome-libsecret', 'basic', ''])(
    'preserves an explicit --password-store=%s, including an empty switch',
    (store) => {
      const { switches, appendSwitch } = configure({}, 'linux', store);
      expect(switches.get('password-store')).toBe(store);
      expect(appendSwitch).not.toHaveBeenCalled();
    },
  );

  it.each([
    { XDG_CURRENT_DESKTOP: 'GNOME', DESKTOP_SESSION: 'hyprland' },
    { XDG_CURRENT_DESKTOP: 'KDE', XDG_SESSION_DESKTOP: 'Hyprland' },
    { XDG_CURRENT_DESKTOP: 'XFCE' },
    { XDG_CURRENT_DESKTOP: 'Unity' },
    { XDG_CURRENT_DESKTOP: 'X-Cinnamon' },
    { XDG_CURRENT_DESKTOP: 'Pantheon' },
    { XDG_CURRENT_DESKTOP: 'UKUI' },
    { XDG_CURRENT_DESKTOP: 'Deepin' },
    { XDG_CURRENT_DESKTOP: 'LXQt' },
    { XDG_CURRENT_DESKTOP: 'sway' },
    { XDG_CURRENT_DESKTOP: 'niri' },
    { XDG_CURRENT_DESKTOP: 'wlroots' },
    { XDG_CURRENT_DESKTOP: 'not-hyprland' },
  ])('leaves recognized or other named desktops to Electron: %j', (env) => {
    expect(configure(env).appendSwitch).not.toHaveBeenCalled();
  });

  it.each(['darwin', 'win32'] as const)('leaves %s unchanged', (platform) => {
    expect(configure({}, platform).appendSwitch).not.toHaveBeenCalled();
  });
});

describe('Linux credential failure diagnostics', () => {
  it('logs only the backend, switch class, and presence booleans', () => {
    const secret = 'secret-token-value';
    const fields = linuxCredentialFailureFields({
      platform: 'linux',
      env: {
        XDG_CURRENT_DESKTOP: 'labwc:wlroots',
        DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus-' + secret,
      },
      backend: 'gnome_libsecret',
      passwordStoreSwitch: 'gnome-libsecret',
    });
    expect(fields).toEqual({
      backend: 'gnome_libsecret',
      passwordStore: 'gnome-libsecret',
      desktopIdentityPresent: true,
      sessionBusPresent: true,
    });
    expect(JSON.stringify(fields)).not.toContain(secret);
    expect(JSON.stringify(fields)).not.toContain('labwc');
    expect(JSON.stringify(fields)).not.toContain('unix:path');
  });

  it('does not echo an unexpected switch or backend, and omits non-Linux fields', () => {
    expect(
      linuxCredentialFailureFields({
        platform: 'linux',
        env: {},
        backend: 'custom-' + 'secret',
        passwordStoreSwitch: '/tmp/' + 'secret',
      }),
    ).toEqual({
      backend: 'unknown',
      passwordStore: 'explicit',
      desktopIdentityPresent: false,
      sessionBusPresent: false,
    });
    expect(
      linuxCredentialFailureFields({
        platform: 'linux',
        env: { XDG_CURRENT_DESKTOP: '   ', DBUS_SESSION_BUS_ADDRESS: '   ' },
      }).desktopIdentityPresent,
    ).toBe(false);
    expect(
      linuxCredentialFailureFields({
        platform: 'darwin',
        env: { XDG_CURRENT_DESKTOP: '', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/tmp/bus' },
        backend: 'gnome_libsecret',
        passwordStoreSwitch: 'basic',
      }),
    ).toEqual({});
  });
});
