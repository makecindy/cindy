import { parsePluginAppearancePatch, type PluginAppearancePatch, type PluginAppearanceFont } from '@cindy/plugin-protocol/appearance';

/** Data shared by theme defaults and the Host's fixed appearance capabilities. */
export interface AppearanceDefinition extends Omit<PluginAppearancePatch, 'theme'> {
  terminalFont?: Omit<PluginAppearanceFont, 'weight' | 'style'>;
  /** Multiplier for the existing spacing tokens. */
  density?: number;
  /** Multiplier for motion durations; zero requests reduced motion. */
  motion?: number;
}

export interface AppearanceResourceDefinition {
  id: string;
  kind: 'font' | 'image' | 'video';
  path: string;
}

export interface ThemeSelection {
  mode: 'system' | 'light' | 'dark';
  familyId: string;
}

export function parseThemeSelection(raw: unknown): ThemeSelection | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).some(key => !['mode', 'familyId'].includes(key)) ||
      !['system', 'light', 'dark'].includes(String(value.mode)) || typeof value.familyId !== 'string' ||
      !value.familyId.trim() || value.familyId.length > 512) return null;
  return { mode: value.mode as ThemeSelection['mode'], familyId: value.familyId };
}

export interface ThemeFontResource {
  source: { themeId: string; packageSha256: string };
  reference: string;
  hash: string;
  family: string;
}

export function parseAppearanceDefinition(raw: unknown): AppearanceDefinition | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const { terminalFont, density, motion, ...fixed } = raw as Record<string, unknown>;
  const parsed = Object.keys(fixed).length ? parsePluginAppearancePatch(fixed) : {};
  if (!parsed || 'theme' in parsed) return null;
  const terminal = terminalFont === undefined ? undefined : parsePluginAppearancePatch({ codeFont: terminalFont })?.codeFont;
  if (terminalFont !== undefined && (!terminal || terminal.weight !== undefined || terminal.style !== undefined)) return null;
  if (density !== undefined && (typeof density !== 'number' || !Number.isFinite(density) || density < 0.75 || density > 1.25)) return null;
  if (motion !== undefined && (typeof motion !== 'number' || !Number.isFinite(motion) || motion < 0 || motion > 2)) return null;
  const result: AppearanceDefinition = { ...parsed, ...(terminal ? { terminalFont: terminal } : {}),
    ...(density !== undefined ? { density: density as number } : {}), ...(motion !== undefined ? { motion: motion as number } : {}) };
  // Theme archives are portable data, never grants to a plugin Library or a
  // particular computer's media/files. Only declared asset IDs may be used.
  for (const { reference } of appearanceResourceReferences(result)) {
    if (!/^asset:[a-zA-Z0-9_-]{1,64}$/.test(reference)) return null;
  }
  return result;
}

export function appearanceResourceReferences(value: AppearanceDefinition): Array<{
  reference: string;
  kind: AppearanceResourceDefinition['kind'] | 'wallpaper';
}> {
  const refs: ReturnType<typeof appearanceResourceReferences> = [];
  for (const role of ['uiFont', 'codeFont', 'bodyFont', 'terminalFont'] as const) {
    if (value[role]?.resource) refs.push({ reference: value[role]!.resource!, kind: 'font' });
  }
  if (value.wallpaper?.resource) refs.push({ reference: value.wallpaper.resource, kind: 'wallpaper' });
  if (value.wallpaper?.fallbackResource) refs.push({ reference: value.wallpaper.fallbackResource, kind: 'image' });
  return refs;
}
