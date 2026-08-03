// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { Editor, Node } from '@tiptap/core';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import HardBreak from '@tiptap/extension-hard-break';
import { AllSelection, TextSelection } from '@tiptap/pm/state';

import {
  ComposerBulletList,
  ComposerListItem,
  ComposerOrderedList,
  handleStructuredListBackspace,
  handleStructuredListBreak,
  isTopLevelBlockSelection,
  isTrailingEmptyTopLevelParagraph,
  promoteTrailingPlainListParagraph,
} from '@/components/new-chat/ComposerListNodes';
import {
  serializeEditorContent,
  serializeEditorSlice,
} from '@/components/new-chat/composerContentSerialization';
import { parseChatQuoteSegments } from '@/lib/chatQuotes';
import { COMPOSER_QUOTE_NODE_TYPE } from '@/lib/composerQuoteDocument';

const TestMentionChip = Node.create({
  name: 'mentionChip',
  inline: true,
  group: 'inline',
  atom: true,
  addAttributes() {
    return {
      kind: { default: 'file' },
      label: { default: '' },
      path: { default: '' },
      titled: { default: false },
      agentText: { default: undefined },
      agentTextTruncated: { default: undefined },
      sourceLabel: { default: undefined },
      sourceDescription: { default: undefined },
    };
  },
  renderHTML({ HTMLAttributes }) {
    return ['span', HTMLAttributes];
  },
});

const TestPastedTextChip = Node.create({
  name: 'pastedTextChip',
  inline: true,
  group: 'inline',
  atom: true,
  addAttributes() {
    return {
      text: { default: '' },
      display: { default: '' },
    };
  },
  renderHTML({ HTMLAttributes }) {
    return ['span', HTMLAttributes];
  },
});

const TestQuote = Node.create({
  name: COMPOSER_QUOTE_NODE_TYPE,
  inline: true,
  group: 'inline',
  atom: true,
  addAttributes() {
    return {
      text: { default: '' },
      sourcePath: { default: null },
      startLine: { default: null },
      endLine: { default: null },
    };
  },
  renderHTML({ HTMLAttributes }) {
    return ['span', HTMLAttributes];
  },
});

const editors: Editor[] = [];

function makeEditor(content?: Record<string, unknown>): Editor {
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: [
      Document,
      Paragraph,
      Text,
      ComposerListItem,
      ComposerBulletList,
      ComposerOrderedList,
      HardBreak,
      TestMentionChip,
      TestPastedTextChip,
      TestQuote,
    ],
    content: content ?? { type: 'doc', content: [{ type: 'paragraph' }] },
  });
  editors.push(editor);
  return editor;
}

function typeThroughInputRules(editor: Editor, text: string): void {
  for (const character of text) {
    const { from, to } = editor.state.selection;
    const handled =
      editor.view.someProp('handleTextInput', (handler) =>
        handler(editor.view, from, to, character, () =>
          editor.state.tr.insertText(character, from, to),
        ),
      ) === true;
    if (!handled) {
      editor.view.dispatch(editor.state.tr.insertText(character, from, to));
    }
  }
}

function selectDocumentEnd(editor: Editor): void {
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.atEnd(editor.state.doc)));
}

afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy();
});

