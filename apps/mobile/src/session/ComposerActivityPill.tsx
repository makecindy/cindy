import type { ReactNode } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { Sparkles } from 'lucide-react-native';
import { Text } from '@/components/AppText';
import { BlurBackdrop, FLOATING_CHROME_BLUR_INTENSITY } from '@/session/BlurBackdrop';
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { fontWeight, iconSize, iconStroke, lineHeight, radius, spacing, typeScale } from '@/theme/tokens';

/**
 * The composer's "思考中" pill; send progress reuses it so both read as one status line.
 * `live` announces label changes (slow-send phases) without reading the per-second timer beside it.
 */
export function ComposerActivityPill({ label, live = false, children }: { label: string; live?: boolean; children?: ReactNode }) {
  const styles = useThemedStyles(makeComposerActivityPillStyles);
  const { colors } = useTheme();
  return (
    <View pointerEvents="none" style={[styles.composerActivityPill, styles.composerActivityPrimary]}>
      <BlurBackdrop intensity={FLOATING_CHROME_BLUR_INTENSITY} overlayColor={composerActivityPillOverlayColor(colors)} style={styles.composerActivityPillBackdrop} />
      <Sparkles color={colors.statusAccent} size={iconSize.sm} strokeWidth={iconStroke.regular} />
      <Text accessibilityLiveRegion={live ? 'polite' : 'none'} numberOfLines={1} style={styles.composerActivityStatusText}>{label}</Text>
      {children}
    </View>
  );
}

// iOS pills share the header/composer edge glass; Android's blur is too weak
// to carry text alone, so it keeps the translucent surface underneath.
export function composerActivityPillOverlayColor(colors: ThemeColors): string {
  return Platform.OS === 'ios' ? 'transparent' : colors.surfaceTranslucent;
}

export const makeComposerActivityPillStyles = (colors: ThemeColors) => StyleSheet.create({
  composerActivityStatus: {
    alignItems: 'center',
    flexDirection: 'row',
    minHeight: 44,
    justifyContent: 'space-between',
    paddingHorizontal: spacing.xs,
  },
  composerActivityPrimary: {
    alignItems: 'center',
    flexShrink: 1,
    flexDirection: 'row',
    gap: 6,
    marginRight: spacing.sm,
    minWidth: 0,
  },
  composerActivityPill: {
    borderRadius: radius.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  composerActivityPillBackdrop: {
    borderRadius: radius.pill,
    overflow: 'hidden',
  },
  composerActivityStatusText: {
    color: colors.statusAccent,
    flexShrink: 1,
    fontSize: typeScale.footnote,
    fontWeight: fontWeight.medium,
    lineHeight: lineHeight.caption,
  },
  composerActivityProgressText: {
    flexShrink: 0,
  },
});
