import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { ChevronDown } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { iconStroke, useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { iconSize, radius, spacing } from '@/theme/tokens';
import { MessageListActionButton } from './MessageListActionButton';

export const SCROLL_TO_BOTTOM_FAB_SIZE = 36;

export function MessageScrollToBottomButton({ hasNewMessages, onPress, style, testID, dotTestID }: {
  hasNewMessages: boolean;
  onPress: () => void;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  dotTestID?: string;
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  return <MessageListActionButton
    accessibilityLabel={t(hasNewMessages ? 'message.renderer.newMessagesToBottom' : 'message.renderer.jumpToBottom')}
    onPress={onPress} hitSlop={spacing.xs} style={[styles.button, style]} testID={testID}>
    <ChevronDown color={colors.textSecondary} size={iconSize.action} strokeWidth={iconStroke.regular} />
    {hasNewMessages ? <View style={styles.dot} testID={dotTestID} /> : null}
  </MessageListActionButton>;
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  button: {
    alignItems: 'center',
    backgroundColor: colors.surfaceTranslucent,
    borderColor: colors.borderTranslucent,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    height: SCROLL_TO_BOTTOM_FAB_SIZE,
    justifyContent: 'center',
    width: SCROLL_TO_BOTTOM_FAB_SIZE,
    zIndex: 20,
  },
  dot: {
    backgroundColor: colors.cta,
    borderRadius: radius.pill,
    height: 8,
    position: 'absolute',
    right: 3,
    top: 3,
    width: 8,
  },
});