describe('composer structured list input rules', () => {
  it.each([
    {
      typed: '- ',
      listType: 'bulletList',
      attrs: {},
    },
    {
      typed: '• ',
      listType: 'bulletList',
      attrs: { marker: '•', separator: ' ' },
    },
    {
      typed: '1. ',
      listType: 'orderedList',
      attrs: { start: 1, marker: '.' },
    },
    {
      typed: '3) ',
      listType: 'orderedList',
      attrs: { start: 3, marker: ')' },
    },
    {
      typed: '10000000. ',
      listType: 'orderedList',
      attrs: { start: 10000000, marker: '.' },
    },
    {
      typed: '2、',
      listType: 'orderedList',
      attrs: { start: 2, marker: '、' },
    },
  ])('turns $typed into a $listType node', ({ typed, listType, attrs }) => {
    const editor = makeEditor();

    typeThroughInputRules(editor, typed);

    const list = editor.state.doc.firstChild;
    expect(list?.type.name).toBe(listType);
    expect(list?.attrs).toMatchObject(attrs);
    expect(list?.firstChild?.type.name).toBe('listItem');
    expect(list?.firstChild?.firstChild?.type.name).toBe('paragraph');
  });

  it('does not promote an indented marker to a top-level list', () => {
    const editor = makeEditor();

    typeThroughInputRules(editor, '  - ');

    expect(editor.state.doc.firstChild?.type.name).toBe('paragraph');
    expect(editor.state.doc.firstChild?.textContent).toBe('  - ');
  });

  it.each(['0. ', '0001. '])('keeps %s as plain text', (typed) => {
    const editor = makeEditor();

    typeThroughInputRules(editor, typed);

    expect(editor.state.doc.firstChild?.type.name).toBe('paragraph');
    expect(editor.state.doc.firstChild?.textContent).toBe(typed);
  });

  it('does not join an explicitly non-contiguous ordered marker with the preceding list', () => {
    const editor = makeEditor({
      type: 'doc',
      content: [
        {
          type: 'orderedList',
          attrs: { start: 1, marker: '.' },
          content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'first' }] }] }],
        },
        { type: 'paragraph' },
      ],
    });
    selectDocumentEnd(editor);

    typeThroughInputRules(editor, '3. ');

    expect(editor.state.doc.childCount).toBe(2);
    expect(editor.state.doc.firstChild?.type.name).toBe('orderedList');
    expect(editor.state.doc.firstChild?.childCount).toBe(1);
    expect(editor.state.doc.lastChild?.type.name).toBe('orderedList');
    expect(editor.state.doc.lastChild?.attrs.start).toBe(3);
  });

  it('reserves enough marker width for long ordered-list numbers', () => {
    const editor = makeEditor();

    typeThroughInputRules(editor, '123456. ');

    expect(editor.view.dom.querySelector('ol')?.getAttribute('data-marker-digits')).toBe('6');
  });

  it.each([
    {
      typed: '- ',
      listType: 'bulletList',
      attrs: {},
    },
    {
      typed: '1. ',
      listType: 'orderedList',
      attrs: { start: 1, marker: '.' },
    },
  ])(
    'turns $typed after a hard break into the same structured $listType',
    ({ typed, listType, attrs }) => {
      const editor = makeEditor({
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'intro' }, { type: 'hardBreak' }],
          },
        ],
      });
      selectDocumentEnd(editor);

      typeThroughInputRules(editor, typed);

      expect(editor.getJSON().content).toEqual([
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'intro' }],
        },
        {
          type: listType,
          ...(listType === 'bulletList'
            ? { attrs: { marker: '-', separator: ' ', ...attrs } }
            : listType === 'orderedList'
              ? { attrs: { separator: ' ', ...attrs } }
              : Object.keys(attrs).length > 0
                ? { attrs }
                : {}),
          content: [
            {
              type: 'listItem',
              content: [{ type: 'paragraph' }],
            },
          ],
        },
      ]);
    },
  );

  it('turns a marker after an empty hard-break paragraph following a list into structure', () => {
    const editor = makeEditor({
      type: 'doc',
      content: [
        {
          type: 'orderedList',
          attrs: { start: 1, marker: '.' },
          content: [
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'item' }] }],
            },
          ],
        },
        {
          type: 'paragraph',
          content: [{ type: 'hardBreak' }],
        },
      ],
    });
    selectDocumentEnd(editor);

    typeThroughInputRules(editor, '1. 12e21ed');

    const list = editor.state.doc.lastChild;
    expect(list?.type.name).toBe('orderedList');
    expect(list?.attrs).toMatchObject({ start: 1, marker: '.' });
    expect(list?.lastChild?.textContent).toBe('12e21ed');
  });

  it('keeps markers literal after a hard break inside a fenced code block', () => {
    const editor = makeEditor({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: '```' }, { type: 'hardBreak' }],
        },
      ],
    });
    selectDocumentEnd(editor);

    typeThroughInputRules(editor, '1. ');

    expect(editor.state.doc.firstChild?.type.name).toBe('paragraph');
    expect(editor.state.doc.firstChild?.textContent).toBe('```1. ');
  });

  it('keeps hard-break markers literal after a preceding open fence', () => {
    const editor = makeEditor({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: '```' }] },
        { type: 'paragraph', content: [{ type: 'hardBreak' }] },
      ],
    });
    selectDocumentEnd(editor);

    typeThroughInputRules(editor, '1. ');

    expect(editor.state.doc.lastChild?.type.name).toBe('paragraph');
    expect(editor.state.doc.lastChild?.textContent).toBe('1. ');
  });

  it('keeps ordinary list markers literal after a preceding open fence', () => {
    const editor = makeEditor({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: '```' }] },
        { type: 'paragraph' },
      ],
    });
    selectDocumentEnd(editor);

    typeThroughInputRules(editor, '1. ');

    expect(editor.state.doc.lastChild?.type.name).toBe('paragraph');
    expect(editor.state.doc.lastChild?.textContent).toBe('1. ');
  });
});

