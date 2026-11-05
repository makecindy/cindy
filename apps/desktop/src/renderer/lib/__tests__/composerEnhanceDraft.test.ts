import { describe, expect, it } from 'vitest';

import {
  documentFingerprint,
  documentHasStructuredNodes,
  editorIsComposing,
} from '../composerEnhanceDraft';

const plainDoc = {
  type: 'doc',
  content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'add a search box' }] },
  ],
};

describe('documentHasStructuredNodes', () => {
  it('accepts a draft that a plain-text rewrite can reproduce', () => {
    expect(documentHasStructuredNodes(plainDoc)).toBe(false);
  });

  it('rejects a draft carrying a mention chip, so enhancement cannot drop it', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'look at ' },
            { type: 'mentionChip', attrs: { kind: 'path', label: 'src', path: '/src' } },
          ],
        },
      ],
    };
    expect(documentHasStructuredNodes(doc)).toBe(true);
  });

  it('rejects a draft carrying a pasted-text chip', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'pastedTextChip', attrs: { text: 'long log' } }],
        },
      ],
    };
    expect(documentHasStructuredNodes(doc)).toBe(true);
  });

  it('rejects a draft carrying a list, whose numbering and nesting a plain text cannot restore', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'orderedList',
          attrs: { start: 3 },
          content: [
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'step one' }] }],
            },
          ],
        },
      ],
    };
    expect(documentHasStructuredNodes(doc)).toBe(true);
  });

  it('treats a missing document as plain', () => {
    expect(documentHasStructuredNodes(undefined)).toBe(false);
  });
});

describe('documentFingerprint', () => {
  it('tells two documents that differ by one character apart', () => {
    const edited = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'add a search box!' }] },
      ],
    };
    expect(documentFingerprint(edited)).not.toBe(documentFingerprint(plainDoc));
  });

  it('tells two structurally different drafts with the same words apart', () => {
    const twoParagraphs = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'add a search box' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'add a search box' }] },
      ],
    };
    expect(documentFingerprint(twoParagraphs)).not.toBe(documentFingerprint(plainDoc));
  });
});

describe('editorIsComposing', () => {
  it('reports an open IME composition', () => {
    expect(editorIsComposing({ view: { composing: true } })).toBe(true);
  });

  it('reports no composition otherwise', () => {
    expect(editorIsComposing({ view: { composing: false } })).toBe(false);
    expect(editorIsComposing({ view: null })).toBe(false);
  });
});
