import { resolveTeammateStatus } from '@cindy/maker-shared/teammate-status';
import { TeammateStatusDot } from './TeammateStatusDot';
/**
 * 首页伙伴段里的群聊行（对照桌面 BotGroupSidebarSection.tsx）：与伙伴行同一个 CompanionListRow，
 * 按最近活动和伙伴混排。成员组合头像收在 44 框内；第二行是电脑给的预览（安排状态或最近一条消息，
 * 已按语言给好，手机不改写）；状态统一放在头像右下角实心点，时间位保留时间。
 * 只在至少一台电脑支持群聊时出现（旧版桌面没有这个集合）。新建群聊在伙伴段的「+」菜单里。
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
  const mainUnread = isRemoteResourceUnread(user?.id ?? '', row.host.deviceId, row.item.ref.id, display.lastReplyAt, row.lastReplySequence);
  const unreadCount = row.chatUnread ? mainUnread ? row.chatUnread.count : row.chatUnread.threadCount : undefined;
  const unread = unreadCount !== undefined ? unreadCount > 0 : mainUnread;
  const mentioned = row.chatUnread && (mainUnread ? row.chatUnread.mentioned : row.chatUnread.threadMentioned);
  const title = resolveRemoteText(display.title, i18n.language);
  const preview = display.preview ? parseMobileMarkdownInlines(resolveRemoteText(display.preview, i18n.language))
    .map((inline) => inline.type === 'image' ? inline.alt : inline.text).join('').replace(/\s+/g, ' ').trim() : '';
  const summary = preview || t(!row.host.deviceId && display.preview === undefined ? 'groupChat.server.previewUnavailable' : 'groupChat.list.noMessages');
  const status = resolveTeammateStatus({ online, unread, working: !!display.generation, activities: [display.teammateActivity] });
  const members = botGroupMemberLinks(row.item, i18n.language).map((member) =>
    identityFor(member.botId, member.label, row.groupMembers?.find(identity => identity.botId === member.botId)));
  const time = display.timestamp !== undefined && Number.isFinite(new Date(display.timestamp).getTime())
    ? formatRemoteSessionSidebarTime(new Date(display.timestamp).toISOString(), now) : '';
  const offline = online ? '' : t('devices.resources.hostOffline');
  return <CompanionListRow
    testID={`botGroups.item.${row.host.deviceId}.${row.item.ref.id}`}
    accessibilityLabel={[title, unread ? t('devices.companions.unread') : '', status !== 'idle' ? t(`devices.companions.avatarStatus.${status}`) : '', offline, summary, time]
      .filter(Boolean).join(', ')}
    avatar={<View>
      <View style={offline ? { opacity: OFFLINE_AVATAR_OPACITY } : undefined}>
      <BotGroupDuoAvatar deviceId={row.host.deviceId} members={members} online={online} />
      </View>
      <TeammateStatusDot status={status} />
    </View>}
    title={title}
    trailing={{ kind: 'time', text: time }}
    preview={offline ? `${offline} · ${summary}` : summary}
    previewTone={offline ? 'tertiary' : 'secondary'}
    unread={unread && unreadCount !== undefined}
    unreadCount={unreadCount}
    mentioned={mentioned}
    unreadLabel={t('devices.companions.unread')}
    disabled={!online}
    last={last}
    onPress={onPress} />;
}