describe('composer structured list keyboard commands', () => {
  it('splits a non-empty item and exits from the empty continuation item', () => {
    const editor = makeEditor({
      type: 'doc',
      content: [
        {
          type: 'orderedList',
          attrs: { start: 1, marker: '.' },
          content: [
            {
              type: 'listItem',
              content: [
                {
                  type: 'paragraph',
                  content: [{ type: 'text', text: 'first' }],
                },
              ],
            },
          ],
        },
      ],
    });
    selectDocumentEnd(editor);

    expect(handleStructuredListBreak(editor.view)).toBe(true);
    expect(editor.state.doc.firstChild?.childCount).toBe(2);
    expect(editor.state.selection.$from.parent.type.name).toBe('paragraph');
    expect(editor.state.selection.$from.parent.content.size).toBe(0);

    expect(handleStructuredListBreak(editor.view)).toBe(true);
    expect(editor.getJSON().content).toEqual([
      {
        type: 'orderedList',
        attrs: { start: 1, marker: '.', separator: ' ' },
        content: [
          {
            type: 'listItem',
            content: [
              {
                type: 'paragraph',
                content: [{ type: 'text', text: 'first' }],
              },
            ],
          },
        ],
      },
      { type: 'paragraph' },
    ]);
  });

  it('lifts an empty list item on Backspace', () => {
    const editor = makeEditor({
      type: 'doc',
      content: [
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [{ type: 'paragraph' }],
            },
          ],
        },
      ],
    });
    selectDocumentEnd(editor);

    expect(handleStructuredListBackspace(editor.view)).toBe(true);
    expect(editor.getJSON().content).toEqual([{ type: 'paragraph' }]);
  });

  it('does not lift a non-empty item from a later empty paragraph', () => {
    const editor = makeEditor({
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
                  content: [{ type: 'text', text: 'kept content' }],
                },
                { type: 'paragraph' },
              ],
            },
          ],
        },
      ],
    });
    selectDocumentEnd(editor);

    expect(handleStructuredListBackspace(editor.view)).toBe(false);
    expect(editor.state.doc.firstChild?.type.name).toBe('bulletList');
  });

  it('continues task syntax as an unchecked item and exits from an empty task', () => {
    const editor = makeEditor({
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
                  content: [{ type: 'text', text: '[x] completed' }],
                },
              ],
            },
          ],
        },
      ],
    });
    selectDocumentEnd(editor);

    expect(handleStructuredListBreak(editor.view)).toBe(true);
    const list = editor.state.doc.firstChild;
    expect(list?.childCount).toBe(2);
    expect(list?.lastChild?.textContent).toBe('[ ] ');
    expect(serializeEditorContent(editor).text).toBe('- [x] completed\n- [ ]');

    expect(handleStructuredListBreak(editor.view)).toBe(true);
    expect(editor.getJSON().content).toEqual([
      {
        type: 'bulletList',
        attrs: { marker: '-', separator: ' ' },
        content: [
          {
            type: 'listItem',
            content: [
              {
                type: 'paragraph',
                content: [{ type: 'text', text: '[x] completed' }],
              },
            ],
          },
        ],
      },
      { type: 'paragraph' },
    ]);
  });

  it('removes an empty task prefix before lifting on Backspace', () => {
    const editor = makeEditor({
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
                  content: [{ type: 'text', text: '[ ] ' }],
                },
              ],
            },
          ],
        },
      ],
    });
    selectDocumentEnd(editor);

    expect(handleStructuredListBackspace(editor.view)).toBe(true);
    expect(editor.getJSON().content).toEqual([{ type: 'paragraph' }]);
  });

  it('treats a whitespace-only CJK marker item as empty on break', () => {
    const editor = makeEditor({
      type: 'doc',
      content: [
        {
          type: 'orderedList',
          attrs: { start: 1, marker: '、', separator: '' },
          content: [
            {
              type: 'listItem',
              content: [
                {
                  type: 'paragraph',
                  content: [{ type: 'text', text: ' ' }],
                },
              ],
            },
          ],
        },
      ],
    });
    selectDocumentEnd(editor);

    expect(handleStructuredListBreak(editor.view)).toBe(true);
    expect(editor.getJSON().content).toEqual([{ type: 'paragraph' }]);
  });

  it('does not add a task prefix when splitting before the task marker', () => {
    const editor = makeEditor({
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
                  content: [{ type: 'text', text: '[x] hello' }],
                },
              ],
            },
          ],
        },
      ],
    });
    editor.commands.setTextSelection(3);

    expect(handleStructuredListBreak(editor.view)).toBe(true);
    expect(editor.getJSON().content).toEqual([
      {
        type: 'bulletList',
        attrs: { marker: '-', separator: ' ' },
        content: [
          { type: 'listItem', content: [{ type: 'paragraph' }] },
          {
            type: 'listItem',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: '[x] hello' }] }],
          },
        ],
      },
    ]);
  });

  it('does not lift earlier content when the current paragraph only has a task prefix', () => {
    const editor = makeEditor({
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
                  content: [{ type: 'text', text: 'kept' }],
                },
                {
                  type: 'paragraph',
                  content: [{ type: 'text', text: '[ ] ' }],
                },
              ],
            },
          ],
        },
      ],
    });
    selectDocumentEnd(editor);

    expect(handleStructuredListBreak(editor.view)).toBe(false);
    expect(handleStructuredListBackspace(editor.view)).toBe(false);
    expect(editor.getJSON().content).toEqual([
      {
        type: 'bulletList',
        attrs: { marker: '-', separator: ' ' },
        content: [
          {
            type: 'listItem',
            content: [
              { type: 'paragraph', content: [{ type: 'text', text: 'kept' }] },
              { type: 'paragraph', content: [{ type: 'text', text: '[ ] ' }] },
            ],
          },
        ],
      },
    ]);
  });

  it('returns from an empty paragraph after a list to the final item on Backspace', () => {
    const editor = makeEditor({
      type: 'doc',
      content: [
        {
          type: 'orderedList',
          attrs: { start: 1, marker: '.' },
          content: [
            {
              type: 'listItem',
              content: [
                {
                  type: 'paragraph',
                  content: [{ type: 'text', text: 'first' }],
                },
              ],
            },
            {
              type: 'listItem',
              content: [
                {
                  type: 'paragraph',
                  content: [{ type: 'text', text: 'second' }],
                },
              ],
            },
          ],
        },
        { type: 'paragraph' },
      ],
    });
    selectDocumentEnd(editor);

    expect(handleStructuredListBackspace(editor.view)).toBe(true);
    expect(editor.state.doc.childCount).toBe(1);
    expect(editor.state.doc.firstChild?.childCount).toBe(2);
    expect(editor.state.selection.$from.parent.textContent).toBe('second');
    expect(editor.state.selection.$from.parentOffset).toBe('second'.length);
  });
});

