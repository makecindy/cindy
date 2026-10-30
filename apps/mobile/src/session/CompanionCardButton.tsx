import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { Text } from '@/components/AppText';
import { fontWeight, lineHeight, radius, spacing, typeScale, useTheme, useThemedStyles, type ThemeColors } from '@/theme';

/** Visible height of card buttons; hitSlop brings the touch target to 44 (K5). */
const HEIGHT = 38;
const HIT_SLOP = { top: 3, bottom: 3 } as const;
// A width, not a percentage flexBasis: Fabric does not re-lay out a basis that changes from 0 to '100%'.
const STACKED = { flexBasis: 'auto', width: '100%' } as const;
const StackContext = createContext<{ stacked: boolean; onWrap(): void } | null>(null);

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
  const stack = useContext(StackContext);
  const inactive = disabled || busy;
  return <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel ?? label}
    accessibilityState={{ disabled: inactive, busy: busy || undefined }} disabled={inactive} hitSlop={HIT_SLOP} onPress={onPress}
    style={({ pressed }) => [styles.button, primary ? styles.primary : styles.secondary, pressed && styles.pressed, disabled && styles.disabled, stack?.stacked && STACKED, style]}
    testID={testID}>
    {busy
      ? <ActivityIndicator size="small" color={primary ? colors.ctaText : colors.textSecondary} />
      : <Text onTextLayout={stack && !stack.stacked ? (event) => { if (event.nativeEvent.lines.length > 1) stack.onWrap(); } : undefined}
        style={[styles.label, primary && styles.labelPrimary]}>{label}</Text>}
  </Pressable>;
}

/**
 * Equal-width row of card buttons, secondary first and primary last. If any label would wrap at that
 * width (long English / Japanese copy on a narrow card), the whole group switches once to one
 * full-width button per row, like the teammate permission card.
 */
export function CompanionCardActions({ children }: { children: ReactNode }) {
  const styles = useThemedStyles(makeStyles);
  const [stacked, setStacked] = useState(false);
  const stack = useMemo(() => ({ stacked, onWrap: () => setStacked(true) }), [stacked]);
  return <StackContext.Provider value={stack}>
    <View style={styles.actions} testID={stacked ? 'companion.cardActions.stacked' : undefined}>{children}</View>
  </StackContext.Provider>;
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.md },
  button: { flex: 1, minHeight: HEIGHT, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.md },
  primary: { backgroundColor: colors.cta },
  secondary: { backgroundColor: colors.surfaceChip },
  pressed: { opacity: 0.72 },
  disabled: { opacity: 0.45 },
  label: { color: colors.textPrimary, fontSize: typeScale.bodySmall, lineHeight: lineHeight.bodySmall, fontWeight: fontWeight.medium, textAlign: 'center' },
  labelPrimary: { color: colors.ctaText },
});
