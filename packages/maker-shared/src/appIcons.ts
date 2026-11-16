import { APP_ICONS, APP_ICON_ARTWORK } from "./appIcons.generated.js";

/**
 * App icons users can choose on Desktop (macOS Dock) and Mobile (iOS home
 * screen). The list and artwork come from `packages/maker-shared/app-icons`;
 * see its README for adding one.
 */
export { APP_ICONS };
export type AppIcon = (typeof APP_ICONS)[number];

export function isAppIcon(value: unknown): value is AppIcon {
  return APP_ICONS.includes(value as AppIcon);
}

/**
 * File name (without `.png`) of the artwork for this mode, shared by every
 * generated rendition. Null means the icon the platform ships with.
 */
export function appIconArtwork(icon: AppIcon, dark: boolean): string | null {
  const artwork = APP_ICON_ARTWORK[icon];
  return artwork ? (dark ? artwork.dark : artwork.light) : null;
}

const IOS_ICON_PREFIX = "AppIcon-";

/** iOS asset name for `setAlternateIconName`; null restores the primary icon. */
export function appIconAlternateName(icon: AppIcon): string | null {
  return APP_ICON_ARTWORK[icon] ? `${IOS_ICON_PREFIX}${icon}` : null;
}

/** Unknown names (an icon removed in a later version) read as the default. */
export function appIconFromAlternateName(name: string | null | undefined): AppIcon {
  const icon = name?.startsWith(IOS_ICON_PREFIX) ? name.slice(IOS_ICON_PREFIX.length) : null;
  return isAppIcon(icon) && APP_ICON_ARTWORK[icon] ? icon : APP_ICONS[0];
}
