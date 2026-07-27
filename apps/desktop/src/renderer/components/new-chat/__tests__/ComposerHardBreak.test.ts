// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import { applyComposerHardBreak, ComposerHardBreak } from '../ComposerHardBreak';
import { CjkPunctDecoration } from '../CjkPunctDecoration';
import { ComposerListIndentDecoration } from '../ComposerListIndentDecoration';

let editor: Editor | null = null;

function makeEditor(lines: string[]): Editor {
  const content: Array<Record<string, unknown>> = [];
  lines.forEach((line, i) => {
    if (i > 0) content.push({ type: 'hardBreak' });
    if (line.length > 0) content.push({ type: 'text', text: line });
  });
  editor = new Editor({
    element: document.createElement('div'),
    extensions: [Document, Paragraph, Text, ComposerHardBreak],
    content: { type: 'doc', content: [{ type: 'paragraph', content }] },
    editorProps: {
      handleKeyDown: (_view, event) => {
        if (
          event.key !== 'Enter' ||
          event.repeat ||
          event.isComposing ||
          event.metaKey ||
          event.ctrlKey ||
          (!event.shiftKey && !event.altKey)
        ) {
          return false;
        }
        return editor ? applyComposerHardBreak(editor) : false;
      },
    },
  });
  editor.commands.setTextSelection(editor.state.doc.content.size - 1);
  return editor;
}

function docText(ed: Editor): string {
  return ed.state.doc.textBetween(0, ed.state.doc.content.size, '\n', '\n');
}

function dispatchEnter(
  ed: Editor,
  options: KeyboardEventInit & { keyCode?: number } = {},
): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key: 'Enter',
    code: 'Enter',
    keyCode: 13,
    bubbles: true,
    cancelable: true,
    ...options,
  });
  ed.view.dom.dispatchEvent(event);
  return event;
}

function compositionCycle(ed: Editor): void {
  ed.view.dom.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
  expect(ed.view.composing).toBe(true);
  ed.view.dom.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
  expect(ed.view.composing).toBe(false);
}

afterEach(() => {
  editor?.destroy();
  editor = null;
});

describe('ComposerHardBreak DOM keydown integration', () => {
  it.each([
    ['Shift+Enter', { shiftKey: true }],
    ['Alt+Enter', { altKey: true }],
  ] as const)('inserts a standard hard break for plain text on %s', (_, options) => {
    const ed = makeEditor(['shirt']);
    dispatchEnter(ed, options);

    expect(docText(ed)).toBe('shirt\n');
    expect(ed.state.doc.child(0).child(1).type.name).toBe('hardBreak');
  });

  it.each([
    ['Shift+Enter', { shiftKey: true }],
    ['Alt+Enter', { altKey: true }],
  ] as const)('continues a list through the real %s keydown path', (_, options) => {
    const ed = makeEditor(['1. item']);
    dispatchEnter(ed, options);

    expect(docText(ed)).toBe('1. item\n2. ');
  });

  it('exits an empty list item through the stable Shift+Enter boundary', () => {
    const ed = makeEditor(['1. item', '2. ']);

    dispatchEnter(ed, { shiftKey: true });

    expect(docText(ed)).toBe('1. item\n');
  });

  it('continues a CJK ordered list without switching the paragraph to fallback layout', () => {
    editor = new Editor({
      element: document.createElement('div'),
      extensions: [
        Document,
        Paragraph,
        Text,
        ComposerHardBreak,
        CjkPunctDecoration,
        ComposerListIndentDecoration,
      ],
      content: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: '1、你' }],
          },
        ],
      },
      editorProps: {
        handleKeyDown: (_view, event) => {
          if (
            event.key !== 'Enter' ||
            event.repeat ||
            event.isComposing ||
            event.metaKey ||
            event.ctrlKey ||
            (!event.shiftKey && !event.altKey)
          ) {
            return false;
          }
          return editor ? applyComposerHardBreak(editor) : false;
        },
      },
    });
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);

    dispatchEnter(editor, { shiftKey: true });

    expect(docText(editor)).toBe('1、你\n2、');
  });

  it('exits an empty CJK item after mixed ordered-list rows without fragmenting the DOM', () => {
    editor = new Editor({
      element: document.createElement('div'),
      extensions: [
        Document,
        Paragraph,
        Text,
        ComposerHardBreak,
        CjkPunctDecoration,
        ComposerListIndentDecoration,
      ],
      content: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: '1. asdasd' },
              { type: 'hardBreak' },
              { type: 'text', text: '2. 阿萨德噶结算单' },
              { type: 'hardBreak' },
              { type: 'text', text: '1、' },
            ],
          },
        ],
      },
      editorProps: {
        handleKeyDown: (_view, event) => {
          if (
            event.key !== 'Enter' ||
            event.repeat ||
            event.isComposing ||
            event.metaKey ||
            event.ctrlKey ||
            (!event.shiftKey && !event.altKey)
          ) {
            return false;
          }
          return editor ? applyComposerHardBreak(editor) : false;
        },
      },
    });
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);

    dispatchEnter(editor, { shiftKey: true });

    expect(docText(editor)).toBe('1. asdasd\n2. 阿萨德噶结算单\n');
  });

  it('leaves active composition Enter to ProseMirror without mutating the document', () => {
    const ed = makeEditor(['你好']);
    const before = ed.state.doc.toJSON();
    ed.view.dom.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));

    const event = dispatchEnter(ed, { shiftKey: true, isComposing: true });

    expect(ed.view.composing).toBe(true);
    expect(event.defaultPrevented).toBe(false);
    expect(ed.state.doc.toJSON()).toEqual(before);
  });

  it.each([
    ['bare Enter', {}],
    ['Shift+Enter', { shiftKey: true }],
    ['Alt+Enter', { altKey: true }],
    ['Ctrl+Enter', { ctrlKey: true }],
    ['Meta+Enter', { metaKey: true }],
  ] as const)(
    'does not mutate the document when %s still belongs to the IME after view composition ended',
    (_, options) => {
      const ed = makeEditor(['1. item']);
      const before = ed.state.doc.toJSON();
      compositionCycle(ed);

      const event = dispatchEnter(ed, { ...options, isComposing: true });

      expect(event.defaultPrevented).toBe(false);
      expect(ed.state.doc.toJSON()).toEqual(before);
      expect(ed.state.doc.childCount).toBe(1);
    },
  );

  it('restores modified Enter after the IME and upstream post-composition guard finish', () => {
    const ed = makeEditor(['shirt']);
    compositionCycle(ed);

    const imeEvent = dispatchEnter(ed, { shiftKey: true, isComposing: true });
    expect(imeEvent.defaultPrevented).toBe(false);
    expect(docText(ed)).toBe('shirt');

    // ProseMirror deliberately ignores one near-composition Enter on Safari.
    // A subsequent non-composing keydown must still reach our shortcut.
    dispatchEnter(ed, { shiftKey: true });
    if (docText(ed) === 'shirt') dispatchEnter(ed, { shiftKey: true });
    expect(docText(ed)).toBe('shirt\n');
  });

  it.each([
    ['Ctrl+Enter', { ctrlKey: true }],
    ['Meta+Enter', { metaKey: true }],
  ] as const)('does not inherit HardBreak Mod-Enter for %s', (_, options) => {
    const ed = makeEditor(['shirt']);
    dispatchEnter(ed, options);

    expect(docText(ed)).toBe('shirt');
  });
});
