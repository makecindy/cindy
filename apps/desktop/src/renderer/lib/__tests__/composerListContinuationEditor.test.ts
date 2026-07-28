// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import HardBreak from '@tiptap/extension-hard-break';
import { applyListBackspace, applyListContinuation } from '../composerListContinuation';

/**
 * applyListContinuation 在真实 Tiptap/ProseMirror 编辑器上的行为测试
 * (schema 与 ChatInput 一致的最小子集:Document + Paragraph + Text + HardBreak)。
 * 覆盖行提取(hardBreak 分行)、事务 dispatch(接续插入 / 空项前缀删除)。
 * 纯前缀匹配用例见 composerListContinuation.test.ts。
 */

let editor: Editor | null = null;

function makeEditor(lines: string[]): Editor {
  // 用 JSON 构造文档(HTML 解析会折叠尾随空格,而 "2. " 的尾随空格正是测试点)。
  const content: Array<Record<string, unknown>> = [];
  lines.forEach((line, i) => {
    if (i > 0) content.push({ type: 'hardBreak' });
    if (line.length > 0) content.push({ type: 'text', text: line });
  });
  editor = new Editor({
    element: document.createElement('div'),
    extensions: [Document, Paragraph, Text, HardBreak],
    content: { type: 'doc', content: [{ type: 'paragraph', content }] },
  });
  // 光标移到文档末尾(段落收尾位置),模拟用户刚敲完最后一个字符。
  editor.commands.setTextSelection(editor.state.doc.content.size - 1);
  return editor;
}

function docText(ed: Editor): string {
  // hardBreak 以 '\n' 呈现,便于断言。
  return ed.state.doc.textBetween(0, ed.state.doc.content.size, '\n', '\n');
}

afterEach(() => {
  editor?.destroy();
  editor = null;
});

describe('applyListContinuation on a real editor', () => {
  it('continues an ordered list with the incremented prefix', () => {
    const ed = makeEditor(['1. test']);
    expect(applyListContinuation(ed.view)).toBe(true);
    expect(docText(ed)).toBe('1. test\n2. ');
    // 光标应落在新前缀之后,可直接续写
    expect(ed.state.selection.from).toBe(ed.state.doc.content.size - 1);
  });

  it('continues based on the caret line only (hardBreak splits lines)', () => {
    const ed = makeEditor(['intro text', '- item']);
    expect(applyListContinuation(ed.view)).toBe(true);
    expect(docText(ed)).toBe('intro text\n- item\n- ');
  });

  it('exits the list by deleting the empty item prefix', () => {
    const ed = makeEditor(['1. test', '2. ']);
    expect(applyListContinuation(ed.view)).toBe(true);
    expect(docText(ed)).toBe('1. test\n');
  });

  it('returns false and leaves the doc untouched on a non-list line', () => {
    const ed = makeEditor(['hello world']);
    expect(applyListContinuation(ed.view)).toBe(false);
    expect(docText(ed)).toBe('hello world');
  });

  it('returns false for `1.5倍` style text (no space after separator)', () => {
    const ed = makeEditor(['3.14159']);
    expect(applyListContinuation(ed.view)).toBe(false);
    expect(docText(ed)).toBe('3.14159');
  });

  it('returns false when the selection is not empty', () => {
    const ed = makeEditor(['1. test']);
    ed.commands.setTextSelection({ from: 1, to: 4 });
    expect(applyListContinuation(ed.view)).toBe(false);
    expect(docText(ed)).toBe('1. test');
  });

  it('continues CJK ordered list (`1、`, no space required)', () => {
    const ed = makeEditor(['1、第一项']);
    expect(applyListContinuation(ed.view)).toBe(true);
    expect(docText(ed)).toBe('1、第一项\n2、');
  });

  it('does not continue ordered dot text without a separator space before CJK text', () => {
    const ed = makeEditor(['1.中文项']);
    expect(applyListContinuation(ed.view)).toBe(false);
    expect(docText(ed)).toBe('1.中文项');
  });

  it('splits mid-line: caret inside the item carries the remainder to the new item', () => {
    const ed = makeEditor(['1. abcdef']);
    // 光标放在 "abc|def" 中间(pos 1 是段首,"1. abc" 共 6 字符 → pos 7)
    ed.commands.setTextSelection(7);
    expect(applyListContinuation(ed.view)).toBe(true);
    expect(docText(ed)).toBe('1. abc\n2. def');
  });
});

describe('applyListBackspace on a real editor', () => {
  it('deletes the whole empty prefix plus the line break, caret lands at end of previous line', () => {
    const ed = makeEditor(['1. test', '2. ']);
    expect(applyListBackspace(ed.view)).toBe(true);
    expect(docText(ed)).toBe('1. test');
    // 光标在 "1. test" 末尾(pos 1 + 7)
    expect(ed.state.selection.from).toBe(8);
  });

  it('on the first line, deletes only the prefix (exits list, stays on the line)', () => {
    const ed = makeEditor(['1. ']);
    expect(applyListBackspace(ed.view)).toBe(true);
    expect(docText(ed)).toBe('');
    expect(ed.state.selection.from).toBe(1);
  });

  it('keeps indentation-aware deletion (indented empty item)', () => {
    const ed = makeEditor(['- a', '  - ']);
    expect(applyListBackspace(ed.view)).toBe(true);
    expect(docText(ed)).toBe('- a');
  });

  it('returns false when the item still has content — normal backspace applies', () => {
    const ed = makeEditor(['1. test', '2. x']);
    expect(applyListBackspace(ed.view)).toBe(false);
    expect(docText(ed)).toBe('1. test\n2. x');
  });

  it('returns false when the caret is not at the end of the line', () => {
    const ed = makeEditor(['2. abc']);
    // 光标放在前缀后、内容前("2. |abc" → pos 4):后面还有文本,不整删
    ed.commands.setTextSelection(4);
    expect(applyListBackspace(ed.view)).toBe(false);
  });

  it('returns false on a plain text line', () => {
    const ed = makeEditor(['hello', 'world']);
    expect(applyListBackspace(ed.view)).toBe(false);
  });

  it('triggers at end of an empty item even when a later line exists (caret before hardBreak)', () => {
    const ed = makeEditor(['1. a', '2. ', '3. b']);
    // 光标放到第二行行尾("2. " 之后、hardBreak 之前):
    // pos = 1 + "1. a"(4) + br(1) + "2. "(3) = 9
    ed.commands.setTextSelection(9);
    expect(applyListBackspace(ed.view)).toBe(true);
    expect(docText(ed)).toBe('1. a\n3. b');
  });
});
