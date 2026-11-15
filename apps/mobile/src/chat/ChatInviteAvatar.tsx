import { useState } from 'react';
import { Image, View } from 'react-native';
import { Users } from 'lucide-react-native';
import { RemoteCompanionAvatar } from '@/components/RemoteCompanionAvatar';
import { botGroupMemberAvatar } from '@/session/botGroupRemote';
import { useTheme } from '@/theme';
import { iconSize, radius } from '@/theme/tokens';
import { chatHttpsUrl, chatMemberAvatar, type MobileChatInviteMemberAvatar } from './chatServerClient';

const SIZE = 88;
const RING = 2;

/** Preview summary only: never fetch the members roster before joining or borrow the inviter's avatar. */
export function ChatInviteAvatar({ avatar, members }: { avatar?: string | null; members?: readonly MobileChatInviteMemberAvatar[] }) {
  const { colors } = useTheme();
  const [failed, setFailed] = useState<string | null>(null);
  const visible = members?.slice(0, 5) ?? [];
  let uri: string | undefined;
  try { if (avatar) uri = chatHttpsUrl(avatar); } catch { /* Legacy group image is optional. */ }
  const box = { width: SIZE, height: SIZE };
  const marker = <View style={[box, { backgroundColor: colors.surfaceChip, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center' }]}>
    <Users size={iconSize.hero} color={colors.textTertiary} />
  </View>;
  const person = (member: MobileChatInviteMemberAvatar, size: number) => {
    const projected = chatMemberAvatar(member.avatar);
    const identity = botGroupMemberAvatar({ name: member.initial, avatar: projected.avatar, avatarColor: '' });
    return <RemoteCompanionAvatar avatar={{ ...identity, fallbackText: member.initial }} imageUrl={projected.avatarUrl}
      deviceId="" name={member.initial} online size={size} framed />;
  };
  if (!visible.length) return <View style={box} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
    {uri && failed !== uri ? <Image source={{ uri }} onError={() => setFailed(uri!)} style={[box, { borderRadius: radius.pill }]} /> : marker}
  </View>;
  if (visible.length === 1) return <View style={box} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">{person(visible[0], SIZE)}</View>;
  // Same two-person overlap / 3–5 orbit as BotGroupAvatars, recentered on the visible contour for the 88pt identity.
  const diameter = visible.length === 2 ? SIZE * 30 / 44 + RING * 2 : SIZE * (visible.length === 3 ? 0.6 : visible.length === 4 ? 0.55 : 0.5);
  const orbit = (SIZE - diameter) / 2;
  const points = visible.map((_, i) => ({ x: orbit * Math.cos(-3 * Math.PI / 4 + i * 2 * Math.PI / visible.length),
    y: orbit * Math.sin(-3 * Math.PI / 4 + i * 2 * Math.PI / visible.length) }));
  const cx = (Math.min(...points.map(p => p.x)) + Math.max(...points.map(p => p.x))) / 2;
  const cy = (Math.min(...points.map(p => p.y)) + Math.max(...points.map(p => p.y))) / 2;
  return <View style={box} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
    {visible.map((member, i) => {
      const pairBack = visible.length === 2 && i === 1;
      const size = pairBack ? diameter - RING * 2 : diameter;
      const point = points[visible.length - 1 - i];
      const left = visible.length === 2 ? (pairBack ? 0 : SIZE - diameter) : SIZE / 2 + point.x - cx - diameter / 2;
      const top = visible.length === 2 ? left : SIZE / 2 + point.y - cy - diameter / 2;
      return <View key={i} style={{ position: 'absolute', left, top, width: size, height: size, borderRadius: radius.pill,
        padding: pairBack ? 0 : RING, backgroundColor: colors.surface }}>
        {person(member, diameter - RING * 2)}
      </View>;
    }).reverse()}
  </View>;
}
