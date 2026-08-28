import type {
  ConversationSearchContentHit,
  ConversationSearchResultItem,
  ConversationSearchSessionSummary,
  ConversationSearchSortBy,
} from '../../shared/conversationSearch.js';
import { stripInternalWebCitations } from '@cindy/maker-shared/internal-citation';
import { isSyntheticTriggerText } from '../../shared/interruptedTurn.js';

const Bonus = {
  WORD_BOUNDARY: 15,
  CONSECUTIVE: 20,
  EXACT_CASE: 1,
  TRUE_PREFIX: 2,
} as const;

const NON_LETTER_NUMBER_RE = /[^\p{L}\p{N}]/u;

function isWordBoundary(text: string, i: number): boolean {
  if (i === 0) return true;
  if (NON_LETTER_NUMBER_RE.test(text[i - 1])) return true;
  const prev = text.charCodeAt(i - 1);
  const curr = text.charCodeAt(i);
  return prev >= 97 && prev <= 122 && curr >= 65 && curr <= 90;
}

export interface FuzzyTitleMatch {
  score: number;
  indices: number[];
}

export function fuzzyTitleMatch(title: string, query: string): FuzzyTitleMatch | null {
  const trimmed = query.trim();
  if (!trimmed) return { score: 0, indices: [] };
  if (!title) return null;

  const tLower = title.toLowerCase();
  const qLower = trimmed.toLowerCase();
  const tLen = title.length;
  const qLen = trimmed.length;
  if (qLen > tLen) return null;

  const indices: number[] = [];
  let score = 0;
  let lastMatchIdx = -2;
  let ti = 0;

  for (let qi = 0; qi < qLen; qi += 1) {
    const qc = qLower.charCodeAt(qi);
    while (ti < tLen && tLower.charCodeAt(ti) !== qc) ti += 1;
    if (ti >= tLen) return null;

    indices.push(ti);
    let chScore = 1;
    const consecutive = ti === lastMatchIdx + 1;
    if (consecutive) chScore += Bonus.CONSECUTIVE;
    else if (isWordBoundary(title, ti)) chScore += Bonus.WORD_BOUNDARY;
    if (title.charCodeAt(ti) === trimmed.charCodeAt(qi)) chScore += Bonus.EXACT_CASE;
    if (qi === 0) {
      chScore *= 2;
      if (ti === 0) chScore += Bonus.TRUE_PREFIX;
    }
    score += chScore;
    lastMatchIdx = ti;
    ti += 1;
  }

  score += 16 / (tLen + 16);
  return { score, indices };
}

export interface MergeConversationSearchArgs {
  titleMatches: Array<{
    session: ConversationSearchSessionSummary;
    score: number;
    indices: number[];
  }>;
  contentHits: Array<{
    session: ConversationSearchSessionSummary;
    hit: ConversationSearchContentHit;
  }>;
  limit: number;
  sortBy?: ConversationSearchSortBy;
}

export interface ContentSearchPage<THit extends { sessionId: string }> {
  hits: THit[];
  vectorUsed: boolean;
  vectorSkipReason: string | null;
  poolCapped: boolean;
  nextOffset: number | null;
}

export interface CollectContentHitsArgs<THit extends { sessionId: string }> {
  maxPages: number;
  pageLimit: number;
  targetUniqueSessions: number;
  fetchPage: (args: { limit: number; offset: number }) => Promise<ContentSearchPage<THit>>;
}

export async function collectContentHitsUntilUniqueSessions<THit extends { sessionId: string }>({
  maxPages,
  pageLimit,
  targetUniqueSessions,
  fetchPage,
}: CollectContentHitsArgs<THit>): Promise<Omit<ContentSearchPage<THit>, 'nextOffset'>> {
  const hits: THit[] = [];
  const uniqueSessionIds = new Set<string>();
  let offset = 0;
  let vectorUsed = false;
  let vectorSkipReason: string | null = null;
  let poolCapped = false;

  for (let page = 0; page < maxPages; page += 1) {
    const content = await fetchPage({ limit: pageLimit, offset });
    hits.push(...content.hits);
    for (const hit of content.hits) uniqueSessionIds.add(hit.sessionId);
    vectorUsed ||= content.vectorUsed;
    vectorSkipReason = vectorSkipReason ?? content.vectorSkipReason;
    poolCapped ||= content.poolCapped;

    if (uniqueSessionIds.size >= targetUniqueSessions || content.nextOffset === null) {
      break;
    }
    offset = content.nextOffset;
  }

  return { hits, vectorUsed, vectorSkipReason, poolCapped };
}

