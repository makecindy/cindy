import type { BotGroupMemberView } from '@cindy/maker-shared/botGroupChat';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Text } from '@/components/AppText';
import { fontWeight, useThemedStyles, type ThemeColors } from '@/theme';
import { lineHeight, spacing, typeScale } from '@/theme/tokens';
import { BotGroupAvatar, BOT_GROUP_ROW_AVATAR_SIZE } from './BotGroupAvatars';
import { botGroupMemberAvatar } from './botGroupRemote';
import { CompanionSheet } from './CompanionSheet';
import { botGroupMentionDisplayName } from './botGroupMentions';

/** Read only the current group's public roster; never open a companion's private profile. */
export function BotGroupMentionIdentity({ member, deviceId, onClose }: {
  member: BotGroupMemberView | null; deviceId: string; onClose(): void;
}) {
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const bot = member && (member.actorKind === 'bot' || (!member.actorKind && !member.role));
  const role = member ? bot
    ? member.ownerName ? t('groupChat.groupSettings.companionOf', { name: member.ownerName }) : null
    : t(`groupChat.settings.roles.${member.role ?? 'member'}`) : null;
  const status = !member || member.status === 'active' ? null
    : t(`groupChat.memberStatus.${member.status === 'paused' ? 'paused' : 'unavailable'}`);
  return <CompanionSheet visible={!!member} title={member ? botGroupMentionDisplayName(member) : ''}
    onClose={onClose} testID="botGroup.mention.identity">
    {member ? <View style={styles.row}>
      <BotGroupAvatar deviceId={deviceId} online identity={{ botId: member.botId, name: member.name,
        avatar: botGroupMemberAvatar(member), avatarUrl: member.avatarUrl }} size={BOT_GROUP_ROW_AVATAR_SIZE} />
      <View style={styles.details}>
        <Text style={styles.name}>{botGroupMentionDisplayName(member)}</Text>
        {member.nickname && member.displayName && member.nickname !== member.displayName ? <Text style={styles.meta}>{member.displayName}</Text> : null}
        {role || status ? <Text style={styles.meta}>{[role, status].filter(Boolean).join(' · ')}</Text> : null}
      </View>
    </View> : null}
  </CompanionSheet>;
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, padding: spacing.lg },
  details: { flex: 1, minWidth: 0, gap: spacing.xs },
  name: { color: colors.textPrimary, fontSize: typeScale.body, lineHeight: lineHeight.body, fontWeight: fontWeight.medium },
  meta: { color: colors.textSecondary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption },
});
