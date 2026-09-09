/**
 * Google Play only permits broad Android photo-library access when it is
 * essential to the app's primary purpose. Cindy only attaches user-selected
 * images, so Android must use the system photo picker instead.
 *
 * iOS keeps the existing recent-photo and screenshot surfaces, whose asset
 * resolution still depends on expo-media-library.
 */
export function canBrowsePhotoLibraryDirectly(platform: string): boolean {
  return platform === 'ios';
}
