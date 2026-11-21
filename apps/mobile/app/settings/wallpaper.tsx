import { Redirect } from 'expo-router';
import { Platform } from 'react-native';
import { WallpaperSettings } from '@/settings/WallpaperSettings';
import { supportsAppWallpaper } from '@/theme/wallpaper';

export default function WallpaperPage() {
  return supportsAppWallpaper(Platform.OS) ? <WallpaperSettings /> : <Redirect href="/settings" />;
}
