// @vitest-environment jsdom
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Editor, Node as TiptapNode } from '@tiptap/core';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import HardBreak from '@tiptap/extension-hard-break';
import {
  buildListIndentDecorations,
  ComposerListIndentDecoration,
  listPrefixIndentStyle,
} from '@/components/new-chat/ComposerListIndentDecoration';
import { CjkPunctDecoration } from '@/components/new-chat/CjkPunctDecoration';
import {
  setSlashCommandRoster,
  SlashCommandDecoration,
} from '@/components/new-chat/SlashCommandDecoration';
import {
  setVoiceInputDraftDecoration,
  VoiceInputDraftDecoration,
} from '@/components/new-chat/VoiceInputDraftDecoration';
import { applyListContinuation } from '@/lib/composerListContinuation';

/**
 * composer 列表行缩进 decoration:
 * - buildListIndentDecorations 的范围计算(hardBreak 分行、多行、整行缩进);
 * - 真实编辑器集成:decoration 渲染进 DOM,打完前缀立即出现、删掉即消失;
 * - ChatInput 注册 + globals.css 样式存在的接线契约。
 */

let editor: Editor | null = null;

const TestAtom = TiptapNode.create({
  name: 'testAtom',
  inline: true,
  group: 'inline',
  atom: true,
  selectable: true,

  parseHTML() {
    return [{ tag: 'span[data-test-atom]' }];
  },

  renderHTML() {
    return ['span', { 'data-test-atom': '' }, 'chip'];
  },
});

function makeEditor(lines: string[]): Editor {
  const content: Array<Record<string, unknown>> = [];
  lines.forEach((line, i) => {
    if (i > 0) content.push({ type: 'hardBreak' });
    if (line.length > 0) content.push({ type: 'text', text: line });
  });
  editor = new Editor({
    element: document.createElement('div'),
    extensions: [
      Document,
      Paragraph,
      Text,
      HardBreak,
      TestAtom,
      ComposerListIndentDecoration,
    ],
    content: { type: 'doc', content: [{ type: 'paragraph', content }] },
  });
  return editor;
}

function indentSpans(ed: Editor): string[] {
  return Array.from(ed.view.dom.querySelectorAll('span.composer-list-line-indent')).map(
    (el) => el.textContent ?? '',
  );
}

afterEach(() => {
  editor?.destroy();
  editor = null;
  vi.useRealTimers();
});

