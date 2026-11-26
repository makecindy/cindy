import { GlassView } from 'expo-glass-effect';
import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { radius, spacing, useTheme } from '@/theme';
import { useLiquidGlassAvailable } from './useLiquidGlassAvailable';

export function AudioPlayerToolbar({ children }: { children: ReactNode }) {
  const { colors, mode } = useTheme();
  const glass = useLiquidGlassAvailable();
  return (
    <View style={[styles.bar, !glass && { backgroundColor: colors.surfaceElevated, borderColor: colors.borderTranslucent,
      borderWidth: StyleSheet.hairlineWidth }]} testID="message.audioToolbar">
      {glass && <GlassView pointerEvents="none" colorScheme={mode} glassEffectStyle="regular"
        style={[StyleSheet.absoluteFill, styles.material]} testID="message.audioToolbar.glass" />}
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    alignSelf: 'center', flexDirection: 'row', alignItems: 'center', minHeight: 52,
    marginTop: spacing.sm, marginBottom: spacing.md, paddingHorizontal: spacing.xs, borderRadius: radius.pill,
  },
  material: { borderRadius: radius.pill },
});
