// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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
    extensions: [Document, Paragraph, Text, HardBreak, TestAtom, ComposerListIndentDecoration],
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
});

describe('buildListIndentDecorations', () => {
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

  it('decorates tab-indented lines and leaves their final width to browser measurement', () => {
    const ed = makeEditor(['\t1. item']);
    const tabIndent = ed.view.dom.querySelector('.composer-list-tab-indent');
    expect(tabIndent).not.toBeNull();
    expect(tabIndent?.getAttribute('data-composer-list-prefix-length')).toBe('4');
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
    expect(src).toMatch(/CjkPunctDecoration,\s*\n\s*ComposerListIndentDecoration,/);
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
    expect(css).toContain('tab-size: 8;');
    expect(css).toContain('white-space: nowrap;');
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