describe('buildListIndentDecorations', () => {
  it('keeps fallback decoration for rows that have not been promoted yet', () => {
    const ed = makeEditor(['1. one', '  - nested', '> quote']);
    expect(indentSpans(ed)).toEqual(['1. one', '  - nested', '> quote']);
  });

  it('builds paired hanging-indent variables without embedding user text', () => {
    const latinStyle = listPrefixIndentStyle('2. ');
    expect(latinStyle).toContain('--composer-list-hang:1.8ch;');
    expect(latinStyle).toContain('--composer-list-hang-negative:-1.8ch;');
    expect(latinStyle).not.toContain('2. ');

    const cjkStyle = listPrefixIndentStyle('10、');
    expect(cjkStyle).toContain('--composer-list-hang:calc(2ch + 1em);');
    expect(cjkStyle).toContain('--composer-list-hang-negative:calc(-2ch - 1em);');
    expect(cjkStyle).not.toContain('10、');
  });

  it('decorates tab-indented lines with a deterministic fallback width', () => {
    const ed = makeEditor(['\t1. item']);
    const tabIndent = ed.view.dom.querySelector('.composer-list-tab-indent');
    expect(tabIndent).not.toBeNull();
    expect(tabIndent?.getAttribute('data-composer-list-prefix-length')).toBe('4');
    expect((tabIndent as HTMLElement | null)?.style.getPropertyValue('--composer-list-hang')).toBe(
      '9.8ch',
    );
  });

  it('reserves a deterministic 8ch slot for every indented tab', () => {
    expect(listPrefixIndentStyle('  \t1. ')).toContain('--composer-list-hang:10.6ch;');
    expect(listPrefixIndentStyle('\t\t1. ')).toContain('--composer-list-hang:17.8ch;');
    expect(listPrefixIndentStyle('1、\t')).toContain(
      '--composer-list-hang:calc(9ch + 1em);',
    );
  });

  it('decorates the full content of a single-line item', () => {
    const ed = makeEditor(['1. test']);
    const found = buildListIndentDecorations(ed.state.doc).find();
    expect(found).toHaveLength(1);
    expect(found[0].from).toBe(0);
    expect(found[0].to).toBe(9);
  });

  it('marks long digit and letter runs for scoped emergency breaking', () => {
    const ed = makeEditor([
      '2. 221241412423532235235325235212414',
      '3. abbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    ]);
    expect(ed.view.dom.querySelector('p.composer-list-block-indent')).toBeNull();
    expect(
      Array.from(ed.view.dom.querySelectorAll('span.composer-list-long-run-marker')).map(
        (node) => node.textContent,
      ),
    ).toEqual(['2. ', '3. ']);
    expect(
      Array.from(ed.view.dom.querySelectorAll('span.composer-list-long-run-body')).map(
        (node) => node.textContent,
      ),
    ).toEqual(['221241412423532235235325235212414', 'abbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb']);
  });

  it('keeps ordinary prose as one wrapper when it contains a long token', () => {
    const ed = makeEditor(['- review abcdefghijklmnop before sending']);
    expect(ed.view.dom.querySelector('p.composer-list-block-indent')).not.toBeNull();
    expect(ed.view.dom.querySelector('span.composer-list-long-run-body')).toBeNull();
  });

  it('keeps a recognized slash pill inside a single-line list wrapper', () => {
    editor = new Editor({
      element: document.createElement('div'),
      extensions: [
        Document,
        Paragraph,
        Text,
        HardBreak,
        SlashCommandDecoration,
        ComposerListIndentDecoration,
      ],
      content: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: '- /foo abcdefghijklmnop' }],
          },
        ],
      },
    });
    setSlashCommandRoster(editor, [{ name: 'foo', description: 'test command' }]);
    expect(editor.view.dom.querySelector('p.composer-list-fallback-container')?.textContent).toBe(
      '- /foo abcdefghijklmnop',
    );
    expect(editor.view.dom.querySelector('span.slash-cmd-pill')?.textContent).toBe('/foo');
    expect(editor.view.dom.querySelector('span.composer-list-long-run-body')).toBeNull();
  });

  it('decorates each list line independently across hardBreaks', () => {
    const ed = makeEditor(['intro', '- item', '2. x']);
    const found = buildListIndentDecorations(ed.state.doc).find();
    expect(found).toHaveLength(2);
    // "intro"(5) + br(1) → "- item" 行起点 offset 6,contentBase 1
    expect(found[0].from).toBe(7);
    expect(found[0].to).toBe(13); // 整行 "- item"
    expect(found[1].from).toBe(14);
    expect(found[1].to).toBe(18); // 整行 "2. x"
  });

  it('decorates a prefix-only line (即时反馈:刚打完 `1. ` 就缩进)', () => {
    const ed = makeEditor(['1. ']);
    expect(buildListIndentDecorations(ed.state.doc).find()).toHaveLength(1);
  });

  it('does not decorate ordered-dot CJK text without a separator space', () => {
    const ed = makeEditor(['5.我']);
    expect(buildListIndentDecorations(ed.state.doc).find()).toHaveLength(0);
  });

  it('does not decorate plain text lines', () => {
    const ed = makeEditor(['hello world', '3.14159']);
    expect(buildListIndentDecorations(ed.state.doc).find()).toHaveLength(0);
  });

  it('uses a paragraph fallback so inline atoms keep their geometry', () => {
    editor = new Editor({
      element: document.createElement('div'),
      extensions: [Document, Paragraph, Text, HardBreak, TestAtom, ComposerListIndentDecoration],
      content: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: '- before ' },
              { type: 'testAtom' },
              { type: 'text', text: ' after' },
            ],
          },
        ],
      },
    });
    expect(editor.view.dom.querySelector('p.composer-list-fallback-container')).not.toBeNull();
    expect(editor.view.dom.querySelector('span.composer-list-fallback-prefix')?.textContent).toBe(
      '- ',
    );
    expect(
      editor.view.dom
        .querySelector('[data-test-atom]')
        ?.classList.contains('composer-list-line-indent'),
    ).toBe(false);
  });

  it('chooses the widest complete fallback prefix instead of combining their units', () => {
    editor = new Editor({
      element: document.createElement('div'),
      extensions: [Document, Paragraph, Text, HardBreak, TestAtom, ComposerListIndentDecoration],
      content: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: '10. before ' },
              { type: 'testAtom' },
              { type: 'hardBreak' },
              { type: 'text', text: '1、next' },
            ],
          },
        ],
      },
    });
    const container = editor.view.dom.querySelector<HTMLElement>(
      'p.composer-list-fallback-container',
    );
    expect(container?.style.getPropertyValue('--composer-list-fallback-indent')).toBe(
      'max(2.8ch, calc(1ch + 1em))',
    );
    expect(container?.getAttribute('style')).not.toContain('calc(2.8ch + 1em)');
  });
});

