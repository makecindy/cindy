import { Pressable, StyleSheet, View } from 'react-native';
import { BookOpen, Brain } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { botLearningRows } from '@cindy/maker-shared/bot-learning';
import { Text } from '@/components/AppText';
import { useTheme, useThemedStyles, iconSize, iconStroke, typeScale, lineHeight, spacing } from '@/theme';
import type { ThemeColors } from '@/theme';

/**
 * Save receipt under the reply that wrote memory (or, for a companion, a Skill).
 *
 * In a companion chat the rows open the companion's settings pages (`onOpenSettings`). An ordinary
 * task's memory lives on the computer that ran it and has no page on the phone, so there the
 * receipt is a plain line: nothing to tap, and never a way into companion settings.
 */
export function CompanionLearningFooter({
  receipts,
  onOpenSettings,
}: {
  receipts: unknown;
  /** Absent for ordinary tasks: the rows are not interactive. */
  onOpenSettings?: (page: 'memory' | 'capabilities') => void;
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const all = botLearningRows(receipts);
  // Ordinary tasks only ever save memory; a Skill row belongs to a companion.
  const rows = onOpenSettings ? all : all.filter((row) => row.kind === 'memory');
  if (!rows.length) return null;
  return (
    <View testID="message.learningFooter">
      {rows.map((row) => {
        const Icon = row.kind === 'memory' ? Brain : BookOpen;
        if (!onOpenSettings) {
          return (
            <View key={row.kind} style={styles.staticRow}>
              <Icon color={colors.textTertiary} size={iconSize.xs} strokeWidth={iconStroke.thin} />
              <Text style={styles.staticText}>{t('message.learning.memory', { title: row.title })}</Text>
            </View>
          );
        }
        return (
          <Pressable
            key={row.kind}
            accessibilityRole="button"
            style={styles.row}
            onPress={() => onOpenSettings(row.kind === 'memory' ? 'memory' : 'capabilities')}
          >
            <Icon color={colors.textTertiary} size={iconSize.xs} strokeWidth={iconStroke.thin} />
            <Text style={styles.text}>
              {t(
                `message.learning.${row.kind === 'memory' ? 'memory' : row.action === 'created' ? 'skillCreated' : 'skillUpdated'}`,
                { title: row.title },
              )}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    row: { flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 44, maxWidth: '86%' },
    // Not a touch target: no 44pt minimum, just breathing room under the reply.
    staticRow: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: spacing.xs, maxWidth: '86%' },
    staticText: {
      color: colors.textTertiary,
      flexShrink: 1,
      fontSize: typeScale.footnote,
      lineHeight: lineHeight.caption,
    },
    text: {
      color: colors.textTertiary,
      flexShrink: 1,
      fontSize: typeScale.footnote,
      lineHeight: lineHeight.caption,
      textDecorationLine: 'underline',
    },
  });
