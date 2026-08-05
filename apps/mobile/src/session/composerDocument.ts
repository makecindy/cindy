/**
 * Mobile composer semantic document.
 *
 * Text remains directly editable. References and long pasted text are atomic
 * nodes whose wire value is independent from the compact label shown in the
 * editor. Keeping this module free of React/WebView code makes draft
 * persistence, fork/rewind restoration and send serialization deterministic.
 */
import {
  boundAgentReferenceText,
  type AgentInputReference,
} from '@cindy/maker-shared/agent-input-projection';
import {
  formatQuoteForSend,
  parseChatQuoteSegments,
  type ChatQuote,
} from '@cindy/maker-shared/chat-quotes';
import { serializeAtResource, type ComposerAtResourceItem } from '@cindy/maker-shared/composer-palette';
import { parseProjectDeepLinkUrl, parseSessionDeepLinkUrl } from '@/session/sessionLinks';
import {
  buildSentInlineTokens,
  locateChatQuoteTextSegmentStarts,
  projectSentRanges,
  type SentInlineToken,
} from '@/session/sentMessageAtoms';

export const MOBILE_LONG_PASTE_LINE_THRESHOLD = 24;
export const MOBILE_LONG_PASTE_CHAR_THRESHOLD = 4_000;
export const MOBILE_LONG_PASTE_MAX_CHARS = 2_000_000;

export interface ComposerTextNode {
  type: 'text';
  text: string;
  /** Selected slash commands are styled marks, never atomic nodes. */
  slashCommand?: string;
}

export interface ComposerQuoteNode {
  type: 'quote';
  quote: ChatQuote;
}

export interface ComposerMentionNode {
  type: 'mention';
  kind: ComposerAtResourceItem['type'] | 'project';
  label: string;
  raw: string;
  /** Project references retain their decoded semantic location beside `raw`. */
  href?: string;
  workingDir?: string;
}

export interface ComposerSessionLinkNode {
  type: 'session-link';
  href: string;
  label: string;
  titled?: boolean;
  messageClientId?: string;
  /** Readable target body; never used as the compact chip label. */
  agentText?: string;
  agentTextTruncated?: boolean;
}

/** Async semantic data resolved for one pasted session/message deep link. */
export interface ResolvedSessionLinkSemantic {
  label: string;
  agentText?: string;
  agentTextTruncated?: boolean;
}

export type ResolveSessionLinkSemantic = (
  href: string,
) => Promise<ResolvedSessionLinkSemantic | null>;

export interface ComposerPastedTextNode {
  type: 'pasted-text';
  text: string;
  display: string;
}

export type ComposerNode =
  | ComposerTextNode
  | ComposerQuoteNode
  | ComposerMentionNode
  | ComposerSessionLinkNode
  | ComposerPastedTextNode;

export interface ComposerDocument {
  version: 1;
  nodes: ComposerNode[];
}

export interface ComposerPastedTextRange {
  start: number;
  end: number;
  display: string;
}

export interface ComposerSlashCommandRange {
  start: number;
  end: number;
}

export interface SerializedComposerDocument {
  text: string;
  quotesEncoded: boolean;
  agentReferences: AgentInputReference[];
  pastedTextRanges: ComposerPastedTextRange[];
  slashCommandRanges: ComposerSlashCommandRange[];
}

export function emptyComposerDocument(): ComposerDocument {
  return { version: 1, nodes: [] };
}

export function textComposerDocument(text: string): ComposerDocument {
  return normalizeComposerDocument({
    version: 1,
    nodes: text ? [{ type: 'text', text }] : [],
  });
}

/** Merge adjacent compatible text runs and discard malformed/empty nodes. */
export function normalizeComposerDocument(document: ComposerDocument): ComposerDocument {
  const nodes: ComposerNode[] = [];
  for (const candidate of document.nodes) {
    const node = normalizeNode(candidate);
    if (!node) continue;
    const previous = nodes.at(-1);
    if (
      node.type === 'text'
      && previous?.type === 'text'
      && previous.slashCommand === node.slashCommand
    ) {
      previous.text += node.text;
    } else {
      nodes.push(node);
    }
  }
  return { version: 1, nodes };
}

