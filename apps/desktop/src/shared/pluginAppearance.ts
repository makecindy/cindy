import { parsePluginAppearancePatch, isPluginAppearanceResource, type PluginAppearancePatch, type PluginAppearanceFont } from '@cindy/plugin-protocol/appearance';
import type { ThemeFontResource } from './appearanceDefinition';
const pluginUiRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** Resource provenance is Host metadata in the existing appearance overrides. */
export interface PluginAppearanceSource { instanceId: string; key: string }
export interface PluginFontResource {
  source: PluginAppearanceSource; reference: string; hash: string; family: string;
}
export type AppearanceFontResource = PluginFontResource | ThemeFontResource;
export function isPluginFontResource(value: AppearanceFontResource): value is PluginFontResource {
  return 'instanceId' in value.source;
}
export interface PluginAppearanceSettingsFields {
  uiFontResource?: AppearanceFontResource;
  codeFontResource?: AppearanceFontResource;
  bodyFontResource?: AppearanceFontResource;
  uiFontTraits?: Pick<PluginAppearanceFont, 'weight' | 'style'>;
  codeFontTraits?: Pick<PluginAppearanceFont, 'weight' | 'style'>;
  bodyFont?: Omit<PluginAppearanceFont, 'resource'>;
  reading?: PluginAppearancePatch['reading'];
  contentStyle?: PluginAppearancePatch['contentStyle'];
  themeColors?: PluginAppearancePatch['theme'];
}

export function parsePluginAppearanceSource(value: unknown): PluginAppearanceSource | null {
  if (!pluginUiRecord(value) || typeof value.instanceId !== 'string' || !value.instanceId || value.instanceId.length > 256 ||
      typeof value.key !== 'string' || !/^[a-f0-9]{64}$/.test(value.key)) return null;
  return { instanceId: value.instanceId, key: value.key };
}

export function normalizePluginAppearanceSettings(raw: Record<string, unknown>): PluginAppearanceSettingsFields {
  const result: PluginAppearanceSettingsFields = {};
  for (const field of ['uiFontResource', 'codeFontResource', 'bodyFontResource'] as const) {
    const value = raw[field];
    if (!pluginUiRecord(value)) continue;
    const source = parsePluginAppearanceSource(value.source);
    if (source && isPluginAppearanceResource(value.reference) && typeof value.hash === 'string' && /^[a-f0-9]{64}$/.test(value.hash) &&
        value.family === `CindyPlugin_${value.hash}`) result[field] = { source, reference: value.reference, hash: value.hash, family: value.family };
    else if (pluginUiRecord(value.source) && typeof value.source.themeId === 'string' && value.source.themeId.length <= 512 &&
        typeof value.source.packageSha256 === 'string' && /^[a-f0-9]{64}$/.test(value.source.packageSha256) &&
        typeof value.reference === 'string' && /^asset:[a-zA-Z0-9_-]{1,64}$/.test(value.reference) &&
        typeof value.hash === 'string' && /^[a-f0-9]{64}$/.test(value.hash) && value.family === `CindyTheme_${value.hash}`)
      result[field] = { source: { themeId: value.source.themeId, packageSha256: value.source.packageSha256 }, reference: value.reference, hash: value.hash, family: value.family };
  }
  for (const field of ['reading', 'contentStyle', 'themeColors', 'bodyFont', 'uiFontTraits', 'codeFontTraits'] as const) {
    if (raw[field] === undefined) continue;
    const publicField = field === 'themeColors' ? 'theme' : field === 'uiFontTraits' ? 'uiFont' : field === 'codeFontTraits' ? 'codeFont' : field;
    const parsed = parsePluginAppearancePatch({ [publicField]: raw[field] });
    if (!parsed) continue;
    if (field === 'uiFontTraits' || field === 'codeFontTraits') {
      const font = parsed[publicField as 'uiFont' | 'codeFont']!;
      if (font.family !== undefined || font.size !== undefined || font.resource !== undefined) continue;
    }
    if (field === 'bodyFont' && parsed.bodyFont?.resource !== undefined) continue;
    Object.assign(result, { [field]: parsed[publicField as keyof PluginAppearancePatch] });
  }
  return result;
}
