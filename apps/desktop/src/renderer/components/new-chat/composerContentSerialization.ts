import type { Editor } from '@tiptap/core';
import { Fragment, Slice, type Node as ProseMirrorNode } from '@tiptap/pm/model';
import { EditorState } from '@tiptap/pm/state';
import type { AgentInputReference } from '@cindy/maker-shared/agent-input-projection';

import type { MentionedResource } from '@/lib/fileTypes';
import { formatQuoteForSend } from '@/lib/chatQuotes';
import { formatMentionRef } from '@/lib/mentionRefFormat';
import {
  parseProjectDeepLinkHref,
  parseSessionDeepLinkHref,
  projectDisplayName,
} from '@/lib/deepLink';
import {
  COMPOSER_QUOTE_NODE_TYPE,
  composerQuoteAttrsToChatQuote,
  serializeComposerContentBlocksWithRanges,
  type ComposerQuoteAttrs,
  type ComposerSerializedBlock,
} from '@/lib/composerQuoteDocument';
import type { PastedTextRange, SlashCommandRange } from '@/lib/imageRef';

import type { MentionChipAttrs } from './MentionChipNode';
import type { PastedTextChipAttrs } from './PastedTextChipNode';
import { getDecoratedSlashCommandMatches, type SlashCommandMatch } from './SlashCommandDecoration';
import { serializeSessionChipText } from './sessionLinkPaste';
import { serializeProjectChipText } from './pastePipeline';

export interface SerializedComposerContent {
  text: string;
  mentions: MentionedResource[];
  hasQuotes: boolean;
  agentReferences: AgentInputReference[];
  pastedTextRanges: PastedTextRange[];
  slashCommandRanges: SlashCommandRange[];
}

type OrderedMarker = '.' | ')' | '、';

const EMPTY_LIST_ITEM_MARKER_RE =
  /(?:^|\n)[ \t]*(?:[1-9]\d{0,8}[.)][ \t]+|[1-9]\d{0,8}、[ \t]*|[-+*•][ \t]+)$/;

const TAB_SIZE = 4;

function expandedIndentWidth(text: string): number {
  let column = 0;
  for (const character of text) {
    if (character === '\t') {
      column += TAB_SIZE - (column % TAB_SIZE);
    } else {
      column += 1;
    }
  }
  return column;
}

function literalListContinuationPrefix(text: string): string | null {
  const match =
    text.match(/^([ \t]+)(?:[-+*•]|[1-9]\d{0,8}[.)])([ \t]+)/) ??
    text.match(/^([ \t]+)[1-9]\d{0,8}、[ \t]*/);
  if (!match) return null;
  return ' '.repeat(expandedIndentWidth(match[0]));
}

function orderedListMarker(node: ProseMirrorNode): OrderedMarker {
  return node.attrs.marker === ')' || node.attrs.marker === '、' ? node.attrs.marker : '.';
}

function orderedListSeparator(node: ProseMirrorNode, marker: OrderedMarker): string {
  if (marker === '、') return '';
  return typeof node.attrs.separator === 'string' && /^[ \t]+$/.test(node.attrs.separator)
    ? node.attrs.separator
    : ' ';
}

function bulletListMarker(node: ProseMirrorNode): string {
  const marker = node.attrs.marker;
  return marker === '+' || marker === '*' || marker === '•' ? marker : '-';
}

function bulletListSeparator(node: ProseMirrorNode): string {
  return typeof node.attrs.separator === 'string' && /^[ \t]+$/.test(node.attrs.separator)
    ? node.attrs.separator
    : ' ';
}

/**
 * Convert the composer's structured document into the Markdown wire format.
 *
 * List markers are editor structure rather than paragraph text, so their
 * serialized width is included when projecting inline reference ranges.
 */
