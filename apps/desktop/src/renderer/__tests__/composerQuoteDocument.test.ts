// @vitest-environment jsdom
import { Editor } from '@tiptap/core';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import HardBreak from '@tiptap/extension-hard-break';
import { afterEach, describe, expect, it } from 'vitest';
import { ComposerQuoteNode } from '@/components/new-chat/ComposerQuoteNode';
import {
  COMPOSER_QUOTE_NODE_TYPE,
  appendQuoteToComposerDocument,
  composerHistoryEntryToDocument,
  prependLegacyQuotesToComposerDocument,
  quoteSegmentsToComposerDocument,
  serializeComposerContentBlocks,
  serializeComposerContentBlocksWithRanges,
} from '@/lib/composerQuoteDocument';
import { formatQuoteForSend, parseChatQuoteSegments } from '@/lib/chatQuotes';

const editors: Editor[] = [];

afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy();
});

function makeEditor(): Editor {
  const editor = new Editor({
    extensions: [Document, Paragraph, Text, HardBreak, ComposerQuoteNode],
    content: { type: 'doc', content: [{ type: 'paragraph' }] },
  });
  editors.push(editor);
  return editor;
}

describe('composerQuoteDocument', () => {
  it('appends quotes inline so each reply can continue directly beside its quote', () => {
    const first = appendQuoteToComposerDocument(null, { text: 'quote one' });
    first.content![0].content!.push({ type: 'text', text: 'response one' });
    const second = appendQuoteToComposerDocument(first, {
      text: 'quote two',
      sourcePath: 'docs/spec.md',
      startLine: 4,
      endLine: 5,
    });

    expect(second).toEqual({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'composerQuote',
              attrs: { text: 'quote one', sourcePath: null, startLine: null, endLine: null },
            },
            { type: 'text', text: 'response one' },
            {
              type: 'composerQuote',
              attrs: {
                text: 'quote two',
                sourcePath: 'docs/spec.md',
                startLine: 4,
                endLine: 5,
              },
            },
          ],
        },
      ],
    });
  });

  it('lets the editor insert reply text immediately after a quote atom', () => {
    const editor = makeEditor();
    editor.commands.setContent(appendQuoteToComposerDocument(null, { text: 'quote' }));
    editor.commands.focus('end');
    editor.commands.insertContent('reply');

    expect(editor.getJSON().content).toEqual([
      {
        type: 'paragraph',
        content: [
          {
            type: 'composerQuote',
            attrs: { text: 'quote', sourcePath: null, startLine: null, endLine: null },
          },
          { type: 'text', text: 'reply' },
        ],
      },
    ]);
  });

  it('lifts legacy leading quote arrays into the document once', () => {
    expect(
      prependLegacyQuotesToComposerDocument(
        {
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'body' }] }],
        },
        [{ text: 'legacy' }],
      ),
    ).toEqual({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'composerQuote',
              attrs: { text: 'legacy', sourcePath: null, startLine: null, endLine: null },
            },
            { type: 'text', text: 'body' },
          ],
        },
      ],
    });
  });

  it('restores alternating sent-message segments in the same order', () => {
    expect(
      quoteSegmentsToComposerDocument([
        { kind: 'quote', quote: { text: 'q1' } },
        { kind: 'text', text: 'a1' },
        { kind: 'quote', quote: { text: 'q2' } },
        { kind: 'text', text: 'a2' },
      ]),
    ).toEqual({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'composerQuote',
              attrs: { text: 'q1', sourcePath: null, startLine: null, endLine: null },
            },
            { type: 'text', text: 'a1' },
            {
              type: 'composerQuote',
              attrs: { text: 'q2', sourcePath: null, startLine: null, endLine: null },
            },
            { type: 'text', text: 'a2' },
          ],
        },
      ],
    });
  });

  it('keeps a sibling list row separate when it follows a quote segment', () => {
    expect(
      quoteSegmentsToComposerDocument([
        { kind: 'text', text: '- first' },
        { kind: 'quote', quote: { text: 'quoted' } },
        { kind: 'text', text: '- second' },
      ]),
    ).toEqual({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: '- first' },
            {
              type: COMPOSER_QUOTE_NODE_TYPE,
              attrs: {
                text: 'quoted',
                sourcePath: null,
                startLine: null,
                endLine: null,
              },
            },
          ],
        },
        { type: 'paragraph', content: [{ type: 'text', text: '- second' }] },
      ],
    });
  });

  it('hydrates encoded history rows as quote atoms and leaves unflagged markers as text', () => {
    const encoded = `${formatQuoteForSend({ text: 'quoted' })}\n\nreply`;

    expect(composerHistoryEntryToDocument({ content: encoded, quotesEncoded: true })).toEqual({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'composerQuote',
              attrs: { text: 'quoted', sourcePath: null, startLine: null, endLine: null },
            },
            { type: 'text', text: 'reply' },
          ],
        },
      ],
    });
    expect(composerHistoryEntryToDocument({ content: encoded })).toEqual({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: encoded }] }],
    });
  });

  it('round-trips pure blank-line islands between quotes without adding paragraphs', () => {
    const first = formatQuoteForSend({ text: 'q1' });
    const second = formatQuoteForSend({ text: 'q2' });
    const encoded = `${first}\n\n\n${second}`;
    const segments = parseChatQuoteSegments(encoded);

    expect(segments).toEqual([
      { kind: 'quote', quote: { text: 'q1' } },
      { kind: 'text', text: '\n' },
      { kind: 'quote', quote: { text: 'q2' } },
    ]);
    expect(quoteSegmentsToComposerDocument(segments)).toEqual({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'composerQuote',
              attrs: { text: 'q1', sourcePath: null, startLine: null, endLine: null },
            },
            { type: 'hardBreak' },
            {
              type: 'composerQuote',
              attrs: { text: 'q2', sourcePath: null, startLine: null, endLine: null },
            },
          ],
        },
      ],
    });
    const serialized = serializeComposerContentBlocks([
      { kind: 'quote', text: first },
      { kind: 'text', text: '\n' },
      { kind: 'quote', text: second },
    ]);
    expect(serialized).toBe(encoded);
    expect(parseChatQuoteSegments(serialized)).toEqual(segments);
  });

  it('projects long-paste ranges through composer trimming without changing wire text', () => {
    const serialized = serializeComposerContentBlocksWithRanges([
      {
        kind: 'text',
        text: '  long pasted text  ',
        pastedTextRanges: [{ start: 2, end: 18, display: 'Pasted text (1 line)' }],
      },
    ]);

    expect(serialized).toEqual({
      text: 'long pasted text',
      agentReferences: [],
      pastedTextRanges: [{ start: 0, end: 16, display: 'Pasted text (1 line)' }],
      slashCommandRanges: [],
    });
    expect(serialized.text.slice(0, 16)).toBe('long pasted text');
  });

  it('clips long-paste ranges that include trimmed whitespace', () => {
    const serialized = serializeComposerContentBlocksWithRanges([
      {
        kind: 'text',
        text: '  long pasted text  ',
        pastedTextRanges: [{ start: 0, end: 20, display: 'Pasted text (1 line)' }],
      },
    ]);

    expect(serialized).toEqual({
      text: 'long pasted text',
      agentReferences: [],
      pastedTextRanges: [{ start: 0, end: 16, display: 'Pasted text (1 line)' }],
      slashCommandRanges: [],
    });
  });

  it('projects structured reference offsets through block separators and trimming', () => {
    const href = 'cindy://session/session-a?message=message-a';
    const serialized = serializeComposerContentBlocksWithRanges([
      {
        kind: 'text',
        text: `  inspect ${href}`,
        agentReferences: [{
          kind: 'message',
          start: 10,
          end: 10 + href.length,
          href,
          sessionId: 'session-a',
          messageClientId: 'message-a',
          text: 'Complete target message body',
        }],
      },
    ]);

    expect(serialized.text).toBe(`inspect ${href}`);
    expect(serialized.agentReferences).toEqual([{
      kind: 'message',
      start: 8,
      end: 8 + href.length,
      href,
      sessionId: 'session-a',
      messageClientId: 'message-a',
      text: 'Complete target message body',
    }]);
  });

  it('projects decorated slash ranges through trimming and quote separators', () => {
    const quote = formatQuoteForSend({ text: 'quoted' });
    const serialized = serializeComposerContentBlocksWithRanges([
      {
        kind: 'text',
        text: '  /git before',
        slashCommandRanges: [{ start: 2, end: 6 }],
      },
      { kind: 'quote', text: quote },
      {
        kind: 'text',
        text: '/git after',
        slashCommandRanges: [{ start: 0, end: 4 }],
      },
    ]);
    const trailingStart = serialized.text.lastIndexOf('/git');

    expect(serialized.slashCommandRanges).toEqual([
      { start: 0, end: 4 },
      { start: trailingStart, end: trailingStart + 4 },
    ]);
    expect(
      serialized.slashCommandRanges.map((range) => serialized.text.slice(range.start, range.end)),
    ).toEqual(['/git', '/git']);
  });

  it('round-trips quote text and source metadata through HTML clipboard serialization', () => {
    const editor = makeEditor();
    editor.commands.setContent({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'composerQuote',
              attrs: {
                text: 'quoted <value>\nsecond line',
                sourcePath: 'src/example.ts',
                startLine: 7,
                endLine: 9,
              },
            },
          ],
        },
      ],
    });

    const restored = makeEditor();
    restored.commands.setContent(editor.getHTML());
    expect(restored.getJSON().content?.[0]?.content?.[0]).toEqual({
      type: 'composerQuote',
      attrs: {
        text: 'quoted <value>\nsecond line',
        sourcePath: 'src/example.ts',
        startLine: 7,
        endLine: 9,
      },
    });
  });

  it('omits empty optional quote attributes from clipboard HTML', () => {
    const editor = makeEditor();
    editor.commands.setContent(appendQuoteToComposerDocument(null, { text: 'quoted' }));

    const html = editor.getHTML();
    expect(html).toContain('data-composer-quote=""');
    expect(html).not.toContain('data-source-path');
    expect(html).not.toContain('data-start-line');
    expect(html).not.toContain('data-end-line');
  });
});
