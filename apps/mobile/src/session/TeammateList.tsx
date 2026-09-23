import { useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { RefreshCw } from 'lucide-react-native';
import { resolveRemoteText } from '@cindy/device-link';
import { Text, TextInput } from '@/components/AppText';
import { MainWindowEmptyState } from '@/components/MobilePrimitives';
import { RemoteCompanionAvatar } from '@/components/RemoteCompanionAvatar';
import { useAuth } from '@/auth/AuthContext';
import { isRemoteResourceUnread } from '@/device-link/remoteResourceCache';
import type { HostedRemoteCollectionItem, RemoteResourceHostTarget } from '@/device-link/remoteResources';
import { useMinuteNow } from '@/utils/useMinuteNow';
import { useThemedStyles, useTheme, type ThemeColors } from '@/theme';
import { fontWeight, iconSize, lineHeight, radius, spacing, typeScale } from '@/theme/tokens';
import { formatRemoteSessionSidebarTime } from './sessionList';
import { orderedTeammates, sameTeammate, teammateIdentity } from './teammateNavigation';
import type { LastTeammateIdentity } from './homeViewPreferenceStore';
import { parseMobileMarkdownInlines } from './messageMarkdown';

export interface TeammateListProps {
  items: readonly HostedRemoteCollectionItem[];
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  isOnline(host: RemoteResourceHostTarget): boolean;
  onRefresh(): void;
  onSelect(item: HostedRemoteCollectionItem): void;
  current?: LastTeammateIdentity | null;
  /** SheetSurface already owns the scroll view. */
  embedded?: boolean;
  autoFocusSearch?: boolean;
  onInteract?(): void;
}
/** Flat identity list shared by home, collection route and the name picker. No host headings or groups. */
export function TeammateList({ items, loading, refreshing, error, isOnline, onRefresh, onSelect,
  current = null, embedded = false, autoFocusSearch = false, onInteract }: TeammateListProps) {
  const { t, i18n } = useTranslation();
  const { user } = useAuth();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const now = useMinuteNow();
  const [query, setQuery] = useState('');
  const rows = useMemo(() => orderedTeammates(items, query, i18n.language), [items, query, i18n.language]);
  const duplicateNames = useMemo(() => {
    const names = new Map<string, number>();
    for (const row of items) {
      const name = resolveRemoteText(row.item.display.title, i18n.language).normalize('NFKC').toLocaleLowerCase(i18n.language);
      names.set(name, (names.get(name) ?? 0) + 1);
    }
    return names;
  }, [items, i18n.language]);
  const header = <View style={styles.controls}>
    <TextInput accessibilityLabel={t('devices.companions.search')} autoFocus={autoFocusSearch}
      autoCorrect={false} onChangeText={(value) => { onInteract?.(); setQuery(value); }} onFocus={onInteract} placeholder={t('devices.companions.search')}
      placeholderTextColor={colors.textTertiary} selectionColor={colors.inputCaret}
      style={styles.search} value={query} testID="teammates.search" />
    {error ? <View style={styles.noticeRow}>
      <Text accessibilityRole="alert" style={[styles.notice, styles.noticeText]} testID="teammates.error">{t(items.length ? 'devices.companions.stale' : 'devices.resources.loadFailed')}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel={t('devices.resources.retry')} disabled={refreshing}
        onPress={onRefresh} style={styles.retry} testID="teammates.refresh">
        {refreshing ? <ActivityIndicator color={colors.textSecondary} /> : <RefreshCw size={iconSize.sm} color={colors.textSecondary} />}
      </Pressable>
    </View> : null}
  </View>;
  const empty = loading ? <View style={styles.empty}><ActivityIndicator color={colors.textSecondary} /><Text style={styles.notice}>{t('devices.resources.loading')}</Text></View>
    : <MainWindowEmptyState centered style={styles.empty} testID="teammates.empty"
      title={query.trim() ? t('devices.companions.noResults') : t('devices.companions.emptyTitle')}
      copy={query.trim() || error ? '' : t('devices.companions.emptyCopy')} />;
  const renderRow = (row: HostedRemoteCollectionItem) => {
    const display = row.item.display;
    const title = resolveRemoteText(display.title, i18n.language);
    const preview = display.preview ? parseMobileMarkdownInlines(resolveRemoteText(display.preview, i18n.language))
      .map(inline => inline.type === 'image' ? inline.alt : inline.text).join('').replace(/\s+/g, ' ').trim() : '';
    const online = isOnline(row.host);
    const ambiguous = (duplicateNames.get(title.normalize('NFKC').toLocaleLowerCase(i18n.language)) ?? 0) > 1;
    const source = ambiguous ? row.host.deviceName : '';
    const unread = isRemoteResourceUnread(user?.id ?? '', row.host.deviceId, row.item.ref.id, display.lastReplyAt);
    const timestamp = display.timestamp;
    const time = timestamp !== undefined && Number.isFinite(new Date(timestamp).getTime())
      ? formatRemoteSessionSidebarTime(new Date(timestamp).toISOString(), now) : '';
    const selected = sameTeammate(current, teammateIdentity(row));
    const meta = [!online ? t('devices.resources.hostOffline') : '', source].filter(Boolean).join(' · ');
    return <Pressable key={row.key} accessibilityRole="button" accessibilityState={{ selected, disabled: !online }}
      accessibilityLabel={[title, preview, time, unread ? t('devices.companions.unread') : '', meta].filter(Boolean).join(', ')}
      disabled={!online} onPress={() => onSelect(row)} style={({ pressed }) => [styles.row, selected && styles.selected, pressed && styles.pressed]}
      testID={`teammates.item.${row.host.deviceId}.${row.item.ref.id}`}>
      <View style={styles.avatar}><RemoteCompanionAvatar avatar={display.avatar} deviceId={row.host.deviceId} name={title} online={online} /></View>
      <View style={styles.body}>
        <View style={styles.titleRow}><Text numberOfLines={1} style={styles.title}>{title}</Text>
          {time ? <Text numberOfLines={1} style={styles.time}>{time}</Text> : null}
          {unread ? <View style={styles.unread} accessibilityLabel={t('devices.companions.unread')} /> : null}
        </View>
        {preview && online ? <Text numberOfLines={1} style={styles.preview}>{preview}</Text> : null}
        {meta ? <Text numberOfLines={1} style={styles.meta}>{meta}</Text> : null}
      </View>
    </Pressable>;
  };
  if (embedded) return <View testID="teammates.list">{header}{rows.length ? rows.map(renderRow) : empty}</View>;
  return <FlatList style={styles.list} contentContainerStyle={styles.content} data={rows} keyExtractor={(row) => row.key}
    keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" onScrollBeginDrag={onInteract} testID="teammates.list"
    ListHeaderComponent={header} ListEmptyComponent={empty} renderItem={({ item }) => renderRow(item)}
    refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.textSecondary} />} />;
}
const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  list: { flex: 1 },
  content: { flexGrow: 1, paddingBottom: spacing.xl },
  controls: { paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, gap: spacing.sm },
  search: { borderRadius: radius.pill, backgroundColor: colors.surfaceElevated, borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth, minHeight: 44, paddingHorizontal: spacing.lg, color: colors.textPrimary, fontSize: typeScale.body },
  notice: { color: colors.textSecondary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption },
  empty: { padding: spacing.xl, gap: spacing.md },
  noticeRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  noticeText: { flex: 1 },
  retry: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingHorizontal: spacing.lg, paddingVertical: spacing.md, minHeight: 78 },
  avatar: { width: 44, height: 44, borderRadius: radius.pill, backgroundColor: colors.surfaceChip, alignItems: 'center', justifyContent: 'center' },
  selected: { backgroundColor: colors.surfaceChip, borderRadius: radius.container },
  pressed: { opacity: 0.72 },
  body: { flex: 1, minWidth: 0, gap: spacing.xs, borderBottomColor: colors.border,
    borderBottomWidth: StyleSheet.hairlineWidth, paddingBottom: spacing.md },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  // Match task rows in HomeListVisuals: title, preview and metadata keep the same hierarchy.
  title: { flex: 1, color: colors.textPrimary, fontSize: typeScale.subtitle, fontWeight: fontWeight.semibold, lineHeight: lineHeight.listTitle },
  preview: { color: colors.textSecondary, fontSize: typeScale.code, fontWeight: fontWeight.regular, lineHeight: lineHeight.subtitle },
  time: { color: colors.textTertiary, fontSize: typeScale.footnote, fontWeight: fontWeight.regular, lineHeight: lineHeight.body },
  meta: { color: colors.textTertiary, fontSize: typeScale.footnote, fontWeight: fontWeight.regular, lineHeight: lineHeight.body },
  unread: { width: 7, height: 7, borderRadius: radius.pill, backgroundColor: colors.textPrimary },
});
