import { describe, expect, it } from 'vitest';

import { isMultilineDraftDoc } from '../composerDraftMultiline';

interface FakeNode {
  type: { name: string };
  isText: boolean;
  isTextblock: boolean;
  text?: string | null;
  attrs: Record<string, unknown>;
}

function fakeDoc(childCount: number, nodes: FakeNode[] = []): Parameters<typeof isMultilineDraftDoc>[0] {
  return {
    childCount,
    descendants: (fn) => {
      for (const node of nodes) {
        if (fn(node) === false) return;
      }
    },
  };
}

const paragraph = (): FakeNode => ({
  type: { name: 'paragraph' },
  isText: false,
  isTextblock: true,
  attrs: {},
});
const text = (content = ''): FakeNode => ({
  type: { name: 'text' },
  isText: true,
  isTextblock: false,
  text: content,
  attrs: {},
});
const hardBreak = (): FakeNode => ({
  type: { name: 'hardBreak' },
  isText: false,
  isTextblock: false,
  attrs: {},
});
const bulletList = (): FakeNode => ({
  type: { name: 'bulletList' },
  isText: false,
  isTextblock: false,
  attrs: {},
});
const listItem = (): FakeNode => ({
  type: { name: 'listItem' },
  isText: false,
  isTextblock: false,
  attrs: {},
});
const pastedChip = (chipText: string): FakeNode => ({
  type: { name: 'pastedTextChip' },
  isText: false,
  isTextblock: false,
  attrs: { text: chipText, display: 'Pasted text' },
});
const quoteChip = (quoteText: string): FakeNode => ({
  type: { name: 'composerQuote' },
  isText: false,
  isTextblock: false,
  attrs: { text: quoteText },
});

describe('isMultilineDraftDoc', () => {
  it('treats an empty or single-paragraph doc as single-line', () => {
    expect(isMultilineDraftDoc(fakeDoc(1, [paragraph()]))).toBe(false);
    expect(isMultilineDraftDoc(fakeDoc(1, [paragraph(), text()]))).toBe(false);
  });

  it('treats multiple top-level blocks as multiline', () => {
    expect(isMultilineDraftDoc(fakeDoc(2))).toBe(true);
  });

  it('treats a hard break inside a single block as multiline', () => {
    expect(isMultilineDraftDoc(fakeDoc(1, [paragraph(), text(), hardBreak(), text()]))).toBe(true);
  });

  it('treats a structured list with multiple items as multiline', () => {
    // 单个顶层 bulletList,两个 listItem 各含一个 paragraph textblock。
    expect(
      isMultilineDraftDoc(
        fakeDoc(1, [bulletList(), listItem(), paragraph(), text(), listItem(), paragraph(), text()]),
      ),
    ).toBe(true);
  });

  it('keeps a single-item list single-line', () => {
    expect(isMultilineDraftDoc(fakeDoc(1, [bulletList(), listItem(), paragraph(), text()]))).toBe(
      false,
    );
  });

  it('treats a text node carrying newlines as multiline (e.g. voice transcript via insertText)', () => {
    expect(isMultilineDraftDoc(fakeDoc(1, [paragraph(), text('line one\nline two')]))).toBe(true);
    expect(isMultilineDraftDoc(fakeDoc(1, [paragraph(), text('single line')]))).toBe(false);
  });

  it('treats a collapsed paste chip carrying newlines as multiline', () => {
    expect(
      isMultilineDraftDoc(fakeDoc(1, [paragraph(), text(), pastedChip('line one\nline two')])),
    ).toBe(true);
  });

  it('keeps a single-line paste chip single-line', () => {
    expect(isMultilineDraftDoc(fakeDoc(1, [paragraph(), pastedChip('one line only')]))).toBe(false);
  });

  it('treats a quote chip as multiline even when the quoted text is single-line', () => {
    // formatQuoteForSend 无条件输出 marker 行 + 引用行,发送结果必然跨行。
    expect(isMultilineDraftDoc(fakeDoc(1, [paragraph(), quoteChip('one line quote')]))).toBe(true);
  });

  it('stops descending once multiline is confirmed', () => {
    let visits = 0;
    const doc = {
      childCount: 1,
      descendants: (fn: (node: FakeNode) => boolean | void) => {
        for (const node of [paragraph(), hardBreak(), text(), text()]) {
          visits += 1;
          if (fn(node) === false) return;
        }
      },
    };
    expect(isMultilineDraftDoc(doc)).toBe(true);
    expect(visits).toBe(2);
  });
});
