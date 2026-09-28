/**
 * 伙伴页里的「群聊」分组（对照桌面 BotGroupSidebarSection.tsx）：小节头带新建按钮，下面是
 * 群行。群行与伙伴行同一套行几何：两位成员斜向叠放的头像，第一行群名与时间，第二行是电脑
 * 给的预览（安排状态或最近一条消息，已按语言给好）；有伙伴正在说话、安排或做事时，预览前
 * 加运行中标记。只在至少一台电脑支持群聊时出现（旧版桌面没有这个集合）。
 */
import { useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Plus, Sparkles } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { resolveRemoteText } from '@cindy/device-link';
import { Text } from '@/components/AppText';
import { useAuth } from '@/auth/AuthContext';
import type { HostedRemoteCollectionItem, RemoteResourceHostTarget } from '@/device-link/remoteResources';
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { fontWeight, iconSize, iconStroke, lineHeight, radius, spacing, typeScale } from '@/theme/tokens';
import { useMinuteNow } from '@/utils/useMinuteNow';
import { BotGroupDuoAvatar, useBotGroupIdentities } from './BotGroupAvatars';
import { BotGroupCreateSheet } from './BotGroupCreateSheet';
import { BotGroupMenu } from './BotGroupMenu';
import { botGroupMemberLinks, orderedBotGroups } from './botGroupRemote';
import { parseMobileMarkdownInlines } from './messageMarkdown';
import { formatRemoteSessionSidebarTime } from './sessionList';

const CREATE_HIT_SLOP = { top: 8, bottom: 8, left: 8, right: 8 } as const;

export function BotGroupSection({ items, query, isOnline, createTargets, preferredDeviceId, onOpen, onOpenCreated, onInteract }: {
  items: readonly HostedRemoteCollectionItem[];
  query: string;
  isOnline(host: RemoteResourceHostTarget): boolean;
  /** Online computers that support group chats. */
  createTargets: readonly RemoteResourceHostTarget[];
  preferredDeviceId?: string;
  onOpen(row: HostedRemoteCollectionItem): void;
  onOpenCreated(host: RemoteResourceHostTarget, groupId: string): void;
  onInteract?(): void;
}) {
  const { t, i18n } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const rows = orderedBotGroups(items, query, i18n.language);
  if (query.trim() && rows.length === 0) return null;
  return <View style={styles.section} testID="botGroups.section">
    <View style={styles.header}>
      <Text accessibilityRole="header" style={styles.sectionTitle}>{t('groupChat.title')}</Text>
      <BotGroupCreateButton targets={createTargets} preferredDeviceId={preferredDeviceId} onInteract={onInteract} onCreated={onOpenCreated} />
    </View>
    {rows.length === 0 ? <Text style={styles.empty} testID="botGroups.empty">{t('groupChat.list.empty')}</Text> : null}
    {rows.map((row) => <BotGroupRow key={row.key} row={row} online={isOnline(row.host)} onPress={() => onOpen(row)} />)}
  </View>;
}

function BotGroupRow({ row, online, onPress }: { row: HostedRemoteCollectionItem; online: boolean; onPress(): void }) {
  const { t, i18n } = useTranslation();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const now = useMinuteNow();
  const identityFor = useBotGroupIdentities(row.host.deviceId);
  const display = row.item.display;
  const title = resolveRemoteText(display.title, i18n.language);
  const preview = display.preview ? parseMobileMarkdownInlines(resolveRemoteText(display.preview, i18n.language))
    .map((inline) => inline.type === 'image' ? inline.alt : inline.text).join('').replace(/\s+/g, ' ').trim() : '';
  const summary = preview || t('groupChat.list.noMessages');
  const running = online && !!display.generation;
  const members = botGroupMemberLinks(row.item, i18n.language).map((member) => identityFor(member.botId, member.label));
  const time = display.timestamp !== undefined && Number.isFinite(new Date(display.timestamp).getTime())
    ? formatRemoteSessionSidebarTime(new Date(display.timestamp).toISOString(), now) : '';
  const offline = online ? '' : t('devices.resources.hostOffline');
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled: !online }}
    accessibilityLabel={[title, running ? t('groupChat.list.running') : '', summary, time, offline].filter(Boolean).join(', ')}
    disabled={!online} onPress={onPress} style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    testID={`botGroups.item.${row.host.deviceId}.${row.item.ref.id}`}>
    <BotGroupDuoAvatar deviceId={row.host.deviceId} members={members} online={online} />
    <View style={styles.body}>
      <View style={styles.titleRow}>
        <Text numberOfLines={1} style={styles.title}>{title}</Text>
        {time ? <Text numberOfLines={1} style={styles.time}>{time}</Text> : null}
      </View>
      <View style={styles.previewRow}>
        {running ? <Sparkles size={iconSize.xs} color={colors.statusAccent} testID="botGroups.running" /> : null}
        <Text numberOfLines={1} style={styles.preview}>{summary}</Text>
      </View>
      {offline ? <Text numberOfLines={1} style={styles.meta}>{offline}</Text> : null}
    </View>
  </Pressable>;
}

