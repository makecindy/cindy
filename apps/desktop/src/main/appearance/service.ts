import { createHash } from 'node:crypto';
import { DEFAULT_THEME_SELECTION, parseThemeSelection, type ThemeSelection } from '../../shared/appearanceDefinition.js';
import { DEFAULT_APPEARANCE_SETTINGS, normalizeAppearanceSettings, type AppearanceOverrides, type AppearanceSettings } from '../../shared/appearanceSettings.js';
import type { OverrideSettingsFile, OverrideSettingsState } from '../maker-host/override-settings-file.js';

export const appearanceRevision = (value: AppearanceSettings) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export interface AppearanceSnapshot { readonly revision: string; readonly settings: AppearanceSettings }
export type ThemeAppearanceDefaults = Omit<Partial<AppearanceSettings>, 'themeSelection'>;
interface Dependencies {
  store: OverrideSettingsFile<AppearanceSettings>;
  resolveTheme(selection: ThemeSelection, retainWallpaper: (url: string) => void): Promise<ThemeAppearanceDefaults>;
  wallpaper(): { url: string; fallbackUrl?: string };
  cleanupMedia?(): Promise<void>;
}

/** Sole appearance owner. Theme defaults are rebuilt data; only explicit overrides persist. */
export class AppearanceService {
  private readonly themes = new Map<string, ThemeAppearanceDefaults>();
  private readonly preparing = new Set<Set<string>>();
  private selectionGeneration = 0;
  private refreshGeneration = 0;
  constructor(private readonly deps: Dependencies) {}

  private themeKey(selection: ThemeSelection): string { return JSON.stringify(selection); }
  private raw() { this.deps.store.invalidateIfChanged(); return this.deps.store.readState(); }
  private defaults(selection?: ThemeSelection): AppearanceSettings {
    return normalizeAppearanceSettings({ ...DEFAULT_APPEARANCE_SETTINGS,
      ...(selection ? this.themes.get(this.themeKey(selection)) : {}) });
  }
  private compose(raw: OverrideSettingsState<AppearanceSettings>): OverrideSettingsState<AppearanceSettings> {
    const defaults = this.defaults(raw.value.themeSelection);
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
    const customizedKeys = raw.customizedKeys.filter(key => key !== 'themeSelection' ||
      JSON.stringify(raw.value.themeSelection) !== JSON.stringify(DEFAULT_THEME_SELECTION));
    value.customizedKeys = customizedKeys;
    return { defaults, value, customizedKeys, isCustomized: customizedKeys.length > 0 };
  }
  readState() { return this.compose(this.raw()); }
  read() { return this.snapshot().settings; }
  snapshot(): AppearanceSnapshot {
    const settings = this.readState().value;
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
  async select(raw: unknown, migrate = false): Promise<AppearanceSettings> {
    const selection = parseThemeSelection(raw);
    if (!selection) throw new Error('INVALID_PARAMS');
    if (migrate && this.raw().value.themeSelection) return this.read();
    const generation = ++this.selectionGeneration;
    const prepared = await this.prepare(selection);
    const defaults = prepared.values;
    const key = this.themeKey(selection), previous = this.themes.get(key);
    try {
      if (generation !== this.selectionGeneration) return this.read();
      this.themes.set(key, defaults);
      await this.deps.store.updateAtomic(current => generation !== this.selectionGeneration || migrate && current.value.themeSelection ? {} : { themeSelection: selection });
    } catch (error) {
      if (this.themes.get(key) === defaults) {
        if (previous) this.themes.set(key, previous); else this.themes.delete(key);
      }
      throw error;
    } finally {
      prepared.release();
    }
    this.prune();
    await this.deps.cleanupMedia?.();
    return this.read();
  }
  async refresh(): Promise<AppearanceSettings> {
    const refresh = ++this.refreshGeneration, generation = this.selectionGeneration;
    const selection = this.raw().value.themeSelection;
    if (selection) {
      const prepared = await this.prepare(selection);
      try {
        // Preparation may finish after a newer selection; never replace its defaults.
        if (refresh === this.refreshGeneration && generation === this.selectionGeneration &&
            this.raw().value.themeSelection && this.themeKey(this.raw().value.themeSelection!) === this.themeKey(selection))
          this.themes.set(this.themeKey(selection), prepared.values);
      } finally { prepared.release(); }
    }
    this.prune();
    await this.deps.cleanupMedia?.();
    return this.read();
  }
  async reset(): Promise<AppearanceSettings> {
    ++this.selectionGeneration;
    await this.deps.store.updateAtomic(current => ({
      ...Object.fromEntries(current.customizedKeys.map(key => [key, undefined])),
      // Retain completion of the migration; never re-adopt stale localStorage.
      ...(current.value.themeSelection ? { themeSelection: { ...DEFAULT_THEME_SELECTION } } : {}),
    }));
    this.prune();
    await this.deps.cleanupMedia?.();
    return this.read();
  }
  referencedWallpapers(): string[] {
    return [...this.themes.values()].flatMap(value => [value.customWallpaperUrl, value.customWallpaperFallbackUrl])
      .concat([...this.preparing].flatMap(value => [...value])).filter((value): value is string => !!value);
  }
  private async prepare(selection: ThemeSelection) {
    const references = new Set<string>();
    this.preparing.add(references);
    try {
      return { values: await this.deps.resolveTheme(selection, url => references.add(url)), release: () => { this.preparing.delete(references); } };
    } catch (error) { this.preparing.delete(references); throw error; }
  }
  private prune() {
    const selection = this.raw().value.themeSelection;
    const key = selection ? this.themeKey(selection) : '';
    for (const cached of this.themes.keys()) if (cached !== key) this.themes.delete(cached);
  }
}

function freeze<T extends object>(value: T): T {
  for (const child of Object.values(value)) if (child && typeof child === 'object') freeze(child);
  return Object.freeze(value);
}
