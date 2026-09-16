import { GlassView, isLiquidGlassAvailable } from 'expo-glass-effect';
import { View } from 'react-native';
import { useTheme } from '@/theme';
import type { ComposerFrameProps } from './ComposerFrame';

export const nativeComposerFrameAvailable = isLiquidGlassAvailable();

/** UIKit glass contains the controls directly, preserving UITextView touch/focus routing. */
export function ComposerFrame({ expanded: _expanded, unframed, style, ...contentProps }: ComposerFrameProps) {
  const { mode } = useTheme();
  if (unframed || !nativeComposerFrameAvailable) return <View {...contentProps} style={style} />;
  return (
    <GlassView
      {...contentProps}
      colorScheme={mode}
      glassEffectStyle="regular"
      isInteractive={false}
      // Native glass geometry matches the existing expanded composer contour.
      style={[style, { borderRadius: 30 }]}
    />
  );
}
