import { readAgentInputReferences } from '@cindy/maker-shared/agent-input-projection';
import type { JSONContent } from '@tiptap/core';

import type { ComposerDraft } from '@/lib/composerDraftStore';
import { formatQuoteForSend, parseChatQuoteSegments, type ChatQuoteSegment } from '@/lib/chatQuotes';
import { COMPOSER_QUOTE_NODE_TYPE } from '@/lib/composerQuoteDocument';
import { normalizeComposerDocumentJSON } from '@/lib/composerListDocument';
import { extractExt, getMimeType, type AttachedFile } from '@/lib/fileTypes';
import type { QueuedMessage, QueueItemContentUpdate } from '@/lib/makerChatStore';
import { rebaseInlineRangesAfterSlashCommandRewrite } from '@/lib/slashCommands';
import { formatMentionRef } from '@/lib/mentionRefFormat';
import type { AgentInputMention, AgentInputReference } from '../../shared/agentInputQueue';

export interface QueueComposerEditDraft {
  draftKey: string;
  draft: ComposerDraft;
  originalAttachmentIds: string[];
}

export interface QueueComposerEditState {
  sessionId: string;
  clientId: string;
  draftKey: string;
  originalAttachmentIds: string[];
}

export function rebaseQueueComposerEditContentAfterSlashCommandRewrite<
  T extends QueueItemContentUpdate['content'],
>(content: T, rewrittenText: string): T {
  if (rewrittenText === content.text) return content;
  return {
    ...content,
    text: rewrittenText,
    agentReferences: rebaseInlineRangesAfterSlashCommandRewrite(
      content.agentReferences,
      content.text,
      rewrittenText,
    ),
    pastedTextRanges: rebaseInlineRangesAfterSlashCommandRewrite(
      content.pastedTextRanges,
      content.text,
      rewrittenText,
    ),
    slashCommandRanges: rebaseInlineRangesAfterSlashCommandRewrite(
      content.slashCommandRanges,
      content.text,
      rewrittenText,
    ),
  };
}

export function isQueueComposerEditCurrent(
  current: QueueComposerEditState | null,
  sessionId: string | undefined,
  candidate: QueueComposerEditState,
): boolean {
  return (
    sessionId === candidate.sessionId &&
    current?.sessionId === candidate.sessionId &&
    current.clientId === candidate.clientId &&
    current.draftKey === candidate.draftKey
  );
}

export function queueComposerEditDraftKey(sessionId: string, clientId: string): string {
  return `queue-edit:${sessionId}:${clientId}`;
}

