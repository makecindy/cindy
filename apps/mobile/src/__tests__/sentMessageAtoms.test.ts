import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatQuoteForSend, parseChatQuoteSegments } from '@cindy/maker-shared/chat-quotes';
import {
  buildSentInlineTokens,
  buildVisibleSentInlineTokens,
  sentInlineTokensDisplayText,
} from '@/session/sentMessageAtoms';

describe('sent message atoms', () => {
  it('keeps atom chips while rendering ordinary chunks with full Markdown semantics', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/session/MessageRenderer.tsx'), 'utf8');
    const bodyStart = source.indexOf('function SentInlineAtomBody');
    const bodyEnd = source.indexOf('function MarkdownBody', bodyStart);
    const bodySource = source.slice(bodyStart, bodyEnd);

    expect(bodySource).toContain('<InlineQuoteChip');
    expect(bodySource).toContain('<InlineReferenceChip');
    expect(bodySource).toContain('<MarkdownBody');
    expect(bodySource).toContain('text={token.text}');
    expect(bodySource).not.toContain('splitAnchoredSessionMessageLinks');
    expect(bodySource).not.toContain('<SentMessageAnchorChip');
    expect(bodySource).not.toContain('parseMobileMarkdownInlines(part.text)');
  });

  it('splits exact pasted-text and slash ranges without guessing', () => {
    const text = '/compact before first\nsecond after';
    expect(buildSentInlineTokens(
      text,
      [{ start: 16, end: 28, display: 'Pasted text (2 lines)' }],
      [{ start: 0, end: 8 }],
    )).toEqual([
      { kind: 'slash', text: '/compact' },
      { kind: 'text', text: ' before ' },
      { kind: 'pasted', text: 'first\nsecond', display: 'Pasted text (2 lines)' },
      { kind: 'text', text: ' after' },
    ]);
  });

  it('preserves quote/text order while projecting atom ranges around quote blocks', () => {
    const quoteA = formatQuoteForSend({ text: 'quoted A' });
    const quoteB = formatQuoteForSend({ text: 'quoted B', sourcePath: 'src/b.ts' });
    const source = `${quoteA}\n\n/help before\n\n${quoteB}\n\nlong\ntext after`;
    const pasteStart = source.indexOf('long\ntext');
    const slashStart = source.indexOf('/help');
    const tokens = buildVisibleSentInlineTokens(
      source,
      parseChatQuoteSegments(source),
      [{ start: pasteStart, end: pasteStart + 9, display: 'Pasted text (2 lines)' }],
      [{ start: slashStart, end: slashStart + 5 }],
    );

    expect(tokens).toEqual([
      { kind: 'quote', quote: { text: 'quoted A' } },
      { kind: 'slash', text: '/help' },
      { kind: 'text', text: ' before' },
      { kind: 'quote', quote: { text: 'quoted B', sourcePath: 'src/b.ts' } },
      { kind: 'pasted', text: 'long\ntext', display: 'Pasted text (2 lines)' },
      { kind: 'text', text: ' after' },
    ]);
    expect(sentInlineTokensDisplayText(tokens)).toBe(
      'quoted A\n/help before\nquoted B\nPasted text (2 lines) after',
    );
  });
});