describe('ComposerListIndentDecoration in a real editor', () => {
  it('keeps the automatically inserted ordered prefix indented before body input', () => {
    editor = new Editor({
      element: document.createElement('div'),
      extensions: [Document, Paragraph, Text, HardBreak, ComposerListIndentDecoration],
      content: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: '1. 第一项' }],
          },
        ],
      },
    });
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);

    expect(applyListContinuation(editor.view)).toBe(true);
    expect(editor.state.doc.textBetween(0, editor.state.doc.content.size, '\n', '\n')).toBe(
      '1. 第一项\n2. ',
    );

    const indentedRows = editor.view.dom.querySelectorAll('.composer-list-fallback-prefix');
    expect(indentedRows).toHaveLength(2);
    expect(indentedRows[1]?.textContent).toBe('2. ');

    editor.commands.insertContent('中文');
    expect(editor.state.doc.textBetween(0, editor.state.doc.content.size, '\n', '\n')).toBe(
      '1. 第一项\n2. 中文',
    );
    expect(editor.view.dom.querySelectorAll('.composer-list-fallback-prefix')).toHaveLength(2);
  });

  it('does not rewrite decoration-owned styles while laying out multiline CJK lists', () => {
    const getBoundingClientRect = vi.fn(() => ({
      width: 24,
      height: 22,
      top: 0,
      right: 24,
      bottom: 22,
      left: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }));
    const originalDescriptor = Object.getOwnPropertyDescriptor(
      Range.prototype,
      'getBoundingClientRect',
    );
    Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
      configurable: true,
      value: getBoundingClientRect,
    });

    try {
      editor = new Editor({
        element: document.createElement('div'),
        extensions: [
          Document,
          Paragraph,
          Text,
          HardBreak,
          CjkPunctDecoration,
          ComposerListIndentDecoration,
        ],
        content: {
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [
                { type: 'text', text: '1. 有新增游戏数的用户数、占全部用户比例。' },
                { type: 'hardBreak' },
                { type: 'text', text: '2. 有新增游戏数的近30天、近1年活跃用户数及占比。' },
                { type: 'hardBreak' },
                {
                  type: 'text',
                  text: '3. 每人新增游戏数的均值、P50、P75、P90、P95、P99、最大值。',
                },
              ],
            },
          ],
        },
      });

      // Force a plugin-view update after the decoration DOM is mounted. Directly
      // writing measured pixels back to these nodes makes ProseMirror's
      // DOMObserver restore the declared decoration styles in Chromium, which
      // can create an update loop and freeze the renderer.
      editor.view.updateState(editor.state);

      expect(getBoundingClientRect).not.toHaveBeenCalled();
      expect(
        editor.view.dom
          .querySelector<HTMLElement>('.composer-list-fallback-prefix')
          ?.style.getPropertyValue('--composer-list-hang'),
      ).toBe('1.8ch');
      expect(
        editor.view.dom
          .querySelector<HTMLElement>('.composer-list-fallback-container')
          ?.style.getPropertyValue('--composer-list-fallback-indent'),
      ).toBe('1.8ch');
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(Range.prototype, 'getBoundingClientRect', originalDescriptor);
      } else {
        Reflect.deleteProperty(Range.prototype, 'getBoundingClientRect');
      }
    }
  });

  it('suspends list decoration but keeps stable CJK punctuation during IME composition', () => {
    vi.useFakeTimers();
    editor = new Editor({
      element: document.createElement('div'),
      extensions: [
        Document,
        Paragraph,
        Text,
        HardBreak,
        CjkPunctDecoration,
        ComposerListIndentDecoration,
      ],
      content: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: '1. 《旧》' }] }],
      },
    });

    expect(editor.view.dom.querySelector('.composer-list-block-indent')).not.toBeNull();
    const punctuationCount =
      editor.view.dom.querySelectorAll('span[style*="font-family"]').length;
    expect(punctuationCount).toBeGreaterThan(0);

    editor.view.dom.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    expect(editor.view.composing).toBe(true);
    expect(editor.view.dom.querySelector('.composer-list-block-indent')).toBeNull();
    expect(editor.view.dom.querySelectorAll('span[style*="font-family"]')).toHaveLength(
      punctuationCount,
    );

    editor.view.dispatch(
      editor.state.tr.insertText('中', editor.state.doc.content.size - 1).setMeta('composition', 1),
    );
    expect(editor.getText()).toBe('1. 《旧》中');
    expect(editor.view.dom.querySelector('.composer-list-block-indent')).toBeNull();
    expect(editor.view.dom.querySelectorAll('span[style*="font-family"]')).toHaveLength(
      punctuationCount,
    );

    editor.view.dom.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    expect(editor.view.composing).toBe(false);
    vi.runOnlyPendingTimers();

    expect(editor.view.dom.querySelector('.composer-list-block-indent')?.textContent).toBe(
      '1. 《旧》中',
    );
    expect(editor.view.dom.querySelectorAll('span[style*="font-family"]').length).toBeGreaterThan(
      0,
    );
  });

  it('keeps full-width parentheses from changing width across repeated IME composition', () => {
    vi.useFakeTimers();
    editor = new Editor({
      element: document.createElement('div'),
      extensions: [Document, Paragraph, Text, CjkPunctDecoration],
      content: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: '（已有内容）' }] }],
      },
    });

    const punctuationSelector = 'span[style*="font-family"]';
    expect(editor.view.dom.querySelectorAll(punctuationSelector)).toHaveLength(2);

    for (const [input, expected] of [
      ['新', '（已有内容）新'],
      ['字', '（已有内容）新字'],
    ] as const) {
      editor.view.dom.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      expect(editor.view.composing).toBe(true);
      expect(editor.view.dom.querySelectorAll(punctuationSelector)).toHaveLength(2);

      editor.view.dispatch(
        editor.state.tr
          .insertText(input, editor.state.doc.content.size - 1)
          .setMeta('composition', 1),
      );
      expect(editor.getText()).toBe(expected);
      expect(editor.view.dom.querySelectorAll(punctuationSelector)).toHaveLength(2);

      editor.view.dom.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
      vi.runOnlyPendingTimers();
      expect(editor.view.composing).toBe(false);
      expect(editor.view.dom.querySelectorAll(punctuationSelector)).toHaveLength(2);
    }
  });

  it('keeps ASCII punctuation in a CJK sentence stable during IME preview', () => {
    vi.useFakeTimers();
    editor = new Editor({
      element: document.createElement('div'),
      extensions: [Document, Paragraph, Text, CjkPunctDecoration],
      content: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              {
                type: 'text',
                text: '现代都市开放世界共创游戏。 () 在上面这个句语基础上,',
              },
            ],
          },
        ],
      },
    });

    const punctuationSelector = 'span[style*="font-family"]';
    const currentEditor = editor;
    if (!currentEditor) throw new Error('editor failed to initialize');
    const decoratedPunctuation = () =>
      Array.from(currentEditor.view.dom.querySelectorAll(punctuationSelector), (node) => node.textContent);
    expect(decoratedPunctuation()).toEqual(['。', '(', ')', ',']);

    editor.view.dom.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    editor.view.dispatch(
      editor.state.tr
        .insertText('w', editor.state.doc.content.size - 1)
        .setMeta('composition', 1),
    );
    expect(editor.getText()).toBe('现代都市开放世界共创游戏。 () 在上面这个句语基础上,w');
    expect(decoratedPunctuation()).toEqual(['。', '(', ')', ',']);

    editor.view.dom.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    vi.runOnlyPendingTimers();
    expect(decoratedPunctuation()).toEqual(['。', '(', ')', ',']);
  });

  it('does not apply the CJK punctuation font to an isolated Latin punctuation run', () => {
    editor = new Editor({
      element: document.createElement('div'),
      extensions: [Document, Paragraph, Text, CjkPunctDecoration],
      content: 'hello (), world',
    });

    expect(editor.view.dom.querySelectorAll('span[style*="font-family"]')).toHaveLength(0);
  });

  it('renders the indent span into the DOM for list lines', () => {
    const ed = makeEditor(['1. hello']);
    expect(ed.view.dom.querySelector('p.composer-list-block-indent')?.textContent).toBe('1. hello');
    expect(
      ed.view.dom
        .querySelector<HTMLElement>('p.composer-list-block-indent')
        ?.style.getPropertyValue('--composer-list-hang'),
    ).toBe('1.8ch');
  });

  it('keeps CJK punctuation inside a paragraph-level list wrapper', () => {
    editor = new Editor({
      element: document.createElement('div'),
      extensions: [
        Document,
        Paragraph,
        Text,
        HardBreak,
        CjkPunctDecoration,
        ComposerListIndentDecoration,
      ],
      content: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: '1. 中文，内容。继续' }],
          },
        ],
      },
    });
    expect(editor.view.dom.querySelectorAll('p.composer-list-block-indent')).toHaveLength(1);
    expect(editor.view.dom.querySelectorAll('span.composer-list-line-indent')).toHaveLength(0);
    const wrapper = editor.view.dom.querySelector('p.composer-list-block-indent');
    expect(wrapper?.classList.contains('composer-list-cjk-font')).toBe(false);
    expect(wrapper?.querySelectorAll('span[style*="font-family"]').length).toBeGreaterThan(0);
  });

  it('keeps Tab-prefixed CJK rows inside the measured list wrapper', () => {
    editor = new Editor({
      element: document.createElement('div'),
      extensions: [
        Document,
        Paragraph,
        Text,
        HardBreak,
        CjkPunctDecoration,
        ComposerListIndentDecoration,
      ],
      content: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: '\t1. 中文《内容》' }] }],
      },
    });
    const wrapper = editor.view.dom.querySelector('p.composer-list-block-indent');
    expect(wrapper?.classList.contains('composer-list-tab-indent')).toBe(true);
    expect(wrapper?.classList.contains('composer-list-cjk-font')).toBe(false);
    expect(wrapper?.querySelectorAll('span[style*="font-family"]').length).toBeGreaterThan(0);
  });

  it('keeps multiline CJK punctuation inside the paragraph fallback flow', () => {
    editor = new Editor({
      element: document.createElement('div'),
      extensions: [
        Document,
        Paragraph,
        Text,
        HardBreak,
        CjkPunctDecoration,
        ComposerListIndentDecoration,
      ],
      content: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: '- 中文《内容》' },
              { type: 'hardBreak' },
              { type: 'text', text: '2. plain' },
            ],
          },
        ],
      },
    });
    const container = editor.view.dom.querySelector('p.composer-list-fallback-container');
    expect(container).not.toBeNull();
    expect(container?.querySelectorAll('.composer-list-line-indent')).toHaveLength(0);
    expect(container?.querySelectorAll('span[style*="font-family"]').length).toBeGreaterThan(0);
  });

  it('keeps the CJK marker in one fixed fallback prefix slot', () => {
    editor = new Editor({
      element: document.createElement('div'),
      extensions: [
        Document,
        Paragraph,
        Text,
        HardBreak,
        CjkPunctDecoration,
        ComposerListIndentDecoration,
      ],
      content: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'intro' },
              { type: 'hardBreak' },
              { type: 'text', text: '1、中文正文《内容》' },
            ],
          },
        ],
      },
    });
    const prefix = editor.view.dom.querySelector(
      '.composer-list-fallback-prefix.composer-list-cjk-font',
    );
    expect(prefix?.textContent).toBe('1、');
    expect(prefix?.querySelectorAll('span[style*="font-family"]')).toHaveLength(0);
    expect(
      editor.view.dom.querySelectorAll(
        'p.composer-list-fallback-container span[style*="font-family"]',
      ).length,
    ).toBeGreaterThan(0);
  });

  it('keeps ASCII punctuation in a list prefix inside the fixed CJK font slot', () => {
    editor = new Editor({
      element: document.createElement('div'),
      extensions: [
        Document,
        Paragraph,
        Text,
        HardBreak,
        CjkPunctDecoration,
        ComposerListIndentDecoration,
      ],
      content: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'intro' },
              { type: 'hardBreak' },
              { type: 'text', text: '1. 中文正文' },
            ],
          },
        ],
      },
    });
    const prefix = editor.view.dom.querySelector(
      '.composer-list-fallback-prefix.composer-list-cjk-font',
    );
    expect(prefix?.textContent).toBe('1. ');
    expect(prefix?.querySelectorAll('span[style*="font-family"]')).toHaveLength(0);
    expect(editor.view.dom.querySelectorAll('span[style*="font-family"]')).toHaveLength(0);
  });

  it('keeps fallback-owned ASCII punctuation stable while list wrappers are suspended for IME', () => {
    vi.useFakeTimers();
    editor = new Editor({
      element: document.createElement('div'),
      extensions: [
        Document,
        Paragraph,
        Text,
        HardBreak,
        CjkPunctDecoration,
        ComposerListIndentDecoration,
      ],
      content: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: '1. 中文正文' },
              { type: 'hardBreak' },
              { type: 'text', text: '中文,内容' },
            ],
          },
        ],
      },
    });

    const punctuation = () =>
      Array.from(editor?.view.dom.querySelectorAll('span[style*="font-family"]') ?? [], (node) =>
        node.textContent,
      );
    expect(punctuation()).toEqual([]);
    expect(editor.view.dom.querySelector('.composer-list-fallback-container')).not.toBeNull();

    editor.view.dom.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    expect(editor.view.composing).toBe(true);
    expect(editor.view.dom.querySelector('.composer-list-fallback-container')).toBeNull();
    expect(punctuation()).toEqual(['.', ',']);

    editor.view.dispatch(
      editor.state.tr.insertText('中', editor.state.doc.content.size - 1).setMeta('composition', 1),
    );
    expect(punctuation()).toEqual(['.', ',']);

    editor.view.dom.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    vi.runOnlyPendingTimers();
    expect(editor.view.composing).toBe(false);
    expect(punctuation()).toEqual([]);
    expect(editor.view.dom.querySelector('.composer-list-fallback-container')).not.toBeNull();
  });

  it('keeps slash-command pills inline inside the paragraph fallback flow', () => {
    editor = new Editor({
      element: document.createElement('div'),
      extensions: [
        Document,
        Paragraph,
        Text,
        HardBreak,
        SlashCommandDecoration,
        ComposerListIndentDecoration,
      ],
      content: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: '- /foo details' },
              { type: 'hardBreak' },
              { type: 'text', text: '2. plain' },
            ],
          },
        ],
      },
    });
    setSlashCommandRoster(editor, [{ name: 'foo', description: 'test command' }]);
    expect(editor.view.dom.querySelector('span.composer-list-fallback-prefix')?.textContent).toBe(
      '- ',
    );
    expect(editor.view.dom.querySelector('p.composer-list-fallback-container')).not.toBeNull();
    expect(editor.view.dom.querySelector('br.composer-list-fallback-break')).not.toBeNull();
    expect(editor.view.dom.querySelector('span.slash-cmd-pill')?.textContent).toBe('/foo');
    expect(editor.view.dom.querySelector('p.composer-list-fallback-container')?.textContent).toBe(
      '- /foo details2. plain',
    );
  });

  it('preserves consecutive hard breaks inside the paragraph fallback flow', () => {
    editor = new Editor({
      element: document.createElement('div'),
      extensions: [
        Document,
        Paragraph,
        Text,
        HardBreak,
        SlashCommandDecoration,
        ComposerListIndentDecoration,
      ],
      content: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: '- /foo' },
              { type: 'hardBreak' },
              { type: 'hardBreak' },
              { type: 'text', text: '2. next' },
            ],
          },
        ],
      },
    });
    setSlashCommandRoster(editor, [{ name: 'foo', description: 'test command' }]);
    expect(
      editor.view.dom.querySelectorAll(
        'p.composer-list-fallback-container br.composer-list-fallback-break',
      ),
    ).toHaveLength(2);
  });

  it('uses the paragraph fallback while voice replacement overlaps a multiline list row', () => {
    editor = new Editor({
      element: document.createElement('div'),
      extensions: [
        Document,
        Paragraph,
        Text,
        HardBreak,
        CjkPunctDecoration,
        ComposerListIndentDecoration,
        VoiceInputDraftDecoration,
      ],
      content: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: '- first' },
              { type: 'hardBreak' },
              { type: 'text', text: '2. second row' },
            ],
          },
        ],
      },
    });
    expect(editor.view.dom.querySelectorAll('.composer-list-line-indent')).toHaveLength(2);

    setVoiceInputDraftDecoration(
      editor,
      'replacement',
      'refinement',
      { from: 9, to: 21 },
      'processing',
    );
    expect(editor.view.dom.querySelector('p.composer-list-fallback-container')).not.toBeNull();
    expect(editor.view.dom.querySelector('.composer-list-line-indent')).toBeNull();
    expect(editor.view.dom.querySelector('[data-voice-draft-inline]')?.textContent).toBe(
      'replacement',
    );
    expect(editor.view.dom.querySelector('.voice-input-draft-replaced')).not.toBeNull();

    setVoiceInputDraftDecoration(editor, '', null);
    expect(editor.view.dom.querySelector('p.composer-list-fallback-container')).toBeNull();
    expect(editor.view.dom.querySelectorAll('.composer-list-line-indent')).toHaveLength(2);
  });

  it('keeps an inline atom and body punctuation inside the multiline fallback flow', () => {
    editor = new Editor({
      element: document.createElement('div'),
      extensions: [
        Document,
        Paragraph,
        Text,
        HardBreak,
        TestAtom,
        CjkPunctDecoration,
        ComposerListIndentDecoration,
      ],
      content: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: '- before ' },
              { type: 'testAtom' },
              { type: 'text', text: ' 《body》' },
              { type: 'hardBreak' },
              { type: 'text', text: '2. next' },
            ],
          },
        ],
      },
    });
    const container = editor.view.dom.querySelector('p.composer-list-fallback-container');
    expect(container).not.toBeNull();
    expect(container?.querySelector('[data-test-atom]')).not.toBeNull();
    expect(container?.querySelector('.composer-list-fallback-prefix')?.textContent).toBe('- ');
    expect(container?.querySelectorAll('.composer-list-line-indent')).toHaveLength(0);
    // The fallback does not suppress CjkPunctDecoration, so body punctuation
    // still receives an explicit font span instead of being silently skipped.
    expect(container?.querySelectorAll('span[style*="font-family"]')).not.toHaveLength(0);
  });

  it('keeps CJK styling on fallback sibling rows', () => {
    editor = new Editor({
      element: document.createElement('div'),
      extensions: [
        Document,
        Paragraph,
        Text,
        HardBreak,
        TestAtom,
        CjkPunctDecoration,
        ComposerListIndentDecoration,
      ],
      content: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: '- before ' },
              { type: 'testAtom' },
              { type: 'text', text: ' 《body》' },
              { type: 'hardBreak' },
              { type: 'text', text: '2. 中文，内容' },
            ],
          },
        ],
      },
    });
    const container = editor.view.dom.querySelector('p.composer-list-fallback-container');
    expect(container).not.toBeNull();
    expect(container?.querySelectorAll('span[style*="font-family"]').length).toBeGreaterThanOrEqual(
      3,
    );
  });

  it('keeps a fallback non-list CJK line as one box after deleting its ordered marker', () => {
    editor = new Editor({
      element: document.createElement('div'),
      extensions: [
        Document,
        Paragraph,
        Text,
        HardBreak,
        CjkPunctDecoration,
        ComposerListIndentDecoration,
      ],
      content: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: '1. 有新增游戏数的用户数,占全部用户比例。' },
              { type: 'hardBreak' },
              { type: 'text', text: '2. 有新增游戏数的近30天、近1年活跃用户数及占比。' },
              { type: 'hardBreak' },
              {
                type: 'text',
                text: '3. 每人新增游戏数的均值、P50、P75、P90、P95、P99、最大值。',
              },
            ],
          },
        ],
      },
    });

    editor.commands.deleteRange({ from: 1, to: 4 });

    const container = editor.view.dom.querySelector('p.composer-list-fallback-container');
    const unindentedRows = container?.querySelectorAll('.composer-list-fallback-unindented');
    expect(container).not.toBeNull();
    expect(unindentedRows).toHaveLength(1);
    expect(unindentedRows?.[0]?.textContent).toBe('有新增游戏数的用户数,占全部用户比例。');
    expect(unindentedRows?.[0]?.classList.contains('composer-list-cjk-font')).toBe(false);
    expect(
      unindentedRows?.[0]?.classList.contains('composer-list-cjk-punctuation-font'),
    ).toBe(true);
    expect(unindentedRows?.[0]?.querySelectorAll('span[style*="font-family"]')).toHaveLength(0);
  });

  it('keeps no-space CJK ordered text unindented inside the multiline fallback', () => {
    editor = new Editor({
      element: document.createElement('div'),
      extensions: [
        Document,
        Paragraph,
        Text,
        HardBreak,
        CjkPunctDecoration,
        ComposerListIndentDecoration,
      ],
      content: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: '1. 有新增游戏数的用户数、占全部用户比例。' },
              { type: 'hardBreak' },
              { type: 'text', text: '5.我' },
            ],
          },
        ],
      },
    });

    const prefixes = editor.view.dom.querySelectorAll('.composer-list-fallback-prefix');
    const unindentedRows = editor.view.dom.querySelectorAll('.composer-list-fallback-unindented');
    expect(prefixes).toHaveLength(1);
    expect(prefixes[0]?.textContent).toBe('1. ');
    expect(unindentedRows).toHaveLength(1);
    expect(unindentedRows[0]?.textContent).toBe('5.我');
  });

  it('keeps fallback long alphanumeric rows in the same visual line as their marker', () => {
    const css = readFileSync(resolve(__dirname, '..', 'styles', 'globals.css'), 'utf8');
    const fallbackContainerRule = css.match(
      /\.ProseMirror \.composer-list-fallback-container \{([\s\S]*?)\n\}/,
    )?.[1];
    const fallbackLongRunRule = css.match(
      /\.ProseMirror \.composer-list-fallback-long-run-body \{([\s\S]*?)\n\}/,
    )?.[1];
    expect(fallbackContainerRule).not.toContain('word-break: break-all;');
    expect(fallbackLongRunRule).toContain('word-break: break-all;');

    editor = new Editor({
      element: document.createElement('div'),
      extensions: [
        Document,
        Paragraph,
        Text,
        HardBreak,
        CjkPunctDecoration,
        ComposerListIndentDecoration,
      ],
      content: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: '1. 中文标点。' },
              { type: 'hardBreak' },
              { type: 'text', text: '2. abcdefghijklmnopqrstuvwxyz' },
              { type: 'hardBreak' },
              { type: 'text', text: '3. alpha ordinaryword omega' },
            ],
          },
        ],
      },
    });
    const longRunBodies = editor.view.dom.querySelectorAll(
      '.composer-list-fallback-long-run-body',
    );
    expect(longRunBodies).toHaveLength(1);
    expect(longRunBodies[0]?.textContent).toBe('abcdefghijklmnopqrstuvwxyz');
  });

  it('keeps hanging indent for slash paths and unknown commands without pills', () => {
    editor = new Editor({
      element: document.createElement('div'),
      extensions: [
        Document,
        Paragraph,
        Text,
        HardBreak,
        SlashCommandDecoration,
        ComposerListIndentDecoration,
      ],
      content: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: '- inspect /usr/local/bin before continuing' },
              { type: 'hardBreak' },
              { type: 'text', text: '2. try /unknown later' },
            ],
          },
        ],
      },
    });
    setSlashCommandRoster(editor, [{ name: 'foo', description: 'test command' }]);
    expect(editor.view.dom.querySelectorAll('span.composer-list-prefix-indent')).toHaveLength(0);
    expect(editor.view.dom.querySelectorAll('span.slash-cmd-pill')).toHaveLength(0);
    expect(indentSpans(editor)).toEqual([
      '- inspect /usr/local/bin before continuing',
      '2. try /unknown later',
    ]);
  });

  it('appears the moment the prefix becomes complete, and disappears when broken', () => {
    const ed = makeEditor(['1.']);
    expect(indentSpans(ed)).toHaveLength(0);
    // 打出空格,前缀完整 → 缩进立即出现
    ed.commands.insertContentAt(ed.state.doc.content.size - 1, ' ');
    expect(ed.view.dom.querySelector('.composer-list-block-indent')?.textContent).toBe('1. ');
    // 删掉空格 → 缩进消失
    ed.commands.deleteRange({
      from: ed.state.doc.content.size - 2,
      to: ed.state.doc.content.size - 1,
    });
    expect(ed.view.dom.querySelector('.composer-list-block-indent')).toBeNull();
  });
});