function serializeComposerDocument(
  doc: ProseMirrorNode,
  decoratedSlashMatches: readonly SlashCommandMatch[],
): SerializedComposerContent {
  const blocks: ComposerSerializedBlock[] = [];
  const mentions: MentionedResource[] = [];
  const seenMentions = new Set<string>();
  let hasQuotes = false;

  const addMention = (attrs: MentionChipAttrs) => {
    // Slash commands and deep links are represented in the wire text but are
    // not filesystem resources.
    if (attrs.kind === 'slash' || attrs.kind === 'session' || attrs.kind === 'project') return;
    const key = `${attrs.kind}:${attrs.path}`;
    if (seenMentions.has(key)) return;
    seenMentions.add(key);
    mentions.push({ type: attrs.kind, name: attrs.label, path: attrs.path });
  };

  const serializeParagraph = (
    paragraph: ProseMirrorNode,
    paragraphPosition: number,
    prefix = '',
    continuationIndent = '',
  ) => {
    let buffer = prefix;
    let bufferAgentReferences: AgentInputReference[] = [];
    let bufferPastedTextRanges: PastedTextRange[] = [];
    let bufferSlashCommandRanges: SlashCommandRange[] = [];
    let emittedInlineSegment = false;
    let continuationAfterQuote: string | null = null;

    const flushText = (force = false) => {
      if (!force && !buffer) return;
      blocks.push({
        kind: 'text',
        text: buffer,
        ...(bufferAgentReferences.length > 0 ? { agentReferences: bufferAgentReferences } : {}),
        ...(bufferPastedTextRanges.length > 0 ? { pastedTextRanges: bufferPastedTextRanges } : {}),
        ...(bufferSlashCommandRanges.length > 0
          ? { slashCommandRanges: bufferSlashCommandRanges }
          : {}),
      });
      buffer = '';
      bufferAgentReferences = [];
      bufferPastedTextRanges = [];
      bufferSlashCommandRanges = [];
      emittedInlineSegment = true;
    };

    const appendSlashCommandRanges = (
      matches: readonly SlashCommandMatch[],
      documentStart: number,
      textLength: number,
      bufferStart: number,
    ) => {
      for (const match of matches) {
        if (match.from < documentStart || match.to > documentStart + textLength) continue;
        bufferSlashCommandRanges.push({
          start: bufferStart + match.from - documentStart,
          end: bufferStart + match.to - documentStart,
        });
      }
    };

    paragraph.forEach((child, childOffset) => {
      if (child.type.name === COMPOSER_QUOTE_NODE_TYPE) {
        hasQuotes = true;
        const quoteText = formatQuoteForSend(
          composerQuoteAttrsToChatQuote(child.attrs as ComposerQuoteAttrs),
        );
        if (prefix || continuationIndent) {
          // A quote chip inside a list item is part of that item. Keeping it
          // in the current text block preserves the list marker. Put the
          // encoded quote on its own continuation lines so history parsing
          // can still recognize the private marker and source metadata.
          const continuationPrefix =
            continuationIndent || ' '.repeat(expandedIndentWidth(prefix));
          const quoteLines = quoteText.split('\n');
          const hasContinuationLine =
            continuationAfterQuote === null &&
            buffer.endsWith(`\n${continuationPrefix}`);
          const quoteSeparator =
            continuationAfterQuote !== null ? '\n\n' : hasContinuationLine ? '' : '\n';
          buffer += `${quoteSeparator}${quoteLines
            .map((line, index) =>
              hasContinuationLine && index === 0 ? line : `${continuationPrefix}${line}`,
            )
            .join('\n')}`;
          continuationAfterQuote = continuationPrefix;
        } else {
          flushText();
          blocks.push({ kind: 'quote', text: quoteText });
          emittedInlineSegment = true;
        }
        return;
      }

      if (continuationAfterQuote !== null) {
        if (child.type.name === 'hardBreak') {
          // The quote parser needs a blank-line boundary, while the hard
          // break itself still needs one indented continuation line. Emit
          // both together so we do not leave an indentation-only line
          // between two separately serialized breaks.
          buffer += `\n\n${continuationIndent}`;
          continuationAfterQuote = null;
          return;
        }
        const childText = child.isText
          ? (child.text ?? '')
          : child.type.name === 'pastedTextChip'
            ? String((child.attrs as PastedTextChipAttrs).text ?? '')
            : '';
        const alreadyIndented =
          child.isText && childText.startsWith(continuationAfterQuote);
        const textAfterIndent = alreadyIndented
          ? childText.slice(continuationAfterQuote.length)
          : childText;
        const needsQuoteBoundary = /^>(?:[ \t]|$)/.test(textAfterIndent);
        buffer += `${needsQuoteBoundary ? '\n\n' : '\n'}${
          alreadyIndented ? '' : continuationAfterQuote
        }`;
        continuationAfterQuote = null;
      }

      if (child.type.name === 'mentionChip') {
        const attrs = child.attrs as MentionChipAttrs;
        addMention(attrs);
        if (attrs.kind === 'slash') {
          buffer += `/${attrs.path} `;
          return;
        }
        if (attrs.kind === 'session') {
          const wire = serializeSessionChipText(attrs);
          const start = buffer.length;
          buffer += wire;
          const target = parseSessionDeepLinkHref(attrs.path);
          if (target?.messageClientId) {
            bufferAgentReferences.push({
              kind: 'message',
              start,
              end: buffer.length,
              href: attrs.path,
              sessionId: target.sessionId,
              messageClientId: target.messageClientId,
              ...(attrs.agentText ? { text: attrs.agentText } : {}),
              ...(attrs.agentTextTruncated ? { truncated: true } : {}),
            });
          } else if (target) {
            bufferAgentReferences.push({
              kind: 'session',
              start,
              end: buffer.length,
              href: attrs.path,
              sessionId: target.sessionId,
              ...(attrs.titled && attrs.label ? { title: attrs.label } : {}),
            });
          }
          return;
        }
        if (attrs.kind === 'project') {
          const wire = serializeProjectChipText(attrs);
          const start = buffer.length;
          buffer += wire;
          const target = parseProjectDeepLinkHref(attrs.path);
          if (target) {
            bufferAgentReferences.push({
              kind: 'project',
              start,
              end: buffer.length,
              href: attrs.path,
              name: attrs.label || projectDisplayName(target.workingDir),
              workingDir: target.workingDir,
            });
          }
          return;
        }
        if (attrs.kind === 'dir') {
          buffer += `@${formatMentionRef(`${attrs.path}/`)}`;
          return;
        }
        if (attrs.kind === 'agent') {
          const path = attrs.path;
          buffer += path.includes('/')
            ? `@${formatMentionRef(path)}`
            : `@${formatMentionRef(path.replace(/\.md$/, ''))}`;
          return;
        }
        buffer += `@${formatMentionRef(attrs.path)}`;
        return;
      }

      if (child.type.name === 'pastedTextChip') {
        const attrs = child.attrs as PastedTextChipAttrs;
        const start = buffer.length;
        buffer += continuationIndent
          ? attrs.text.replace(/\n/g, `\n${continuationIndent}`)
          : attrs.text;
        bufferPastedTextRanges.push({ start, end: buffer.length, display: attrs.display });
        return;
      }

      if (child.type.name === 'hardBreak') {
        buffer += `\n${continuationIndent}`;
        return;
      }

      if (child.isText) {
        const childText = child.text ?? '';
        const bufferStart = buffer.length;
        const documentStart = paragraphPosition + 1 + childOffset;
        buffer += childText;
        appendSlashCommandRanges(
          decoratedSlashMatches,
          documentStart,
          childText.length,
          bufferStart,
        );
      }
    });

    // Preserve truly empty paragraphs as line breaks, but do not synthesize an
    // empty text segment after a quote chip at the end of a paragraph.
    flushText(!emittedInlineSegment);
  };

  const serializeList = (listNode: ProseMirrorNode, listPosition: number, indent: string) => {
    const isOrdered = listNode.type.name === 'orderedList';
    const start =
      typeof listNode.attrs.start === 'number' &&
      Number.isInteger(listNode.attrs.start) &&
      listNode.attrs.start > 0
        ? listNode.attrs.start
        : 1;
    const marker = orderedListMarker(listNode);
    const separator = orderedListSeparator(listNode, marker);

    listNode.forEach((item, itemOffset, itemIndex) => {
      if (item.type.name !== 'listItem') return;
      const itemPosition = listPosition + 1 + itemOffset;
      const itemMarker = isOrdered
        ? `${start + itemIndex}${marker}${separator}`
        : `${bulletListMarker(listNode)}${bulletListSeparator(listNode)}`;
      const itemIndent = ' '.repeat(expandedIndentWidth(`${indent}${itemMarker}`));
      let firstParagraph = true;

      item.forEach((child, childOffset) => {
        const childPosition = itemPosition + 1 + childOffset;
        if (child.type.name === 'paragraph') {
          serializeParagraph(
            child,
            childPosition,
            firstParagraph ? `${indent}${itemMarker}` : itemIndent,
            itemIndent,
          );
          firstParagraph = false;
          return;
        }
        if (child.type.name === 'bulletList' || child.type.name === 'orderedList') {
          serializeList(child, childPosition, itemIndent);
        }
      });
    });
  };

  doc.forEach((node, nodeOffset, nodeIndex) => {
    if (node.type.name === COMPOSER_QUOTE_NODE_TYPE) {
      hasQuotes = true;
      blocks.push({
        kind: 'quote',
        text: formatQuoteForSend(composerQuoteAttrsToChatQuote(node.attrs as ComposerQuoteAttrs)),
      });
      return;
    }
    if (node.type.name === 'paragraph') {
      const onlyQuote =
        node.childCount === 1 && node.firstChild?.type.name === COMPOSER_QUOTE_NODE_TYPE;
      const previous = nodeIndex > 0 ? doc.child(nodeIndex - 1) : null;
      const literalContinuation =
        onlyQuote && previous?.type.name === 'paragraph'
          ? literalListContinuationPrefix(previous.textContent)
          : null;
      if (literalContinuation) {
        hasQuotes = true;
        const quoteText = formatQuoteForSend(
          composerQuoteAttrsToChatQuote(node.firstChild!.attrs as ComposerQuoteAttrs),
        );
        blocks.push({
          kind: 'text',
          text: quoteText
            .split('\n')
            .map((line) => `${literalContinuation}${line}`)
            .join('\n'),
        });
        return;
      }
      const inlineQuoteOffset = (() => {
        let offset = 0;
        for (let index = 0; index < node.childCount; index += 1) {
          const child = node.child(index);
          if (child.type.name === COMPOSER_QUOTE_NODE_TYPE) return offset;
          offset += child.nodeSize;
        }
        return null;
      })();
      const inlineLiteralContinuation =
        inlineQuoteOffset !== null
          ? literalListContinuationPrefix(
              node.textBetween(0, inlineQuoteOffset, '\n', '\uFFFC'),
            )
          : null;
      if (inlineLiteralContinuation) {
        serializeParagraph(node, nodeOffset, '', inlineLiteralContinuation);
        return;
      }
      serializeParagraph(node, nodeOffset);
      return;
    }
    if (node.type.name === 'bulletList' || node.type.name === 'orderedList') {
      serializeList(node, nodeOffset, '');
    }
  });

  const lastTextBlock = blocks.at(-1);
  const preserveTrailingWhitespace =
    lastTextBlock?.kind === 'text' && EMPTY_LIST_ITEM_MARKER_RE.test(lastTextBlock.text);
  return {
    ...serializeComposerContentBlocksWithRanges(blocks, { preserveTrailingWhitespace }),
    mentions,
    hasQuotes,
  };
}

