import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import ts from 'typescript';
import { SentInlineAtomBody } from '@/session/SentInlineAtomBody';
import { InlineQuoteChip } from '@/session/InlineQuoteChip';
import { InlineReferenceChip } from '@/session/InlineReferenceChip';

vi.mock('react-native', () => ({ View: 'View', StyleSheet: { create: (styles: unknown) => styles } }));
vi.mock('@/components/AppText', () => ({ Text: 'Text' }));
vi.mock('lucide-react-native', () => ({ FileText: 'FileText' }));
vi.mock('@/session/InlineQuoteChip', () => ({ InlineQuoteChip: 'QuoteChip' }));
vi.mock('@/session/InlineReferenceChip', () => ({ InlineReferenceChip: 'ReferenceChip' }));
vi.mock('@/theme', () => ({
  useTheme: () => ({ colors: { textSecondary: '#333' } }), useThemedStyles: () => ({}),
  lineHeight: { bodyLarge: 20 }, spacing: { xs: 4 }, iconSize: { sm: 16 }, iconStroke: { regular: 2 },
}));

describe('production sent atom body', () => {
  it('routes text through its caller renderer and keeps atom payloads behind their chips', () => {
    const renderText = vi.fn((text: string) => React.createElement('markdown', null, text));
    const open = vi.fn();
    const tree = SentInlineAtomBody({ tokens: [
      { kind: 'text', text: '**bold**' }, { kind: 'quote', quote: { text: 'Quote' } },
      { kind: 'pasted', text: 'Private payload', display: 'Pasted text' }, { kind: 'slash', text: '/help' },
    ], renderText, onOpenPayload: open });
    const children = tree.props.children as React.ReactElement<any>[];
    expect(renderText).toHaveBeenCalledWith('**bold**', 0);
    expect(children[0].type).toBe('markdown');
    expect(children[1].type).toBe(InlineQuoteChip);
    expect(children[2].type).toBe(InlineReferenceChip);
    expect(children[2].props.label).toBe('Pasted text');
    children[2].props.onPress();
    expect(open).toHaveBeenCalledWith({ kind: 'text', title: 'Pasted text', body: 'Private payload' });
    expect(children[3].props.label).toBe('/help');
  });

  it('clamps structured long content as a whole without allowing hidden payload interaction', () => {
    const tree = SentInlineAtomBody({ tokens: [{ kind: 'pasted', text: 'Hidden payload', display: 'Pasted text' }],
      interactiveAtoms: false, maxVisibleLines: 3, onOpenPayload: vi.fn() });
    expect(tree.props.style).toContainEqual({ maxHeight: 68, overflow: 'hidden' });
    expect(tree.props.children[0].props.onPress).toBeUndefined();
    const source = readFileSync(resolve(process.cwd(), 'src/session/MessageRenderer.tsx'), 'utf8');
    const ast = ts.createSourceFile('renderer.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let initializer: ts.Expression | undefined;
    function visit(node: ts.Node) {
      if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'collapseMeasureEnabled') initializer = node.initializer;
      ts.forEachChild(node, visit);
    }
    visit(ast);
    if (!initializer) throw new Error('Missing production long-message measurement gate');
    const measure = new Function('isUser', 'hookSource', 'item', 'displayBubbleBody', 'collapseThreshold', 'mayExceedVisualLineThreshold', 'rendersSentInlineBody', 'return (' + initializer.getText(ast) + ');');
    expect(measure(true, undefined, { message: { kind: 'user' } }, 'Pasted text\n'.repeat(20), 3, () => true, true)).toBe(true);
    expect(measure(true, undefined, { message: { kind: 'user', systemCardType: 'notice' } }, 'Pasted text\n'.repeat(20), 3, () => true, true)).toBe(false);
  });
});
import { formatQuoteForSend, parseChatQuoteSegments } from '@cindy/maker-shared/chat-quotes';
import {
  buildSentInlineTokens,
  buildVisibleSentInlineTokens,
  sentInlineTokensDisplayText,
} from '@/session/sentMessageAtoms';

describe('sent message atoms', () => {
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

  it('projects Pi runtime /skill: chips to the human slash label', () => {
    expect(sentInlineTokensDisplayText(buildSentInlineTokens(
      '/skill:git follow-up',
      [],
      [{ start: 0, end: 10 }],
    ))).toBe('/git follow-up');
  });
});