describe('composer live plain-list promotion', () => {
  it('recognizes only the trailing empty top-level paragraph as a list-paste boundary', () => {
    const editor = makeEditor({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'before' }] },
        { type: 'paragraph' },
      ],
    });

    editor.commands.setTextSelection(2);
    expect(isTrailingEmptyTopLevelParagraph(editor.view)).toBe(false);

    selectDocumentEnd(editor);
    expect(isTrailingEmptyTopLevelParagraph(editor.view)).toBe(true);
  });

  it('recognizes a whole top-level paragraph selection for structured paste', () => {
    const editor = makeEditor({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'replace me' }] }],
    });
    editor.commands.setTextSelection({ from: 1, to: 11 });

    expect(isTopLevelBlockSelection(editor.view)).toBe(true);
  });

  it('promotes a trailing pasted row beside an existing structured list', () => {
    const editor = makeEditor({
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
          type: 'paragraph',
          content: [{ type: 'text', text: '1. 12e21ed' }],
        },
      ],
    });
    selectDocumentEnd(editor);

    expect(promoteTrailingPlainListParagraph(editor.view)).toBe(true);

    const list = editor.state.doc.lastChild;
    expect(list?.type.name).toBe('orderedList');
    expect(list?.lastChild?.textContent).toBe('12e21ed');
    expect(editor.state.doc.textContent).not.toContain('1. 12e21ed');
  });

  it('leaves decimal text as a paragraph', () => {
    const editor = makeEditor({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'parent' }] },
        {
          type: 'paragraph',
          content: [{ type: 'text', text: '3.14159' }],
        },
      ],
    });
    selectDocumentEnd(editor);

    expect(promoteTrailingPlainListParagraph(editor.view)).toBe(false);
    expect(editor.state.doc.lastChild?.type.name).toBe('paragraph');
  });

  it('keeps optional CJK spacing during live promotion', () => {
    const editor = makeEditor({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: '3、 项目' }],
        },
      ],
    });
    selectDocumentEnd(editor);

    expect(promoteTrailingPlainListParagraph(editor.view)).toBe(true);
    expect(serializeEditorContent(editor).text).toBe('3、 项目');
  });

  it('does not promote a multiline paragraph as one list item', () => {
    const editor = makeEditor({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: '1. first' },
            { type: 'hardBreak' },
            { type: 'text', text: '2. second' },
          ],
        },
      ],
    });
    selectDocumentEnd(editor);

    expect(promoteTrailingPlainListParagraph(editor.view)).toBe(false);
    expect(editor.state.doc.firstChild?.type.name).toBe('paragraph');
  });

  it('recognizes a whole-document selection as a top-level block selection', () => {
    const editor = makeEditor({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'first' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'second' }] },
      ],
    });
    editor.view.dispatch(editor.state.tr.setSelection(new AllSelection(editor.state.doc)));

    expect(isTopLevelBlockSelection(editor.view)).toBe(true);
  });

  it('promotes a trailing bullet-glyph row inserted outside input rules', () => {
    const editor = makeEditor({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: '• item' }],
        },
      ],
    });
    selectDocumentEnd(editor);

    expect(promoteTrailingPlainListParagraph(editor.view)).toBe(true);
    expect(editor.state.doc.firstChild?.type.name).toBe('bulletList');
    expect(editor.state.doc.firstChild?.firstChild?.textContent).toBe('item');
  });

  it('does not promote a marker inside an unclosed fenced block', () => {
    const editor = makeEditor({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: '```' }] },
        { type: 'paragraph', content: [{ type: 'text', text: '1. literal' }] },
      ],
    });
    selectDocumentEnd(editor);

    expect(promoteTrailingPlainListParagraph(editor.view)).toBe(false);
    expect(editor.state.doc.lastChild?.type.name).toBe('paragraph');
  });
});

