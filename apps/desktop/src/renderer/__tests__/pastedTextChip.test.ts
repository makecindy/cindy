// @vitest-environment jsdom
// (Editor 构造与 getHTML/setContent 的 DOM 序列化回环需要 document。)
import { Editor } from '@tiptap/core';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import History from '@tiptap/extension-history';
import HardBreak from '@tiptap/extension-hard-break';
import { afterEach, describe, expect, it } from 'vitest';

import {
  applyPastedTextChipEdit,
  PastedTextChipNode,
  replacePastedTextChipWithPlainText,
  type PastedTextChipAttrs,
} from '@/components/new-chat/PastedTextChipNode';
import { LONG_PASTE_MAX_CHARS } from '@/components/new-chat/pastePipeline';

// Editor 必须逐个 destroy:EditorView 的异步回调(observer / flush)会在
// jsdom 环境拆除后触发 `document is not defined` 未处理异常,vitest 全绿
// 也会 exit 1(CI unit-shard 实撞)。
const editors: Editor[] = [];
afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy();
});

function makeEditor(): Editor {
  const editor = new Editor({
    extensions: [Document, Paragraph, Text, HardBreak, History, PastedTextChipNode],
    content: { type: 'doc', content: [{ type: 'paragraph', content: [] }] },
  });
  editors.push(editor);
  return editor;
}

function firstInline(editor: Editor): {
  type?: string;
  attrs?: PastedTextChipAttrs;
  text?: string;
} | undefined {
  const paragraph = editor.getJSON().content?.[0] as
    | { content?: Array<{ type?: string; attrs?: PastedTextChipAttrs; text?: string }> }
    | undefined;
  return paragraph?.content?.[0];
}

describe('PastedTextChipNode', () => {
  it('round-trips the full text payload through DOM serialization (review P1)', () => {
    // ProseMirror 剪贴板序列化走同一个 toDOM:复制 / 剪切 chip 再粘回,
    // 原文必须能从 data-pasted-text 还原,否则发送时静默丢内容。
    const text = '第一行 log\n第二行 "带引号" 与 <标签>\n第三行';
    const display = '粘贴的文本(3 行)';
    const editor = makeEditor();
    editor.commands.insertContent({ type: 'pastedTextChip', attrs: { text, display } });
    const html = editor.getHTML();

    const restored = makeEditor();
    restored.commands.setContent(html);
    const inline = (restored.getJSON().content?.[0]?.content ?? []) as Array<{
      type?: string;
      attrs?: PastedTextChipAttrs;
    }>;
    expect(inline).toHaveLength(1);
    expect(inline[0].type).toBe('pastedTextChip');
    expect(inline[0].attrs?.text).toBe(text);
    expect(inline[0].attrs?.display).toBe(display);
  });

  it('updates the captured chip in place and preserves edited payload serialization', () => {
    const original = '旧内容\n第二行';
    const edited = '新内容\n第二行 "引号" <标签>\n第三行';
    const editor = makeEditor();
    editor.commands.insertContent({
      type: 'pastedTextChip',
      attrs: { text: original, display: '粘贴的文本(2 行)' },
    });

    expect(
      applyPastedTextChipEdit(editor, 1, original, {
        text: edited,
        display: '粘贴的文本(3 行)',
      }),
    ).toBe(true);
    const attrs = firstInline(editor)?.attrs;
    expect(attrs).toEqual({ text: edited, display: '粘贴的文本(3 行)', externalReference: false });

    const restored = makeEditor();
    restored.commands.setContent(editor.getHTML());
    const restoredAttrs = firstInline(restored)?.attrs;
    expect(restoredAttrs).toEqual(attrs);
  });

  it('fails closed when the position or original payload is stale', () => {
    const editor = makeEditor();
    editor.commands.insertContent({
      type: 'pastedTextChip',
      attrs: { text: 'original', display: 'Pasted text (1 line)' },
    });
    const before = editor.getJSON();

    expect(
      applyPastedTextChipEdit(editor, 1, 'different payload', {
        text: 'wrong update',
        display: 'Pasted text (1 line)',
      }),
    ).toBe(false);
    expect(
      applyPastedTextChipEdit(editor, 99, 'original', {
        text: 'wrong position',
        display: 'Pasted text (1 line)',
      }),
    ).toBe(false);
    expect(editor.getJSON()).toEqual(before);
  });

  it('deletes an emptied chip and keeps the edit undoable', () => {
    const editor = makeEditor();
    editor.commands.setContent({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'pastedTextChip',
              attrs: { text: 'to remove', display: 'Pasted text (1 line)' },
            },
          ],
        },
      ],
    });

    expect(applyPastedTextChipEdit(editor, 1, 'to remove', null)).toBe(true);
    expect(editor.getJSON().content?.[0]?.content).toBeUndefined();

    expect(editor.commands.undo()).toBe(true);
    const restored = firstInline(editor);
    expect(restored?.type).toBe('pastedTextChip');
    expect(restored?.attrs?.text).toBe('to remove');
  });

  it('downgrades an edit beyond the DOM attribute cap to ordinary text', () => {
    const editor = makeEditor();
    const oversized = `${'x'.repeat(LONG_PASTE_MAX_CHARS + 1)}\nsecond\n\nthird`;
    editor.commands.insertContent({
      type: 'pastedTextChip',
      attrs: { text: 'small', display: 'Pasted text (1 line)' },
    });

    expect(replacePastedTextChipWithPlainText(editor, 1, 'small', oversized)).toBe(true);
    const inline = (editor.getJSON().content?.[0]?.content ?? []) as Array<{
      type?: string;
      text?: string;
    }>;
    expect(inline.map((node) => node.type)).toEqual([
      'text',
      'hardBreak',
      'text',
      'hardBreak',
      'hardBreak',
      'text',
    ]);
    expect(inline[0]?.text).toHaveLength(LONG_PASTE_MAX_CHARS + 1);
    expect(inline[2]?.text).toBe('second');
    expect(inline[5]?.text).toBe('third');
    expect(editor.getHTML()).not.toContain('data-pasted-text');
  });
});
