import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { Text } from '@/components/AppText';
import { fontWeight, lineHeight, radius, spacing, typeScale, useTheme, useThemedStyles, type ThemeColors } from '@/theme';

/** Visible height of card buttons; hitSlop brings the touch target to 44 (K5). */
const HEIGHT = 38;
const HIT_SLOP = { top: 3, bottom: 3 } as const;

/**
 * Companion card button (K5): 38pt pill, 15/20 medium label centered. Primary is the inverse CTA fill;
 * secondary is a quiet chip fill without a border. Rows of these share the width equally.
 */
export function CompanionCardButton({ label, onPress, primary = false, busy = false, disabled = false, accessibilityLabel, testID, style }: {
  label: string;
  onPress(): void;
  primary?: boolean;
  busy?: boolean;
  disabled?: boolean;
  accessibilityLabel?: string;
  testID?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const inactive = disabled || busy;
  return <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel ?? label}
    accessibilityState={{ disabled: inactive, busy: busy || undefined }} disabled={inactive} hitSlop={HIT_SLOP} onPress={onPress}
    style={({ pressed }) => [styles.button, primary ? styles.primary : styles.secondary, pressed && styles.pressed, disabled && styles.disabled, style]}
    testID={testID}>
    {busy
      ? <ActivityIndicator size="small" color={primary ? colors.ctaText : colors.textSecondary} />
      : <Text numberOfLines={1} style={[styles.label, primary && styles.labelPrimary]}>{label}</Text>}
  </Pressable>;
}

/** Equal-width row of card buttons, secondary first and primary last. */
export function CompanionCardActions({ children }: { children: ReactNode }) {
  const styles = useThemedStyles(makeStyles);
  return <View style={styles.actions}>{children}</View>;
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  actions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md },
  button: { flex: 1, minHeight: HEIGHT, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.md },
  primary: { backgroundColor: colors.cta },
  secondary: { backgroundColor: colors.surfaceChip },
  pressed: { opacity: 0.72 },
  disabled: { opacity: 0.45 },
  label: { color: colors.textPrimary, fontSize: typeScale.bodySmall, lineHeight: lineHeight.bodySmall, fontWeight: fontWeight.medium, textAlign: 'center' },
  labelPrimary: { color: colors.ctaText },
});