describe('composer structured list serialization', () => {
  it('uses the full parent marker width for nested list indentation', () => {
    const editor = makeEditor({
      type: 'doc',
      content: [
        {
          type: 'orderedList',
          attrs: { start: 10, marker: '.' },
          content: [
            {
              type: 'listItem',
              content: [
                {
                  type: 'paragraph',
                  content: [{ type: 'text', text: 'parent' }],
                },
                {
                  type: 'bulletList',
                  content: [
                    {
                      type: 'listItem',
                      content: [
                        {
                          type: 'paragraph',
                          content: [{ type: 'text', text: 'child' }],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });

    expect(serializeEditorContent(editor).text).toBe('10. parent\n    - child');
  });

  it('preserves the optional space after CJK ordered markers', () => {
    const editor = makeEditor({
      type: 'doc',
      content: [
        {
          type: 'orderedList',
          attrs: { start: 2, marker: '、' },
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

    expect(serializeEditorContent(editor).text).toBe('2、项目\n3、 项目');
  });

  it('keeps list markers when copying a selected structured fragment', () => {
    const editor = makeEditor({
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

    const slice = editor.state.doc.slice(0, editor.state.doc.content.size);
    expect(serializeEditorSlice(editor, slice)).toBe('1. first\n2. second');
  });

  it('keeps the original ordinal when copying from the middle of an ordered list', () => {
    const editor = makeEditor({
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
    let secondTextPosition = 0;
    editor.state.doc.descendants((node, position) => {
      if (node.isText && node.text === 'second') secondTextPosition = position;
    });
    editor.commands.setTextSelection(secondTextPosition + 1);
    const slice = editor.state.doc.slice(secondTextPosition, editor.state.doc.content.size);

    expect(serializeEditorSlice(editor, slice)).toBe('2. second');
  });

  it('preserves non-default bullet markers and spacing when sending', () => {
    const editor = makeEditor({
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
      ],
    });

    expect(serializeEditorContent(editor).text).toBe('+   item');
  });

  it('preserves non-default ordered marker spacing when sending', () => {
    const editor = makeEditor({
      type: 'doc',
      content: [
        {
          type: 'orderedList',
          attrs: { start: 1, marker: '.', separator: '\t' },
          content: [
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'item' }] }],
            },
          ],
        },
      ],
    });

    expect(serializeEditorContent(editor).text).toBe('1.\titem');
  });

  it('expands tab separators when indenting nested list content', () => {
    const editor = makeEditor({
      type: 'doc',
      content: [
        {
          type: 'bulletList',
          attrs: { marker: '-', separator: '\t' },
          content: [
            {
              type: 'listItem',
              content: [
                { type: 'paragraph', content: [{ type: 'text', text: 'parent' }] },
                {
                  type: 'bulletList',
                  content: [
                    {
                      type: 'listItem',
                      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'child' }] }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });

    expect(serializeEditorContent(editor).text).toBe('-\tparent\n    - child');
  });

  it('indents hard-break continuation lines inside a list item', () => {
    const editor = makeEditor({
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
                  content: [
                    { type: 'text', text: 'first' },
                    { type: 'hardBreak' },
                    { type: 'text', text: 'second' },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });

    expect(serializeEditorContent(editor).text).toBe('- first\n  second');
  });

  it('indents multiline pasted-text chips inside a list item', () => {
    const editor = makeEditor({
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
                  content: [
                    { type: 'text', text: 'prefix ' },
                    {
                      type: 'pastedTextChip',
                      attrs: { text: 'first\nsecond', display: 'Pasted text (2 lines)' },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });

    const serialized = serializeEditorContent(editor);
    expect(serialized.text).toBe('- prefix first\n  second');
    expect(serialized.pastedTextRanges).toEqual([
      {
        start: '- prefix '.length,
        end: serialized.text.length,
        display: 'Pasted text (2 lines)',
      },
    ]);
  });

  it('keeps a dragged quote inside its list item', () => {
    const editor = makeEditor({
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
                  content: [
                    { type: 'text', text: 'before' },
                    { type: COMPOSER_QUOTE_NODE_TYPE, attrs: { text: 'quoted' } },
                    { type: 'text', text: 'after' },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });

    const serialized = serializeEditorContent(editor).text;
    expect(serialized).toBe(
      '- before\n  > <!-- cindy-composer-quote -->\n  > quoted\n  after',
    );
    expect(parseChatQuoteSegments(serialized)).toEqual([
      { kind: 'text', text: '- before' },
      { kind: 'quote', quote: { text: 'quoted' } },
      { kind: 'text', text: '  after' },
    ]);
  });

  it('keeps a restored nested list quote under its literal list row', () => {
    const editor = makeEditor({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'parent' }] },
        { type: 'paragraph', content: [{ type: 'text', text: '  - child' }] },
        {
          type: 'paragraph',
          content: [{ type: COMPOSER_QUOTE_NODE_TYPE, attrs: { text: 'quoted' } }],
        },
      ],
    });

    const serialized = serializeEditorContent(editor).text;
    expect(serialized).toBe(
      'parent\n  - child\n    > <!-- cindy-composer-quote -->\n    > quoted',
    );
    expect(parseChatQuoteSegments(serialized)).toEqual([
      { kind: 'text', text: 'parent\n  - child' },
      { kind: 'quote', quote: { text: 'quoted' } },
    ]);
  });

  it('indents a restored quote after a no-space CJK list marker', () => {
    const editor = makeEditor({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'parent' }] },
        { type: 'paragraph', content: [{ type: 'text', text: '  2、项目' }] },
        {
          type: 'paragraph',
          content: [{ type: COMPOSER_QUOTE_NODE_TYPE, attrs: { text: 'quoted' } }],
        },
      ],
    });

    expect(serializeEditorContent(editor).text).toBe(
      'parent\n  2、项目\n    > <!-- cindy-composer-quote -->\n    > quoted',
    );
  });

  it('keeps an inline restored quote under its literal list row', () => {
    const editor = makeEditor({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'parent' }] },
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: '  - child' },
            { type: COMPOSER_QUOTE_NODE_TYPE, attrs: { text: 'quoted' } },
          ],
        },
      ],
    });

    expect(serializeEditorContent(editor).text).toBe(
      'parent\n  - child\n    > <!-- cindy-composer-quote -->\n    > quoted',
    );
  });

  it('keeps quote-like reply text separate from a list quote chip', () => {
    const editor = makeEditor({
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
                  content: [
                    { type: COMPOSER_QUOTE_NODE_TYPE, attrs: { text: 'quoted' } },
                    { type: 'text', text: '> reply' },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });

    const serialized = serializeEditorContent(editor).text;
    expect(parseChatQuoteSegments(serialized)).toEqual([
      { kind: 'text', text: '- ' },
      { kind: 'quote', quote: { text: 'quoted' } },
      { kind: 'text', text: '  > reply' },
    ]);
  });

  it('keeps a bare quote marker separate from a list quote chip', () => {
    const editor = makeEditor({
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
                  content: [
                    { type: COMPOSER_QUOTE_NODE_TYPE, attrs: { text: 'quoted' } },
                    { type: 'text', text: '>' },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });

    expect(parseChatQuoteSegments(serializeEditorContent(editor).text)).toEqual([
      { kind: 'text', text: '- ' },
      { kind: 'quote', quote: { text: 'quoted' } },
      { kind: 'text', text: '  >' },
    ]);
  });

  it('keeps a pasted quote-like chip separate from a list quote chip', () => {
    const editor = makeEditor({
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
                  content: [
                    { type: COMPOSER_QUOTE_NODE_TYPE, attrs: { text: 'quoted' } },
                    {
                      type: 'pastedTextChip',
                      attrs: { text: '> pasted reply', display: '> pasted reply' },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });

    expect(parseChatQuoteSegments(serializeEditorContent(editor).text)).toEqual([
      { kind: 'text', text: '- ' },
      { kind: 'quote', quote: { text: 'quoted' } },
      { kind: 'text', text: '  > pasted reply' },
    ]);
  });

  it('reuses a hard-break continuation line for a list quote chip', () => {
    const editor = makeEditor({
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
                  content: [
                    { type: 'text', text: 'before' },
                    { type: 'hardBreak' },
                    { type: COMPOSER_QUOTE_NODE_TYPE, attrs: { text: 'quoted' } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });

    const serialized = serializeEditorContent(editor).text;
    expect(serialized).toBe(
      '- before\n  > <!-- cindy-composer-quote -->\n  > quoted',
    );
    expect(parseChatQuoteSegments(serialized)).toEqual([
      { kind: 'text', text: '- before' },
      { kind: 'quote', quote: { text: 'quoted' } },
    ]);
  });

  it('does not duplicate an indented break after a list quote chip', () => {
    const editor = makeEditor({
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
                  content: [
                    { type: COMPOSER_QUOTE_NODE_TYPE, attrs: { text: 'quoted' } },
                    { type: 'hardBreak' },
                    { type: 'text', text: 'after' },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });

    const serialized = serializeEditorContent(editor).text;
    expect(serialized).not.toContain('\n  \n  ');
    expect(parseChatQuoteSegments(serialized)).toEqual([
      { kind: 'text', text: '- ' },
      { kind: 'quote', quote: { text: 'quoted' } },
      { kind: 'text', text: '  after' },
    ]);
  });

  it('preserves indentation on an empty nested list item', () => {
    const editor = makeEditor({
      type: 'doc',
      content: [
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [
                { type: 'paragraph', content: [{ type: 'text', text: 'parent' }] },
                {
                  type: 'bulletList',
                  content: [{ type: 'listItem', content: [{ type: 'paragraph' }] }],
                },
              ],
            },
          ],
        },
      ],
    });

    expect(serializeEditorContent(editor).text).toBe('- parent\n  - ');
  });

  it('does not duplicate restored continuation indentation after a list quote', () => {
    const editor = makeEditor({
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
                  content: [
                    { type: COMPOSER_QUOTE_NODE_TYPE, attrs: { text: 'quoted' } },
                    { type: 'text', text: '  after' },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });

    expect(serializeEditorContent(editor).text).toBe(
      '- \n  > <!-- cindy-composer-quote -->\n  > quoted\n  after',
    );
  });

  it('keeps adjacent list quote chips as separate quote segments', () => {
    const editor = makeEditor({
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
                  content: [
                    { type: COMPOSER_QUOTE_NODE_TYPE, attrs: { text: 'first' } },
                    { type: COMPOSER_QUOTE_NODE_TYPE, attrs: { text: 'second' } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });

    const serialized = serializeEditorContent(editor).text;
    expect(parseChatQuoteSegments(serialized)).toEqual([
      { kind: 'text', text: '- ' },
      { kind: 'quote', quote: { text: 'first' } },
      { kind: 'quote', quote: { text: 'second' } },
    ]);
  });

  it('preserves an empty structured list item separator at the end of serialized text', () => {
    const editor = makeEditor({
      type: 'doc',
      content: [
        {
          type: 'orderedList',
          attrs: { start: 2, marker: '.' },
          content: [{ type: 'listItem', content: [{ type: 'paragraph' }] }],
        },
      ],
    });

    expect(serializeEditorContent(editor).text).toBe('2. ');
  });

  it('preserves the trailing separator for a generated nine-digit marker', () => {
    const editor = makeEditor({
      type: 'doc',
      content: [
        {
          type: 'orderedList',
          attrs: { start: 99999999, marker: '.' },
          content: [{ type: 'listItem', content: [{ type: 'paragraph' }] }],
        },
      ],
    });

    expect(serializeEditorContent(editor).text).toBe('99999999. ');
  });

  it('keeps partial inline boundaries when copying one ordered-list item', () => {
    const editor = makeEditor({
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
    let secondTextPosition = 0;
    editor.state.doc.descendants((node, position) => {
      if (node.isText && node.text === 'second') secondTextPosition = position;
    });
    editor.commands.setTextSelection({
      from: secondTextPosition + 1,
      to: secondTextPosition + 4,
    });
    const slice = editor.state.doc.slice(
      editor.state.selection.from,
      editor.state.selection.to,
    );

    expect(serializeEditorSlice(editor, slice)).toBe('2. eco');
  });

  it('keeps the visible ordinal when copying an empty ordered-list item', () => {
    const editor = makeEditor({
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
              content: [{ type: 'paragraph' }],
            },
          ],
        },
      ],
    });
    let emptyParagraphPosition = 0;
    editor.state.doc.descendants((node, position) => {
      if (node.type.name === 'paragraph' && node.content.size === 0) {
        emptyParagraphPosition = position;
      }
    });
    editor.commands.setTextSelection(emptyParagraphPosition + 1);
    const slice = editor.state.doc.slice(
      emptyParagraphPosition,
      emptyParagraphPosition + 1,
    );

    expect(serializeEditorSlice(editor, slice)).toBe('2. ');
  });

  it('adjusts the nested ordered list that contains the copied selection start', () => {
    const editor = makeEditor({
      type: 'doc',
      content: [
        {
          type: 'orderedList',
          attrs: { start: 1, marker: '.' },
          content: [
            {
              type: 'listItem',
              content: [
                { type: 'paragraph', content: [{ type: 'text', text: 'outer-first' }] },
                {
                  type: 'orderedList',
                  attrs: { start: 5, marker: '.' },
                  content: [
                    {
                      type: 'listItem',
                      content: [
                        { type: 'paragraph', content: [{ type: 'text', text: 'nested-first' }] },
                      ],
                    },
                    {
                      type: 'listItem',
                      content: [
                        { type: 'paragraph', content: [{ type: 'text', text: 'nested-second' }] },
                      ],
                    },
                  ],
                },
              ],
            },
            {
              type: 'listItem',
              content: [
                { type: 'paragraph', content: [{ type: 'text', text: 'outer-second' }] },
              ],
            },
          ],
        },
      ],
    });
    let nestedSecondPosition = 0;
    let outerSecondPosition = 0;
    editor.state.doc.descendants((node, position) => {
      if (node.isText && node.text === 'nested-second') nestedSecondPosition = position;
      if (node.isText && node.text === 'outer-second') outerSecondPosition = position;
    });
    editor.commands.setTextSelection({
      from: nestedSecondPosition,
      to: outerSecondPosition + 'outer-second'.length,
    });
    const slice = editor.state.doc.slice(
      editor.state.selection.from,
      editor.state.selection.to,
    );

    const copied = serializeEditorSlice(editor, slice);
    expect(copied).toContain('6. nested-second');
    expect(copied).not.toContain('1. nested-second');
  });

  it('preserves nested markers and projects atom ranges into wire offsets', () => {
    const href = 'cindy://session/session-a?message=message-a';
    const editor = makeEditor({
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
                  content: [{ type: 'text', text: 'parent' }],
                },
                {
                  type: 'orderedList',
                  attrs: { start: 3, marker: ')' },
                  content: [
                    {
                      type: 'listItem',
                      content: [
                        {
                          type: 'paragraph',
                          content: [
                            { type: 'text', text: 'open ' },
                            {
                              type: 'mentionChip',
                              attrs: {
                                kind: 'session',
                                label: 'message',
                                path: href,
                                titled: false,
                              },
                            },
                            { type: 'text', text: ' then ' },
                            {
                              type: 'pastedTextChip',
                              attrs: {
                                text: 'pasted text',
                                display: 'Pasted text (1 line)',
                              },
                            },
                          ],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
            {
              type: 'listItem',
              content: [
                {
                  type: 'paragraph',
                  content: [
                    { type: 'text', text: 'read ' },
                    {
                      type: 'mentionChip',
                      attrs: {
                        kind: 'file',
                        label: 'guide.md',
                        path: 'docs/guide.md',
                      },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });

    const serialized = serializeEditorContent(editor);
    expect(serialized.text).toBe(
      `- parent\n  3) open ${href} then pasted text\n- read @docs/guide.md`,
    );
    expect(serialized.mentions).toEqual([
      { type: 'file', name: 'guide.md', path: 'docs/guide.md' },
    ]);

    const referenceStart = serialized.text.indexOf(href);
    expect(serialized.agentReferences).toEqual([
      {
        kind: 'message',
        start: referenceStart,
        end: referenceStart + href.length,
        href,
        sessionId: 'session-a',
        messageClientId: 'message-a',
      },
    ]);
    expect(
      serialized.text.slice(serialized.agentReferences[0].start, serialized.agentReferences[0].end),
    ).toBe(href);

    const pastedStart = serialized.text.indexOf('pasted text');
    expect(serialized.pastedTextRanges).toEqual([
      {
        start: pastedStart,
        end: pastedStart + 'pasted text'.length,
        display: 'Pasted text (1 line)',
      },
    ]);
  });

  it('serializes browser-tab and desktop-window chips as structured non-file references', () => {
    const tabHref = 'cindy://browser-tab/tab-1?url=https%3A%2F%2Fexample.com%2Fdocs';
    const windowHref = 'cindy://desktop-window/11/22?app=Code.exe';
    const editor = makeEditor({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'mentionChip',
              attrs: { kind: 'browser-tab', label: 'Docs', path: tabHref },
            },
            { type: 'text', text: ' and ' },
            {
              type: 'mentionChip',
              attrs: { kind: 'desktop-window', label: 'Editor', path: windowHref },
            },
          ],
        },
      ],
    });

    const serialized = serializeEditorContent(editor);
    expect(serialized.text).toBe(`[Docs](${tabHref}) and [Editor](${windowHref})`);
    expect(serialized.mentions).toEqual([]);
    expect(serialized.agentReferences).toEqual([
      {
        kind: 'browser-tab',
        start: 0,
        end: `[Docs](${tabHref})`.length,
        href: tabHref,
        tabId: 'tab-1',
        url: 'https://example.com/docs',
        title: 'Docs',
      },
      {
        kind: 'desktop-window',
        start: `[Docs](${tabHref}) and `.length,
        end: serialized.text.length,
        href: windowHref,
        windowId: 22,
        pid: 11,
        appName: 'Code.exe',
        title: 'Editor',
      },
    ]);
  });

  it('serializes Plugin business resources as opaque structured references', () => {
    const href = 'cindy://plugin-resource/issues/search_issues/ISSUE-1';
    const editor = makeEditor({
      type: 'doc',
      content: [{
        type: 'paragraph',
        content: [{
          type: 'mentionChip',
          attrs: {
            kind: 'plugin-resource',
            label: 'Fix login',
            path: href,
            sourceLabel: 'Issue Tracker',
            sourceDescription: 'Open issue',
          },
        }],
      }],
    });

    const serialized = serializeEditorContent(editor);
    expect(serialized.text).toBe(`[Fix login](${href})`);
    expect(serialized.mentions).toEqual([]);
    expect(serialized.agentReferences).toEqual([{
      kind: 'plugin-resource',
      start: 0,
      end: serialized.text.length,
      href,
      ghostId: 'issues',
      tool: 'search_issues',
      resourceId: 'ISSUE-1',
      pluginName: 'Issue Tracker',
      label: 'Fix login',
      description: 'Open issue',
    }]);
  });
});
