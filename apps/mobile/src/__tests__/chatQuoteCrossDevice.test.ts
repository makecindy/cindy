import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function readSource(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), 'utf8').replace(/\r\n/g, '\n');
}

describe('mobile cross-device quote wiring', () => {
  it('parses interleaved desktop quote segments instead of exposing marker text', () => {
    const source = readSource('src/session/MessageRenderer.tsx');
    const bubbleStart = source.indexOf('function MessageBubble');
    const bubbleEnd = source.indexOf('function copyActionLabel', bubbleStart);
    const bubbleSource = source.slice(bubbleStart, bubbleEnd);

    expect(bubbleSource).toContain('parseChatQuoteSegments(item.message.body');
    expect(bubbleSource).toContain('item.message.quotesEncoded === true');
    expect(bubbleSource).not.toContain('allowLegacyInterleavedQuotes');
    expect(bubbleSource).toContain("segment.kind === 'quote' ? [segment.quote] : []");
    expect(bubbleSource).toContain('joinChatQuoteTextSegments(quoteSegments)');
    expect(bubbleSource).toContain('actions.onPreviewRewind?.(clientId, {');
    expect(bubbleSource).toContain('{ orderedBody: item.message.body }');
  });

  it('propagates quote metadata through direct and attachment-outbox sends', () => {
    const source = readSource('app/sessions/[sessionId].tsx');

    expect(source).toContain('quotesEncoded: quotesEncodedAtSend');
    expect(source).toContain('pastedTextRanges: pastedTextRangesAtSend');
    expect(source).toContain('slashCommandRanges: slashCommandRangesAtSend');
    expect(source).toContain('quotesEncoded: item.quotesEncoded');
    expect(source).toContain('restoreOutboxItemsToDraft([item])');
    expect(source).toContain('saveComposerDocumentDraft(\n        draftSessionId,\n        recovery.document,');
    expect(source).toContain('createQueueEditTextState(item)');
    expect(source).toContain('resolveQueueEditTextSubmission(queueEditAtSendStart.textState, documentAtSend)');
    expect(source).toContain('applyComposerDocument(textState.document, { persist: false })');
    expect(source).toContain('quotesEncoded: queueEditPreservesEncodedQuotes');
  });

  it('restores structured quote drafts for mobile fork and rewind actions', () => {
    const source = readSource('app/sessions/[sessionId].tsx');

    expect(source).toContain('const forkDocument = draft?.document ?? migrateLegacyComposerDraft(');
    expect(source).toContain('saveComposerDocumentDraft(forked.id, forkDocument);');
    expect(source).toContain('applyComposerDocument(state.draftDocument ?? migrateLegacyComposerDraft(');
    expect(source).toContain('serializeComposerDocument(documentAtSend)');
  });

  it('strips private markers from queued and outbox raw-text bubbles', () => {
    const source = readSource('src/session/InlineQueueSection.tsx');
    expect(source).toContain('stripChatQuoteMarkerLines(item.text)');
    expect(source).toContain('item.chatMessage.quotesEncoded === true');
    expect(source).toContain('item.quotesEncoded ? stripChatQuoteMarkerLines(item.text)');
  });
});
