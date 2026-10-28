/**
 * 群的身份标记（对照桌面 BotGroupAvatars.tsx）：双人斜向叠放，三人以上圆形聚拢，最多前五位。
 * 列表行 44 框、任务首页头像条 56 框、聊天顶栏 32 框；第一位始终在最前层。每个头像仍是 RemoteCompanionAvatar；叠放处用与
 * 底色同色的 2pt 描边隔开，不引入阴影或新 token。头像与名字取伙伴列表缓存（只用于显示），
 * 缓存里没有时退回群里带来的名字与头像字段。
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { StyleSheet, View } from 'react-native';
import { Users } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { resolveRemoteText, type RemoteResourceAvatar } from '@cindy/device-link';
import type { BotGroupMemberView } from '@cindy/maker-shared/botGroupChat';
import { useAuth } from '@/auth/AuthContext';
import { RemoteCompanionAvatar } from '@/components/RemoteCompanionAvatar';
import {
  cachedBotItem,
  readRemoteResourceSnapshot,
  remoteResourceCacheRevision,
  subscribeRemoteResourceCache,
} from '@/device-link/remoteResourceCache';
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { iconSize, radius } from '@/theme/tokens';
import { BOT_GROUP_TEAMMATES_COLLECTION_ID, botGroupMemberAvatar } from './botGroupRemote';
import { CompanionPresenceRing } from './CompanionPresenceRing';

export interface BotGroupIdentity {
  botId: string;
  name: string;
  avatar?: RemoteResourceAvatar;
  avatarUrl?: string | null;
}

/** Timeline and plan rows: Desktop BotAvatar `sm` / `xs` on a phone. */
export const BOT_GROUP_MESSAGE_AVATAR_SIZE = 28;
export const BOT_GROUP_STEP_AVATAR_SIZE = 24;
export const BOT_GROUP_INLINE_AVATAR_SIZE = 20;
export const BOT_GROUP_ROW_AVATAR_SIZE = 32;
/** List rows (44 box, two 30 avatars), the task home's avatar strip (56, two 38) and chat headers (32, two 22). */
const DUO_SIZES = { row: { box: 44, avatar: 30 }, strip: { box: 56, avatar: 38 }, header: { box: 32, avatar: 22 } } as const;
/** Separates overlapped avatars; the same 2pt ring as the teammate connection dot. */
const STACK_RING = 2;

/**
 * Identity lookup for one computer's Bots: the cached teammate row (name, avatar) wins,
 * then the group's own member fields, then the name snapshot a message or step carries.
 */
export function useBotGroupIdentities(deviceId: string) {
  const { user } = useAuth();
  const userId = user?.id ?? '';
  const { i18n } = useTranslation();
  const revision = useSyncExternalStore(subscribeRemoteResourceCache, remoteResourceCacheRevision);
  // Loading the persisted roster does not notify subscribers; re-render once it is in memory.
  const [loaded, setLoaded] = useState(0);
  useEffect(() => {
    if (!userId) return;
    let current = true;
    void readRemoteResourceSnapshot(userId).then(() => { if (current) setLoaded((value) => value + 1); });
    return () => { current = false; };
  }, [userId]);
  return useCallback((botId: string, fallbackName = '', member?: Pick<BotGroupMemberView, 'name' | 'avatar' | 'avatarColor' | 'avatarUrl'>): BotGroupIdentity => {
    void revision; void loaded;
    const cached = botId ? cachedBotItem(userId, BOT_GROUP_TEAMMATES_COLLECTION_ID, deviceId, botId) : null;
    const cachedName = cached ? resolveRemoteText(cached.display.title, i18n.language) : '';
    const name = fallbackName.trim() || member?.name.trim() || cachedName || '';
    const avatar = cached?.display.avatar ?? (member ? botGroupMemberAvatar({ ...member, name: member.name || name }) : undefined);
    return { botId, name, ...(avatar ? { avatar } : {}), ...(member?.avatarUrl ? { avatarUrl: member.avatarUrl } : {}) };
  }, [deviceId, i18n.language, loaded, revision, userId]);
}

export function BotGroupAvatar({ deviceId, identity, size, online }: {
  deviceId: string; identity: BotGroupIdentity; size: number; online: boolean;
}) {
  return <RemoteCompanionAvatar avatar={identity.avatar} imageUrl={identity.avatarUrl} deviceId={deviceId} name={identity.name} online={online} size={size} framed />;
}

/**
 * Group mark: a diagonal pair or circular cluster, kept inside the row/header box.
 * The front avatar carries a 2pt page-colored ring; while someone in the group works, that ring
 * breathes in Heart Orange (CompanionPresenceRing).
 */
export function BotGroupDuoAvatar({ deviceId, members, online, variant = 'row', working = false }: {
  deviceId: string; members: readonly BotGroupIdentity[]; online: boolean; variant?: keyof typeof DUO_SIZES; working?: boolean;
}) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const { box, avatar } = DUO_SIZES[variant];
  const [first, second] = members;
  const frame = { width: box, height: box };
  if (!first) {
    return <View style={[frame, styles.duoEmpty]} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Users size={iconSize.md} color={colors.textTertiary} />
    </View>;
  }
  if (members.length >= 3) {
    // Match Desktop: take the first five, then paint back-to-front so the first is unobscured.
    const visible = members.slice(0, 5).reverse();
    const diameter = box * (visible.length === 3 ? 0.6 : visible.length === 4 ? 0.55 : 0.5);
    // Image geometry excludes the page-colored border; this is not a toolbar icon size.
    const imageDiameter = diameter - STACK_RING * 2;
    const orbit = (box - diameter) / 2;
    return <View style={frame} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {visible.map((member, index) => {
        const angle = (-3 * Math.PI) / 4 + (index * 2 * Math.PI) / visible.length;
        return <View key={member.botId} style={[styles.ring, {
          position: 'absolute', width: diameter, height: diameter,
          left: orbit * (1 + Math.cos(angle)), top: orbit * (1 + Math.sin(angle)),
        }]}>
          <BotGroupAvatar deviceId={deviceId} identity={member} size={imageDiameter} online={online} />
          {index === visible.length - 1 ? <CompanionPresenceRing active={working} gap={0} width={STACK_RING} /> : null}
        </View>;
      })}
    </View>;
  }
  const front = avatar + STACK_RING * 2;
  return <View style={frame} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
    <View style={styles.duoBack}><BotGroupAvatar deviceId={deviceId} identity={second ?? first} size={second ? avatar : box} online={online} /></View>
    {second ? <View style={[styles.ring, { position: 'absolute', left: box - front, top: box - front }]}>
      <BotGroupAvatar deviceId={deviceId} identity={first} size={avatar} online={online} />
      <CompanionPresenceRing active={working} gap={0} width={STACK_RING} />
    </View> : <CompanionPresenceRing active={working} />}
  </View>;
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  ring: { borderRadius: radius.pill, borderWidth: STACK_RING, borderColor: colors.surface, overflow: 'hidden' },
  duoEmpty: { alignItems: 'center', justifyContent: 'center', borderRadius: radius.pill, backgroundColor: colors.surfaceChip },
  duoBack: { position: 'absolute', left: 0, top: 0 },
});