export function mergeConversationSearchResults({
  titleMatches,
  contentHits,
  limit,
  sortBy = 'relevance',
}: MergeConversationSearchArgs): ConversationSearchResultItem[] {
  const bySessionId = new Map<string, ConversationSearchResultItem>();

  for (let i = 0; i < titleMatches.length; i += 1) {
    const match = titleMatches[i];
    bySessionId.set(match.session.id, {
      session: match.session,
      matchKind: 'title',
      titleMatchIndices: match.indices,
      titleScore: match.score,
      contentHit: null,
      contentHits: [],
      rankScore: 2_000_000 + match.score * 100 - i,
    });
  }

  for (let i = 0; i < contentHits.length; i += 1) {
    const { session, hit } = contentHits[i];
    const existing = bySessionId.get(session.id);
    if (existing) {
      existing.contentHits = insertContentHit(existing.contentHits, hit);
      existing.contentHit = existing.contentHits[0] ?? null;
      if (existing.titleScore !== null) {
        existing.matchKind = 'both';
        existing.rankScore += 50_000 + hit.score * 10;
      }
      continue;
    }
    bySessionId.set(session.id, {
      session,
      matchKind: 'content',
      titleMatchIndices: [],
      titleScore: null,
      contentHit: hit,
      contentHits: [hit],
      rankScore: 1_000_000 + hit.score * 10 - i,
    });
  }

  return sortConversationSearchResults([...bySessionId.values()], sortBy).slice(0, limit);
}

function insertContentHit(
  hits: ConversationSearchContentHit[],
  hit: ConversationSearchContentHit,
): ConversationSearchContentHit[] {
  if (hits.some((item) => item.messageId === hit.messageId)) return hits;
  return [...hits, hit].sort((a, b) =>
    b.score - a.score ||
    Date.parse(b.createdAt) - Date.parse(a.createdAt) ||
    a.messageId.localeCompare(b.messageId),
  );
}

export function sortConversationSearchResults(
  results: ConversationSearchResultItem[],
  sortBy: ConversationSearchSortBy = 'relevance',
): ConversationSearchResultItem[] {
  return results.sort((a, b) => {
    if (sortBy === 'activityDesc') {
      return (
        activityMs(b.session) - activityMs(a.session) ||
        relevanceCompare(a, b)
      );
    }
    if (sortBy === 'activityAsc') {
      return (
        activityMs(a.session) - activityMs(b.session) ||
        relevanceCompare(a, b)
      );
    }
    return relevanceCompare(a, b);
  });
}

function relevanceCompare(a: ConversationSearchResultItem, b: ConversationSearchResultItem): number {
  const groupA = a.matchKind === 'title' || a.matchKind === 'both' ? 1 : 0;
  const groupB = b.matchKind === 'title' || b.matchKind === 'both' ? 1 : 0;
  return (
    groupB - groupA ||
    b.rankScore - a.rankScore ||
    activityMs(b.session) - activityMs(a.session) ||
    a.session.id.localeCompare(b.session.id)
  );
}

