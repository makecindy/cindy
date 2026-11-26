import type { BotGroupMemberView, BotGroupMention } from '@cindy/maker-shared/botGroupChat';
import { chatGroupHumanDisplayName } from '@cindy/maker-shared/botGroupPresentation';
import { botGroupMentionRanges, splitBotGroupMentionSegments, type BotGroupTextSegment } from '@cindy/maker-shared/botGroupMentions';

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

type MentionRange = { start: number; end: number };
const overlaps = (a: MentionRange, b: MentionRange) => a.start < b.end && b.start < a.end;

/** Each saved recipient must occur somewhere. Highlight only a unique occurrence
 * with no competing possible range. Broadcasts also occupy their known spans. */
function confirmedMobileMentionRanges(text: string, context: BotGroupMentionContext): MentionRange[] {
  const { members, mentions, allLabels, allBotsLabels } = context;
  const rangesFor = (labels: readonly string[]) => [...new Set(labels.map(label => label.trim()))]
    .flatMap(label => botGroupMentionRanges(text, label));
  const broadcasts = [mentions.all ? rangesFor(allLabels) : [], mentions.allBots ? rangesFor(allBotsLabels) : []];
  const fixedBroadcasts = broadcasts.flatMap(ranges => ranges.length === 1 ? ranges : []);
  const groups = mentions.botIds.map(id => {
    const member = members.find(candidate => candidate.botId === id);
    return member ? rangesFor(memberMentionLabels(member)).filter(range => !fixedBroadcasts.some(broadcast => overlaps(range, broadcast))) : [];
  });
  // A missing target position means the current roster cannot account for the
  // saved recipients. In that case there is no basis to infer personal ranges.
  const candidates = groups.every(ranges => ranges.length) ? groups.flat() : [];
  const personal = groups.flatMap(ranges => ranges.length === 1 ? ranges : [])
    .filter(range => candidates.includes(range) && !candidates.some(other => other !== range && overlaps(other, range))
      && !broadcasts.some(ranges => ranges.some(broadcast => overlaps(range, broadcast))));
  return [...fixedBroadcasts.filter(range => !fixedBroadcasts.some(other => other !== range && overlaps(other, range))), ...personal]
    .sort((a, b) => a.start - b.start);
}

export function splitMobileBotGroupMentionSegments(text: string, labels: readonly string[], context?: BotGroupMentionContext,
  source = text): BotGroupTextSegment[] {
  if (!context?.mentions.botIds.length) return splitBotGroupMentionSegments(text, labels);
  // A Markdown projection without source offsets may turn ordinary text
  // into a spelling that exists elsewhere in the original message.
  if (text !== source) return [{ text, mention: false }];
  const ranges = confirmedMobileMentionRanges(text, context);
  const segments: BotGroupTextSegment[] = [];
  let cursor = 0;
  for (const { start: from, end: to } of ranges) {
    if (from > cursor) segments.push({ text: text.slice(cursor, from), mention: false });
    segments.push({ text: text.slice(from, to), mention: true });
    cursor = to;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), mention: false });
  return segments;
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
