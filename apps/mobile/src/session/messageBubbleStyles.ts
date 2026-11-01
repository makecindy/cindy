import { StyleSheet, type ViewStyle } from 'react-native';
import { radius, spacing, type ThemeColors } from '@/theme';

export const messageBubbleBase: ViewStyle = {
  borderRadius: radius.container,
  borderWidth: StyleSheet.hairlineWidth,
  gap: spacing.xs,
  padding: spacing.md,
};

export const compactMessageBubble: ViewStyle = {
  gap: 6,
  paddingHorizontal: spacing.md,
  paddingVertical: spacing.sm,
};

export const userMessageBubble = (colors: ThemeColors): ViewStyle => ({
  alignSelf: 'flex-end',
  backgroundColor: colors.surfaceElevated,
  borderColor: colors.border,
  maxWidth: '86%',
  minWidth: 0,
  overflow: 'hidden',
});
