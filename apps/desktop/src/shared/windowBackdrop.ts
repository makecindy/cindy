export const WINDOWS_BACKDROP_MATERIALS = ['acrylic', 'mica', 'tabbed', 'none'] as const;

export type WindowsBackdropMaterial = (typeof WINDOWS_BACKDROP_MATERIALS)[number];

export const CINDY_ACRYLIC_WINDOW_BACKING = {
  light: 'rgba(238, 238, 233, 0.85)',
  dark: 'rgba(5, 5, 5, 0.85)',
} as const;

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
