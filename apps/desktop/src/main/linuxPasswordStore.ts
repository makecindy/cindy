/** Preserve only the storage selector, not URLs or transient task arguments. */
export function linuxPasswordStoreRelaunchArgs(value: string): string[] {
  return ['gnome-libsecret', 'kwallet', 'kwallet5', 'kwallet6', 'basic'].includes(value)
    ? ['--password-store=' + value]
    : [];
}

const GNOME_LIBSECRET_DESKTOPS = new Set(['hyprland', 'labwc']);
const KNOWN_PASSWORD_STORES = new Set([
  'gnome-libsecret',
  'kwallet',
  'kwallet5',
  'kwallet6',
  'basic',
]);
const KNOWN_STORAGE_BACKENDS = new Set([
  'basic_text',
  'gnome_libsecret',
  'kwallet',
  'kwallet5',
  'kwallet6',
  'unknown',
  'unavailable',
]);

/** First non-empty desktop identity. A session type is not a desktop name. */
export function linuxDesktopIdentity(env: NodeJS.ProcessEnv): string {
  return (
    env.XDG_CURRENT_DESKTOP?.trim() ||
    env.XDG_SESSION_DESKTOP?.trim() ||
    env.DESKTOP_SESSION?.trim() ||
    ''
  );
}

/**
 * Chromium only maps a few desktop names onto a secret store. Hyprland and
 * labwc are not among them, so an unlocked Secret Service is never opened.
 * An empty identity falls through to basic_text, which packaged builds refuse.
 * Other named desktops, including sway and niri, stay with Electron.
 */
export function linuxDesktopNeedsGnomeLibsecret(identity: string): boolean {
  if (!identity.trim()) return true;
  return identity
    .split(':')
    .some((name) => GNOME_LIBSECRET_DESKTOPS.has(name.trim().toLowerCase()));
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
  // Prefer the active desktop over legacy session hints so a stale
  // DESKTOP_SESSION cannot override GNOME/KDE's native selection.
  if (linuxDesktopNeedsGnomeLibsecret(linuxDesktopIdentity(env))) {
    commandLine.appendSwitch('password-store', 'gnome-libsecret');
  }
}

/** Never echo an unexpected switch value; it is not a credential, but it is untrusted. */
export function redactPasswordStoreSwitch(value: string | undefined): string {
  if (value === undefined) return 'unset';
  if (value === '') return 'empty';
  return KNOWN_PASSWORD_STORES.has(value) ? value : 'explicit';
}

export function redactStorageBackend(value: string | undefined): string {
  if (!value) return 'unknown';
  return KNOWN_STORAGE_BACKENDS.has(value) ? value : 'unknown';
}

/** Safe fields for a real credential failure. No desktop name, bus address, argv, or token. */
export function linuxCredentialFailureFields(input: {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  backend?: string;
  passwordStoreSwitch?: string;
}): Record<string, string | boolean> {
  if (input.platform !== 'linux') return {};
  return {
    backend: redactStorageBackend(input.backend),
    passwordStore: redactPasswordStoreSwitch(input.passwordStoreSwitch),
    desktopIdentityPresent: linuxDesktopIdentity(input.env).length > 0,
    sessionBusPresent: Boolean(input.env.DBUS_SESSION_BUS_ADDRESS?.trim()),
  };
}
