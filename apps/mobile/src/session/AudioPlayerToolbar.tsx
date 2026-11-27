import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { radius, spacing, useThemedStyles, type ThemeColors } from '@/theme';

export function AudioPlayerToolbar({ children }: { children: ReactNode }) {
  const styles = useThemedStyles(makeStyles);
  return <View style={styles.bar} testID="message.audioToolbar">{children}</View>;
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  bar: {
    alignSelf: 'center', flexDirection: 'row', alignItems: 'center', minHeight: 48,
    marginTop: spacing.sm, marginBottom: spacing.md, paddingHorizontal: spacing.xs,
    borderRadius: radius.pill, backgroundColor: colors.surfaceElevated,
    borderColor: colors.borderTranslucent, borderWidth: StyleSheet.hairlineWidth,
  },
});
