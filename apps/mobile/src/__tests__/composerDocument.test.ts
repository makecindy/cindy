import { describe, expect, it } from 'vitest';
import { formatQuoteForSend } from '@cindy/maker-shared/chat-quotes';
import {
  appendComposerNode,
  composerDocumentFromEncodedMessage,
  composerDocumentFromSerializedMessage,
  composerDocumentProjectedText,
  hydrateComposerMessageReferenceBodies,
  isLongComposerPaste,
  mentionComposerNode,
  MOBILE_LONG_PASTE_MAX_CHARS,
  migrateLegacyComposerDraft,
  pastedTextComposerNode,
  parseStoredComposerDocument,
  reconcileComposerProjectedText,
  removeComposerNode,
  replaceComposerTextRange,
  serializeComposerDocument,
  sessionLinkComposerNode,
  slashCommandTextNode,
  textComposerDocument,
} from '@/session/composerDocument';

describe('mobile composer document', () => {
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
