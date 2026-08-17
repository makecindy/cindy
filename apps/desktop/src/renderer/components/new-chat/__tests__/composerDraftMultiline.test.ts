import { describe, expect, it } from 'vitest';

import { isMultilineDraftDoc } from '../composerDraftMultiline';

interface FakeLeaf {
  type: { name: string };
  isText: boolean;
}

function fakeDoc(childCount: number, leaves: FakeLeaf[] = []): Parameters<typeof isMultilineDraftDoc>[0] {
  return {
    childCount,
    descendants: (fn) => {
      for (const leaf of leaves) {
        if (fn(leaf) === false) return;
      }
    },
  };
}

const text = (): FakeLeaf => ({ type: { name: 'text' }, isText: true });
const hardBreak = (): FakeLeaf => ({ type: { name: 'hardBreak' }, isText: false });

describe('isMultilineDraftDoc', () => {
  it('treats an empty or single-paragraph doc as single-line', () => {
    expect(isMultilineDraftDoc(fakeDoc(1))).toBe(false);
    expect(isMultilineDraftDoc(fakeDoc(1, [text()]))).toBe(false);
  });

  it('treats multiple block nodes as multiline', () => {
    expect(isMultilineDraftDoc(fakeDoc(2))).toBe(true);
  });

  it('treats a hard break inside a single block as multiline', () => {
    expect(isMultilineDraftDoc(fakeDoc(1, [text(), hardBreak(), text()]))).toBe(true);
  });

  it('stops descending once a hard break is found', () => {
    let visits = 0;
    const doc = {
      childCount: 1,
      descendants: (fn: (node: FakeLeaf) => boolean | void) => {
        for (const leaf of [hardBreak(), text(), text()]) {
          visits += 1;
          if (fn(leaf) === false) return;
        }
      },
    };
    expect(isMultilineDraftDoc(doc)).toBe(true);
    expect(visits).toBe(1);
  });
});
