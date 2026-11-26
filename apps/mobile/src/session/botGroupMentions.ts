import type { BotGroupMemberView, BotGroupMention } from '@cindy/maker-shared/botGroupChat';
import { chatGroupHumanDisplayName, chatGroupMentionRoster } from '@cindy/maker-shared/botGroupPresentation';
import { botGroupMentionRanges, resolveBotGroupMentions, splitBotGroupMentionSegments, type BotGroupTextSegment } from '@cindy/maker-shared/botGroupMentions';

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

export type MentionRange = { start: number; end: number };
const overlaps = (a: MentionRange, b: MentionRange) => a.start < b.end && b.start < a.end;

/** Each saved recipient must occur somewhere. Highlight only a unique occurrence
 * with no competing possible range. Broadcasts also occupy their known spans. */
export function confirmedMobileMentionRanges(text: string, context: BotGroupMentionContext): MentionRange[] {
  const { members, mentions, allLabels, allBotsLabels } = context;
  const rangesFor = (labels: readonly string[]) => [...new Set(labels.map(label => label.trim()))]
    .flatMap(label => botGroupMentionRanges(text, label));
  const broadcasts = [mentions.all ? rangesFor(allLabels) : [], mentions.allBots ? rangesFor(allBotsLabels) : []];
  const memberRanges = broadcasts.some(ranges => ranges.length > 1)
    ? rangesFor(members.flatMap(memberMentionLabels)) : [];
  const fixedBroadcasts = broadcasts.flatMap(ranges => ranges.length === 1 ? ranges : ranges.filter(range =>
    !memberRanges.some(other => overlaps(other, range))
    && !broadcasts.some(group => group.some(other => other !== range && overlaps(other, range)))));
  const groups = mentions.botIds.map(id => {
    const member = members.find(candidate => candidate.botId === id);
    return member ? rangesFor(memberMentionLabels(member)).filter(range => !fixedBroadcasts.some(broadcast => overlaps(range, broadcast))) : [];
  });
  // Replies and shares can have implicit recipients. A missing range for one
  // recipient doesn't remove another recipient's independently matched range.
  const candidates = groups.flat();
  // An isolated occurrence of an unambiguous typed name would address that
  // member even without a pick. Check all labels, including unaddressed names,
  // so a longer match cannot explain away this occurrence.
  const roster = chatGroupMentionRoster(members);
  const typedLabels = roster.flatMap(member => [member.name, member.nickname || member.displayName || member.name]);
  const possibleRanges = rangesFor([...context.labels, ...typedLabels, ...allLabels, ...allBotsLabels]);
  const personal = groups.flatMap((ranges, index) => ranges.length === 1 ? ranges : ranges.filter(range => {
    if (possibleRanges.some(other => (other.start !== range.start || other.end !== range.end) && overlaps(other, range))) return false;
    const spelling = text.slice(range.start, range.end);
    if (!typedLabels.some(label => spelling === `@${label.trim()}`)) return false;
    const typed = resolveBotGroupMentions(spelling, { members: roster, allLabels, allBotLabels: [...allBotsLabels, 'bots'] });
    return typed.botIds.length === 1 && typed.botIds[0] === mentions.botIds[index];
  }))
    .filter(range => candidates.includes(range) && !candidates.some(other => other !== range && overlaps(other, range))
      && !broadcasts.some(ranges => ranges.some(broadcast => overlaps(range, broadcast))));
  return [...fixedBroadcasts.filter(range => !fixedBroadcasts.some(other => other !== range && overlaps(other, range))), ...personal]
    .sort((a, b) => a.start - b.start);
}

export function splitMobileBotGroupMentionSegments(text: string, labels: readonly string[], context?: BotGroupMentionContext): BotGroupTextSegment[] {
  if (!context?.mentions.botIds.length) return splitBotGroupMentionSegments(text, labels);
  return splitConfirmedMentionRanges(text, confirmedMobileMentionRanges(text, context));
}

export function splitConfirmedMentionRanges(text: string, ranges: readonly MentionRange[]): BotGroupTextSegment[] {
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
