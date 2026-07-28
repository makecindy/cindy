/**
 * Pure Tiptap JSON helpers for inline chat quotes.
 *
 * Quotes are inline atoms inside ordinary paragraphs so users can type a reply
 * directly beside each compact quote chip. Their document order still remains
 * explicit and survives session switches, fork, rewind, and send.
 * Keeping these transforms free of React/Tiptap runtime objects makes the
 * draft store deterministic and directly testable.
 */
import type { JSONContent } from '@tiptap/core';
import type { AgentInputReference } from '../../shared/agentInputQueue';
import { parseChatQuoteSegments, type ChatQuote, type ChatQuoteSegment } from '@/lib/chatQuotes';
import type { PastedTextRange, SlashCommandRange } from '@/lib/imageRef';
import { normalizeComposerDocumentJSON } from './composerListDocument';

export const COMPOSER_QUOTE_NODE_TYPE = 'composerQuote';

export interface ComposerQuoteAttrs {
  text: string;
  sourcePath: string | null;
  startLine: number | null;
  endLine: number | null;
}

export interface ComposerSerializedBlock {
  kind: 'text' | 'quote';
  text: string;
  /** Structured reference offsets relative to this block's text. */
  agentReferences?: AgentInputReference[];
  /** Ranges are relative to this block's text. */
  pastedTextRanges?: PastedTextRange[];
  /** Ranges are relative to this block's text. */
  slashCommandRanges?: SlashCommandRange[];
}

export interface ComposerHistoryEntry {
  content: string;
  quotesEncoded?: boolean;
}

function trimRangeToText(
  range: { start: number; end: number },
  leadingTrim: number,
  textLength: number,
): { start: number; end: number } | null {
  const start = Math.max(0, range.start - leadingTrim);
  const end = Math.min(textLength, range.end - leadingTrim);
  return start < end ? { start, end } : null;
}

export function composerQuoteAttrsToChatQuote(attrs: ComposerQuoteAttrs): ChatQuote {
  return {
    text: attrs.text,
    ...(attrs.sourcePath ? { sourcePath: attrs.sourcePath } : {}),
    ...(typeof attrs.startLine === 'number' ? { startLine: attrs.startLine } : {}),
    ...(typeof attrs.endLine === 'number' ? { endLine: attrs.endLine } : {}),
  };
}

function quoteNode(quote: ChatQuote): JSONContent {
  return {
    type: COMPOSER_QUOTE_NODE_TYPE,
    attrs: {
      text: quote.text,
      sourcePath: quote.sourcePath ?? null,
      startLine: quote.startLine ?? null,
      endLine: quote.endLine ?? null,
    },
  };
}

function paragraph(content: JSONContent[] = []): JSONContent {
  return content.length > 0 ? { type: 'paragraph', content } : { type: 'paragraph' };
}

function isPureLineBreakText(text: string): boolean {
  if (!text) return false;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== '\n') return false;
  }
  return true;
}

const LIST_ROW_MARKER_RE = /^(?:[-+*•][ \t]+|[1-9]\d{0,8}[.)][ \t]+|[1-9]\d{0,8}、[ \t]*)/;

function normalizeTopLevelQuoteNodes(document: JSONContent | null | undefined): JSONContent[] {
  const source =
    document?.type === 'doc' && Array.isArray(document.content) ? document.content : [];
  const normalized: JSONContent[] = [];
  let pendingQuotes: JSONContent[] = [];

  const flushPendingQuotes = () => {
    if (pendingQuotes.length === 0) return;
    normalized.push(paragraph(pendingQuotes));
    pendingQuotes = [];
  };

  for (const node of source) {
    if (node.type === COMPOSER_QUOTE_NODE_TYPE) {
      // Compatibility with documents produced by the first block-card preview.
      pendingQuotes.push(node);
      continue;
    }
    if (node.type === 'paragraph' && pendingQuotes.length > 0) {
      normalized.push(paragraph([...pendingQuotes, ...(node.content ?? [])]));
      pendingQuotes = [];
      continue;
    }
    flushPendingQuotes();
    normalized.push(node);
  }
  flushPendingQuotes();
  return normalized;
}

/** Append a quote to the final paragraph so the caret can continue beside it. */
export function appendQuoteToComposerDocument(
  document: JSONContent | null | undefined,
  quote: ChatQuote,
): JSONContent {
  const content = normalizeTopLevelQuoteNodes(document);
  const last = content.at(-1);
  if (last?.type === 'paragraph') {
    content[content.length - 1] = paragraph([...(last.content ?? []), quoteNode(quote)]);
  } else {
    content.push(paragraph([quoteNode(quote)]));
  }
  return { type: 'doc', content };
}

/**
 * One-way compatibility lift for drafts created by the former separate quote
 * array. Historical quotes preceded the whole body, so preserve that order.
 */
export function prependLegacyQuotesToComposerDocument(
  document: JSONContent | null | undefined,
  quotes: readonly ChatQuote[],
): JSONContent | null {
  const body = normalizeTopLevelQuoteNodes(document);
  if (quotes.length === 0) {
    if (!document) return null;
    return { type: 'doc', content: body.length > 0 ? body : [paragraph()] };
  }
  const leadingQuotes = quotes.map(quoteNode);
  if (body[0]?.type === 'paragraph') {
    body[0] = paragraph([...leadingQuotes, ...(body[0].content ?? [])]);
  } else {
    body.unshift(paragraph(leadingQuotes));
  }
  return { type: 'doc', content: body };
}