/** Structural equality without depending on object property insertion order. */
export function composerDocumentsEqual(
  leftDocument: ComposerDocument,
  rightDocument: ComposerDocument,
): boolean {
  const left = normalizeComposerDocument(leftDocument).nodes;
  const right = normalizeComposerDocument(rightDocument).nodes;
  if (left.length !== right.length) return false;
  return left.every((node, index) => {
    const candidate = right[index];
    if (!candidate || node.type !== candidate.type) return false;
    if (node.type === 'text' && candidate.type === 'text') {
      return node.text === candidate.text && node.slashCommand === candidate.slashCommand;
    }
    if (node.type === 'quote' && candidate.type === 'quote') {
      return node.quote.text === candidate.quote.text
        && node.quote.sourcePath === candidate.quote.sourcePath
        && node.quote.startLine === candidate.quote.startLine
        && node.quote.endLine === candidate.quote.endLine;
    }
    if (node.type === 'mention' && candidate.type === 'mention') {
      return node.kind === candidate.kind
        && node.label === candidate.label
        && node.raw === candidate.raw
        && node.href === candidate.href
        && node.workingDir === candidate.workingDir;
    }
    if (node.type === 'session-link' && candidate.type === 'session-link') {
      return node.href === candidate.href
        && node.label === candidate.label
        && node.titled === candidate.titled
        && node.messageClientId === candidate.messageClientId
        && node.agentText === candidate.agentText
        && node.agentTextTruncated === candidate.agentTextTruncated;
    }
    return node.type === 'pasted-text'
      && candidate.type === 'pasted-text'
      && node.text === candidate.text
      && node.display === candidate.display;
  });
}

/** Visible editable projection. Quote atoms intentionally contribute no text. */
export function composerDocumentProjectedText(document: ComposerDocument): string {
  return document.nodes.map((node) => {
    switch (node.type) {
      case 'text':
      case 'pasted-text':
        return node.text;
      case 'mention':
        return node.raw;
      case 'session-link':
        return serializeSessionLink(node);
      case 'quote':
        return '';
    }
  }).join('');
}

export function composerDocumentHasContent(document: ComposerDocument): boolean {
  return document.nodes.some((node) => (
    node.type === 'quote'
      || (node.type === 'pasted-text' ? node.text.length > 0 : composerNodeWireText(node).trim().length > 0)
  ));
}

/** Apply a plain-text producer (voice, queue restore) without discarding atoms outside its edit. */
export function reconcileComposerProjectedText(
  document: ComposerDocument,
  nextText: string,
): ComposerDocument {
  if (!nextText) return emptyComposerDocument();
  const previousText = composerDocumentProjectedText(document);
  if (previousText === nextText) return document;
  let prefix = 0;
  while (
    prefix < previousText.length
    && prefix < nextText.length
    && previousText[prefix] === nextText[prefix]
  ) prefix += 1;
  let suffix = 0;
  while (
    suffix < previousText.length - prefix
    && suffix < nextText.length - prefix
    && previousText[previousText.length - 1 - suffix] === nextText[nextText.length - 1 - suffix]
  ) suffix += 1;
  const replacement = nextText.slice(prefix, nextText.length - suffix);
  return replaceComposerTextRange(
    document,
    prefix,
    previousText.length - suffix,
    replacement ? [{ type: 'text', text: replacement }] : [],
  );
}

export function composerDocumentQuotes(document: ComposerDocument): ChatQuote[] {
  return document.nodes.flatMap((node) => (node.type === 'quote' ? [node.quote] : []));
}

export function appendComposerNode(
  document: ComposerDocument,
  node: ComposerNode,
): ComposerDocument {
  return normalizeComposerDocument({ version: 1, nodes: [...document.nodes, node] });
}

export function prependComposerNodes(
  document: ComposerDocument,
  nodes: readonly ComposerNode[],
): ComposerDocument {
  return normalizeComposerDocument({ version: 1, nodes: [...nodes, ...document.nodes] });
}

export function removeComposerNode(document: ComposerDocument, index: number): ComposerDocument {
  if (!Number.isInteger(index) || index < 0 || index >= document.nodes.length) return document;
  return normalizeComposerDocument({
    version: 1,
    nodes: document.nodes.filter((_, candidate) => candidate !== index),
  });
}