function activityMs(session: ConversationSearchSessionSummary): number {
  const value = session.updatedAt;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

export function textPreview(value: unknown, max = 180): string {
  const text = extractText(value).replace(/\s+/g, ' ').trim();
  const chars = [...text];
  if (chars.length <= max) return text;
  return `${chars.slice(0, Math.max(0, max - 1)).join('').replace(/\s+$/u, '')}...`;
}

export interface NormalizedConversationContentPreview {
  preview: string;
  snippet: string | null;
  keywordMatchedVisibleText: boolean;
}

export function normalizeConversationContentPreview(
  role: string,
  content: unknown,
  query: string,
  max = 180,
): NormalizedConversationContentPreview {
  const visibleText = visibleMessageTextForConversationSearch(role, content);
  const ranges = keywordRanges(visibleText, query);
  const snippet = ranges.length > 0 ? visibleSnippet(visibleText, ranges[0], max) : null;
  return {
    preview: textPreview(visibleText, max),
    snippet,
    keywordMatchedVisibleText: ranges.length > 0,
  };
}

export function visibleMessageTextForConversationSearch(role: string, content: unknown): string {
  const parsed = typeof content === 'string' ? tryParseJsonLike(content) : content;
  const rawText = roleVisibleText(role, parsed);
  const text = role === 'assistant' ? stripInternalWebCitations(rawText) : rawText;
  return text.replace(/\s+/g, ' ').trim();
}

function roleVisibleText(role: string, content: unknown): string {
  if (role === 'user') return userVisibleText(content);
  if (role === 'assistant') return assistantVisibleText(content);
  if (role === 'ask_user') return askUserVisibleText(content);
  if (role === 'plan_review') return planReviewVisibleText(content);
  return extractText(content);
}

function userVisibleText(content: unknown): string {
  const text = userVisibleTextRaw(content);
  // 合成 UI 指令行(隐藏续跑指令等)对用户不可见,全文检索/learn-host 证据链
  // 同样不可见:返回空串 → keywordMatchedVisibleText=false → 命中被上游丢弃。
  // 与 mapper(sidebar 预览)/任务摘要/embedder 的排除口径一致,防隐藏英文指令
  // 经搜索 preview/snippet 泄漏给用户。
  return isSyntheticTriggerText(text) ? '' : text;
}

function userVisibleTextRaw(content: unknown): string {
  if (typeof content === 'string') return content;
  const blocksText = textBlocksText(content);
  if (blocksText) return blocksText;
  if (content && typeof content === 'object') {
    const obj = content as Record<string, unknown>;
    if (typeof obj.text === 'string') return obj.text;
    return preferredObjectText(obj);
  }
  return '';
}

function assistantVisibleText(content: unknown): string {
  if (typeof content === 'string') return content;
  const blocksText = textBlocksText(content);
  if (blocksText) return blocksText;
  if (
    content &&
    typeof content === 'object' &&
    (content as { type?: unknown }).type === 'text' &&
    typeof (content as { text?: unknown }).text === 'string'
  ) {
    return (content as { text: string }).text;
  }
  return extractText(content);
}

function askUserVisibleText(content: unknown): string {
  if (!content || typeof content !== 'object') return typeof content === 'string' ? content : '';
  const obj = content as Record<string, unknown>;
  const parts: string[] = [];
  const questions = obj.questions;
  if (Array.isArray(questions)) {
    for (const question of questions) {
      if (
        question &&
        typeof question === 'object' &&
        typeof (question as { question?: unknown }).question === 'string'
      ) {
        parts.push((question as { question: string }).question);
      }
    }
  }
  if (typeof obj.question === 'string') parts.push(obj.question);
  if (obj.answers && typeof obj.answers === 'object') {
    for (const answer of Object.values(obj.answers)) {
      if (typeof answer === 'string') parts.push(answer);
    }
  }
  if (typeof obj.reply === 'string') parts.push(obj.reply);
  return parts.join('\n');
}

function planReviewVisibleText(content: unknown): string {
  if (!content || typeof content !== 'object') return typeof content === 'string' ? content : '';
  const obj = content as Record<string, unknown>;
  return [obj.plan, obj.feedback].filter((value): value is string => typeof value === 'string').join('\n');
}

function textBlocksText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (
      block &&
      typeof block === 'object' &&
      (block as { type?: unknown }).type === 'text' &&
      typeof (block as { text?: unknown }).text === 'string'
    ) {
      parts.push((block as { text: string }).text);
    }
  }
  return parts.join('\n\n');
}

function preferredObjectText(obj: Record<string, unknown>): string {
  return [obj.text, obj.content, obj.message, obj.question, obj.plan]
    .map(extractText)
    .filter(Boolean)
    .join(' ');
}

