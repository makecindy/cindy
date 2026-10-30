import { useEffect, useState } from 'react';
import { Image, Platform } from 'react-native';

/** MenuView uses UIImage(named:), which accepts an absolute file path, not a file URL.
 * Materialize the bundled image at 1x so UIImage keeps its 20pt canvas and 6pt dot.
 * ImageManipulator owns the temporary output directory; retain only this mount's file.
 */
export function useNativeMenuReminderImage(enabled: boolean): string | undefined {
  const [path, setPath] = useState<string>();
  useEffect(() => {
    if (!enabled || Platform.OS !== 'ios') return;
    let disposed = false;
    let removeImage: (() => void) | undefined;
    void (async () => {
      const [{ ImageManipulator, SaveFormat }, { File }] = await Promise.all([
        import('expo-image-manipulator'),
        import('expo-file-system'),
      ]);
      if (disposed) return;
      const source = Image.resolveAssetSource(require('../../../assets/navigation/filter-reminder.png'));
      const context = ImageManipulator.manipulate(source.uri);
      let image: Awaited<ReturnType<typeof context.renderAsync>> | undefined;
      try {
        context.resize({ width: 20, height: 20 });
        image = await context.renderAsync();
        const saved = await image.saveAsync({ format: SaveFormat.PNG });
        removeImage = () => {
          try { new File(saved.uri).delete(); } catch { /* OS cache cleanup can finish later. */ }
        };
        if (disposed) removeImage();
        else setPath(decodeURIComponent(saved.uri.replace(/^file:\/\//, '')));
      } finally {
        image?.release();
        context.release();
      }
    })().catch(() => { /* Keep the native menu and its ordinary row icons available. */ });
    return () => { disposed = true; removeImage?.(); };
  }, [enabled]);
  return path;
}
