import { describe, expect, it } from 'vitest';

import {
  composerDocumentContainsHostCapabilityChip,
  insertComposerDocumentForRestore,
  normalizeComposerDocumentJSON,
  plainTextToComposerDocument,
  stripHostCapabilityChips,
} from '@/lib/composerListDocument';

const bulletListDocument = (text: string) => ({
  type: 'doc',
  content: [
    {
      type: 'bulletList',
      content: [
        {
          type: 'listItem',
          content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
        },
      ],
    },
  ],
});

describe('composer list document normalization', () => {
  it('promotes plain ordered rows into one structured list', () => {
    expect(plainTextToComposerDocument('1. first\n2. second')).toEqual({
      type: 'doc',
      content: [
        {
          type: 'orderedList',
          attrs: { start: 1, marker: '.' },
          content: [
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'first' }] }],
            },
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'second' }] }],
            },
          ],
        },
      ],
    });
  });

  it('restores a generated seven-digit ordered continuation as one list', () => {
    const document = plainTextToComposerDocument('999999. first\n1000000. second');
    expect(document.content?.[0]).toMatchObject({
      type: 'orderedList',
      attrs: { start: 999999, marker: '.' },
    });
    expect(document.content?.[0]?.content).toHaveLength(2);
  });

  it('restores a generated eight-digit ordered continuation as one list', () => {
    const document = plainTextToComposerDocument('9999999. first\n10000000. second');
    expect(document.content?.[0]).toMatchObject({
      type: 'orderedList',
      attrs: { start: 9999999, marker: '.' },
    });
    expect(document.content?.[0]?.content).toHaveLength(2);
  });

  it('keeps surrounding paragraphs and task bodies intact', () => {
    expect(plainTextToComposerDocument('intro\n- [ ] todo\n- [x] done\noutro')).toEqual({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'intro' }] },
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: '[ ] todo' }] }],
            },
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: '[x] done' }] }],
            },
          ],
        },
        { type: 'paragraph', content: [{ type: 'text', text: 'outro' }] },
      ],
    });
  });

  it('does not consume indented rows as top-level lists', () => {
    expect(plainTextToComposerDocument('1. parent\n  - child')).toEqual({
      type: 'doc',
      content: [
        {
          type: 'orderedList',
          attrs: { start: 1, marker: '.' },
          content: [
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'parent' }] }],
            },
          ],
        },
        { type: 'paragraph', content: [{ type: 'text', text: '  - child' }] },
      ],
    });
  });

  it('strips each ordered marker at its own width and ignores decimal text', () => {
    expect(plainTextToComposerDocument('9. nine\n10. ten').content?.[0]?.content).toEqual([
      {
        type: 'listItem',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'nine' }] }],
      },
      {
        type: 'listItem',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'ten' }] }],
      },
    ]);
    expect(plainTextToComposerDocument('3.14159')).toEqual({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: '3.14159' }] }],
    });
  });

  it('keeps non-contiguous ordered rows as separate lists', () => {
    expect(
      normalizeComposerDocumentJSON({
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: '1. first' },
              { type: 'hardBreak' },
              { type: 'text', text: '3. third' },
            ],
          },
        ],
      }),
    ).toEqual({
      type: 'doc',
      content: [
        {
          type: 'orderedList',
          attrs: { start: 1, marker: '.' },
          content: [
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'first' }] }],
            },
          ],
        },
        {
          type: 'orderedList',
          attrs: { start: 3, marker: '.' },
          content: [
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'third' }] }],
            },
          ],
        },
      ],
    });
  });

  it('keeps optional spaces after CJK ordered markers in item text', () => {
    expect(plainTextToComposerDocument('2、项目\n3、 项目')).toEqual({
      type: 'doc',
      content: [
        {
          type: 'orderedList',
          attrs: { start: 2, marker: '、', separator: '' },
          content: [
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: '项目' }] }],
            },
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: ' 项目' }] }],
            },
          ],
        },
      ],
    });
  });

  it('preserves accepted unordered marker syntax and spacing', () => {
    expect(plainTextToComposerDocument('+   item\n• next')).toEqual({
      type: 'doc',
      content: [
        {
          type: 'bulletList',
          attrs: { marker: '+', separator: '   ' },
          content: [
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'item' }] }],
            },
          ],
        },
        {
          type: 'bulletList',
          attrs: { marker: '•', separator: ' ' },
          content: [
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'next' }] }],
            },
          ],
        },
      ],
    });
  });

  it('preserves non-default ordered marker spacing', () => {
    expect(plainTextToComposerDocument('1.   item\n2.\tsecond')).toEqual({
      type: 'doc',
      content: [
        {
          type: 'orderedList',
          attrs: { start: 1, marker: '.', separator: '   ' },
          content: [
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'item' }] }],
            },
          ],
        },
        {
          type: 'orderedList',
          attrs: { start: 2, marker: '.', separator: '\t' },
          content: [
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'second' }] }],
            },
          ],
        },
      ],
    });
  });

  it('does not promote marker-shaped lines inside fenced code', () => {
    expect(plainTextToComposerDocument('before\n```js\n1. literal\n```\n2. real')).toEqual({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'before' }] },
        { type: 'paragraph', content: [{ type: 'text', text: '```js' }] },
        { type: 'paragraph', content: [{ type: 'text', text: '1. literal' }] },
        { type: 'paragraph', content: [{ type: 'text', text: '```' }] },
        {
          type: 'orderedList',
          attrs: { start: 2, marker: '.' },
          content: [
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'real' }] }],
            },
          ],
        },
      ],
    });
  });

  it('keeps multiline paragraphs intact while inside a fenced code block', () => {
    const document = {
      type: 'doc' as const,
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: '```' }] },
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: '1. literal' },
            { type: 'hardBreak' },
            { type: 'text', text: '2. literal' },
          ],
        },
        { type: 'paragraph', content: [{ type: 'text', text: '```' }] },
      ],
    };

    const normalized = normalizeComposerDocumentJSON(document);
    expect(normalized.content?.[1]).toEqual(document.content[1]);
  });

  it('leaves existing structured content unchanged', () => {
    const document = {
      type: 'doc' as const,
      content: [
        {
          type: 'orderedList',
          attrs: { start: 3, marker: ')' },
          content: [
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'existing' }] }],
            },
          ],
        },
      ],
    };
    expect(normalizeComposerDocumentJSON(document)).toEqual(document);
  });

  it('restores a failed send before text entered while it was waiting', () => {
    expect(
      insertComposerDocumentForRestore(
        {
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'failed send' }] }],
        },
        {
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'new draft' }] }],
        },
      ).document,
    ).toEqual({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'failed send' }] },
        { type: 'paragraph' },
        { type: 'paragraph', content: [{ type: 'text', text: 'new draft' }] },
      ],
    });
  });

  it('inserts consecutive failed sends at a stable FIFO cursor', () => {
    const current = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'C' }] }],
    };
    const first = insertComposerDocumentForRestore(
      {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'A' }] }],
      },
      current,
    );
    const second = insertComposerDocumentForRestore(
      {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'B' }] }],
      },
      first.document,
      first.nextInsertAt,
    );

    expect(second.document.content).toEqual([
      { type: 'paragraph', content: [{ type: 'text', text: 'A' }] },
      { type: 'paragraph' },
      { type: 'paragraph', content: [{ type: 'text', text: 'B' }] },
      { type: 'paragraph' },
      { type: 'paragraph', content: [{ type: 'text', text: 'C' }] },
    ]);
  });

  it('keeps compatible lists separate across a recovery boundary', () => {
    expect(
      insertComposerDocumentForRestore(
        {
          type: 'doc',
          content: [
            {
              type: 'bulletList',
              content: [
                {
                  type: 'listItem',
                  content: [
                    { type: 'paragraph', content: [{ type: 'text', text: 'failed item' }] },
                  ],
                },
              ],
            },
          ],
        },
        {
          type: 'doc',
          content: [
            {
              type: 'bulletList',
              content: [
                {
                  type: 'listItem',
                  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'new item' }] }],
                },
              ],
            },
          ],
        },
      ).document,
    ).toEqual({
      type: 'doc',
      content: [
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'failed item' }] }],
            },
          ],
        },
        { type: 'paragraph' },
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'new item' }] }],
            },
          ],
        },
      ],
    });
  });

  it('keeps consecutive compatible list recoveries in FIFO order', () => {
    const first = insertComposerDocumentForRestore(
      bulletListDocument('A'),
      bulletListDocument('C'),
    );
    const second = insertComposerDocumentForRestore(
      bulletListDocument('B'),
      first.document,
      first.nextInsertAt,
    );

    expect(second.document.content).toEqual([
      bulletListDocument('A').content[0],
      { type: 'paragraph' },
      bulletListDocument('B').content[0],
      { type: 'paragraph' },
      bulletListDocument('C').content[0],
    ]);
  });
});

