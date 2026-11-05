import { radius, spacing, type ThemeColors } from '@/theme';

/** Shared bubble geometry for private and group companion messages. */
export const companionMessageBubble = (colors: ThemeColors) => ({
  alignSelf: 'flex-start' as const,
  maxWidth: '100%' as const,
  backgroundColor: colors.surfaceElevated,
  borderWidth: 0,
  borderRadius: radius.container,
  paddingHorizontal: spacing.md,
  paddingVertical: spacing.md,
  gap: spacing.xs,
});
