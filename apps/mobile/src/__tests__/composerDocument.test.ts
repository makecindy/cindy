import { describe, expect, it } from 'vitest';
import { formatQuoteForSend } from '@cindy/maker-shared/chat-quotes';
import {
  appendComposerNode,
  composerDocumentFromEncodedMessage,
  composerDocumentFromSerializedMessage,
  composerDocumentProjectedText,
  composerCaretPosition,
  composerSelectionOffset,
  hydrateComposerMessageReferenceBodies,
  isLongComposerPaste,
  mentionComposerNode,
  MOBILE_LONG_PASTE_MAX_CHARS,
  migrateLegacyComposerDraft,
  pastedTextComposerNode,
  parseStoredComposerDocument,
  reconcileComposerProjectedText,
  reconcileComposerVoiceDraft,
  type ComposerDocument,
  removeComposerNode,
  replaceComposerTextRange,
  serializeComposerDocument,
  sessionLinkComposerNode,
  slashCommandTextNode,
  textComposerDocument,
} from '@/session/composerDocument';

describe('mobile composer document', () => {
  it.each([
    [0, 2, 0, 1, 'voice'],
    [1, 1, 0, 1, 'avoiceb'],
    [1, 1, 0, 0, 'avoice|b'],
    [1, 1, 1, 1, 'a|voiceb'],
    [0, 1, 0, 0, 'voice|b'],
    [1, 2, 1, 1, 'a|voice'],
  ])('replaces structural voice selection [%i, %i] atoms [%i, %i]', (start, end, atomStart, atomEnd, expected) => {
    const initialDocument: ComposerDocument = { version: 1, nodes: [
      { type: 'text', text: 'a' }, { type: 'quote', quote: { text: 'quote' } }, { type: 'text', text: 'b' },
    ] };
    const result = reconcileComposerVoiceDraft(initialDocument, {
      draft: 'ab'.slice(0, start) + 'voice' + 'ab'.slice(end), initialDocument,
      initialSelection: { start, end, atomRange: { start: atomStart, end: atomEnd } }, insertionEnd: start + 5,
    });
    expect(result.nodes.map((node) => node.type === 'quote' ? '|' : node.type === 'text' ? node.text : '?').join('')).toBe(expected);
  });

  it('removes only the selected quote among consecutive zero-width atoms', () => {
    const initialDocument: ComposerDocument = { version: 1, nodes: ['one', 'two', 'three'].map((text) => ({ type: 'quote', quote: { text } })) };
    const result = reconcileComposerVoiceDraft(initialDocument, {
      draft: 'voice', initialDocument, initialSelection: { start: 0, end: 0, atomRange: { start: 1, end: 2 } }, insertionEnd: 5,
    });
    expect(result.nodes).toEqual([initialDocument.nodes[0], { type: 'text', text: 'voice' }, initialDocument.nodes[2]]);
    expect(serializeComposerDocument(result).text).not.toContain('two');
  });

  it('keeps repeated streaming text on the original side of an unselected quote', () => {
    const initialDocument: ComposerDocument = { version: 1, nodes: [
      { type: 'text', text: 'a' }, { type: 'quote', quote: { text: 'quote' } }, { type: 'text', text: 'a' },
    ] };
    const update = { draft: 'aa', initialDocument, initialSelection: { start: 0, end: 1, atomRange: { start: 0, end: 0 } }, insertionEnd: 1 };
    const first = reconcileComposerVoiceDraft(initialDocument, update);
    const next = reconcileComposerVoiceDraft(first, { ...update, draft: 'aaa', replacement: { start: 0, end: 1, text: 'aa' } });
    expect(next.nodes).toEqual([{ type: 'text', text: 'aa' }, initialDocument.nodes[1], { type: 'text', text: 'a' }]);
  });

  it('does not reuse captured atom selection after the document was edited', () => {
    const initialDocument: ComposerDocument = { version: 1, nodes: [{ type: 'quote', quote: { text: 'keep' } }] };
    const edited = appendComposerNode(initialDocument, { type: 'text', text: 'typed' });
    const result = reconcileComposerVoiceDraft(edited, {
      draft: 'typed\nvoice', initialDocument, initialSelection: { start: 0, end: 0, atomRange: { start: 0, end: 1 } }, insertionEnd: 11,
    });
    expect(result.nodes[0]).toEqual(initialDocument.nodes[0]);
    expect(composerDocumentProjectedText(result)).toBe('typed\nvoice');
  });

  it('resolves compact prefixes through long pasted content and semantic reference projections', () => {
    const document = { version: 1 as const, nodes: [
      { type: 'text' as const, text: '前🙂后' },
      { type: 'quote' as const, quote: { text: '引用' } },
      { type: 'pasted-text' as const, text: '文'.repeat(4_000_000), display: '长文本' },
      { type: 'session-link' as const, href: 'https://example.com/task', label: '标题', titled: true },
    ] };
    expect(composerSelectionOffset(document, { textLength: 3, atomCount: 1 })).toBe(3);
    expect(composerSelectionOffset(document, { textLength: 4, atomCount: 2 })).toBe(4_000_004);
    expect(composerSelectionOffset(document, { textLength: 4, atomCount: 3 }))
      .toBe(composerDocumentProjectedText(document).length);
    expect(composerSelectionOffset(document, { textLength: 5, atomCount: 0 })).toBeNull();
    expect(composerSelectionOffset(document, { textLength: 0, atomCount: 4 })).toBeNull();
  });
  it('locates a dictated caret using projected chip lengths and skips zero-width quotes', () => {
    const document = { version: 1 as const, nodes: [
      { type: 'quote' as const, quote: { text: '引用' } },
      { type: 'session-link' as const, href: 'https://example.com/task', label: '标题', titled: true },
      { type: 'text' as const, text: '插入后文' },
    ] };
    const prefix = '[标题](https://example.com/task)';
    expect(composerCaretPosition(document, prefix.length + 2)).toEqual({ nodeIndex: 2, offset: 2 });
    expect(composerCaretPosition(textComposerDocument('甲🙂乙'), 3)).toEqual({ nodeIndex: 0, offset: 3 });
  });
  it('roundtrips interleaved quote and text nodes without leaking private markers', () => {
    const quoteA = { text: 'alpha' };
    const quoteB = { text: 'beta', sourcePath: 'src/b.ts', startLine: 4, endLine: 5 };
    const encoded = `${formatQuoteForSend(quoteA)}\n\nreply a\n\n${formatQuoteForSend(quoteB)}\n\nreply b`;
    const document = composerDocumentFromEncodedMessage(encoded);

    expect(document.nodes.map((node) => node.type)).toEqual(['quote', 'text', 'quote', 'text']);
    expect(composerDocumentProjectedText(document)).toBe('reply areply b');
    expect(serializeComposerDocument(document)).toMatchObject({ text: encoded, quotesEncoded: true });
  });

  it('migrates legacy quotes before the plain text draft', () => {
    const migrated = migrateLegacyComposerDraft('answer', [{ text: 'quoted' }]);
    expect(migrated.nodes.map((node) => node.type)).toEqual(['quote', 'text']);
    expect(serializeComposerDocument(migrated).text).toBe(
      `${formatQuoteForSend({ text: 'quoted' })}\n\nanswer`,
    );
  });

  it('keeps mentions and message links atomic while serializing desktop-compatible text', () => {
    let document = textComposerDocument('read ');
    document = appendComposerNode(document, mentionComposerNode({
      type: 'file',
      name: 'design notes.md',
      relPath: 'docs/design notes.md',
    }));
    document = appendComposerNode(document, { type: 'text', text: ' then ' });
    document = appendComposerNode(document, sessionLinkComposerNode({
      href: 'cindy://session/s-1?message=m-2',
      label: 'the target message',
      titled: true,
    }));

    expect(serializeComposerDocument(document).text).toBe(
      'read @"docs/design notes.md" then cindy://session/s-1?message=m-2',
    );
    expect(removeComposerNode(document, 1).nodes.map((node) => node.type)).toEqual([
      'text', 'session-link',
    ]);
    expect(mentionComposerNode({ type: 'file', relPath: 'docs/fallback.md' }).label).toBe(
      'docs/fallback.md',
    );
  });

  it('awaits missing message-chip bodies before send serialization', async () => {
    const href = 'cindy://session/session-a?message=message-a';
    const document = {
      version: 1 as const,
      nodes: [
        { type: 'text' as const, text: 'inspect ' },
        sessionLinkComposerNode({ href, label: 'message-a' }),
      ],
    };

    const hydrated = await hydrateComposerMessageReferenceBodies(
      document,
      async () => ({
        label: 'Target message',
        agentText: 'Complete target body',
      }),
    );

    expect(serializeComposerDocument(hydrated).agentReferences).toEqual([
      expect.objectContaining({
        kind: 'message',
        href,
        text: 'Complete target body',
      }),
    ]);
    expect(document.nodes[1]).not.toHaveProperty('agentText');
  });

  it('tracks slash decorations as editable text ranges and invalidates them after edits', () => {
    const document = {
      version: 1 as const,
      nodes: [slashCommandTextNode('compact'), { type: 'text' as const, text: ' now' }],
    };
    const serialized = serializeComposerDocument(document);
    expect(serialized.slashCommandRanges).toEqual([{ start: 0, end: 8 }]);
    expect(serialized.text.slice(0, 8)).toBe('/compact');

    const edited = replaceComposerTextRange(document, 7, 8, [{ type: 'text', text: 'x' }]);
    expect(serializeComposerDocument(edited).slashCommandRanges).toEqual([]);
    expect(serializeComposerDocument(edited).text).toBe('/compacx now');
  });

  it('serializes long paste atoms with exact presentation ranges', () => {
    let document = textComposerDocument('before ');
    document = appendComposerNode(document, pastedTextComposerNode('first\nsecond'));
    document = appendComposerNode(document, { type: 'text', text: ' after' });
    const serialized = serializeComposerDocument(document);
    expect(serialized.text).toBe('before first\nsecond after');
    expect(serialized.pastedTextRanges).toEqual([{
      start: 7,
      end: 19,
      display: 'Pasted text (2 lines)',
    }]);
    expect(isLongComposerPaste(Array(24).fill('line').join('\n'))).toBe(true);
    expect(isLongComposerPaste('x'.repeat(MOBILE_LONG_PASTE_MAX_CHARS + 1))).toBe(true);
    expect(isLongComposerPaste('short')).toBe(false);
  });

  it('restores quote, pasted-text and slash metadata into one document', () => {
    const quote = formatQuoteForSend({ text: 'quoted' });
    const encoded = `/help before\n\n${quote}\n\nlong\ntext after`;
    const pasteStart = encoded.indexOf('long\ntext');
    const restored = composerDocumentFromSerializedMessage(encoded, {
      quotesEncoded: true,
      pastedTextRanges: [{
        start: pasteStart,
        end: pasteStart + 9,
        display: 'Pasted text (2 lines)',
      }],
      slashCommandRanges: [{ start: 0, end: 5 }],
    });

    expect(restored.nodes.map((node) => node.type)).toEqual([
      'text', 'text', 'quote', 'pasted-text', 'text',
    ]);
    expect(serializeComposerDocument(restored)).toEqual({
      text: encoded,
      quotesEncoded: true,
      agentReferences: [],
      pastedTextRanges: [{
        start: pasteStart,
        end: pasteStart + 9,
        display: 'Pasted text (2 lines)',
      }],
      slashCommandRanges: [{ start: 0, end: 5 }],
    });
  });

  it('roundtrips message, conversation and project references while keeping deep-link wire text', () => {
    const messageHref = 'cindy://session/session-a?message=message-a';
    const sessionHref = 'cindy://session/session-b';
    const projectHref = 'cindy://project/%2Frepos%2Fcindy';
    const fullMessage = `Target body ${'x'.repeat(300)}`;
    const document = {
      version: 1 as const,
      nodes: [
        { type: 'text' as const, text: 'inspect ' },
        sessionLinkComposerNode({
          href: messageHref,
          label: 'compact label',
          agentText: fullMessage,
        }),
        { type: 'text' as const, text: ' continue ' },
        sessionLinkComposerNode({
          href: sessionHref,
          label: 'Planning',
          titled: true,
        }),
        { type: 'text' as const, text: ' project ' },
        {
          type: 'mention' as const,
          kind: 'project' as const,
          label: 'Cindy',
          raw: projectHref,
          href: projectHref,
          workingDir: '/stale/path',
        },
      ],
    };

    const serialized = serializeComposerDocument(document);
    expect(serialized.text).toBe(
      `inspect ${messageHref} continue [Planning](${sessionHref}) project ${projectHref}`,
    );
    expect(serialized.agentReferences).toEqual([
      expect.objectContaining({
        kind: 'message',
        href: messageHref,
        text: fullMessage,
      }),
      expect.objectContaining({
        kind: 'session',
        href: sessionHref,
        title: 'Planning',
      }),
      expect.objectContaining({
        kind: 'project',
        href: projectHref,
        name: 'Cindy',
        workingDir: '/repos/cindy',
      }),
    ]);

    const restored = composerDocumentFromSerializedMessage(serialized.text, {
      agentReferences: serialized.agentReferences,
    });
    expect(serializeComposerDocument(restored)).toEqual(serialized);
  });

  it('keeps unsupported Desktop Plugin references as exact editable wire text', () => {
    const href = 'cindy://plugin-resource/issues/search_issues/ISSUE-1';
    const text = `[Fix login](${href})`;
    const restored = composerDocumentFromSerializedMessage(text, {
      agentReferences: [{
        kind: 'plugin-resource',
        start: 0,
        end: text.length,
        href,
        ghostId: 'issues',
        tool: 'search_issues',
        resourceId: 'ISSUE-1',
        pluginName: 'Issue Tracker',
        label: 'Fix login',
      }],
    });

    expect(composerDocumentProjectedText(restored)).toBe(text);
    expect(serializeComposerDocument(restored)).toMatchObject({
      text,
      agentReferences: [],
    });
  });

  it('replaces projected text without changing the surrounding atom', () => {
    const document = {
      version: 1 as const,
      nodes: [
        { type: 'text' as const, text: 'a' },
        { type: 'quote' as const, quote: { text: 'q' } },
        { type: 'text' as const, text: 'b' },
      ],
    };
    expect(replaceComposerTextRange(document, 0, 1, [{ type: 'text', text: 'x' }]).nodes).toEqual([
      { type: 'text', text: 'x' },
      { type: 'quote', quote: { text: 'q' } },
      { type: 'text', text: 'b' },
    ]);
  });

  it('preserves quote atoms while voice text appends and clears the whole document explicitly', () => {
    const document = migrateLegacyComposerDraft('hello', [{ text: 'quote' }]);
    expect(reconcileComposerProjectedText(document, 'hello world').nodes.map((node) => node.type)).toEqual([
      'quote', 'text',
    ]);
    expect(reconcileComposerProjectedText(document, '').nodes).toEqual([]);
  });

  it('drops malformed persisted atom fields at the document boundary', () => {
    const restored = parseStoredComposerDocument({
      version: 1,
      nodes: [
        { type: 'mention', kind: 'file', label: 42, raw: '@"a"' },
        { type: 'session-link', href: 'cindy://session/s-1', label: 'session', titled: 'yes' },
        { type: 'pasted-text', text: 'paste', display: false },
        { type: 'quote', quote: { text: 'quote', sourcePath: 'a.ts', startLine: 8, endLine: 3 } },
        { type: 'mention', kind: 'file', label: 'a', raw: '@"a"' },
        { type: 'quote', quote: { text: 'valid', sourcePath: 'a.ts', startLine: 3, endLine: 8 } },
      ],
    });

    expect(restored?.nodes).toEqual([
      { type: 'mention', kind: 'file', label: 'a', raw: '@"a"' },
      { type: 'quote', quote: { text: 'valid', sourcePath: 'a.ts', startLine: 3, endLine: 8 } },
    ]);
  });
});
