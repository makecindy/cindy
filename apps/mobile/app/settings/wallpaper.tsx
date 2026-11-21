import { Redirect } from 'expo-router';
import { Platform } from 'react-native';
import { WallpaperSettings } from '@/settings/WallpaperSettings';

export default function WallpaperPage() {
  return Platform.OS === 'ios' ? <WallpaperSettings /> : <Redirect href="/settings" />;
}
