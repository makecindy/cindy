/**
 * 群聊输入框里的 @ 点名：纯文本解析，不依赖 React 与 IPC。
 *
 * 输入框是普通 textarea，点名以 `@名字 ` 的形式留在正文里。发送时以正文为准重新解析
 * （手打的 `@小满` 与从候选里选的效果一致）。选择候选时记下的 botId 用于消歧，
 * 成员离群后仍保留显式目标，由宿主拒绝失效目标。宿主按解析结果决定谁回答
 * （docs/product-rules/bot-group-chat.md §4.1）。
 */
import type { BotGroupMention } from './botGroupChat.js';

export interface BotGroupMentionMember {
  botId: string;
  name: string;
  /** Chat Server's undecorated name, so an existing @name still resolves. */
  displayName?: string;
  nickname?: string | null;
}

/** A mention picked from the candidate list; `label` is the text after `@`. */
export interface BotGroupTrackedMention {
  botId: string;
  label: string;
  /** UTF-16 index of this picked token's `@` in the untrimmed draft. */
  start: number;
}

export interface BotGroupMentionQuery {
  /** Index of the `@`. */
  start: number;
  /** Text typed after `@`, up to the caret. */
  query: string;
}

/** 候选词最长这么多字；再长就当成普通正文，不再弹候选。 */
const MAX_MENTION_QUERY_CHARS = 32;

/** `@` 紧跟在这些字符后面时是邮箱或标识符的一部分，不是点名。 */
const WORD_BEFORE_AT = /[A-Za-z0-9._%+-]/;
const LATIN_WORD_CHAR = /[A-Za-z0-9_]/;

function isMentionStart(text: string, at: number): boolean {
  return at === 0 || !WORD_BEFORE_AT.test(text[at - 1] ?? '');
}

/**
 * 中文名后面常常直接接正文（「@小满帮我查一下」），所以名字不要求后面跟空格；
 * 只有以拉丁字母或数字结尾的名字才要求词边界，免得 `@Anna` 被当成 `@Ann`。
 */
function endsAtBoundary(label: string, next: string | undefined): boolean {
  if (next === undefined) return true;
  const last = label[label.length - 1] ?? '';
  return !(LATIN_WORD_CHAR.test(last) && LATIN_WORD_CHAR.test(next));
}

interface LabelEntry {
  label: string;
  all: boolean;
  botIds: string[];
}

function buildLabelEntries(
  members: readonly BotGroupMentionMember[],
  allLabels: readonly string[],
  tracked: readonly BotGroupTrackedMention[],
): LabelEntry[] {
  const byLabel = new Map<string, LabelEntry>();
  for (const raw of allLabels) {
    const label = raw.trim();
    if (label) byLabel.set(label, { label, all: true, botIds: [] });
  }
  for (const member of members) {
    for (const raw of [member.name, member.nickname || member.displayName || '']) {
      const label = raw.trim();
      if (!label || byLabel.get(label)?.all) continue;
      const entry = byLabel.get(label) ?? { label, all: false, botIds: [] };
      if (!entry.botIds.includes(member.botId)) entry.botIds.push(member.botId);
      byLabel.set(label, entry);
    }
  }
  // Keep an explicit pick even after it disappears from the live roster. This
  // records intent, not membership: the host must reject unavailable targets.
  for (const mention of tracked) {
    const label = mention.label.trim();
    if (label && !byLabel.has(label)) byLabel.set(label, { label, all: false, botIds: [] });
  }
  // 最长优先：`@小满满` 不能先被 `@小满` 截走。
  return [...byLabel.values()].sort((a, b) => b.label.length - a.label.length);
}

interface MentionToken {
  start: number;
  end: number;
  entry: LabelEntry;
}

function scanMentionTokens(text: string, entries: readonly LabelEntry[]): MentionToken[] {
  const tokens: MentionToken[] = [];
  let index = text.indexOf('@');
  while (index >= 0) {
    let next = index + 1;
    if (isMentionStart(text, index)) {
      const entry = entries.find(
        (candidate) =>
          text.startsWith(candidate.label, index + 1) &&
          endsAtBoundary(candidate.label, text[index + 1 + candidate.label.length]),
      );
      if (entry) {
        const end = index + 1 + entry.label.length;
        tokens.push({ start: index, end, entry });
        next = end;
      }
    }
    index = text.indexOf('@', next);
  }
  return tokens;
}

/**
 * Resolve who a group message addresses. Mentions are re-derived from the text
 * at send time; a tracked pick also preserves a stale target for host validation.
 */