interface InlineReplacement {
  start: number;
  end: number;
  node: JSONContent;
  priority: number;
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function agentReferenceNode(reference: AgentInputReference, sourceText: string): JSONContent {
  const titled = sourceText.startsWith('[');
  if (reference.kind === 'message') {
    return {
      type: 'mentionChip',
      attrs: {
        kind: 'session',
        label: oneLine(reference.text ?? '') || reference.messageClientId,
        path: reference.href,
        titled: false,
        ...(reference.text ? { agentText: reference.text } : {}),
        ...(reference.truncated ? { agentTextTruncated: true } : {}),
      },
    };
  }
  if (reference.kind === 'session') {
    return {
      type: 'mentionChip',
      attrs: {
        kind: 'session',
        label: oneLine(reference.title ?? '') || reference.sessionId,
        path: reference.href,
        titled,
      },
    };
  }
  if (reference.kind === 'project') {
    return {
      type: 'mentionChip',
      attrs: {
        kind: 'project',
        label: oneLine(reference.name) || reference.workingDir,
        path: reference.href,
        titled,
      },
    };
  }
  if (reference.kind === 'browser-tab') {
    return {
      type: 'mentionChip',
      attrs: {
        kind: 'browser-tab',
        label: oneLine(reference.title ?? '') || reference.url,
        path: reference.href,
      },
    };
  }
  if (reference.kind === 'desktop-window') {
    return {
      type: 'mentionChip',
      attrs: {
        kind: 'desktop-window',
        label: oneLine(reference.title ?? '') || oneLine(reference.appName),
        path: reference.href,
      },
    };
  }
  if (reference.kind === 'plugin-resource') {
    return {
      type: 'mentionChip',
      attrs: {
        kind: 'plugin-resource',
        label: reference.label,
        path: reference.href,
        sourceLabel: reference.pluginName,
        ...(reference.description ? { sourceDescription: reference.description } : {}),
      },
    };
  }
  return {
    type: 'mentionChip',
    attrs: { kind: 'bot', label: reference.name, path: reference.botId },
  };
}

function mentionWireText(mention: AgentInputMention): string {
  if (mention.type === 'dir') return `@${formatMentionRef(`${mention.path}/`)}`;
  if (mention.type === 'agent') {
    const path = mention.path.includes('/')
      ? mention.path
      : mention.path.replace(/\.md$/, '');
    return `@${formatMentionRef(path)}`;
  }
  return `@${formatMentionRef(mention.path)}`;
}

function collectInlineReplacements(entry: QueuedMessage, text: string): InlineReplacement[] {
  const replacements: InlineReplacement[] = [];
  const agentReferences = readAgentInputReferences(
    entry.chatMessage.agentReferences?.length
      ? entry.chatMessage.agentReferences
      : entry.agentReferences,
    text,
  );
  for (const reference of agentReferences) {
    replacements.push({
      start: reference.start,
      end: reference.end,
      node: agentReferenceNode(reference, text.slice(reference.start, reference.end)),
      priority: 0,
    });
  }

  for (const range of entry.chatMessage.pastedTextRanges ?? []) {
    if (
      !Number.isSafeInteger(range.start) ||
      !Number.isSafeInteger(range.end) ||
      range.start < 0 ||
      range.end <= range.start ||
      range.end > text.length ||
      typeof range.display !== 'string'
    ) {
      continue;
    }
    replacements.push({
      start: range.start,
      end: range.end,
      node: {
        type: 'pastedTextChip',
        attrs: { text: text.slice(range.start, range.end), display: range.display },
      },
      priority: 1,
    });
  }

  const mentionsByWireText = new Map<string, AgentInputMention>();
  for (const mention of entry.mentions ?? []) mentionsByWireText.set(mentionWireText(mention), mention);
  for (const [wireText, mention] of mentionsByWireText) {
    let start = text.indexOf(wireText);
    while (start >= 0) {
      replacements.push({
        start,
        end: start + wireText.length,
        node: {
          type: 'mentionChip',
          attrs: { kind: mention.type, label: mention.name, path: mention.path, titled: false },
        },
        priority: 2,
      });
      start = text.indexOf(wireText, start + wireText.length);
    }
  }

  replacements.sort((left, right) =>
    left.start - right.start || left.priority - right.priority || right.end - left.end,
  );
  const accepted: InlineReplacement[] = [];
  let previousEnd = 0;
  for (const replacement of replacements) {
    if (replacement.start < previousEnd) continue;
    accepted.push(replacement);
    previousEnd = replacement.end;
  }
  return accepted;
}

function locateTextSegmentStarts(
  text: string,
  segments: readonly ChatQuoteSegment[],
): Array<number | null> {
  let cursor = 0;
  return segments.map((segment) => {
    const value = segment.kind === 'quote' ? formatQuoteForSend(segment.quote) : segment.text;
    const start = text.indexOf(value, cursor);
    if (start < 0) return null;
    cursor = start + value.length;
    return segment.kind === 'text' ? start : null;
  });
}

function textSegmentNodes(
  text: string,
  sourceStart: number | null,
  replacements: readonly InlineReplacement[],
): JSONContent[] {
  if (sourceStart === null) return text ? [{ type: 'text', text }] : [];
  const sourceEnd = sourceStart + text.length;
  const nodes: JSONContent[] = [];
  let cursor = sourceStart;
  for (const replacement of replacements) {
    if (replacement.start < sourceStart || replacement.end > sourceEnd) continue;
    if (replacement.start > cursor) {
      nodes.push({ type: 'text', text: text.slice(cursor - sourceStart, replacement.start - sourceStart) });
    }
    nodes.push(replacement.node);
    cursor = replacement.end;
  }
  if (cursor < sourceEnd) nodes.push({ type: 'text', text: text.slice(cursor - sourceStart) });
  return nodes;
}

const LIST_ROW_MARKER_RE = /^(?:[-+*•][ \t]+|[1-9]\d{0,8}[.)][ \t]+|[1-9]\d{0,8}、[ \t]*)/;