/** Replace a range in the projected wire text while preserving surrounding atoms. */
export function replaceComposerTextRange(
  document: ComposerDocument,
  from: number,
  to: number,
  replacement: readonly ComposerNode[],
): ComposerDocument {
  const start = Math.max(0, Math.min(from, to));
  const end = Math.max(start, Math.max(from, to));
  const before: ComposerNode[] = [];
  const after: ComposerNode[] = [];
  let offset = 0;

  for (const node of document.nodes) {
    const text = composerNodeProjectedText(node);
    const nodeStart = offset;
    const nodeEnd = nodeStart + text.length;
    offset = nodeEnd;

    if (nodeEnd <= start) {
      before.push(node);
      continue;
    }
    if (nodeStart >= end) {
      after.push(node);
      continue;
    }

    // Trigger replacement only splits editable text. Atom deletion is handled
    // by the editor's node-selection path because quote atoms have no projected
    // text and other atoms are never partially selectable.
    if (node.type === 'text') {
      const localStart = Math.max(0, start - nodeStart);
      const localEnd = Math.min(text.length, end - nodeStart);
      if (localStart > 0) before.push({ ...node, text: text.slice(0, localStart) });
      if (localEnd < text.length) after.unshift({ ...node, text: text.slice(localEnd) });
    }
  }

  if (start >= offset) before.push(...document.nodes.slice(before.length));
  return normalizeComposerDocument({ version: 1, nodes: [...before, ...replacement, ...after] });
}

export function mentionComposerNode(
  item: Pick<ComposerAtResourceItem, 'type' | 'relPath'> & { name?: string },
): ComposerMentionNode {
  return {
    type: 'mention',
    kind: item.type,
    label: item.name || item.relPath,
    raw: serializeAtResource(item),
  };
}

export function slashCommandTextNode(commandName: string): ComposerTextNode {
  const value = `/${commandName}`;
  return { type: 'text', text: value, slashCommand: value };
}

export function sessionLinkComposerNode(input: {
  href: string;
  label: string;
  titled?: boolean;
  agentText?: string;
  agentTextTruncated?: boolean;
}): ComposerSessionLinkNode {
  const target = parseSessionDeepLinkUrl(input.href);
  const bounded = input.agentText ? boundAgentReferenceText(input.agentText) : null;
  return {
    type: 'session-link',
    href: input.href,
    label: input.label,
    titled: input.titled,
    ...(target?.messageClientId ? { messageClientId: target.messageClientId } : {}),
    ...(bounded?.text ? { agentText: bounded.text } : {}),
    ...((input.agentTextTruncated === true || bounded?.truncated === true)
      ? { agentTextTruncated: true }
      : {}),
  };
}

/**
 * Message chips can arrive from a pasted deep link before their readable body
 * has finished loading from the source device. Resolve every missing body
 * before serializing a send so an immediate tap cannot degrade the semantic
 * reference to the deep link alone.
 */
export async function hydrateComposerMessageReferenceBodies(
  document: ComposerDocument,
  resolve: ResolveSessionLinkSemantic,
): Promise<ComposerDocument> {
  const hrefs = [...new Set(document.nodes.flatMap((node) => (
    node.type === 'session-link' && node.messageClientId && !node.agentText
      ? [node.href]
      : []
  )))];
  if (hrefs.length === 0) return document;

  const resolved = new Map<string, ResolvedSessionLinkSemantic>();
  await Promise.all(hrefs.map(async (href) => {
    try {
      const semantic = await resolve(href);
      if (semantic) resolved.set(href, semantic);
    } catch {
      // Keep the stable deep-link identity when the source device is unavailable.
    }
  }));
  if (resolved.size === 0) return document;

  return normalizeComposerDocument({
    version: 1,
    nodes: document.nodes.map((node) => {
      if (node.type !== 'session-link' || node.agentText) return node;
      const semantic = resolved.get(node.href);
      if (!semantic) return node;
      return sessionLinkComposerNode({
        ...node,
        label: semantic.label,
        titled: true,
        ...(semantic.agentText ? { agentText: semantic.agentText } : {}),
        ...(semantic.agentTextTruncated ? { agentTextTruncated: true } : {}),
      });
    }),
  });
}

export function pastedTextComposerNode(text: string): ComposerPastedTextNode {
  const lineCount = text.length === 0 ? 0 : text.split('\n').length;
  return {
    type: 'pasted-text',
    text,
    display: `Pasted text (${lineCount} ${lineCount === 1 ? 'line' : 'lines'})`,
  };
}

export function isLongComposerPaste(text: string): boolean {
  if (text.length > MOBILE_LONG_PASTE_MAX_CHARS) return true;
  if (text.length >= MOBILE_LONG_PASTE_CHAR_THRESHOLD) return true;
  let lines = 1;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10 && ++lines >= MOBILE_LONG_PASTE_LINE_THRESHOLD) return true;
  }
  return false;
}

