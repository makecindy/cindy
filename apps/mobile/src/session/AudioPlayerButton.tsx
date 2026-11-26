import type { ReactNode } from 'react';
import { Pressable, StyleSheet, type ViewStyle } from 'react-native';
import { radius, useTheme } from '@/theme';
import type { AudioPlayerSymbolProps } from './AudioPlayerSymbol';

export type AudioPlayerButtonProps = {
  children: ReactNode;
  symbol: AudioPlayerSymbolProps['name'];
  size: number;
  width: number;
  height: number;
  label: string;
  disabled?: boolean;
  loading?: boolean;
  primary?: boolean;
  testID: string;
  onPress(): void;
  style: ViewStyle;
};

export function AudioPlayerButton({ children, label, disabled, loading, testID, onPress, style }: AudioPlayerButtonProps) {
  const { colors } = useTheme();
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled, busy: loading }}
      disabled={disabled} onPress={onPress} testID={testID}
      android_ripple={{ color: colors.borderTranslucent, foreground: true }}
      style={({ pressed }) => [style, styles.clip, pressed && styles.pressed]}>{children}</Pressable>
  );
}

const styles = StyleSheet.create({
  clip: { borderRadius: radius.pill, overflow: 'hidden' },
  pressed: { opacity: 0.72 },
});