export function serializeEditorContent(editor: Editor): SerializedComposerContent {
  return serializeComposerDocument(editor.state.doc, getDecoratedSlashCommandMatches(editor));
}

/**
 * Serialize a selected editor fragment for plain-text clipboard consumers.
 * Replacing an empty document with the open slice lets ProseMirror retain
 * surrounding structure; ordered-list context is rebuilt below when an
 * inline-only slice omits it.
 */
export function serializeEditorSlice(editor: Editor | null, slice: Slice): string {
  if (!editor) {
    return slice.content.textBetween(0, slice.content.size, '\n');
  }

  try {
    const emptyDoc = editor.state.schema.topNodeType.createAndFill();
    if (!emptyDoc) throw new Error('composer schema cannot create an empty document');
    const state = EditorState.create({ schema: editor.state.schema, doc: emptyDoc });
    const { $from } = editor.state.selection;
    let sourceList: ProseMirrorNode | null = null;
    let sourceListDepth: number | null = null;
    for (let depth = $from.depth; depth > 0; depth -= 1) {
      const list = $from.node(depth);
      if (list.type.name !== 'orderedList') continue;
      sourceList = list;
      sourceListDepth = depth;
      break;
    }
    let replaced = state.tr.replace(0, state.doc.content.size, slice).doc;
    const sourceIndex = sourceListDepth === null ? null : $from.index(sourceListDepth);
    const findFirstOrderedList = (
      document: ProseMirrorNode,
    ): { node: ProseMirrorNode; position: number } | null => {
      let found: { node: ProseMirrorNode; position: number } | null = null;
      document.descendants((node, position) => {
        if (found === null && node.type.name === 'orderedList') {
          found = { node, position };
          return false;
        }
        return found === null;
      });
      return found;
    };
    let firstOrderedList = findFirstOrderedList(replaced);

    // A text-only slice from inside a list item loses the enclosing list.
    // Rebuild the selected source items so plain-text copies keep their marker.
    if (sourceList && sourceIndex !== null && firstOrderedList === null) {
      const itemType = editor.state.schema.nodes.listItem;
      if (itemType?.validContent(replaced.content)) {
        const copiedItem = itemType.create(null, replaced.content);
        const copiedList = sourceList.copy(Fragment.from(copiedItem));
        replaced = state.tr.replace(
          0,
          state.doc.content.size,
          new Slice(Fragment.from(copiedList), 0, 0),
        ).doc;
        firstOrderedList = findFirstOrderedList(replaced);
      }
    }

    // A partial selection keeps the source list's attrs but may omit earlier
    // siblings. Shift the copied ordered-list start to the selected item.
    const copiedStart =
      sourceList && sourceIndex !== null
        ? Number(sourceList.attrs.start) + sourceIndex
        : null;
    if (copiedStart !== null) {
      let firstContentPosition: number | null = null;
      replaced.descendants((node, position) => {
        if (firstContentPosition === null && (node.isText || node.isAtom)) {
          firstContentPosition = position;
          return false;
        }
        return firstContentPosition === null;
      });
      let orderedListPosition: number | null = firstContentPosition === null
        ? firstOrderedList?.position ?? null
        : null;
      if (firstContentPosition !== null) {
        const $firstContent = replaced.resolve(firstContentPosition);
        for (let depth = $firstContent.depth; depth > 0; depth -= 1) {
          if ($firstContent.node(depth).type.name !== 'orderedList') continue;
          orderedListPosition = $firstContent.before(depth);
          break;
        }
      }
      if (orderedListPosition !== null) {
        const node = replaced.nodeAt(orderedListPosition);
        if (node) {
          const replacedState = EditorState.create({ schema: editor.state.schema, doc: replaced });
          replaced = replacedState.tr
            .setNodeMarkup(orderedListPosition, node.type, {
              ...node.attrs,
              start: copiedStart,
            })
            .doc;
        }
      }
    }
    return serializeComposerDocument(replaced, []).text;
  } catch {
    return slice.content.textBetween(0, slice.content.size, '\n');
  }
}