export function resolveBotGroupMentions(
  text: string,
  input: {
    members: readonly BotGroupMentionMember[];
    allLabels: readonly string[];
    tracked?: readonly BotGroupTrackedMention[];
  },
): BotGroupMention {
  const entries = buildLabelEntries(input.members, input.allLabels, input.tracked ?? []);
  const botIds: string[] = [];
  let all = false;
  for (const token of scanMentionTokens(text, entries)) {
    if (token.entry.all) all = true;
    const picked = (input.tracked ?? []).filter(mention => !token.entry.all &&
      mention.start === token.start && mention.label.trim() === token.entry.label);
    for (const botId of picked.length ? picked.map(mention => mention.botId) : token.entry.botIds) {
      if (!botIds.includes(botId)) botIds.push(botId);
    }
  }
  // 按正文里点名的先后输出：宿主直接按这个顺序轮流发言（bot-group-chat.md §4.1）。
  return { all, botIds };
}

/** Move intact picked tokens with a text edit; forget tokens the edit replaces. */
export function retainBotGroupTrackedMentions(
  previousText: string,
  text: string,
  input: {
    members: readonly BotGroupMentionMember[];
    allLabels: readonly string[];
    tracked: readonly BotGroupTrackedMention[];
    /** Previous selection start (or new caret after deletion) disambiguates identical tokens. */
    editStart?: number;
    /** Selected text is replaced even when its characters also match the new suffix. */
    editEnd?: number;
  },
): BotGroupTrackedMention[] {
  const prefixLimit = Math.min(previousText.length, text.length, Math.max(0, input.editStart ?? previousText.length));
  let prefix = 0;
  while (prefix < prefixLimit && previousText[prefix] === text[prefix]) prefix++;
  let previousEnd = previousText.length, nextEnd = text.length;
  const suffixLimit = Math.max(prefix, input.editEnd ?? prefix);
  while (previousEnd > suffixLimit && nextEnd > prefix && previousText[previousEnd - 1] === text[nextEnd - 1]) {
    previousEnd--; nextEnd--;
  }
  const delta = text.length - previousText.length;
  const tracked = input.tracked.flatMap(mention => {
    if (mention.start + 1 + mention.label.trim().length <= prefix) return [mention];
    if (mention.start >= previousEnd) return [{ ...mention, start: mention.start + delta }];
    return []; // This particular token was edited or deleted, even if a namesake remains.
  });
  const entries = buildLabelEntries(input.members, input.allLabels, tracked);
  const tokens = scanMentionTokens(text, entries);
  return tracked.filter(mention => tokens.some(token => !token.entry.all &&
    token.start === mention.start && token.entry.label === mention.label.trim()));
}

/** The `@query` being typed right before the caret, if any. */
export function findBotGroupMentionQuery(text: string, caret: number): BotGroupMentionQuery | null {
  const before = text.slice(0, Math.max(0, Math.min(caret, text.length)));
  const at = before.lastIndexOf('@');
  if (at < 0 || !isMentionStart(before, at)) return null;
  const query = before.slice(at + 1);
  if (query.length > MAX_MENTION_QUERY_CHARS || /\s/.test(query)) return null;
  return { start: at, query };
}

/** Case-insensitive match; names starting with the query come first. */
export function filterBotGroupMentionCandidates<T extends { name: string }>(
  query: string,
  candidates: readonly T[],
): T[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [...candidates];
  const prefix: T[] = [];
  const inner: T[] = [];
  for (const candidate of candidates) {
    const name = candidate.name.toLocaleLowerCase();
    if (name.startsWith(needle)) prefix.push(candidate);
    else if (name.includes(needle)) inner.push(candidate);
  }
  return [...prefix, ...inner];
}

/** Replace `@query` (from `start` to `end`) with `@label ` and return the new caret. */
export function insertBotGroupMention(
  text: string,
  range: { start: number; end: number },
  label: string,
): { text: string; caret: number } {
  const after = text.slice(range.end);
  const inserted = after.startsWith(' ') ? `@${label}` : `@${label} `;
  const caret = range.start + inserted.length + (after.startsWith(' ') ? 1 : 0);
  return { text: text.slice(0, range.start) + inserted + after, caret };
}

export interface BotGroupTextSegment {
  text: string;
  mention: boolean;
}

/** Split message text so `@name` tokens can be shown as mention chips. */
export function splitBotGroupMentionSegments(
  text: string,
  labels: readonly string[],
): BotGroupTextSegment[] {
  const entries = [...new Set(labels.map((label) => label.trim()).filter(Boolean))]
    .sort((a, b) => b.length - a.length)
    .map((label) => ({ label, all: false, botIds: [] }));
  const segments: BotGroupTextSegment[] = [];
  let cursor = 0;
  for (const token of scanMentionTokens(text, entries)) {
    if (token.start > cursor) segments.push({ text: text.slice(cursor, token.start), mention: false });
    segments.push({ text: text.slice(token.start, token.end), mention: true });
    cursor = token.end;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), mention: false });
  return segments;
}
