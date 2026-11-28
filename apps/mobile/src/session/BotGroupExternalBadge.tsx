import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Text } from '@/components/AppText';
import { fontWeight, lineHeight, radius, spacing, typeScale, useThemedStyles, type ThemeColors } from '@/theme';

/**
 * Compact 「外部 / External」 pill shown exclusively to enterprise viewers on external groups
 * and external human members (DESIGN.md §2, mobile-design-guide.md §3, bot-group-chat.md §5).
 * Reuses `groupMentionText` (#1D4ED8 Light / #93C5FD Dark) with a 14% translucent tint so both modes
 * keep strong contrast without introducing a new token or hardcoded hex.
 */
export function BotGroupExternalBadge({ testID = 'botGroup.externalBadge' }: { testID?: string }) {
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.pill} testID={testID}>
      <Text numberOfLines={1} style={styles.label}>
        {t('groupChat.externalBadge')}
      </Text>
    </View>
  );
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  pill: {
    flexShrink: 0,
    borderRadius: radius.micro,
    paddingHorizontal: spacing.xs + 2,
    backgroundColor: `${colors.groupMentionText}24`,
    alignSelf: 'center',
  },
  label: {
    color: colors.groupMentionText,
    fontSize: typeScale.micro,
    lineHeight: lineHeight.micro,
    fontWeight: fontWeight.medium,
  },
});
