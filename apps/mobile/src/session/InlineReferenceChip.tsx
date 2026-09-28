import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Text } from '@/components/AppText';
import { fontWeight, lineHeight, radius, spacing, typeScale, useThemedStyles, type ThemeColors } from '@/theme';

/** Shared compact pill shell for composer-adjacent and sent-message references. */
export function InlineReferenceChip({
  accessibilityLabel,
  icon,
  label,
  onPress,
  testID,
}: {
  accessibilityLabel?: string;
  icon?: ReactNode;
  label: string;
  onPress?: () => void;
  testID?: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const content = (
    <>
      {icon ? <View style={styles.icon}>{icon}</View> : null}
      <Text numberOfLines={1} style={styles.label}>{label}</Text>
    </>
  );
  if (!onPress) return <View style={styles.pill} testID={testID}>{content}</View>;
  return (
    <Pressable
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityRole="button"
      hitSlop={8}
      onPress={onPress}
      style={({ pressed }) => [styles.pill, pressed && styles.pressed]}
      testID={testID}
    >
      {content}
    </Pressable>
  );
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  pill: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    backgroundColor: colors.surfaceChip,
    borderColor: colors.border,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: 6,
    maxWidth: 240,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
  },
  icon: { alignItems: 'center', justifyContent: 'center' },
  label: {
    color: colors.textPrimary,
    flexShrink: 1,
    fontSize: typeScale.caption,
    fontWeight: fontWeight.regular,
    lineHeight: lineHeight.bodySmall,
  },
  pressed: { opacity: 0.7 },
});
