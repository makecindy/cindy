import { View, StyleSheet } from 'react-native';
import { Square } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { Text } from '@/components/AppText';
import { SharedTaskAction } from '@/session/SharedTaskScreen';
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { fontWeight, iconSize, lineHeight, radius, spacing, typeScale } from '@/theme/tokens';

/** Membership loss has a recovery action, without claiming an unverified offline cause. */
export function SharedTaskEndedState({ onRejoin }: { onRejoin(): void }) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  return <View style={styles.body} testID="sharedTask.ended">
    <View style={styles.icon}><Square size={iconSize.md} color={colors.textTertiary} /></View>
    <Text style={styles.title}>{t('sharedTask.ended')}</Text>
    <Text style={styles.text}>{t('sharedTask.accessEndedBody')}</Text>
    <SharedTaskAction action={{ label: t('sharedTask.rejoin'), tone: 'primary', onPress: onRejoin }} />
  </View>;
}
const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  body: { paddingVertical: spacing.xl, paddingHorizontal: spacing.xs, alignItems: 'center' },
  icon: { width: 44, height: 44, borderRadius: radius.pill, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, alignItems: 'center', justifyContent: 'center', marginBottom: spacing.lg },
  title: { color: colors.textPrimary, fontSize: typeScale.bodySmall, lineHeight: lineHeight.bodySmall, fontWeight: fontWeight.medium },
  text: { color: colors.textTertiary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption, textAlign: 'center', maxWidth: 280, marginTop: spacing.sm, marginBottom: spacing.lg },
});
