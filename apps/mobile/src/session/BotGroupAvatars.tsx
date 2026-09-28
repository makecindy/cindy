/**
 * 群的身份标记（对照桌面 BotGroupAvatars.tsx）：列表行用两位成员斜向叠放，顶栏用一排
 * 叠放头像。每个头像仍是 RemoteCompanionAvatar；叠放处用与底色同色的 2pt 描边隔开，
 * 不引入阴影或新 token。头像与名字取伙伴列表缓存（只用于显示），缓存里没有时退回群里
 * 带来的名字与头像字段。
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

export interface BotGroupIdentity {
  botId: string;
  name: string;
  avatar?: RemoteResourceAvatar;
}

/** Timeline and plan rows: Desktop BotAvatar `sm` / `xs` on a phone. */
export const BOT_GROUP_MESSAGE_AVATAR_SIZE = 28;
export const BOT_GROUP_STEP_AVATAR_SIZE = 24;
export const BOT_GROUP_INLINE_AVATAR_SIZE = 20;
export const BOT_GROUP_ROW_AVATAR_SIZE = 32;
const STACK_AVATAR_SIZE = 24;
const DUO_AVATAR_SIZE = 28;
const DUO_BOX_SIZE = 44;
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
  return useCallback((botId: string, fallbackName = '', member?: Pick<BotGroupMemberView, 'name' | 'avatar' | 'avatarColor'>): BotGroupIdentity => {
    void revision; void loaded;
    const cached = botId ? cachedBotItem(userId, BOT_GROUP_TEAMMATES_COLLECTION_ID, deviceId, botId) : null;
    const cachedName = cached ? resolveRemoteText(cached.display.title, i18n.language) : '';
    const name = fallbackName.trim() || member?.name.trim() || cachedName || '';
    const avatar = cached?.display.avatar ?? (member ? botGroupMemberAvatar({ ...member, name: member.name || name }) : undefined);
    return { botId, name, ...(avatar ? { avatar } : {}) };
  }, [deviceId, i18n.language, loaded, revision, userId]);
}

export function BotGroupAvatar({ deviceId, identity, size, online }: {
  deviceId: string; identity: BotGroupIdentity; size: number; online: boolean;
}) {
  return <RemoteCompanionAvatar avatar={identity.avatar} deviceId={deviceId} name={identity.name} online={online} size={size} framed />;
}

/** A row of overlapped member avatars (screen header). */
export function BotGroupAvatarStack({ deviceId, members, online, max = 3 }: {
  deviceId: string; members: readonly BotGroupIdentity[]; online: boolean; max?: number;
}) {
  const styles = useThemedStyles(makeStyles);
  return <View style={styles.stack} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
    {members.slice(0, max).map((member, index) => <View key={member.botId || index} style={[styles.ring, index > 0 && styles.stacked]}>
      <BotGroupAvatar deviceId={deviceId} identity={member} size={STACK_AVATAR_SIZE} online={online} />
    </View>)}
  </View>;
}

/** 44pt list mark: the first two members, offset diagonally (Desktop BotGroupDuoAvatar). */
export function BotGroupDuoAvatar({ deviceId, members, online }: {
  deviceId: string; members: readonly BotGroupIdentity[]; online: boolean;
}) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const [first, second] = members;
  if (!first) {
    return <View style={[styles.duo, styles.duoEmpty]} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Users size={iconSize.md} color={colors.textTertiary} />
    </View>;
  }
  return <View style={styles.duo} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
    <View style={styles.duoFirst}><BotGroupAvatar deviceId={deviceId} identity={first} size={DUO_AVATAR_SIZE} online={online} /></View>
    {second ? <View style={[styles.ring, styles.duoSecond]}>
      <BotGroupAvatar deviceId={deviceId} identity={second} size={DUO_AVATAR_SIZE} online={online} />
    </View> : null}
  </View>;
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  stack: { flexDirection: 'row', alignItems: 'center', flexShrink: 0 },
  ring: { borderRadius: radius.pill, borderWidth: STACK_RING, borderColor: colors.surface, overflow: 'hidden' },
  // Overlap by a third of the avatar, the same rhythm as the desktop header lockup.
  stacked: { marginLeft: -(STACK_AVATAR_SIZE / 3) },
  duo: { width: DUO_BOX_SIZE, height: DUO_BOX_SIZE, flexShrink: 0 },
  duoEmpty: { alignItems: 'center', justifyContent: 'center', borderRadius: radius.pill, backgroundColor: colors.surfaceChip },
  duoFirst: { position: 'absolute', left: 0, top: 0 },
  duoSecond: { position: 'absolute', right: -STACK_RING, bottom: -STACK_RING },
});
