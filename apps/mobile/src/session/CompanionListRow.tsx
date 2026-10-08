/**
 * 伙伴页的一行（伙伴与群聊共用，对齐任务行的几何）：固定 78 高；44 头像距左 16，文字列从 72 开始，
 * 右内边距 16；分割线画在文字列底边，从 72 一直到屏幕右缘，最后一行不画。
 *
 * 第一行：名字（18/28 500）+ 同名时的「· 电脑名」+ 右侧时间位。时间位只放一样东西：时间，或工作中
 * 的中性转圈。第二行：预览（15/26）+ 右侧未读蓝点。需要你处理的事写成预览开头的前缀（正文色
 * 500），不再用彩色点。见 apps/mobile/docs/mobile-design-guide.md §3 的列表节奏例外。
 */
import type { ReactElement, ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Text } from '@/components/AppText';
import { StatusDot } from '@/components/MobilePrimitives';
import { fontWeight, lineHeight, radius, spacing, typeScale, useThemedStyles, type ThemeColors } from '@/theme';
import { SessionRightSpinner } from './SessionRightSpinner';

export const COMPANION_ROW_HEIGHT = 78;
export const COMPANION_ROW_AVATAR_SIZE = 44;
/** Unread / presence dots: the task row's 10pt status dot. */
export const COMPANION_ROW_DOT_SIZE = 10;
const LEFT_INSET = spacing.lg;

export type CompanionRowTrailing = { kind: 'time'; text: string } | { kind: 'working' };

export function CompanionListRow({
  avatar, title, device, trailing, preview, previewTone = 'secondary', previewPrefix, previewPrefixTestID,
  unread = false, unreadLabel, disabled = false, last = false, accessibilityLabel, onPress, testID,
}: {
  /** Content of the 44pt avatar box (the caller draws presence dot and ring inside it). */
  avatar: ReactNode;
  title: string;
  /** Computer name, only when two rows share a name. */
  device?: string;
  trailing: CompanionRowTrailing;
  /** Plain text, or a live element (the working copy) that renders outside the text node. */
  preview: string | ReactElement;
  previewTone?: 'secondary' | 'tertiary';
  /** 「等你确认」「需要关注」「离线」 — what needs the user, before the preview. */
  previewPrefix?: string;
  previewPrefixTestID?: string;
  unread?: boolean;
  unreadLabel?: string;
  disabled?: boolean;
  last?: boolean;
  accessibilityLabel: string;
  onPress(): void;
  testID?: string;
}) {
  const styles = useThemedStyles(makeStyles);
  return <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel} accessibilityState={{ disabled }}
    disabled={disabled} onPress={onPress} style={({ pressed }) => [styles.row, pressed && !disabled && styles.pressed]} testID={testID}>
    <View style={styles.avatar}>{avatar}</View>
    <View style={[styles.body, !last && styles.divider]}>
      <View style={styles.titleRow}>
        <Text numberOfLines={1} style={styles.title}>{title}</Text>
        {device ? <Text numberOfLines={1} style={styles.device}>{`· ${device}`}</Text> : null}
        <View style={styles.spacer} />
        <View style={styles.trailing}>
          {trailing.kind === 'working'
            ? <SessionRightSpinner testID="companion.row.working" />
            : <Text numberOfLines={1} style={styles.time}>{trailing.text}</Text>}
        </View>
      </View>
      <View style={styles.previewRow}>
        {typeof preview === 'string'
          ? <Text numberOfLines={1} style={[styles.preview, previewTone === 'tertiary' && styles.previewQuiet]}>
            {previewPrefix ? <Text style={styles.prefix} testID={previewPrefixTestID}>{`${previewPrefix} · `}</Text> : null}
            {preview}
          </Text>
          : <View style={styles.previewSlot}>{preview}</View>}
        {unread ? <View style={styles.unread} accessibilityLabel={unreadLabel} testID="companion.row.unread" /> : null}
      </View>
    </View>
  </Pressable>;
}

/** Presence dot on the avatar's bottom-right, ringed with the page surface (desktop BotConnectionStatus). */
/** The shared status dot in a page-coloured ring, so it stays legible over the avatar. */
export function CompanionPresenceDot({ connected, testID = 'teammate.connection' }: { connected: boolean | null; testID?: string }) {
  const styles = useThemedStyles(makeStyles);
  return <View testID={testID} style={styles.presence}>
    <StatusDot tone={connected === null ? 'muted' : connected ? 'ready' : 'off'} />
  </View>;
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, height: COMPANION_ROW_HEIGHT, paddingLeft: LEFT_INSET },
  pressed: { opacity: 0.72 },
  avatar: { width: COMPANION_ROW_AVATAR_SIZE, height: COMPANION_ROW_AVATAR_SIZE },
  body: { flex: 1, minWidth: 0, alignSelf: 'stretch', justifyContent: 'center', paddingRight: spacing.lg },
  divider: { borderBottomColor: colors.border, borderBottomWidth: StyleSheet.hairlineWidth },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, height: lineHeight.listTitle },
  // Home list rhythm exception (mobile guide §3): 18/28 title, 15/26 preview, 13/22 metadata.
  title: { flexShrink: 1, color: colors.textPrimary, fontSize: typeScale.subtitle, lineHeight: lineHeight.listTitle, fontWeight: fontWeight.medium },
  // Aligned to the title line (alignment exception): the name keeps its width, the computer name truncates first.
  device: { flexShrink: 3, color: colors.textTertiary, fontSize: typeScale.bodySmall, lineHeight: lineHeight.listTitle, fontWeight: fontWeight.regular },
  spacer: { flexGrow: 1, minWidth: spacing.sm },
  trailing: { minWidth: COMPANION_ROW_DOT_SIZE, alignItems: 'flex-end', justifyContent: 'center' },
  time: { color: colors.textTertiary, fontSize: typeScale.footnote, lineHeight: lineHeight.body, fontWeight: fontWeight.regular, fontVariant: ['tabular-nums'] },
  previewRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, height: lineHeight.subtitle },
  preview: { flex: 1, minWidth: 0, color: colors.textSecondary, fontSize: typeScale.bodySmall, lineHeight: lineHeight.subtitle, fontWeight: fontWeight.regular },
  previewQuiet: { color: colors.textTertiary },
  previewSlot: { flex: 1, minWidth: 0, flexDirection: 'row' },
  prefix: { color: colors.textPrimary, fontSize: typeScale.bodySmall, lineHeight: lineHeight.subtitle, fontWeight: fontWeight.medium },
  unread: { width: COMPANION_ROW_DOT_SIZE, height: COMPANION_ROW_DOT_SIZE, borderRadius: radius.pill, backgroundColor: colors.botUnread },
  presence: { position: 'absolute', right: 0, bottom: 0, padding: 2, borderRadius: radius.pill, backgroundColor: colors.surface },
});
