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
    const atomSource = readFileSync(resolve(process.cwd(), 'src/session/SentInlineAtomBody.tsx'), 'utf8');
    const rendererSource = readFileSync(resolve(process.cwd(), 'src/session/MessageRenderer.tsx'), 'utf8');

    expect(atomSource).toContain('<InlineQuoteChip');
    expect(atomSource).toContain('<InlineReferenceChip');
    expect(atomSource).toContain('renderText(token.text, index)');
    expect(atomSource).toContain('selectable={selectable}');
    expect(rendererSource).toContain('<MarkdownBody');
    expect(rendererSource).toContain('text={text}');
    expect(atomSource).not.toContain('splitAnchoredSessionMessageLinks');
    expect(atomSource).not.toContain('<SentMessageAnchorChip');
    expect(atomSource).not.toContain('parseMobileMarkdownInlines(part.text)');
  });

  it('keeps atomized long messages structured while collapsed', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/session/MessageRenderer.tsx'), 'utf8');
    const collapseStart = source.indexOf('const collapseMeasureEnabled =');
    const collapseEnd = source.indexOf(';', collapseStart);

    expect(collapseStart).toBeGreaterThan(-1);
    expect(collapseEnd).toBeGreaterThan(collapseStart);
    expect(source.slice(collapseStart, collapseEnd)).not.toContain('!rendersSentInlineBody');
    expect(source).toContain('maxVisibleLines={collapsedLineCount}');
    expect(source).toContain('testID="message.collapsedSentInlineAtoms"');
    expect(source).toContain('selectable={canSelectVisibleText}');
    expect(source).toContain('interactiveAtoms={false}');
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

  it('projects pasted payloads to the same visible chip labels used by the message stream', () => {
    const text = 'before private payload after';
    const start = text.indexOf('private payload');

    expect(sentInlineTokensDisplayText(buildVisibleSentInlineTokens(
      text,
      [{ kind: 'text', text }],
      [{ start, end: start + 'private payload'.length, display: 'Pasted text (1 line)' }],
    ))).toBe('before Pasted text (1 line) after');
  });
});
