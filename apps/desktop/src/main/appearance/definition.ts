import type { PluginAppearanceFont, PluginAppearancePatch } from '@cindy/plugin-protocol/appearance';
import type { AppearanceDefinition } from '../../shared/appearanceDefinition.js';
import type { AppearanceOverrides } from '../../shared/appearanceSettings.js';
import type { AppearanceFontResource } from '../../shared/pluginAppearance.js';

export const APPEARANCE_FONT_ROLES = ['uiFont', 'codeFont', 'bodyFont', 'terminalFont'] as const;
export type AppearanceFontRole = typeof APPEARANCE_FONT_ROLES[number];
const resetKeys: Record<string, readonly (keyof AppearanceOverrides)[]> = {
  uiFont: ['uiFamily', 'uiSize', 'uiFontResource', 'uiFontTraits'],
  codeFont: ['codeFamily', 'codeSize', 'codeFontResource', 'codeFontTraits'],
  bodyFont: ['bodyFont', 'bodyFontResource'],
  terminalFont: ['terminalFamily', 'terminalSize', 'terminalFontResource'],
  wallpaper: ['wallpaperId', 'wallpaperOverlay', 'wallpaperMotion', 'wallpaperVisibility', 'wallpaperBlur'],
  theme: ['themeColors'], reading: ['reading'], contentStyle: ['contentStyle'], density: ['density'], motion: ['motion'],
};
export const APPEARANCE_RESET_FIELDS = [...new Set([...Object.keys(resetKeys), ...Object.values(resetKeys).flat(), 'desktopVisibility'])];

/** One translation into the Host settings model for theme defaults and fixed writes. */
export function appearanceDefinitionToOverrides(
  current: AppearanceOverrides,
  patch: AppearanceDefinition & Pick<PluginAppearancePatch, 'theme'>,
  assets: Partial<Record<AppearanceFontRole, AppearanceFontResource>> = {},
): AppearanceOverrides {
  const next: AppearanceOverrides = {};
  for (const role of APPEARANCE_FONT_ROLES) {
    const font: PluginAppearanceFont | undefined = patch[role];
    if (!font) continue;
    const { resource: _reference, ...traits } = font; void _reference;
    const asset = assets[role];
    if (role === 'bodyFont') {
      next.bodyFont = { ...current.bodyFont, ...traits, ...(asset ? { family: asset.family } : {}) };
      if (asset || font.family !== undefined) next.bodyFontResource = asset;
    } else {
      const prefix = role === 'uiFont' ? 'ui' : role === 'codeFont' ? 'code' : 'terminal';
      const familyKey = `${prefix}Family` as 'uiFamily', sizeKey = `${prefix}Size` as 'uiSize';
      const resourceKey = `${role}Resource` as 'uiFontResource', traitsKey = `${role}Traits` as 'uiFontTraits';
      if (asset || font.family !== undefined) { next[familyKey] = asset?.family ?? font.family!; next[resourceKey] = asset; }
      if (font.size !== undefined) next[sizeKey] = font.size;
      if (role !== 'terminalFont' && (font.weight !== undefined || font.style !== undefined)) next[traitsKey] = { ...current[traitsKey],
        ...(font.weight !== undefined ? { weight: font.weight } : {}), ...(font.style ? { style: font.style } : {}) };
    }
  }
  if (patch.theme) next.themeColors = { ...current.themeColors,
    ...(patch.theme.light ? { light: { ...current.themeColors?.light, ...patch.theme.light } } : {}),
    ...(patch.theme.dark ? { dark: { ...current.themeColors?.dark, ...patch.theme.dark } } : {}) };
  if (patch.reading) next.reading = { ...current.reading, ...patch.reading };
  if (patch.contentStyle) next.contentStyle = { ...current.contentStyle, ...patch.contentStyle };
  if (patch.wallpaper) {
    if (patch.wallpaper.resource) next.wallpaperId = 'custom';
    if (patch.wallpaper.visibility !== undefined) next.wallpaperVisibility = patch.wallpaper.visibility;
    if (patch.wallpaper.blur !== undefined) next.wallpaperBlur = patch.wallpaper.blur;
    if (patch.wallpaper.motion !== undefined) next.wallpaperMotion = patch.wallpaper.motion;
  }
  if (patch.density !== undefined) next.density = patch.density;
  if (patch.motion !== undefined) next.motion = patch.motion;
  return next;
}

/** Removing overrides follows the active theme, rather than pinning old defaults. */
export function appearanceResetPatch(fields: readonly string[]): AppearanceOverrides {
  const next: AppearanceOverrides = {};
  for (const field of fields) {
    if (!APPEARANCE_RESET_FIELDS.includes(field)) continue;
    for (const key of resetKeys[field] ?? [field]) Object.assign(next, { [key]: undefined });
  }
  return next;
}