function keywordRanges(text: string, query: string): Array<{ start: number; end: number }> {
  const tokens = [...new Set(query.match(/[\p{L}\p{N}]+/gu) ?? [])]
    .map((token) => token.trim())
    .filter((token) => token.length > 0)
    .sort((a, b) => b.length - a.length);
  if (tokens.length === 0 || !text) return [];

  // 不能先 toLocaleLowerCase() 再用折叠串的下标切原文：大小写折叠会改变长度
  // （如 U+0130「İ」折叠为 i + U+0307），emoji 等多单元字符也会让两套下标失配。
  // 为折叠串的每个 UTF-16 单元记录「折叠偏移 → 原文 UTF-16 偏移」的映射，
  // 命中偏移经映射换算回原文坐标后再切，切片恒落在码点边界。
  const { lowerText, foldOffsetToOrig16 } = foldWithOrigMap(text);
  const ranges: Array<{ start: number; end: number }> = [];
  for (const token of tokens) {
    const lowerToken = token.toLowerCase();
    let index = lowerText.indexOf(lowerToken);
    while (index >= 0) {
      const endUnit = index + lowerToken.length - 1;
      if (index >= foldOffsetToOrig16.length || endUnit >= foldOffsetToOrig16.length) break;
      const next = {
        start: foldOffsetToOrig16[index]!,
        end: foldOffsetToOrig16[endUnit]! + codePointLenAt(text, foldOffsetToOrig16[endUnit]!),
      };
      if (next.end > next.start && !ranges.some((range) => rangesOverlap(range, next))) {
        ranges.push(next);
      }
      index = lowerText.indexOf(lowerToken, index + lowerToken.length);
    }
  }
  return ranges.sort((a, b) => a.start - b.start);
}

/** 求原文在 UTF-16 偏移 pos 处的码点长度（1 或 2），用于把起始偏移换算成结束偏移。 */
function codePointLenAt(text: string, pos: number): number {
  return (text.codePointAt(pos) ?? 0) > 0xffff ? 2 : 1;
}

/**
 * 一次折叠同时产出小写串和「折叠 UTF-16 偏移 → 原文 UTF-16 偏移」映射。
 * 不用 toLocaleLowerCase()：lt/tr 等 locale 有上下文相关规则，逐码点折叠
 * 与整串折叠可能不等长，后面的 ASCII 会漏匹配。
 */
function foldWithOrigMap(text: string): { lowerText: string; foldOffsetToOrig16: number[] } {
  const foldOffsetToOrig16: number[] = [];
  let lowerText = '';
  let orig16 = 0;
  for (const ch of text) {
    const folded = ch.toLowerCase();
    lowerText += folded;
    for (let k = 0; k < folded.length; k += 1) {
      foldOffsetToOrig16.push(orig16);
    }
    orig16 += ch.length;
  }
  return { lowerText, foldOffsetToOrig16 };
}

function visibleSnippet(text: string, range: { start: number; end: number }, max: number): string {
  const chars = [...text];
  if (chars.length <= max) return text;
  const hitStartCp = utf16ToCodePointIndex(text, range.start);
  const hitEndCp = utf16ToCodePointIndex(text, range.end);
  const hitLength = Math.max(1, hitEndCp - hitStartCp);
  const side = Math.max(0, Math.floor((max - hitLength) / 2));
  let start = Math.max(0, hitStartCp - side);
  let end = Math.min(chars.length, start + max);
  start = Math.max(0, end - max);
  const prefix = start > 0 ? '...' : '';
  const suffix = end < chars.length ? '...' : '';
  return `${prefix}${chars.slice(start, end).join('').trim()}${suffix}`;
}

/** UTF-16 偏移 → 码点下标；落在低代理上时算到该码点。 */
function utf16ToCodePointIndex(text: string, utf16: number): number {
  let i = 0;
  let cp = 0;
  while (i < text.length && i < utf16) {
    const code = text.charCodeAt(i);
    i += code >= 0xd800 && code <= 0xdbff ? 2 : 1;
    cp += 1;
  }
  return cp;
}

function rangesOverlap(a: { start: number; end: number }, b: { start: number; end: number }): boolean {
  return a.start < b.end && b.start < a.end;
}

function extractText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map(extractText).filter(Boolean).join(' ');
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const preferred = [obj.text, obj.content, obj.message, obj.question, obj.plan]
      .map(extractText)
      .filter(Boolean)
      .join(' ');
    if (preferred) return preferred;
    return Object.values(obj).map(extractText).filter(Boolean).join(' ');
  }
  return '';
}

function tryParseJsonLike(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) return value;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}
