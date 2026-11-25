import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Text } from '@/components/AppText';
import { useTheme } from '@/theme';
import { fontWeight, lineHeight, radius, spacing, typeScale } from '@/theme/tokens';
import type { MobileTurnChanges } from './mobileTurnChanges';

export function MobileTurnChangesCard({ summary }: { summary: MobileTurnChanges }) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  return (
    <View style={[styles.card, { borderColor: colors.border }]} testID="message.turnChanges">
      <View style={styles.heading}>
        <Text style={[styles.title, { color: colors.textPrimary }]}>
          {t('message.renderer.turnChanges.title', { count: summary.fileCount })}
        </Text>
        <Text style={[styles.stats, { color: colors.textTertiary }]}>
          {`+${summary.additions} −${summary.deletions}`}
        </Text>
      </View>
      {summary.partial && (
        <Text style={[styles.note, { color: colors.textSecondary }]}>
          {t('message.renderer.turnChanges.partial')}
        </Text>
      )}
      {summary.fileNames.map((name, index) => (
        <Text key={index} style={[styles.note, { color: colors.textSecondary }]}>
          {name}
        </Text>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    padding: spacing.md,
    gap: spacing.xs,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.container,
  },
  heading: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    flexWrap: 'wrap',
    gap: spacing.xs,
  },
  title: {
    fontSize: typeScale.bodySmall,
    lineHeight: lineHeight.bodySmall,
    fontWeight: fontWeight.semibold,
  },
  stats: {
    fontSize: typeScale.caption,
    lineHeight: lineHeight.caption,
    fontVariant: ['tabular-nums'],
  },
  note: {
    fontSize: typeScale.footnote,
    lineHeight: lineHeight.caption,
  },
});
