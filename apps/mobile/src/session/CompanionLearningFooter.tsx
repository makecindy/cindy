import { Pressable, StyleSheet, View } from 'react-native';
import { BookOpen, Brain } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { botLearningRows } from '@cindy/maker-shared/bot-learning';
import { Text } from '@/components/AppText';
import { useTheme, useThemedStyles, iconSize, iconStroke, typeScale, lineHeight } from '@/theme';
import type { ThemeColors } from '@/theme';

export function CompanionLearningFooter({
  receipts,
  onOpenSettings,
}: {
  receipts: unknown;
  onOpenSettings?: (page: 'memory' | 'capabilities') => void;
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const rows = botLearningRows(receipts);
  if (!rows.length) return null;
  return (
    <View testID="message.learningFooter">
      {rows.map((row) => {
        const Icon = row.kind === 'memory' ? Brain : BookOpen;
        return (
          <Pressable
            key={row.kind}
            accessibilityRole="button"
            style={styles.row}
            onPress={() => onOpenSettings?.(row.kind === 'memory' ? 'memory' : 'capabilities')}
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
    text: {
      color: colors.textTertiary,
      flexShrink: 1,
      fontSize: typeScale.footnote,
      lineHeight: lineHeight.caption,
      textDecorationLine: 'underline',
    },
  });