describe('stripHostCapabilityChips', () => {
  const hostCapabilityChip = () => ({
    type: 'mentionChip',
    attrs: {
      kind: 'plugin-capability',
      label: 'iOS Simulator',
      path: 'ios-simulator',
      pluginId: 'cindy-ios-simulator',
      sourceLabel: 'iOS Simulator',
    },
  });

  it('removes host capability chips while preserving surrounding text', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            hostCapabilityChip(),
            { type: 'text', text: ' ' },
            { type: 'text', text: '打开模拟器' },
          ],
        },
      ],
    };

    expect(stripHostCapabilityChips(doc)).toEqual({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: ' ' },
            { type: 'text', text: '打开模拟器' },
          ],
        },
      ],
    });
  });

  it('leaves non-capability chips (slash / session / plugin-resource) untouched', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'mentionChip', attrs: { kind: 'slash', label: '/plan', path: '/plan' } },
            { type: 'text', text: '继续' },
          ],
        },
      ],
    };

    expect(stripHostCapabilityChips(doc)).toEqual(doc);
  });

  it('recursively strips chips nested inside lists', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [
                {
                  type: 'paragraph',
                  content: [hostCapabilityChip(), { type: 'text', text: '第一条' }],
                },
              ],
            },
          ],
        },
      ],
    };

    expect(stripHostCapabilityChips(doc)).toEqual({
      type: 'doc',
      content: [
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [
                {
                  type: 'paragraph',
                  content: [{ type: 'text', text: '第一条' }],
                },
              ],
            },
          ],
        },
      ],
    });
  });

  it('composerDocumentContainsHostCapabilityChip detects chips but ignores other nodes', () => {
    expect(
      composerDocumentContainsHostCapabilityChip({
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              hostCapabilityChip(),
              { type: 'text', text: ' ' },
              { type: 'text', text: '打开模拟器' },
            ],
          },
        ],
      }),
    ).toBe(true);

    expect(
      composerDocumentContainsHostCapabilityChip({
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'mentionChip', attrs: { kind: 'slash', label: '/plan', path: '/plan' } },
              { type: 'text', text: '继续' },
            ],
          },
        ],
      }),
    ).toBe(false);
  });
});
