import { Pressable, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Text } from '@/components/AppText';
import { mobileInteractionStyles } from '@/components/mobileInteractionStyles';
import { fontWeight, lineHeight, useThemedStyles, type ThemeColors } from '@/theme';
import { radius, spacing, typeScale } from '@/theme/tokens';

/** Explicit recovery only; never sends a message or interprets the cause of a stream failure. */
export function ReadableHistoryRecovery({ onRecover, busy }: { onRecover(): void; busy?: boolean }) {
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  return <View style={styles.container}>
    <Text style={styles.description}>{t('session.tail.readableHistoryRecoveryDescription')}</Text>
    <Pressable accessibilityRole="button" disabled={busy}
      accessibilityState={{ disabled: !!busy, busy: !!busy }}
      onPress={onRecover} testID="session.readableHistoryRecovery"
      style={({ pressed }) => [styles.button, pressed && mobileInteractionStyles.pressed, busy && styles.disabled]}>
      <Text style={styles.label}>{t('session.tail.readableHistoryRecovery')}</Text>
    </Pressable>
  </View>;
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  container: { gap: spacing.sm },
  description: { color: colors.textSecondary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption, fontWeight: fontWeight.regular },
  button: { minHeight: 44, borderRadius: radius.pill, backgroundColor: colors.surfaceChip, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, alignItems: 'center', justifyContent: 'center', alignSelf: 'flex-start' },
  label: { color: colors.textPrimary, fontSize: typeScale.body, lineHeight: lineHeight.body, fontWeight: fontWeight.medium },
  disabled: { opacity: 0.5 },
});
