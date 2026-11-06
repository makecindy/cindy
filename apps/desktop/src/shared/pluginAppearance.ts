import { parsePluginAppearancePatch, isPluginAppearanceResource } from '../../../../packages/maker-shared/src/pluginAppearance.js';
import { pluginUiRecord } from '../../../../packages/maker-shared/src/pluginUi.js';
import type { PluginAppearancePatch, PluginAppearanceFont } from '@cindy/maker-shared/plugin-ui';

/** Resource provenance is Host metadata in the existing appearance overrides. */
export interface PluginAppearanceSource { instanceId: string; key: string }
export interface PluginFontResource {
  source: PluginAppearanceSource; reference: string; hash: string; family: string;
}
export interface PluginAppearanceSettingsFields {
  uiFontResource?: PluginFontResource;
  codeFontResource?: PluginFontResource;
  bodyFontResource?: PluginFontResource;
  uiFontTraits?: Pick<PluginAppearanceFont, 'weight' | 'style'>;
  codeFontTraits?: Pick<PluginAppearanceFont, 'weight' | 'style'>;
  bodyFont?: Omit<PluginAppearanceFont, 'resource'>;
  reading?: PluginAppearancePatch['reading'];
  contentStyle?: PluginAppearancePatch['contentStyle'];
  themeColors?: PluginAppearancePatch['theme'];
}

export const PLUGIN_APPEARANCE_FONT = 'ghosts:appearance:font';
export const PLUGIN_APPEARANCE_APPLY = 'ghosts:appearance:apply';
export const PLUGIN_APPEARANCE_APPLIED = 'ghosts:appearance:applied';
export interface PluginAppearanceApplication {
  requestId: string;
  settings: import('./appearanceSettings').AppearanceSettings;
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
