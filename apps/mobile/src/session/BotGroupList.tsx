/**
 * 伙伴页里的群聊行（对照桌面 BotGroupSidebarSection.tsx）：与伙伴行同一个 CompanionListRow，
 * 按最近活动和伙伴混排。双头像收在 44 框内；第二行是电脑给的预览（安排状态或最近一条消息，
 * 已按语言给好，手机不改写）；有伙伴正在说话、安排或做事时，时间位换成转圈、前面的头像呼吸。
 * 只在至少一台电脑支持群聊时出现（旧版桌面没有这个集合）。新建群聊在伙伴页顶栏的「+」菜单里。
 */
import { useSyncExternalStore } from 'react';
import { View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { resolveRemoteText } from '@cindy/device-link';
import { useAuth } from '@/auth/AuthContext';
import { isRemoteResourceUnread, subscribeRemoteResourceCache, remoteResourceCacheRevision } from '@/device-link/remoteResourceCache';
import type { HostedRemoteCollectionItem } from '@/device-link/remoteResources';
import { useMinuteNow } from '@/utils/useMinuteNow';
import { BotGroupDuoAvatar, useBotGroupIdentities } from './BotGroupAvatars';
import { botGroupMemberLinks } from './botGroupRemote';
import { CompanionListRow } from './CompanionListRow';
import { parseMobileMarkdownInlines } from './messageMarkdown';
import { formatRemoteSessionSidebarTime } from './sessionList';

/** Offline rows keep the avatar readable but visibly unavailable. */
export const OFFLINE_AVATAR_OPACITY = 0.45;

export function BotGroupListRow({ row, online, last = false, onPress }: {
  row: HostedRemoteCollectionItem; online: boolean; last?: boolean; onPress(): void;
}) {
  const { t, i18n } = useTranslation();
  const now = useMinuteNow();
  const identityFor = useBotGroupIdentities(row.host.deviceId);
  const { user } = useAuth();
  useSyncExternalStore(subscribeRemoteResourceCache, remoteResourceCacheRevision);
  const display = row.item.display;
  const unread = isRemoteResourceUnread(user?.id ?? '', row.host.deviceId, row.item.ref.id, display.lastReplyAt);
  const title = resolveRemoteText(display.title, i18n.language);
  const preview = display.preview ? parseMobileMarkdownInlines(resolveRemoteText(display.preview, i18n.language))
    .map((inline) => inline.type === 'image' ? inline.alt : inline.text).join('').replace(/\s+/g, ' ').trim() : '';
  const summary = preview || t('groupChat.list.noMessages');
  const running = online && !!display.generation;
  const members = botGroupMemberLinks(row.item, i18n.language).map((member) => identityFor(member.botId, member.label));
  const time = display.timestamp !== undefined && Number.isFinite(new Date(display.timestamp).getTime())
    ? formatRemoteSessionSidebarTime(new Date(display.timestamp).toISOString(), now) : '';
  const offline = online ? '' : t('devices.resources.hostOffline');
  return <CompanionListRow
    testID={`botGroups.item.${row.host.deviceId}.${row.item.ref.id}`}
    accessibilityLabel={[title, unread ? t('devices.companions.unread') : '', running ? t('groupChat.list.running') : '', offline, summary, time]
      .filter(Boolean).join(', ')}
    avatar={<View style={offline ? { opacity: OFFLINE_AVATAR_OPACITY } : undefined}>
      <BotGroupDuoAvatar deviceId={row.host.deviceId} members={members} online={online} working={running} />
    </View>}
    title={title}
    trailing={running ? { kind: 'working' } : { kind: 'time', text: time }}
    preview={offline ? `${offline} · ${summary}` : summary}
    previewTone={offline ? 'tertiary' : 'secondary'}
    unread={unread}
    unreadLabel={t('devices.companions.unread')}
    disabled={!online}
    last={last}
    onPress={onPress} />;
}
