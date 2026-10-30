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

/** Keep controls in the React Native hit-test tree; glass is only the backdrop. */
export function ComposerFrame({ expanded: _expanded, unframed, style, children, entryTransitionId, onEntryTransitionComplete, expandToken, ...contentProps }: ComposerFrameProps) {
  const { mode } = useTheme();
  if (unframed || !nativeComposerFrameAvailable) return <View {...contentProps} style={style}>{children}</View>;
  // The native morph module requires target -> glass contentView -> effectView.
  // Preserve that hierarchy for animated task composers.
  if (entryTransitionId || expandToken != null) return (
    <GlassView {...contentProps} colorScheme={mode} glassEffectStyle="regular" isInteractive={false}
      style={[style, { borderRadius: composerGeometry.cornerRadius }]}>
      {children}
      {MorphTarget ? <MorphTarget transitionId={entryTransitionId ?? ''} expandToken={expandToken ?? ''}
        cornerRadius={composerGeometry.cornerRadius} onComplete={() => onEntryTransitionComplete?.()}
        pointerEvents="none" style={StyleSheet.absoluteFill} /> : null}
    </GlassView>
  );
  return (
    <View {...contentProps} style={style}>
      <GlassView
        pointerEvents="none"
        colorScheme={mode}
        glassEffectStyle="regular"
        isInteractive={false}
        style={[StyleSheet.absoluteFill, { borderRadius: composerGeometry.cornerRadius }]}
      />
      {children}
    </View>
  );
}
