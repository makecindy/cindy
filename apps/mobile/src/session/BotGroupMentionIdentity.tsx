import type { ViewInstance } from 'react-native';
import type { BotGroupMemberView } from '@cindy/maker-shared/botGroupChat';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { StyleSheet, View, useWindowDimensions } from 'react-native';
import { useTranslation } from 'react-i18next';
import { spacing } from '@/theme/tokens';
import { useTheme } from '@/theme';
import { BotGroupAvatar, BOT_GROUP_MENTION_AVATAR_SIZE } from './BotGroupAvatars';
import { botGroupMemberAvatar } from './botGroupRemote';
import { BotGroupMentionPopover } from './BotGroupMentionPopover';
import { botGroupMentionDisplayName, type BotGroupMentionPoint } from './botGroupMentions';

/** Read only the current group's public roster; never open a companion's private profile. */
export function BotGroupMentionIdentity({ member, anchor, deviceId, onClose }: {
  member: BotGroupMemberView | null; anchor: BotGroupMentionPoint | null; deviceId: string; onClose(): void;
}) {
  const { t } = useTranslation();
  const { mode } = useTheme();
  const surface = useRef<ViewInstance>(null);
  const { width, height } = useWindowDimensions();
  const viewport = useRef({ width, height, mode });
  const [position, setPosition] = useState<{ anchor: BotGroupMentionPoint; x: number; y: number; width: number } | null>(null);
  useEffect(() => {
    const previous = viewport.current;
    viewport.current = { width, height, mode };
    if (member && (previous.width !== width || previous.height !== height || previous.mode !== mode)) onClose();
  }, [width, height, mode, member, onClose]);
  useLayoutEffect(() => {
    if (!member || !anchor) return;
    let cancelled = false;
    // Translate the screen touch into this timeline's scrolling/safe-area origin.
    surface.current?.measureInWindow((x, y, measuredWidth) => {
      if (!cancelled && measuredWidth > 0) setPosition({ anchor, x: anchor.x - x, y: anchor.y - y,
        width: Math.min(280, Math.max(1, measuredWidth - spacing.lg * 2)) });
    });
    return () => { cancelled = true; };
  }, [member?.botId, anchor, width, height]);
  const bot = member && (member.actorKind === 'bot' || (!member.actorKind && !member.role));
  const role = member ? bot
    ? member.ownerName ? t('groupChat.groupSettings.companionOf', { name: member.ownerName }) : null
    : t(`groupChat.settings.roles.${member.role ?? 'member'}`) : null;
  const status = !member || member.status === 'active' ? null
    : t(`groupChat.memberStatus.${member.status === 'paused' ? 'paused' : 'unavailable'}`);
  return <View ref={surface} collapsable={false} pointerEvents="box-none" style={StyleSheet.absoluteFill}>
    {member && anchor && position?.anchor === anchor ? <BotGroupMentionPopover
      position={position} width={position.width} onClose={onClose}
      name={botGroupMentionDisplayName(member)}
      displayName={member.nickname && member.displayName && member.nickname !== member.displayName ? member.displayName : undefined}
      caption={[role, status].filter(Boolean).join(' · ')}
      avatar={<BotGroupAvatar deviceId={deviceId} online identity={{ botId: member.botId, name: member.name,
        avatar: botGroupMemberAvatar(member), avatarUrl: member.avatarUrl }} size={BOT_GROUP_MENTION_AVATAR_SIZE} />} /> : null}
  </View>;
}
