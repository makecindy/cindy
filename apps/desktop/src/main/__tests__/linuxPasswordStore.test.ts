import { describe, expect, it } from 'vitest';
import { linuxPasswordStoreFallback, linuxPasswordStoreRelaunchArgs } from '../linuxPasswordStore';

describe('Linux secure storage startup policy', () => {
  it.each(['Hyprland', 'sway', 'niri', 'Hyprland:wlroots'])('uses Secret Service on %s', (desktop) => {
    expect(linuxPasswordStoreFallback('linux', desktop, false)).toBe('gnome-libsecret');
  });
  it.each(['KDE', 'GNOME', 'XFCE', 'KDE:Hyprland', '', undefined])('leaves %s to Chromium', (desktop) => {
    expect(linuxPasswordStoreFallback('linux', desktop, false)).toBeNull();
  });
  it('preserves explicit overrides and other platforms', () => {
    expect(linuxPasswordStoreFallback('linux', 'Hyprland', true)).toBeNull();
    expect(linuxPasswordStoreFallback('darwin', 'Hyprland', false)).toBeNull();
    expect(linuxPasswordStoreFallback('win32', 'Hyprland', false)).toBeNull();
  });
  it('preserves the backend on relaunch without forwarding arbitrary arguments', () => {
    expect(linuxPasswordStoreRelaunchArgs('gnome-libsecret')).toEqual(['--password-store=gnome-libsecret']);
    expect(linuxPasswordStoreRelaunchArgs('kwallet6')).toEqual(['--password-store=kwallet6']);
    expect(linuxPasswordStoreRelaunchArgs('')).toEqual([]);
    expect(linuxPasswordStoreRelaunchArgs('gnome-libsecret --no-sandbox')).toEqual([]);
  });
});