function structuredQueueDocument(entry: QueuedMessage, text: string): JSONContent | null {
  if (!text) return null;
  const segments = entry.chatMessage.quotesEncoded
    ? parseChatQuoteSegments(text)
    : [{ kind: 'text' as const, text }];
  const segmentStarts = locateTextSegmentStarts(text, segments);
  const replacements = collectInlineReplacements(entry, text);
  const content: JSONContent[] = [];
  let inlineContent: JSONContent[] = [];
  let quoteJustEnded = false;

  const finishParagraph = () => {
    content.push(
      inlineContent.length > 0
        ? { type: 'paragraph', content: inlineContent }
        : { type: 'paragraph' },
    );
    inlineContent = [];
  };

  segments.forEach((segment, index) => {
    if (segment.kind === 'quote') {
      inlineContent.push({
        type: COMPOSER_QUOTE_NODE_TYPE,
        attrs: {
          text: segment.quote.text,
          sourcePath: segment.quote.sourcePath ?? null,
          startLine: segment.quote.startLine ?? null,
          endLine: segment.quote.endLine ?? null,
        },
      });
      quoteJustEnded = true;
      return;
    }
    if (!segment.text) return;
    if (/^\n+$/.test(segment.text)) {
      inlineContent.push(
        ...Array.from({ length: segment.text.length }, () => ({ type: 'hardBreak' })),
      );
      return;
    }

    for (const node of textSegmentNodes(segment.text, segmentStarts[index], replacements)) {
      if (node.type !== 'text') {
        inlineContent.push(node);
        quoteJustEnded = false;
        continue;
      }
      const lines = (node.text ?? '').split('\n');
      lines.forEach((line, lineIndex) => {
        if (quoteJustEnded && line && LIST_ROW_MARKER_RE.test(line) && inlineContent.length > 0) {
          finishParagraph();
        }
        if (line) inlineContent.push({ ...node, text: line });
        if (lineIndex < lines.length - 1) finishParagraph();
        if (line) quoteJustEnded = false;
      });
    }
  });

  finishParagraph();
  return normalizeComposerDocumentJSON({ type: 'doc', content });
}

export function queueMessageToComposerEditDraft(
  sessionId: string,
  entry: QueuedMessage,
): QueueComposerEditDraft {
  const text = entry.chatMessage.content ?? entry.text;
  const retryFilesById = new Map(
    (entry.chatMessage.retryFiles ?? []).map((file) => [file.id, file]),
  );
  const attachments: AttachedFile[] = (entry.files ?? []).map(({ pathOrigin: _, ...file }) => {
    const retryFile = retryFilesById.get(file.id);
    const annotationSourceUrl =
      file.annotated === true &&
      retryFile?.annotated === true &&
      retryFile.path === file.path &&
      retryFile.url === file.url &&
      retryFile.annotationSourceUrl &&
      retryFile.annotationStrokes?.length
        ? retryFile.annotationSourceUrl
        : null;
    if (!annotationSourceUrl || !retryFile?.annotationStrokes) {
      return { ...file, cacheUrlShared: true, stagedPathShared: true };
    }
    const sourceExt = extractExt(annotationSourceUrl) || file.ext;
    const editableFile = { ...file };
    delete editableFile.annotated;
    return {
      ...editableFile,
      path: annotationSourceUrl,
      url: annotationSourceUrl,
      ext: sourceExt,
      mimeType: getMimeType(sourceExt, 'image'),
      annotationStrokes: retryFile.annotationStrokes.map((stroke) => ({
        points: stroke.points.map((point) => ({ ...point })),
      })),
      cacheUrlShared: true,
      stagedPathShared: true,
    };
  });
  const document = structuredQueueDocument(entry, text);

  return {
    draftKey: queueComposerEditDraftKey(sessionId, entry.clientId),
    draft: {
      text: document,
      attachments,
      quotes: [],
      browserComments: [],
      focusAtEnd: true,
    },
    originalAttachmentIds: attachments.map((file) => file.id),
  };
}
