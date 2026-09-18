/** Preserve only the storage selector, not URLs or transient task arguments. */
export function linuxPasswordStoreRelaunchArgs(value: string): string[] {
  return ['gnome-libsecret', 'kwallet', 'kwallet5', 'kwallet6', 'basic'].includes(value)
    ? [`--password-store=${value}`] : [];
}

/** Configure before Electron's ready event, without probing or opening the keyring. */
export function configureLinuxPasswordStore({
  platform,
  env,
  commandLine,
}: {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  commandLine: {
    hasSwitch(name: string): boolean;
    appendSwitch(name: string, value: string): void;
  };
}): void {
  if (platform !== 'linux' || commandLine.hasSwitch('password-store')) return;

  // Chromium does not recognize Hyprland (including Omarchy) as a desktop
  // with a secret store. Prefer the active desktop over legacy session hints
  // so a stale DESKTOP_SESSION cannot override GNOME/KDE's native selection.
  const desktop =
    env.XDG_CURRENT_DESKTOP?.trim() ||
    env.XDG_SESSION_DESKTOP?.trim() ||
    env.DESKTOP_SESSION?.trim() ||
    '';
  if (desktop.split(':').some((name) => name.trim().toLowerCase() === 'hyprland')) {
    commandLine.appendSwitch('password-store', 'gnome-libsecret');
  }
}