describe('wiring contract', () => {
  it('ChatInput registers ComposerListIndentDecoration', () => {
    const src = readFileSync(
      resolve(__dirname, '..', 'components', 'new-chat', 'ChatInput.tsx'),
      'utf8',
    );
    expect(src).toContain(
      "import { ComposerListIndentDecoration } from './ComposerListIndentDecoration';",
    );
    expect(src).toMatch(
      /CjkPunctDecoration,\s*\n\s*ComposerListIndentDecoration,/,
    );
  });

  it('globals.css defines the indent class', () => {
    const css = readFileSync(resolve(__dirname, '..', 'styles', 'globals.css'), 'utf8');
    expect(css).toContain('.ProseMirror .composer-list-block-indent');
    expect(css).toContain('.ProseMirror .composer-list-prefix-indent');
    expect(css).toContain('.ProseMirror .composer-list-line-indent');
    expect(css).toContain(
      'width: calc(100% + 1em + var(--composer-list-fallback-indent, 1.25em));',
    );
    expect(css).toContain(
      'margin-left: calc(-1em - var(--composer-list-fallback-indent, 1.25em));',
    );
    expect(css).toContain('display: inline-block;');
    expect(css).toContain('width: 100%;');
    expect(css).toContain('padding-left: calc(1em + var(--composer-list-hang, 1.25em));');
    expect(css).toContain('text-indent: var(--composer-list-hang-negative, -1.25em);');
    expect(css).toContain('overflow-wrap: anywhere;');
    expect(css).toContain('.ProseMirror .composer-list-long-run-marker');
    expect(css).toContain('.ProseMirror .composer-list-long-run-body');
    expect(css).toContain('.ProseMirror .composer-list-tab-indent');
    expect(css).toContain('.ProseMirror .composer-list-cjk-punctuation-font');
    expect(css).toContain("font-family: 'Cindy CJK Punctuation Local'");
    expect(css).toContain("font-family: 'Cindy CJK Punctuation Bundled'");
    expect(css).toContain('U+3000-303F, U+FF00-FFEF;');
    expect(css.match(/U\+0021-0022, U\+0027-0029/g)).toHaveLength(2);
    const punctuationFontCss = css.slice(
      css.indexOf("font-family: 'Cindy CJK Punctuation Local'"),
      css.indexOf('.ProseMirror .composer-list-cjk-punctuation-font'),
    );
    expect(punctuationFontCss.match(/font-style: normal;/g)).toHaveLength(5);
    expect(punctuationFontCss.match(/font-weight: 400;/g)).toHaveLength(5);
    const bundledPunctuationFonts = [
      'Regular_256855.woff2',
      'Regular_312071.woff2',
      'Regular_ac4458.woff2',
      'Regular_ea8896.woff2',
    ];
    bundledPunctuationFonts.forEach((filename) => {
      expect(css).toContain(`harmonyos-sans-sc-webfont-splitted/dist/${filename}`);
      expect(
        existsSync(
          resolve(
            __dirname,
            '..',
            '..',
            '..',
            '..',
            '..',
            'node_modules',
            'harmonyos-sans-sc-webfont-splitted',
            'dist',
            filename,
          ),
        ),
      ).toBe(true);
    });
    const desktopPackage = JSON.parse(
      readFileSync(resolve(__dirname, '..', '..', '..', 'package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string> };
    expect(desktopPackage.dependencies?.['harmonyos-sans-sc-webfont-splitted']).toBe('1.1.0');
    expect(css).toContain('tab-size: 8ch;');
    expect(css).toContain('white-space: pre;');
    const fallbackPrefixRule = css.match(
      /\.ProseMirror \.composer-list-fallback-prefix \{([\s\S]*?)\n\}/,
    )?.[1];
    expect(fallbackPrefixRule).toContain(
      'width: var(--composer-list-fallback-indent, 1.25em);',
    );
    expect(fallbackPrefixRule).toContain(
      'margin-left: calc(0px - var(--composer-list-fallback-indent, 1.25em));',
    );
    expect(fallbackPrefixRule).not.toContain('width: calc(1em +');
    expect(fallbackPrefixRule).not.toContain('margin-left: calc(-1em -');
    const fallbackBreakRule = css.match(
      /\.ProseMirror \.composer-list-fallback-break \{([\s\S]*?)\n\}/,
    )?.[1];
    expect(fallbackBreakRule).toContain('display: inline;');
    expect(fallbackBreakRule).not.toContain('height: 0');
    expect(fallbackBreakRule).not.toContain('line-height: 0');
    const longRunBodyRule = css.match(
      /\.ProseMirror \.composer-list-long-run-body \{([\s\S]*?)\n\}/,
    )?.[1];
    expect(longRunBodyRule).toContain('word-break: break-all;');
    const regularIndentRule = css.match(
      /\.ProseMirror \.composer-list-line-indent \{([\s\S]*?)\n\}/,
    )?.[1];
    expect(regularIndentRule).not.toContain('word-break: break-all;');
  });
});
