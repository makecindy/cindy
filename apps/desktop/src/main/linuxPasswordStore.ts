/** Narrow fallback for standalone Wayland compositors Chromium does not detect.
 * KDE/GNOME and explicit overrides retain their existing key identity. Never
 * fall back to basic/plaintext when a keyring is locked.
 */
export function linuxPasswordStoreFallback(
  platform: string, desktop: string | undefined, hasExplicitStore: boolean,
): 'gnome-libsecret' | null {
  if (platform !== 'linux' || hasExplicitStore) return null;
  const names = (desktop ?? '').toLowerCase().split(/[:;]/);
  if (names.some((name) => /^(kde|gnome|x-cinnamon|xfce|unity)$/.test(name))) return null;
  return names.some((name) => /^(hyprland|sway|niri)$/.test(name)) ? 'gnome-libsecret' : null;
}

/** Preserve only the storage selector, not URLs or transient task arguments. */
export function linuxPasswordStoreRelaunchArgs(value: string): string[] {
  return ['gnome-libsecret', 'kwallet', 'kwallet5', 'kwallet6', 'basic'].includes(value)
    ? [`--password-store=${value}`] : [];
}
