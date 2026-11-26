import { useState } from 'react';
import { Image, StyleSheet, View, type ImageSourcePropType } from 'react-native';
import { useTheme } from './ThemeProvider';
import { useWallpaper, wallpaperSources } from './wallpaper';

function Scene({ image, video, aspect, focus }: {
  image: ImageSourcePropType; video?: number | string; aspect: number; focus: number;
}) {
  const { mode, colors } = useTheme();
  const [size, setSize] = useState({ width: 0, height: 0 });
  const width = Math.max(size.width, size.height * aspect);
  const height = width / aspect;
  const left = Math.min(0, Math.max(size.width - width, size.width / 2 - width * focus));
  const Motion = video !== undefined ? (require('./WallpaperMotion') as typeof import('./WallpaperMotion')).WallpaperMotion : null;
  return <View accessible={false} accessibilityElementsHidden pointerEvents="none"
    style={[StyleSheet.absoluteFill, { overflow: 'hidden', backgroundColor: colors.surface }]}
    onLayout={({ nativeEvent: { layout } }) => setSize(previous =>
      previous.width === layout.width && previous.height === layout.height ? previous :
        { width: layout.width, height: layout.height })}>
    {width > 0 && <View style={{ position: 'absolute', width, height, left, top: (size.height - height) / 2 }}>
      <Image resizeMode="stretch" source={image} style={{ width: '100%', height: '100%' }} />
      {Motion && video !== undefined && <Motion key={video} source={video} />}
    </View>}
    <View style={[StyleSheet.absoluteFill, { backgroundColor: colors.surface, opacity: mode === 'dark' ? 0.84 : 0.78 }]} />
  </View>;
}

export function WallpaperBackdrop() {
  const { selected, dynamic, custom } = useWallpaper();
  if (selected === 'none') return null;
  if (selected === 'custom') return custom && <Scene image={{ uri: custom.imageUri }}
    video={dynamic && custom.videoUri ? custom.videoUri : undefined} aspect={custom.width / custom.height} focus={0.5} />;
  const scene = wallpaperSources[selected];
  return <Scene image={scene.image()} video={dynamic ? scene.video() : undefined} aspect={16 / 9} focus={scene.focus} />;
}
