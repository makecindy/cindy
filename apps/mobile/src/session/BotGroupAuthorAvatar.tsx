import { Platform, Pressable, View, type StyleProp, type ViewStyle } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { BotGroupMemberView } from '@cindy/maker-shared/botGroupChat';
import { isActiveBotGroupMember } from '@cindy/maker-shared/botGroupPresentation';
import { useScreenReaderEnabled } from '@/hooks/useScreenReaderEnabled';
import { BOT_GROUP_MESSAGE_AVATAR_SIZE, BotGroupAvatar, type BotGroupIdentity } from './BotGroupAvatars';

const MENTION_HIT_SLOP = (44 - BOT_GROUP_MESSAGE_AVATAR_SIZE) / 2;

export function BotGroupAuthorAvatar({ deviceId, identity, online, style, member, onMention }: {
  deviceId: string;
  identity: BotGroupIdentity;
  online: boolean;
  style: StyleProp<ViewStyle>;
  member?: BotGroupMemberView;
  onMention?: (botId: string) => void;
}) {
  const { t } = useTranslation();
  const screenReader = useScreenReaderEnabled();
  const avatar = <BotGroupAvatar deviceId={deviceId} identity={identity} size={BOT_GROUP_MESSAGE_AVATAR_SIZE} online={online} />;
  if (!onMention || !member || !isActiveBotGroupMember(member) || member.actorKind === 'human' || !member.name.trim()) {
    return <View style={style}>{avatar}</View>;
  }
  const mention = () => onMention(member.botId);
  return <Pressable style={style}
    testID={`botGroup.avatarMention.${member.botId}`}
    hitSlop={MENTION_HIT_SLOP}
    accessibilityLabel={identity.name}
    accessibilityRole="button"
    accessibilityHint={t('groupChat.mention.avatarHint')}
    accessibilityActions={[
      { name: 'longpress', label: t('groupChat.mention.label') },
      ...(Platform.OS === 'android' ? [{ name: 'activate' }] : []),
    ]}
    onAccessibilityTap={mention}
    onAccessibilityAction={({ nativeEvent }) => {
      if (nativeEvent.actionName === 'activate' || nativeEvent.actionName === 'longpress') mention();
    }}
    onPress={screenReader ? mention : undefined}
    onLongPress={mention}>
    {avatar}
  </Pressable>;
}