/** 「+」 in the section header; with several computers it first asks which one hosts the group. */
function BotGroupCreateButton({ targets, preferredDeviceId, onInteract, onCreated }: {
  targets: readonly RemoteResourceHostTarget[];
  preferredDeviceId?: string;
  onInteract?(): void;
  onCreated(host: RemoteResourceHostTarget, groupId: string): void;
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { accountGeneration } = useAuth();
  const [host, setHost] = useState<RemoteResourceHostTarget | null>(null);
  const [visible, setVisible] = useState(false);
  const receipt = useRef<{ host: RemoteResourceHostTarget; groupId: string; account: number } | null>(null);
  const ordered = [...targets].sort((a, b) => Number(b.deviceId === preferredDeviceId) - Number(a.deviceId === preferredDeviceId));
  const open = (deviceId: string) => {
    onInteract?.();
    const target = targets.find((candidate) => candidate.deviceId === deviceId);
    if (!target) return;
    setHost(target);
    setVisible(true);
  };
  const label = t('groupChat.create.title');
  const button = (onPress: (() => void) | undefined) => <Pressable accessibilityRole="button" accessibilityLabel={label}
    disabled={targets.length === 0} hitSlop={CREATE_HIT_SLOP} onPress={onPress}
    style={({ pressed }) => [styles.create, pressed && styles.pressed, targets.length === 0 && styles.disabled]}
    testID="botGroups.create">
    <Plus size={iconSize.md} color={colors.textSecondary} strokeWidth={iconStroke.regular} />
  </Pressable>;
  return <>
    {targets.length > 1
      ? <BotGroupMenu title={t('groupChat.create.chooseComputer')} accessibilityLabel={label} testID="botGroups.createMenu"
        sections={[{ id: 'computers', title: t('groupChat.create.chooseComputer'), options: ordered.map((target) => ({ id: target.deviceId, title: target.deviceName })) }]}
        onSelect={open}>
        {button}
      </BotGroupMenu>
      : button(targets[0] ? () => open(targets[0]!.deviceId) : undefined)}
    <BotGroupCreateSheet visible={visible} host={host} online={!!host && targets.some((target) => target.deviceId === host.deviceId)}
      onClose={() => setVisible(false)}
      onCreated={(groupId) => { if (host) receipt.current = { host, groupId, account: accountGeneration }; }}
      onClosed={() => {
        const created = receipt.current;
        receipt.current = null;
        if (created && created.account === accountGeneration) onCreated(created.host, created.groupId);
      }} />
  </>;
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  section: { paddingTop: spacing.lg },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: spacing.lg, minHeight: 44 },
  sectionTitle: { color: colors.textTertiary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption, fontWeight: fontWeight.semibold },
  create: { width: 32, height: 32, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center' },
  disabled: { opacity: 0.46 },
  empty: { color: colors.textSecondary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption, paddingHorizontal: spacing.lg, paddingBottom: spacing.md },
  // Teammate row geometry (TeammateList): the divider sits on the text column's bottom edge.
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingHorizontal: spacing.lg, minHeight: 78 },
  pressed: { opacity: 0.72 },
  body: { flex: 1, minWidth: 0, alignSelf: 'stretch', justifyContent: 'center', gap: spacing.xs,
    borderBottomColor: colors.border, borderBottomWidth: StyleSheet.hairlineWidth, paddingVertical: 18 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  title: { flex: 1, color: colors.textPrimary, fontSize: typeScale.subtitle, fontWeight: fontWeight.medium, lineHeight: lineHeight.listTitle },
  previewRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  preview: { flex: 1, color: colors.textSecondary, fontSize: typeScale.bodySmall, fontWeight: fontWeight.regular, lineHeight: lineHeight.subtitle },
  time: { color: colors.textTertiary, fontSize: typeScale.footnote, fontWeight: fontWeight.regular, lineHeight: lineHeight.body },
  meta: { color: colors.textTertiary, fontSize: typeScale.footnote, fontWeight: fontWeight.regular, lineHeight: lineHeight.body },
});
