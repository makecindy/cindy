import { useMemo } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { ChevronDown, ChevronRight } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import {
  partitionBuddyRoster,
  setBuddySetCollapsed,
  type BuddyRosterRow,
  type BuddySetsState,
} from '@cindy/maker-shared/buddy-sets';
import { resolveRemoteText } from '@cindy/device-link';
import { Text } from '@/components/AppText';
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { fontWeight, iconSize, iconStroke, lineHeight, radius, spacing, typeScale } from '@/theme/tokens';
import { mobileInteractionStyles } from '@/components/mobileInteractionStyles';
import { DisclosureItem } from './listDisclosureTransition';
import { mobileBuddySetCopy } from './buddySetCopy';
import type { TeammateListEntry } from './TeammateList';

/**
 * 侧栏「伙伴」段里的「伙伴集」容器:只收伙伴私聊行(kind === 'buddy'),
 * 群聊与任务行永远留在平铺区;点击容器里的伙伴仍走原路由。
 */
interface RosterItem extends BuddyRosterRow {
  entry: TeammateListEntry;
  name: string;
}

export function BuddySetGroups({ entries, buddySets, onChange, onEditSet, renderRow, query }: {
  entries: readonly TeammateListEntry[];
  buddySets: BuddySetsState;
  onChange: (next: BuddySetsState | ((current: BuddySetsState) => BuddySetsState)) => void;
  onEditSet: (buddySetId: string) => void;
  renderRow: (entry: TeammateListEntry, last: boolean) => React.ReactNode;
  query: string;
}) {
  const { t, i18n } = useTranslation();
  const copy = mobileBuddySetCopy(t);
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);

  const roster = useMemo<RosterItem[]>(() => entries.map((entry) => ({
    entry,
    id: `${entry.kind}:${entry.row.key}`,
    kind: entry.kind === 'bot' ? 'buddy' : 'group',
    name: resolveRemoteText(entry.row.item.display.title, i18n.language),
  })), [entries, i18n.language]);
  const partition = useMemo(() => partitionBuddyRoster(roster, buddySets), [roster, buddySets]);

  // Search results stay flat, but must include buddies that belong to a set:
  // `entries` is already the full match list, while partition.flat omits them.
  if (query.trim()) {
    return <>{roster.map((item, index) => renderRow(item.entry, index === roster.length - 1))}</>;
  }
  if (buddySets.sets.length === 0) {
    return <>{partition.flat.map((item, index) => renderRow(item.entry, index === partition.flat.length - 1))}</>;
  }

  return <>
    {partition.groups.map(({ set, rows }) => {
      const collapsed = set.collapsed === true;
      const Chevron = collapsed ? ChevronRight : ChevronDown;
      return <View key={`buddy-set:${set.buddySetId}`} testID={`buddySet.${set.buddySetId}`}>
        <Pressable accessibilityRole="button" accessibilityLabel={`${set.name}, ${collapsed ? copy.expand : copy.collapse}`}
          accessibilityState={{ expanded: !collapsed }}
          onPress={() => onChange((current) => setBuddySetCollapsed(current, set.buddySetId, !collapsed))}
          onLongPress={() => onEditSet(set.buddySetId)}
          style={({ pressed }) => [styles.header, pressed && mobileInteractionStyles.pressed]}>
          <Chevron size={iconSize.sm} color={colors.textSecondary} strokeWidth={iconStroke.regular} />
          <Text numberOfLines={1} style={styles.title}>{set.name}</Text>
          <Text style={styles.count}>{set.buddyIds.length}</Text>
        </Pressable>
        {collapsed ? null : <DisclosureItem exit>
          <View style={styles.rows}>
            {rows.map((item, index) => renderRow(item.entry, index === rows.length - 1))}
          </View>
        </DisclosureItem>}
      </View>;
    })}
    {partition.flat.map((item, index) => renderRow(item.entry, index === partition.flat.length - 1))}
  </>;
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: 40,
    paddingHorizontal: spacing.lg, backgroundColor: colors.surface, borderRadius: radius.container },
  title: { flex: 1, color: colors.textSecondary, fontSize: typeScale.bodySmall,
    lineHeight: lineHeight.bodySmall, fontWeight: fontWeight.medium },
  count: { color: colors.textTertiary, fontSize: typeScale.caption, lineHeight: lineHeight.caption,
    fontVariant: ['tabular-nums'] },
  rows: { paddingLeft: spacing.md },
});
