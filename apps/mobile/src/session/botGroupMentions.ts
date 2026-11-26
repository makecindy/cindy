import type { BotGroupMemberView, BotGroupMention } from '@cindy/maker-shared/botGroupChat';
import { chatGroupHumanDisplayName } from '@cindy/maker-shared/botGroupPresentation';
import { splitBotGroupMentionSegments } from '@cindy/maker-shared/botGroupMentions';

// Sent text keeps its original locale and wording across product renames.
// Share historical labels with segmentation so a shorter member name cannot split them.
export const LEGACY_BOT_GROUP_ALL_BOTS_LABELS = [
  'All teammates', '모든 동료', 'Alle Teammitglieder', 'Tous les coéquipiers',
  'Todos los compañeros', 'Todos os colegas', '诸同僚', '諸同僚',
] as const;

// Same display and identity rules as Desktop BotGroupMentionCard / TimelineModel.
export function botGroupMentionDisplayName(member: BotGroupMemberView): string {
  if (member.actorKind === 'human') return chatGroupHumanDisplayName(member);
  const name = member.name.trim();
  const owner = member.ownerName?.trim();
  const suffix = owner ? ` (${owner})` : '';
  return suffix && member.isOwned === false && !name.endsWith(suffix) ? `${name}${suffix}` : name;
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

function memberMentionLabels(member: BotGroupMemberView) {
  return [member.name, botGroupMentionDisplayName(member), member.nickname || member.displayName || member.name];
}

export function splitMobileBotGroupMentionSegments(text: string, labels: readonly string[], context?: BotGroupMentionContext) {
  if (!context?.mentions.botIds.length) return splitBotGroupMentionSegments(text, labels);
  const { members, mentions, allLabels, allBotsLabels } = context;
  const recipients = new Set(mentions.botIds);
  const preferred = members.filter(member => recipients.has(member.botId)).flatMap(memberMentionLabels);
  if (mentions.all) preferred.push(...allLabels);
  if (mentions.allBots) preferred.push(...allBotsLabels);
  return splitBotGroupMentionSegments(text, labels, preferred);
}

export function botGroupMentionMember(label: string, context: BotGroupMentionContext): BotGroupMemberView | undefined {
  const { members, mentions, serverBacked, allLabels, allBotsLabels } = context;
  const name = label.replace(/^@/, '').trim();
  const fallback = serverBacked && !mentions.all && !mentions.allBots && mentions.botIds.length === 0;
  const broadcast = [...allLabels, '所有人', '全員', '모두', 'all', 'everyone'].some(label => label.toLowerCase() === name.toLowerCase());
  if ((mentions.all || fallback) && broadcast) return undefined;
  const botBroadcast = [...allBotsLabels, ...LEGACY_BOT_GROUP_ALL_BOTS_LABELS, '所有伙伴', '所有夥伴', 'すべての仲間', '모든 동반자', 'all buddies', 'bots'].some(label => label.toLowerCase() === name.toLowerCase());
  if ((mentions.allBots || fallback) && botBroadcast) return undefined;
  const matches = members.filter(member => (fallback || mentions.botIds.includes(member.botId))
    && memberMentionLabels(member)
      .some(candidate => candidate?.trim() === name));
  return matches.length === 1 ? matches[0] : undefined;
}
