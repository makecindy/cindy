import type { BotGroupMemberView, BotGroupMention } from '@cindy/maker-shared/botGroupChat';

// Same display and identity rules as Desktop BotGroupMentionCard / TimelineModel.
export function botGroupMentionDisplayName(member: BotGroupMemberView): string {
  const name = member.name.trim();
  const owner = member.ownerName?.trim();
  const suffix = owner ? ` (${owner})` : '';
  return suffix && member.isOwned === false && member.actorKind !== 'human' && !name.endsWith(suffix) ? `${name}${suffix}` : name;
}

export interface BotGroupMentionPoint { x: number; y: number }

export interface BotGroupMentionContext {
  members: readonly BotGroupMemberView[];
  mentions: BotGroupMention;
  serverBacked: boolean;
  allLabels: readonly string[];
  allBotsLabels: readonly string[];
  labels: readonly string[];
  onPress(member: BotGroupMemberView, anchor?: BotGroupMentionPoint): void;
}

export function botGroupMentionMember(label: string, context: BotGroupMentionContext): BotGroupMemberView | undefined {
  const { members, mentions, serverBacked, allLabels, allBotsLabels } = context;
  const name = label.replace(/^@/, '').trim();
  const fallback = serverBacked && !mentions.all && !mentions.allBots && mentions.botIds.length === 0;
  const broadcast = [...allLabels, '所有人', '全員', '모두', 'all', 'everyone'].some(label => label.toLowerCase() === name.toLowerCase());
  if ((mentions.all || fallback) && broadcast) return undefined;
  const botBroadcast = [...allBotsLabels, '所有伙伴', '所有夥伴', 'すべての仲間', '모든 동료', 'all teammates', 'bots'].some(label => label.toLowerCase() === name.toLowerCase());
  if ((mentions.allBots || fallback) && botBroadcast) return undefined;
  const matches = members.filter(member => (fallback || mentions.botIds.includes(member.botId))
    && [member.name, botGroupMentionDisplayName(member), member.nickname || member.displayName || member.name]
      .some(candidate => candidate?.trim() === name));
  return matches.length === 1 ? matches[0] : undefined;
}
