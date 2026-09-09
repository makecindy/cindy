import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, View } from 'react-native';
import { ChevronDown, ChevronRight, Layers, RefreshCw, Target } from 'lucide-react-native';
import { useRecyclingState } from '@legendapp/list/react-native';
import { Text } from '@/components/AppText';
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { fontWeight, iconSize, iconStroke, lineHeight, radius, spacing, typeScale } from '@/theme/tokens';
import { formatMobileSystemCard } from '@/session/systemCard';

export type MobileBoundaryNoticeType = 'compact' | 'goal-complete' | 'goal-resumed' | 'context-rebuild';

/** Quiet transcript markers; long reasons and handoffs stay available on demand. */
export function MobileBoundaryNotice({ type, data }: {
  type: MobileBoundaryNoticeType;
  data?: Record<string, unknown>;
}) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const { t } = useTranslation();
  const [expanded, setExpanded] = useRecyclingState(false);
  const card = formatMobileSystemCard(type, data);
  const hasDetail = !!card.body?.trim();
  const Icon = type === 'compact' ? Layers : type === 'context-rebuild' ? RefreshCw : Target;
  const label = type === 'compact'
    ? `${t('message.systemCard.compact.aria')} · ${card.title}`
    : card.title;
  const content = (
    <>
      <Icon color={colors.textTertiary} size={iconSize.xs} strokeWidth={iconStroke.regular} />
      <Text style={styles.label} numberOfLines={1}>{card.title}</Text>
      {hasDetail && (expanded
        ? <ChevronDown color={colors.textTertiary} size={iconSize.xs} />
        : <ChevronRight color={colors.textTertiary} size={iconSize.xs} />)}
    </>
  );

  return (
    <View style={styles.container} testID={`message.systemCard.${type}`}>
      <View style={[styles.row, hasDetail && styles.interactiveRow]}>
        <View style={styles.divider} />
        {hasDetail ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t(expanded ? 'message.renderer.collapseRow' : 'message.renderer.expandRow', { label })}
            accessibilityState={{ expanded }}
            hitSlop={{ top: spacing.sm + spacing.xs, bottom: spacing.sm + spacing.xs }}
            onPress={() => setExpanded((value) => !value)}
            style={styles.pill}
          >{content}</Pressable>
        ) : (
          <View accessible accessibilityLabel={label} style={styles.pill}>{content}</View>
        )}
        <View style={styles.divider} />
      </View>
      {expanded && hasDetail ? (
        <View style={styles.detail}>
          {card.subtitle ? <Text style={styles.detailTitle}>{card.subtitle}</Text> : null}
          <Text selectable style={styles.detailBody}>{card.body}</Text>
        </View>
      ) : null}
    </View>
  );
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  container: { paddingVertical: spacing.xs },
  row: { alignItems: 'center', flexDirection: 'row', gap: spacing.md },
  // Native hitSlop cannot extend beyond the parent; leave room around the small pill.
  interactiveRow: { minHeight: 44 },
  divider: { backgroundColor: colors.border, flex: 1, height: StyleSheet.hairlineWidth },
  pill: {
    alignItems: 'center',
    borderColor: colors.border,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    flexShrink: 1,
    gap: spacing.xs,
    minWidth: 0,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  label: {
    color: colors.textTertiary,
    flexShrink: 1,
    fontSize: typeScale.caption,
    fontWeight: fontWeight.regular,
    lineHeight: lineHeight.caption,
    fontVariant: ['tabular-nums'],
  },
  detail: {
    backgroundColor: colors.surfaceElevated,
    borderColor: colors.border,
    borderRadius: radius.control,
    borderWidth: StyleSheet.hairlineWidth,
    gap: spacing.xs,
    marginTop: spacing.sm,
    padding: spacing.md,
  },
  detailTitle: { color: colors.textTertiary, fontSize: typeScale.caption, lineHeight: lineHeight.caption },
  detailBody: { color: colors.textPrimary, fontSize: typeScale.footnote, lineHeight: lineHeight.body },
});
