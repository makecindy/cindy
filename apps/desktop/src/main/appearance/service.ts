import { createHash } from 'node:crypto';
import { parseThemeSelection, type ThemeSelection } from '../../shared/appearanceDefinition.js';
import { DEFAULT_APPEARANCE_SETTINGS, normalizeAppearanceSettings, type AppearanceOverrides, type AppearanceSettings } from '../../shared/appearanceSettings.js';
import type { OverrideSettingsFile, OverrideSettingsState } from '../maker-host/override-settings-file.js';
import { LOCAL_THEME_SUFFIX } from '../../shared/local-themes.js';

export const appearanceRevision = (value: AppearanceSettings) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export interface AppearanceSnapshot { readonly revision: string; readonly settings: AppearanceSettings }
export type ThemeAppearanceDefaults = Partial<AppearanceSettings>;
interface Dependencies {
  store: OverrideSettingsFile<AppearanceSettings>;
  resolveTheme(selection: ThemeSelection, retainWallpaper: (url: string) => void): Promise<ThemeAppearanceDefaults>;
  wallpaper(): { url: string; fallbackUrl?: string };
  cleanupMedia?(): Promise<void>;
}

/** Existing settings owner with a rebuildable projection of the renderer's package choice. */
export class AppearanceService {
  private projection: { selection: ThemeSelection; values: ThemeAppearanceDefaults } | undefined;
  private readonly preparing = new Set<Set<string>>();
  private selectionGeneration = 0;
  private refreshGeneration = 0;
  constructor(private readonly deps: Dependencies) {}

  private themeKey(selection: ThemeSelection): string { return JSON.stringify(selection); }
  private raw() { return this.deps.store.readState(); }
  hasThemeDefaults(): boolean { return !!this.projection && Object.keys(this.projection.values).length > 0; }
  private defaults(): AppearanceSettings {
    return normalizeAppearanceSettings({ ...DEFAULT_APPEARANCE_SETTINGS,
      ...this.projection?.values });
  }
  private compose(raw: OverrideSettingsState<AppearanceSettings>): OverrideSettingsState<AppearanceSettings> {
    if (!this.hasThemeDefaults()) {
      // Preserve the original settings value and customized-state shape.
      const media = this.deps.wallpaper();
      return { ...raw, value: { ...raw.value, customWallpaperUrl: media.url,
        ...(media.fallbackUrl ? { customWallpaperFallbackUrl: media.fallbackUrl } : {}),
        wallpaperId: raw.value.wallpaperId === 'custom' && !media.url ? 'none' : raw.value.wallpaperId } };
    }
    const defaults = this.defaults();
    const overrides = Object.fromEntries(raw.customizedKeys.filter(key => raw.value[key as keyof AppearanceSettings] !== undefined).map(key => [key, raw.value[key as keyof AppearanceSettings]]));
    const value = normalizeAppearanceSettings({ ...defaults, ...overrides });
    for (const key of ['bodyFont', 'reading', 'contentStyle', 'uiFontTraits', 'codeFontTraits'] as const) {
      if (defaults[key] && value[key]) Object.assign(value, { [key]: { ...defaults[key], ...value[key] } });
    }
    for (const prefix of ['ui', 'code', 'terminal'] as const) {
      const resourceKey = `${prefix}FontResource` as 'uiFontResource';
      if (raw.customizedKeys.includes(`${prefix}Family`) && !raw.customizedKeys.includes(resourceKey)) delete value[resourceKey];
    }
    if (raw.value.bodyFont?.family !== undefined && raw.customizedKeys.includes('bodyFont') && !raw.customizedKeys.includes('bodyFontResource')) delete value.bodyFontResource;
    const media = this.deps.wallpaper();
    const themeWallpaper = !raw.customizedKeys.includes('wallpaperId') && defaults.customWallpaperUrl;
    value.customWallpaperUrl = themeWallpaper ? defaults.customWallpaperUrl : media.url;
    const fallback = themeWallpaper ? defaults.customWallpaperFallbackUrl : media.fallbackUrl;
    if (fallback) value.customWallpaperFallbackUrl = fallback;
    else delete value.customWallpaperFallbackUrl;
    if (value.wallpaperId === 'custom' && !value.customWallpaperUrl) value.wallpaperId = 'none';
    const customizedKeys = raw.customizedKeys;
    value.customizedKeys = customizedKeys;
    return { defaults, value, customizedKeys, isCustomized: customizedKeys.length > 0 };
  }
  readState() { return this.compose(this.raw()); }
  read() { return this.readState().value; }
  snapshot(): AppearanceSnapshot {
    const settings = structuredClone(this.readState().value);
    return Object.freeze({ revision: appearanceRevision(settings), settings: freeze(settings) });
  }
  async update(updater: (current: AppearanceSettings, overrides: AppearanceOverrides) => AppearanceOverrides) {
    await this.deps.store.updateAtomic(raw => {
      const overrides = Object.fromEntries(raw.customizedKeys.map(key => [key, raw.value[key as keyof AppearanceSettings]]));
      return updater(this.compose(raw).value, overrides);
    });
    return this.read();
  }
  patch(patch: AppearanceOverrides) { return this.update(() => patch); }
  async select(raw: unknown): Promise<AppearanceSettings> {
    if (raw === null) {
      ++this.selectionGeneration;
      if (!this.projection && !this.preparing.size) return this.read();
      this.projection = undefined;
      await this.deps.cleanupMedia?.();
      return this.read();
    }
    const selection = parseThemeSelection(raw);
    if (!selection) throw new Error('INVALID_PARAMS');
    if (!selection.familyId.endsWith(LOCAL_THEME_SUFFIX)) throw new Error('INVALID_PARAMS');
    const generation = ++this.selectionGeneration;
    const prepared = await this.prepare(selection);
    try {
      if (generation === this.selectionGeneration) this.projection = { selection, values: prepared.values };
    } finally {
      prepared.release();
    }
    await this.deps.cleanupMedia?.();
    return this.read();
  }
  refresh(): Promise<AppearanceSettings> | undefined {
    const selection = this.projection?.selection;
    if (!selection) return undefined;
    return this.refreshSelected(selection);
  }
  private async refreshSelected(selection: ThemeSelection): Promise<AppearanceSettings> {
    const refresh = ++this.refreshGeneration, generation = this.selectionGeneration;
    const prepared = await this.prepare(selection);
    try {
      // Preparation may finish after a newer selection; never replace its defaults.
      if (refresh === this.refreshGeneration && generation === this.selectionGeneration &&
          this.projection && this.themeKey(this.projection.selection) === this.themeKey(selection))
        this.projection = { selection, values: prepared.values };
    } finally { prepared.release(); }
    await this.deps.cleanupMedia?.();
    return this.read();
  }
  async reset(): Promise<AppearanceSettings> {
    await this.deps.store.resetAtomic();
    return this.read();
  }
  referencedWallpapers(): string[] {
    return (this.projection ? [this.projection.values] : []).flatMap(value => [value.customWallpaperUrl, value.customWallpaperFallbackUrl])
      .concat([...this.preparing].flatMap(value => [...value])).filter((value): value is string => !!value);
  }
  private async prepare(selection: ThemeSelection) {
    const references = new Set<string>();
    this.preparing.add(references);
    try {
      return { values: await this.deps.resolveTheme(selection, url => references.add(url)), release: () => { this.preparing.delete(references); } };
    } catch (error) { this.preparing.delete(references); throw error; }
  }
}

function freeze<T extends object>(value: T): T {
  for (const child of Object.values(value)) if (child && typeof child === 'object') freeze(child);
  return Object.freeze(value);
}