/** Restore a sent quotesEncoded body into its original quote/text order. */
export function composerDocumentFromEncodedMessage(content: string): ComposerDocument {
  return normalizeComposerDocument({
    version: 1,
    nodes: parseChatQuoteSegments(content).flatMap<ComposerNode>((segment) => (
      segment.kind === 'quote'
        ? [{ type: 'quote', quote: segment.quote }]
        : segment.text ? [{ type: 'text', text: segment.text }] : []
    )),
  });
}

/** Restore all persisted composer presentation metadata into semantic nodes. */
export function composerDocumentFromSerializedMessage(
  content: string,
  options: {
    quotesEncoded?: boolean;
    agentReferences?: readonly AgentInputReference[];
    pastedTextRanges?: readonly ComposerPastedTextRange[];
    slashCommandRanges?: readonly ComposerSlashCommandRange[];
  } = {},
): ComposerDocument {
  const segments = options.quotesEncoded === true
    ? parseChatQuoteSegments(content)
    : [{ kind: 'text' as const, text: content }];
  const starts = locateChatQuoteTextSegmentStarts(content, segments);
  const nodes: ComposerNode[] = [];
  segments.forEach((segment, index) => {
    if (segment.kind === 'quote') {
      nodes.push({ type: 'quote', quote: segment.quote });
      return;
    }
    const sourceStart = starts[index];
    const pastedTextRanges = projectSentRanges(
      options.pastedTextRanges ?? [],
      sourceStart,
      segment.text.length,
    );
    const slashCommandRanges = projectSentRanges(
      options.slashCommandRanges ?? [],
      sourceStart,
      segment.text.length,
    );
    const agentReferences = projectSentRanges(
      options.agentReferences ?? [],
      sourceStart,
      segment.text.length,
    );
    nodes.push(...composerNodesFromTextSegment(
      segment.text,
      pastedTextRanges,
      slashCommandRanges,
      agentReferences,
    ));
  });
  return normalizeComposerDocument({ version: 1, nodes });
}

/** One-way lift for the former `draft string + quote[]` persistence shape. */
export function migrateLegacyComposerDraft(
  text: string | null | undefined,
  quotes: readonly ChatQuote[],
  orderedBody?: string | null,
): ComposerDocument {
  if (orderedBody && quotes.length > 0) return composerDocumentFromEncodedMessage(orderedBody);
  return normalizeComposerDocument({
    version: 1,
    nodes: [
      ...quotes.map<ComposerQuoteNode>((quote) => ({ type: 'quote', quote })),
      ...(text ? [{ type: 'text' as const, text }] : []),
    ],
  });
}

export function serializeComposerDocument(document: ComposerDocument): SerializedComposerDocument {
  let serialized = '';
  let previous: ComposerNode | null = null;
  const pastedTextRanges: ComposerPastedTextRange[] = [];
  const slashCommandRanges: ComposerSlashCommandRange[] = [];
  const agentReferences: AgentInputReference[] = [];
  let quotesEncoded = false;

  for (const node of normalizeComposerDocument(document).nodes) {
    const wire = composerNodeWireText(node);
    if (!wire) continue;
    const separator = previous && (previous.type === 'quote' || node.type === 'quote') ? '\n\n' : '';
    serialized += separator;
    const start = serialized.length;
    serialized += wire;
    if (node.type === 'session-link') {
      const target = parseSessionDeepLinkUrl(node.href);
      if (target?.messageClientId) {
        agentReferences.push({
          kind: 'message',
          start,
          end: start + wire.length,
          href: node.href,
          sessionId: target.sessionId,
          messageClientId: target.messageClientId,
          ...(node.agentText ? { text: node.agentText } : {}),
          ...(node.agentTextTruncated ? { truncated: true } : {}),
        });
      } else if (target) {
        agentReferences.push({
          kind: 'session',
          start,
          end: start + wire.length,
          href: node.href,
          sessionId: target.sessionId,
          ...(node.titled && node.label ? { title: node.label } : {}),
        });
      }
    } else if (
      node.type === 'mention'
      && node.kind === 'project'
      && node.href
      && node.workingDir
    ) {
      agentReferences.push({
        kind: 'project',
        start,
        end: start + wire.length,
        href: node.href,
        name: node.label,
        workingDir: node.workingDir,
      });
    }
    if (node.type === 'quote') quotesEncoded = true;
    if (node.type === 'pasted-text') {
      pastedTextRanges.push({ start, end: start + wire.length, display: node.display });
    }
    if (node.type === 'text' && node.slashCommand === node.text) {
      slashCommandRanges.push({ start, end: start + wire.length });
    }
    previous = node;
  }

  const leadingTrim = serialized.length - serialized.trimStart().length;
  const text = serialized.trim();
  const trimRange = <T extends { start: number; end: number }>(range: T): T | null => {
    const start = Math.max(0, range.start - leadingTrim);
    const end = Math.min(text.length, range.end - leadingTrim);
    return start < end ? { ...range, start, end } : null;
  };
  return {
    text,
    quotesEncoded,
    agentReferences: agentReferences.map(trimRange).filter((reference): reference is AgentInputReference => !!reference),
    pastedTextRanges: pastedTextRanges.map(trimRange).filter((range): range is ComposerPastedTextRange => !!range),
    slashCommandRanges: slashCommandRanges.map(trimRange).filter((range): range is ComposerSlashCommandRange => !!range),
  };
}

