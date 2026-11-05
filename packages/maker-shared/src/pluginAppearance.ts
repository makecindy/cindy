import type { PluginAppearancePatch, PluginAppearanceField, PluginAppearanceColor } from './pluginUiPublic.js';

export const PLUGIN_APPEARANCE_FIELDS: readonly PluginAppearanceField[] = [
  'wallpaper', 'uiFont', 'codeFont', 'bodyFont', 'theme', 'reading', 'contentStyle', 'appIcon',
];
export const PLUGIN_APPEARANCE_COLORS: readonly PluginAppearanceColor[] = [
  'text', 'secondaryText', 'surface', 'border', 'userBubble', 'userText', 'assistantBubble',
];
export const PLUGIN_APPEARANCE_LIMITS = {
  uiSize: [12, 24], codeSize: [10, 24], bodySize: [12, 28], weight: [100, 900],
  visibility: [0, 1], blur: [0, 20], bodyLineHeight: [1.2, 2.4], codeLineHeight: [1.1, 2.4],
  maxWidth: [320, 1400], messageGap: [0, 48], messagePadding: [0, 32], messageRadius: [0, 32],
} as const;

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const finite = (value: unknown, range: readonly [number, number]): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= range[0] && value <= range[1];
const keys = (value: Record<string, unknown>, allowed: readonly string[]) =>
  Object.keys(value).length > 0 && Object.keys(value).every(key => allowed.includes(key));

export function isPluginAppearanceResource(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 1024) return false;
  if (/^asset:[a-zA-Z0-9_-]{1,64}$/.test(value)) return true;
  if (/^cindy-media:\/\/blobs\/[0-9a-f]{64}\.[a-z0-9]+$/.test(value)) return true;
  if (!value.startsWith('library:')) return false;
  const path = value.slice(8);
  return path.length > 0 && !/[\\\x00-\x1f\x7f:%?#]/.test(path) &&
    path.split('/').every(part => part.length > 0 && part !== '.' && part !== '..');
}

/** Exact writable fields, not arbitrary CSS or a theme-token escape hatch. */
export function parsePluginAppearancePatch(value: unknown): PluginAppearancePatch | null {
  if (!record(value) || !keys(value, PLUGIN_APPEARANCE_FIELDS)) return null;
  if (value.appIcon !== undefined && (!record(value.appIcon) || !keys(value.appIcon, ['resource']) ||
      !isPluginAppearanceResource(value.appIcon.resource))) return null;
  for (const role of ['uiFont', 'codeFont', 'bodyFont'] as const) {
    const font = value[role];
    if (font === undefined) continue;
    if (!record(font) || !keys(font, ['family', 'size', 'resource', 'weight', 'style'])) return null;
    if (font.family !== undefined && (typeof font.family !== 'string' || font.family.length > 256 ||
        !/^[\p{L}\p{N} _.,'"-]*$/u.test(font.family))) return null;
    if (font.resource !== undefined && !isPluginAppearanceResource(font.resource)) return null;
    if (font.size !== undefined && !finite(font.size, PLUGIN_APPEARANCE_LIMITS[role === 'uiFont' ? 'uiSize' : role === 'codeFont' ? 'codeSize' : 'bodySize'])) return null;
    if (font.weight !== undefined && (!finite(font.weight, PLUGIN_APPEARANCE_LIMITS.weight) || !Number.isInteger(font.weight))) return null;
    if (font.style !== undefined && !['normal', 'italic'].includes(String(font.style))) return null;
    if (font.resource !== undefined && font.family !== undefined) return null;
  }
  if (value.wallpaper !== undefined) {
    const w = value.wallpaper;
    if (!record(w) || !keys(w, ['resource', 'fallbackResource', 'visibility', 'blur', 'motion'])) return null;
    if (w.fallbackResource !== undefined && w.resource === undefined) return null;
    for (const field of ['resource', 'fallbackResource'])
      if (w[field] !== undefined && !isPluginAppearanceResource(w[field])) return null;
    if (w.visibility !== undefined && !finite(w.visibility, PLUGIN_APPEARANCE_LIMITS.visibility)) return null;
    if (w.blur !== undefined && !finite(w.blur, PLUGIN_APPEARANCE_LIMITS.blur)) return null;
    if (w.motion !== undefined && !['static', 'dynamic'].includes(String(w.motion))) return null;
  }
  if (value.theme !== undefined) {
    if (!record(value.theme) || !keys(value.theme, ['light', 'dark'])) return null;
    for (const mode of Object.values(value.theme)) {
      if (!record(mode) || !keys(mode, PLUGIN_APPEARANCE_COLORS) ||
          Object.values(mode).some(color => typeof color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(color))) return null;
    }
  }
  for (const section of ['reading', 'contentStyle'] as const) {
    const fields = value[section];
    const allowed = section === 'reading' ? ['bodyLineHeight', 'codeLineHeight', 'maxWidth'] :
      ['messageGap', 'messagePadding', 'messageRadius'];
    if (fields === undefined) continue;
    if (!record(fields) || !keys(fields, allowed)) return null;
    for (const [key, n] of Object.entries(fields))
      if (!finite(n, PLUGIN_APPEARANCE_LIMITS[key as keyof typeof PLUGIN_APPEARANCE_LIMITS])) return null;
  }
  return value as PluginAppearancePatch;
}
