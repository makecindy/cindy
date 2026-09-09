import {
  formatQuoteForSend,
  type ChatQuote,
  type ChatQuoteSegment,
} from '@cindy/maker-shared/chat-quotes';
import { slashCommandDisplayLabel } from '@cindy/maker-shared/composer-palette';

export interface SentPastedTextRange {
  start: number;
  end: number;
  display: string;
}

export interface SentSlashCommandRange {
  start: number;
  end: number;
}

export function readSentPastedTextRanges(
  value: unknown,
  text: string,
): SentPastedTextRange[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const ranges: SentPastedTextRange[] = [];
  let previousEnd = 0;
  for (const candidate of value) {
    const range = readRangeRecord(candidate);
    if (
      !range
      || !Number.isSafeInteger(range.start)
      || !Number.isSafeInteger(range.end)
      || typeof range.display !== 'string'
      || !range.display
    ) return undefined;
    const start = Number(range.start);
    const end = Number(range.end);
    if (start < previousEnd || start < 0 || end <= start || end > text.length) return undefined;
    ranges.push({ start, end, display: range.display });
    previousEnd = end;
  }
  return ranges;
}

export function readSentSlashCommandRanges(
  value: unknown,
  text: string,
): SentSlashCommandRange[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const ranges: SentSlashCommandRange[] = [];
  let previousEnd = 0;
  for (const candidate of value) {
    const range = readRangeRecord(candidate);
    if (!range || !Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end)) return undefined;
    const start = Number(range.start);
    const end = Number(range.end);
    if (
      start < previousEnd
      || start < 0
      || end <= start
      || end > text.length
      || !/^\/\S+$/.test(text.slice(start, end))
    ) return undefined;
    ranges.push({ start, end });
    previousEnd = end;
  }
  return ranges;
}

export type SentInlineToken =
  | { kind: 'text'; text: string }
  | { kind: 'slash'; text: string }
  | { kind: 'pasted'; text: string; display: string }
  | { kind: 'quote'; quote: ChatQuote };

/** Split exact persisted ranges without guessing from repeated text. */
export function buildSentInlineTokens(
  content: string,
  pastedTextRanges: readonly SentPastedTextRange[] = [],
  slashCommandRanges: readonly SentSlashCommandRange[] = [],
): SentInlineToken[] {
  const ranges = [
    ...pastedTextRanges.map((range) => ({ ...range, kind: 'pasted' as const })),
    ...slashCommandRanges.map((range) => ({ ...range, kind: 'slash' as const })),
  ].sort((a, b) => a.start - b.start || a.end - b.end);
  const tokens: SentInlineToken[] = [];
  let cursor = 0;
  for (const range of ranges) {
    if (
      range.start < cursor
      || range.start < 0
      || range.end > content.length
      || range.end <= range.start
    ) continue;
    if (range.start > cursor) pushTextToken(tokens, content.slice(cursor, range.start));
    const text = content.slice(range.start, range.end);
    if (range.kind === 'pasted') {
      tokens.push({ kind: 'pasted', text, display: range.display });
    } else {
      tokens.push({ kind: 'slash', text });
    }
    cursor = range.end;
  }
  if (cursor < content.length) pushTextToken(tokens, content.slice(cursor));
  return tokens;
}

/** Locate each parsed text island in the original quote wire text. */
export function locateChatQuoteTextSegmentStarts(
  content: string,
  segments: readonly ChatQuoteSegment[],
): Array<number | null> {
  let cursor = 0;
  return segments.map((segment) => {
    if (segment.kind === 'quote') {
      const encoded = formatQuoteForSend(segment.quote);
      const start = content.indexOf(encoded, cursor);
      if (start >= 0) cursor = start + encoded.length;
      return null;
    }
    const start = content.indexOf(segment.text, cursor);
    if (start < 0) return null;
    cursor = start + segment.text.length;
    return start;
  });
}

export function projectSentRanges<T extends { start: number; end: number }>(
  ranges: readonly T[],
  sourceStart: number | null,
  textLength: number,
): T[] {
  if (sourceStart === null) return [];
  const sourceEnd = sourceStart + textLength;
  return ranges
    .filter((range) => range.start >= sourceStart && range.end <= sourceEnd)
    .map((range) => ({
      ...range,
      start: range.start - sourceStart,
      end: range.end - sourceStart,
    }));
}

/**
 * Replace quote wire blocks with quote tokens while preserving atom ranges
 * inside every text island. Keeping every segment in one ordered stream is
 * what lets sent messages render `quote A -> reply A -> quote B -> reply B`.
 */
export function buildVisibleSentInlineTokens(
  source: string,
  segments: readonly ChatQuoteSegment[],
  pastedTextRanges: readonly SentPastedTextRange[] = [],
  slashCommandRanges: readonly SentSlashCommandRange[] = [],
): SentInlineToken[] {
  if (segments.length === 0) return buildSentInlineTokens(source, pastedTextRanges, slashCommandRanges);
  const starts = locateChatQuoteTextSegmentStarts(source, segments);
  const tokens: SentInlineToken[] = [];
  segments.forEach((segment, index) => {
    if (segment.kind === 'quote') {
      tokens.push({ kind: 'quote', quote: segment.quote });
      return;
    }
    const sourceStart = starts[index];
    const projectedPastes = projectSentRanges(pastedTextRanges, sourceStart, segment.text.length);
    const projectedSlashes = projectSentRanges(slashCommandRanges, sourceStart, segment.text.length);
    for (const token of buildSentInlineTokens(segment.text, projectedPastes, projectedSlashes)) {
      if (token.kind === 'text') pushTextToken(tokens, token.text);
      else tokens.push(token);
    }
  });
  return tokens;
}

export function sentInlineTokensDisplayText(tokens: readonly SentInlineToken[]): string {
  let display = '';
  for (const token of tokens) {
    if (token.kind === 'quote') {
      if (display && !display.endsWith('\n')) display += '\n';
      display += token.quote.text;
      if (!display.endsWith('\n')) display += '\n';
      continue;
    }
    display += token.kind === 'pasted'
      ? token.display
      : token.kind === 'slash'
        ? slashCommandDisplayLabel(token.text)
        : token.text;
  }
  return display.trimEnd();
}

function pushTextToken(tokens: SentInlineToken[], text: string): void {
  if (!text) return;
  const previous = tokens.at(-1);
  if (previous?.kind === 'text') previous.text += text;
  else tokens.push({ kind: 'text', text });
}

function readRangeRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