export function parseStoredComposerDocument(value: unknown): ComposerDocument | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as { version?: unknown; nodes?: unknown };
  if (candidate.version !== 1 || !Array.isArray(candidate.nodes)) return null;
  return normalizeComposerDocument({ version: 1, nodes: candidate.nodes as ComposerNode[] });
}

function serializeSessionLink(node: ComposerSessionLinkNode): string {
  if (node.messageClientId) return node.href;
  const safeLabel = sanitizeComposerLinkLabel(node.label);
  return node.titled && safeLabel ? `[${safeLabel}](${node.href})` : node.href;
}

export function sanitizeComposerLinkLabel(label: string): string {
  return label.replace(/[[\]]/g, ' ').replace(/@/g, '＠').replace(/\s+/g, ' ').trim();
}

function composerNodeFromSentToken(token: SentInlineToken): ComposerNode {
  if (token.kind === 'quote') {
    return { type: 'quote', quote: token.quote };
  }
  if (token.kind === 'pasted') {
    return { type: 'pasted-text', text: token.text, display: token.display };
  }
  if (token.kind === 'slash') {
    return { type: 'text', text: token.text, slashCommand: token.text };
  }
  return { type: 'text', text: token.text };
}

function compactReferenceLabel(value: string): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length <= 240 ? compact : `${compact.slice(0, 239)}…`;
}

function composerNodeFromAgentReference(
  reference: AgentInputReference,
  raw: string,
): ComposerNode {
  if (reference.kind === 'message') {
    return sessionLinkComposerNode({
      href: reference.href,
      label: compactReferenceLabel(reference.text || reference.messageClientId),
      titled: Boolean(reference.text),
      ...(reference.text ? { agentText: reference.text } : {}),
      ...(reference.truncated ? { agentTextTruncated: true } : {}),
    });
  }
  if (reference.kind === 'session') {
    return sessionLinkComposerNode({
      href: reference.href,
      label: reference.title || reference.sessionId,
      titled: Boolean(reference.title),
    });
  }
  return {
    type: 'mention',
    kind: 'project',
    label: reference.name,
    raw,
    href: reference.href,
    workingDir: reference.workingDir,
  };
}

function composerNodesFromTextSegment(
  text: string,
  pastedTextRanges: readonly ComposerPastedTextRange[],
  slashCommandRanges: readonly ComposerSlashCommandRange[],
  agentReferences: readonly AgentInputReference[],
): ComposerNode[] {
  if (agentReferences.length === 0) {
    return buildSentInlineTokens(text, pastedTextRanges, slashCommandRanges)
      .map(composerNodeFromSentToken);
  }
  const nodes: ComposerNode[] = [];
  let cursor = 0;
  for (const reference of agentReferences) {
    if (reference.start > cursor) {
      const prefix = text.slice(cursor, reference.start);
      nodes.push(...buildSentInlineTokens(
        prefix,
        projectSentRanges(pastedTextRanges, cursor, prefix.length),
        projectSentRanges(slashCommandRanges, cursor, prefix.length),
      ).map(composerNodeFromSentToken));
    }
    nodes.push(composerNodeFromAgentReference(
      reference,
      text.slice(reference.start, reference.end),
    ));
    cursor = reference.end;
  }
  if (cursor < text.length) {
    const suffix = text.slice(cursor);
    nodes.push(...buildSentInlineTokens(
      suffix,
      projectSentRanges(pastedTextRanges, cursor, suffix.length),
      projectSentRanges(slashCommandRanges, cursor, suffix.length),
    ).map(composerNodeFromSentToken));
  }
  return nodes;
}

