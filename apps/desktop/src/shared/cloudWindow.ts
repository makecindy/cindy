/**
 * Launch argument for the main window's cloud bridges. Other windows load the same preload and
 * never get it, so they expose no cloud bridge. `instance` marks a managed cloud instance; the
 * settings page reads it from here instead of asking Main.
 */
const CLOUD_WINDOW_ARGUMENT = '--cindy-cloud-window=';

export interface CloudWindowRole {
  instance: boolean;
}

export function createCloudWindowArgument(role: CloudWindowRole): string {
  return `${CLOUD_WINDOW_ARGUMENT}${role.instance ? 'instance' : 'client'}`;
}

/** The main window's role, or null for any other window. */
export function readCloudWindowRole(argv: readonly string[]): CloudWindowRole | null {
  for (let index = argv.length - 1; index >= 0; index -= 1) {
    const argument = argv[index];
    if (!argument?.startsWith(CLOUD_WINDOW_ARGUMENT)) continue;
    const value = argument.slice(CLOUD_WINDOW_ARGUMENT.length);
    return value === 'instance' || value === 'client' ? { instance: value === 'instance' } : null;
  }
  return null;
}
