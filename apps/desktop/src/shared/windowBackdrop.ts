export const WINDOWS_BACKDROP_MATERIALS = ['acrylic', 'mica', 'tabbed', 'none'] as const;

export type WindowsBackdropMaterial = (typeof WINDOWS_BACKDROP_MATERIALS)[number];

// BEGIN GENERATED DS-8: window-backing
export const CINDY_ACRYLIC_WINDOW_BACKING = {
  light: 'rgba(238, 238, 233, 0.85)',
  dark: 'rgba(5, 5, 5, 0.85)',
} as const;
// END GENERATED DS-8: window-backing

/** Electron applies Windows system backdrops only from Windows 11 22H2 (build 22621). */
const WINDOWS_SYSTEM_BACKDROP_MIN_BUILD = 22621;

/**
 * Whether a window can reveal the desktop behind it with a native material: macOS
 * always, Windows only where whole-window Acrylic is available. Elsewhere a clear
 * window would show the desktop unblurred behind the sidebar, so callers keep it opaque.
 * `osRelease` is `os.release()` / `process.getSystemVersion()` (e.g. `10.0.22631`).
 */
export function supportsDesktopBackdrop(
  platform: string | undefined,
  osRelease: string | null | undefined,
): boolean {
  if (platform === 'darwin') return true;
  if (platform !== 'win32' || !osRelease) return false;
  const build = Number.parseInt(osRelease.trim().split('.')[2] ?? '', 10);
  return Number.isFinite(build) && build >= WINDOWS_SYSTEM_BACKDROP_MIN_BUILD;
}

export const WINDOW_BACKDROP_MATERIAL_CHANGED_CHANNEL =
  'window-backdrop-material:changed';

const WINDOW_BACKDROP_MATERIAL_ARGUMENT = '--cindy-window-backdrop-material=';

export function isWindowsBackdropMaterial(value: string): value is WindowsBackdropMaterial {
  return WINDOWS_BACKDROP_MATERIALS.some((material) => material === value);
}

export function createWindowBackdropMaterialArgument(material: WindowsBackdropMaterial): string {
  return `${WINDOW_BACKDROP_MATERIAL_ARGUMENT}${material}`;
}

export function readWindowBackdropMaterialFromArgv(
  argv: readonly string[],
): WindowsBackdropMaterial {
  for (let index = argv.length - 1; index >= 0; index -= 1) {
    const argument = argv[index];
    if (!argument?.startsWith(WINDOW_BACKDROP_MATERIAL_ARGUMENT)) continue;
    const raw = argument.slice(WINDOW_BACKDROP_MATERIAL_ARGUMENT.length);
    return isWindowsBackdropMaterial(raw) ? raw : 'none';
  }
  return 'none';
}