function composerNodeWireText(node: ComposerNode): string {
  switch (node.type) {
    case 'text':
    case 'pasted-text':
      return node.text;
    case 'quote':
      return formatQuoteForSend(node.quote);
    case 'mention':
      return node.raw;
    case 'session-link':
      return serializeSessionLink(node);
  }
}

function composerNodeProjectedText(node: ComposerNode): string {
  if (node.type === 'quote') return '';
  return composerNodeWireText(node);
}

function normalizeNode(node: ComposerNode): ComposerNode | null {
  if (!node || typeof node !== 'object' || typeof node.type !== 'string') return null;
  if (node.type === 'text') {
    if (typeof node.text !== 'string' || node.text.length === 0) return null;
    return {
      type: 'text',
      text: node.text,
      ...(typeof node.slashCommand === 'string' && node.slashCommand === node.text
        ? { slashCommand: node.slashCommand }
        : {}),
    };
  }
  if (node.type === 'quote') {
    const quote = normalizeQuote(node.quote);
    return quote ? { type: 'quote', quote } : null;
  }
  if (node.type === 'mention') {
    if (
      typeof node.kind !== 'string'
      || !['file', 'dir', 'agent', 'project'].includes(node.kind)
      || typeof node.raw !== 'string'
      || !node.raw
      || typeof node.label !== 'string'
      || !node.label
    ) return null;
    if (node.kind === 'project') {
      const legacyMarkdownHref = node.raw.startsWith('[') && node.raw.endsWith(')')
        ? node.raw.slice(node.raw.lastIndexOf('](') + 2, -1)
        : node.raw;
      const href = typeof node.href === 'string' && node.href ? node.href : legacyMarkdownHref;
      const parsed = parseProjectDeepLinkUrl(href);
      if (!parsed) return null;
      return {
        type: 'mention',
        kind: 'project',
        raw: node.raw,
        label: node.label,
        href,
        workingDir: parsed.workingDir,
      };
    }
    return { type: 'mention', kind: node.kind, raw: node.raw, label: node.label };
  }
  if (node.type === 'session-link') {
    if (
      typeof node.href !== 'string'
      || !node.href
      || typeof node.label !== 'string'
      || !node.label
      || (node.titled !== undefined && typeof node.titled !== 'boolean')
      || (node.messageClientId !== undefined && typeof node.messageClientId !== 'string')
      || (node.agentText !== undefined && typeof node.agentText !== 'string')
      || (
        node.agentTextTruncated !== undefined
        && typeof node.agentTextTruncated !== 'boolean'
      )
      || !parseSessionDeepLinkUrl(node.href)
    ) return null;
    return sessionLinkComposerNode(node);
  }
  if (node.type === 'pasted-text') {
    if (
      typeof node.text !== 'string'
      || !node.text
      || typeof node.display !== 'string'
      || !node.display
    ) return null;
    return { type: 'pasted-text', text: node.text, display: node.display };
  }
  return null;
}

function normalizeQuote(value: unknown): ChatQuote | null {
  if (!value || typeof value !== 'object') return null;
  const quote = value as {
    text?: unknown;
    sourcePath?: unknown;
    startLine?: unknown;
    endLine?: unknown;
  };
  if (typeof quote.text !== 'string' || !quote.text) return null;
  if (quote.sourcePath !== undefined && typeof quote.sourcePath !== 'string') return null;
  if (quote.startLine !== undefined && !isPositiveLine(quote.startLine)) return null;
  if (quote.endLine !== undefined && !isPositiveLine(quote.endLine)) return null;
  if ((quote.startLine !== undefined || quote.endLine !== undefined) && !quote.sourcePath) return null;
  if (quote.endLine !== undefined && quote.startLine === undefined) return null;
  if (
    typeof quote.startLine === 'number'
    && typeof quote.endLine === 'number'
    && quote.endLine < quote.startLine
  ) return null;
  return {
    text: quote.text,
    ...(quote.sourcePath !== undefined ? { sourcePath: quote.sourcePath } : {}),
    ...(typeof quote.startLine === 'number' ? { startLine: quote.startLine } : {}),
    ...(typeof quote.endLine === 'number' ? { endLine: quote.endLine } : {}),
  };
}

function isPositiveLine(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
