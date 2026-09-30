import { GlassView, isLiquidGlassAvailable } from 'expo-glass-effect';
import { View } from 'react-native';
import { useTheme } from '@/theme';
import type { ComposerFrameProps } from './ComposerFrame';
import { requireNativeView, requireOptionalNativeModule } from 'expo';
import { StyleSheet } from 'react-native';
import { composerGeometry } from './composerGeometry';

const MorphTarget = requireOptionalNativeModule('CindyComposerMorph') ? requireNativeView<{
  transitionId: string; expandToken: string; cornerRadius: number; onComplete(): void; style: object; pointerEvents: 'none';
}>('CindyComposerMorph', 'CindyComposerMorphTarget') : null;

export const nativeComposerFrameAvailable = isLiquidGlassAvailable();

/** UIKit glass contains the controls directly, preserving UITextView touch/focus routing. */
export function ComposerFrame({ expanded: _expanded, unframed, style, children, entryTransitionId, onEntryTransitionComplete, expandToken, ...contentProps }: ComposerFrameProps) {
  const { mode } = useTheme();
  if (unframed || !nativeComposerFrameAvailable) return <View {...contentProps} style={style}>{children}</View>;
  return (
    <GlassView
      {...contentProps}
      colorScheme={mode}
      glassEffectStyle="regular"
      isInteractive={false}
      // Native glass geometry matches the existing expanded composer contour.
      style={[style, { borderRadius: composerGeometry.cornerRadius }]}
    >
      {children}
      {(entryTransitionId || expandToken != null) && MorphTarget ? <MorphTarget transitionId={entryTransitionId ?? ''}
        expandToken={expandToken ?? ''}
        cornerRadius={composerGeometry.cornerRadius}
        onComplete={() => onEntryTransitionComplete?.()} pointerEvents="none" style={StyleSheet.absoluteFill} /> : null}
    </GlassView>
  );
}
