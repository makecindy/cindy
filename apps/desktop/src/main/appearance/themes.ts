import { nativeTheme } from 'electron';
import type { ThemeSelection, ThemeFontResource } from '../../shared/appearanceDefinition.js';
import type { ThemeAppearanceDefaults } from './service.js';
import { LOCAL_THEME_SUFFIX } from '../../shared/local-themes.js';
import { getLocalThemesDir, loadLocalThemesSync } from '../local-themes/loader.js';
import { readThemePackageResourceSync } from '../local-themes/packages.js';
import { ingestClientWallpaper } from '../cindy-media/ingest.js';
import { withClientWallpaperLock } from '../cindy-media/clientWallpaperLock.js';
import { appearanceDefinitionToOverrides, APPEARANCE_FONT_ROLES } from './definition.js';
import { prepareAppearanceResource, inspectAppearanceResource } from './resources.js';

/** Built-ins have no extra appearance defaults; all supplied definitions use this owner. */
export async function resolveThemeAppearance(selection: ThemeSelection, retainWallpaper: (url: string) => void): Promise<ThemeAppearanceDefaults> {
  if (!selection.familyId.endsWith(LOCAL_THEME_SUFFIX)) return {};
  const requested = selection.mode === 'system' ? nativeTheme?.shouldUseDarkColors ? 'dark' : 'light' : selection.mode;
  const family = loadLocalThemesSync().themes.filter(theme => (theme.family ? `${theme.family}${LOCAL_THEME_SUFFIX}` : theme.id) === selection.familyId);
  const theme = family.find(value => value.type === requested) ?? family[0];
  if (!theme?.appearance) return {};
  const assets: Partial<Record<typeof APPEARANCE_FONT_ROLES[number], ThemeFontResource>> = {};
  const read = (reference: string) => readThemePackageResourceSync(getLocalThemesDir(), theme.id.slice(0, -LOCAL_THEME_SUFFIX.length), reference);
  for (const role of APPEARANCE_FONT_ROLES) {
    const reference = theme.appearance[role]?.resource;
    if (!reference) continue;
    const { bytes, packageSha256 } = read(reference);
    const { hash } = inspectAppearanceResource(bytes, 'font');
    assets[role] = { source: { themeId: theme.id, packageSha256 }, reference, hash, family: `CindyTheme_${hash}` };
  }
  const defaults: ThemeAppearanceDefaults = appearanceDefinitionToOverrides({}, theme.appearance, assets);
  const wallpaper = theme.appearance.wallpaper;
  if (wallpaper?.resource) {
    const prepared = await prepareAppearanceResource(read(wallpaper.resource).bytes, 'wallpaper');
    const fallback = wallpaper.fallbackResource ? await prepareAppearanceResource(read(wallpaper.fallbackResource).bytes, 'image') : undefined;
    await withClientWallpaperLock(async () => {
      const media = await ingestClientWallpaper({ buffer: prepared.bytes, mimeType: prepared.kind === 'video' ? 'video/mp4' : 'image/webp' });
      retainWallpaper(media.url);
      defaults.customWallpaperUrl = media.url;
      if (fallback) {
        const image = await ingestClientWallpaper({ buffer: fallback.bytes, mimeType: 'image/webp' });
        retainWallpaper(image.url);
        defaults.customWallpaperFallbackUrl = image.url;
      }
    });
  }
  return defaults;
}

export function readThemeFont(resource: ThemeFontResource): { family: string; bytes: ArrayBuffer } {
  const loaded = readThemePackageResourceSync(getLocalThemesDir(), resource.source.themeId.slice(0, -LOCAL_THEME_SUFFIX.length), resource.reference);
  if (loaded.packageSha256 !== resource.source.packageSha256 || inspectAppearanceResource(loaded.bytes, 'font').hash !== resource.hash) throw new Error('RESOURCE_UNAVAILABLE');
  return { family: resource.family, bytes: new Uint8Array(loaded.bytes).buffer };
}