/** Restore an encoded sent message into the same inline composer order. */
export function quoteSegmentsToComposerDocument(
  segments: readonly ChatQuoteSegment[],
): JSONContent | null {
  const content: JSONContent[] = [];
  let inlineContent: JSONContent[] = [];
  let hasContent = false;
  let quoteJustEnded = false;

  const finishParagraph = () => {
    content.push(paragraph(inlineContent));
    inlineContent = [];
  };

  for (const segment of segments) {
    if (segment.kind === 'quote') {
      inlineContent.push(quoteNode(segment.quote));
      hasContent = true;
      quoteJustEnded = true;
      continue;
    }
    if (!segment.text) continue;
    hasContent = true;
    if (isPureLineBreakText(segment.text)) {
      // parseChatQuoteSegments 用纯换行 text island 表达「两个 quote 块之间
      // 超出 Markdown 结构分隔的真实空行」。用 hardBreak 留在同一段内，
      // 避免 split 产生尾部空 paragraph，并让再次序列化能精确恢复数量。
      inlineContent.push(
        ...Array.from({ length: segment.text.length }, () => ({ type: 'hardBreak' })),
      );
      continue;
    }
    const lines = segment.text.split('\n');
    lines.forEach((line, index) => {
      if (quoteJustEnded && line && LIST_ROW_MARKER_RE.test(line) && inlineContent.length > 0) {
        finishParagraph();
      }
      if (line) inlineContent.push({ type: 'text', text: line });
      if (index < lines.length - 1) finishParagraph();
      if (line) quoteJustEnded = false;
    });
  }
  if (!hasContent) return null;
  finishParagraph();
  return { type: 'doc', content };
}

/** Restore an ↑/↓ history row without exposing private quote marker text. */
export function composerHistoryEntryToDocument(entry: ComposerHistoryEntry): JSONContent {
  if (entry.quotesEncoded === true) {
    const quotedDocument = quoteSegmentsToComposerDocument(parseChatQuoteSegments(entry.content));
    if (quotedDocument) return normalizeComposerDocumentJSON(quotedDocument);
  }
  return normalizeComposerDocumentJSON({
    type: 'doc',
    content: [paragraph(entry.content ? [{ type: 'text', text: entry.content }] : [])],
  });
}

/**
 * Composer semantic blocks → wire text. Quote 两侧通常各有一个 Markdown
 * 空行；两个 quote 之间的纯换行 text island 已经表示额外回车，只需共享
 * 一份结构分隔，不能在它两侧各补一次导致空行膨胀。
 */
export function serializeComposerContentBlocks(blocks: readonly ComposerSerializedBlock[]): string {
  return serializeComposerContentBlocksWithRanges(blocks).text;
}

/** Serialize blocks and project block-relative presentation ranges into wire offsets. */
export function serializeComposerContentBlocksWithRanges(
  blocks: readonly ComposerSerializedBlock[],
  options: { preserveTrailingWhitespace?: boolean } = {},
): {
  text: string;
  agentReferences: AgentInputReference[];
  pastedTextRanges: PastedTextRange[];
  slashCommandRanges: SlashCommandRange[];
} {
  let serialized = '';
  const agentReferences: AgentInputReference[] = [];
  const pastedTextRanges: PastedTextRange[] = [];
  const slashCommandRanges: SlashCommandRange[] = [];
  let previousKind: ComposerSerializedBlock['kind'] | null = null;
  let suppressNextSeparator = false;

  blocks.forEach((block, index) => {
    const previous = blocks[index - 1];
    const next = blocks[index + 1];
    const pureLineBreakIsland =
      block.kind === 'text' &&
      isPureLineBreakText(block.text) &&
      previous?.kind === 'quote' &&
      next?.kind === 'quote';
    if (pureLineBreakIsland) {
      serialized += `\n\n${block.text}`;
      suppressNextSeparator = true;
      previousKind = block.kind;
      return;
    }

    const separator =
      previousKind === null || suppressNextSeparator
        ? ''
        : previousKind === 'quote' || block.kind === 'quote'
          ? '\n\n'
          : '\n';
    serialized += separator;
    const blockStart = serialized.length;
    serialized += block.text;
    for (const reference of block.agentReferences ?? []) {
      agentReferences.push({
        ...reference,
        start: blockStart + reference.start,
        end: blockStart + reference.end,
      });
    }
    for (const range of block.pastedTextRanges ?? []) {
      pastedTextRanges.push({
        start: blockStart + range.start,
        end: blockStart + range.end,
        display: range.display,
      });
    }
    for (const range of block.slashCommandRanges ?? []) {
      slashCommandRanges.push({
        start: blockStart + range.start,
        end: blockStart + range.end,
      });
    }
    suppressNextSeparator = false;
    previousKind = block.kind;
  });

  const leadingTrim = serialized.length - serialized.trimStart().length;
  const text = options.preserveTrailingWhitespace ? serialized.trimStart() : serialized.trim();
  return {
    text,
    agentReferences: agentReferences
      .map((reference) => {
        const trimmed = trimRangeToText(reference, leadingTrim, text.length);
        return trimmed ? { ...reference, ...trimmed } : null;
      })
      .filter((reference): reference is AgentInputReference => reference !== null),
    pastedTextRanges: pastedTextRanges
      .map((range) => {
        const trimmed = trimRangeToText(range, leadingTrim, text.length);
        return trimmed ? { ...range, ...trimmed } : null;
      })
      .filter((range): range is PastedTextRange => range !== null),
    slashCommandRanges: slashCommandRanges
      .map((range) => trimRangeToText(range, leadingTrim, text.length))
      .filter((range): range is SlashCommandRange => range !== null),
  };
}
