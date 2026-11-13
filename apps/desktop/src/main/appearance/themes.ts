import { nativeTheme } from 'electron';
import type { ThemeSelection, ThemeFontResource } from '../../shared/appearanceDefinition.js';
import type { ThemeAppearanceDefaults } from './service.js';
import { LOCAL_THEME_SUFFIX } from '../../shared/local-themes.js';
import { getLocalThemesDir, loadLocalThemesSync } from '../local-themes/loader.js';
import { readThemePackageResource } from '../local-themes/packages.js';
import { ingestClientWallpaper } from '../cindy-media/ingest.js';
import { withClientWallpaperLock } from '../cindy-media/clientWallpaperLock.js';
import { appearanceDefinitionToOverrides, APPEARANCE_FONT_ROLES } from './definition.js';
import { prepareAppearanceResource } from './resources.js';

/** Built-ins have no extra appearance defaults; all supplied definitions use this owner. */
export async function resolveThemeAppearance(selection: ThemeSelection, retainWallpaper: (url: string) => void): Promise<ThemeAppearanceDefaults> {
  if (!selection.familyId.endsWith(LOCAL_THEME_SUFFIX)) return {};
  const requested = selection.mode === 'system' ? nativeTheme?.shouldUseDarkColors ? 'dark' : 'light' : selection.mode;
  const family = loadLocalThemesSync().themes.filter(theme => (theme.family ? `${theme.family}${LOCAL_THEME_SUFFIX}` : theme.id) === selection.familyId);
  const theme = family.find(value => value.type === requested) ?? family[0];
  if (!theme?.packageSha256 || !theme.appearance) return {};
  const assets: Partial<Record<typeof APPEARANCE_FONT_ROLES[number], ThemeFontResource>> = {};
  const fonts = new Map<string, Promise<{ hash: string; packageSha256: string }>>();
  let packageSha256: string | undefined;
  const read = async (reference: string) => {
    const loaded = await readThemePackageResource(getLocalThemesDir(), theme.id.slice(0, -LOCAL_THEME_SUFFIX.length), reference);
    if (packageSha256 && loaded.packageSha256 !== packageSha256) throw new Error('RESOURCE_UNAVAILABLE');
    packageSha256 = loaded.packageSha256;
    return loaded;
  };
  for (const role of APPEARANCE_FONT_ROLES) {
    const reference = theme.appearance[role]?.resource;
    if (!reference) continue;
    let pending = fonts.get(reference);
    if (!pending) {
      pending = read(reference).then(({ hash, packageSha256 }) => ({ hash, packageSha256 }));
      fonts.set(reference, pending);
    }
    const font = await pending;
    assets[role] = { source: { themeId: theme.id, packageSha256: font.packageSha256 }, reference, hash: font.hash, family: `CindyTheme_${font.hash}` };
  }
  const defaults: ThemeAppearanceDefaults = appearanceDefinitionToOverrides({}, theme.appearance, assets);
  const wallpaper = theme.appearance.wallpaper;
  if (wallpaper?.resource) {
    const loaded = await read(wallpaper.resource);
    const prepared = loaded.resource.kind === 'video' ? { bytes: loaded.bytes, kind: 'video' } : await prepareAppearanceResource(loaded.bytes, 'image');
    const fallback = wallpaper.fallbackResource === wallpaper.resource ? prepared :
      wallpaper.fallbackResource ? await prepareAppearanceResource((await read(wallpaper.fallbackResource)).bytes, 'image') : undefined;
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

export async function readThemeFont(resource: ThemeFontResource): Promise<{ family: string; bytes: ArrayBuffer }> {
  const loaded = await readThemePackageResource(getLocalThemesDir(), resource.source.themeId.slice(0, -LOCAL_THEME_SUFFIX.length), resource.reference);
  if (loaded.resource.kind !== 'font' || loaded.packageSha256 !== resource.source.packageSha256 || loaded.hash !== resource.hash) throw new Error('RESOURCE_UNAVAILABLE');
  return { family: resource.family, bytes: new Uint8Array(loaded.bytes).buffer };
}
