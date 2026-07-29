/**
 * editorRangeMapping.test.ts — 语音插入点跟随文档变化的契约
 * ---------------------------------------------------------------------------
 * 语音插入点是开始听写时按当时选区记下的两个 offset。听写期间 composer 是只读的,
 * 但程序化写入(草稿恢复、引用插入等)不受限制,会让这两个数字过期;而断线抢救正是
 * 在会话已经出问题时拿它去替换文本——错位就等于吃掉用户此刻的文字。
 *
 * 这里锁死 ProseMirror mapping 的 association 方向:落在边界上的插入必须留在替换
 * 区间**外面**。方向写反(-1 / 1)看起来更"直觉",实际会让区间反过来把新文字圈进去,
 * 下一次替换就把它覆盖掉——这正是本文件要防的回归。
 */
import { describe, expect, it } from 'vitest';
import { Schema } from '@tiptap/pm/model';
import { EditorState } from '@tiptap/pm/state';

import {
  clampEditorTextRangeToDoc,
  mapEditorTextRange,
  resolveInsertedTextRange,
} from '../editorRangeMapping';

const schema = new Schema({
  nodes: {
    doc: { content: 'paragraph+' },
    paragraph: { content: 'text*' },
    text: {},
  },
});

function stateWith(text: string): EditorState {
  return EditorState.create({
    doc: schema.node('doc', null, [schema.node('paragraph', null, text ? [schema.text(text)] : [])]),
  });
}

describe('mapEditorTextRange', () => {
  it('returns null for a missing range', () => {
    const state = stateWith('hello');
    expect(mapEditorTextRange(null, state.tr.insertText('x', 1))).toBeNull();
  });

  it('keeps a collapsed cursor collapsed after an insertion at that exact spot', () => {
    const state = stateWith('hello');
    // Cursor parked right after "hello" (doc positions start at 1).
    const cursor = { from: 6, to: 6 };
    const mapped = mapEditorTextRange(cursor, state.tr.insertText('ABC', 6));

    // Still collapsed — a range spanning "ABC" would make the salvage path
    // replace text this run never produced.
    expect(mapped).toEqual({ from: 9, to: 9 });
  });

  it('keeps text inserted at the range start outside the range', () => {
    const state = stateWith('hello world');
    const selection = { from: 7, to: 12 }; // "world"
    const mapped = mapEditorTextRange(selection, state.tr.insertText('XY', 7));

    expect(mapped).toEqual({ from: 9, to: 14 });
    expect(state.tr.insertText('XY', 7).doc.textBetween(mapped!.from, mapped!.to)).toBe('world');
  });

  it('keeps text inserted at the range end outside the range', () => {
    const state = stateWith('hello world');
    const selection = { from: 1, to: 6 }; // "hello"
    const mapped = mapEditorTextRange(selection, state.tr.insertText('XY', 6));

    expect(mapped).toEqual({ from: 1, to: 6 });
    expect(state.tr.insertText('XY', 6).doc.textBetween(mapped!.from, mapped!.to)).toBe('hello');
  });

  it('shifts the whole range when text lands before it', () => {
    const state = stateWith('hello world');
    const selection = { from: 7, to: 12 }; // "world"
    const mapped = mapEditorTextRange(selection, state.tr.insertText('XY', 1));

    expect(mapped).toEqual({ from: 9, to: 14 });
    expect(state.tr.insertText('XY', 1).doc.textBetween(mapped!.from, mapped!.to)).toBe('world');
  });

  // 整篇替换(外部草稿恢复走 setContent → replace(0, size))会把锚点映射到 block
  // 边界。那不是听写能插入的位置:insertText 会另起一个段落,上屏文字前面凭空多出
  // 一个空行(新建对话页语音结束时多一个回车的成因)。映射结果必须吸附回段落内。
  it('snaps an anchor back inside the paragraph after a full-document replacement', () => {
    const state = stateWith('');
    const tr = state.tr.replaceWith(0, state.doc.content.size, schema.node('paragraph'));
    const mapped = mapEditorTextRange({ from: 1, to: 1 }, tr);

    expect(mapped).toEqual({ from: 1, to: 1 });
    expect(tr.doc.resolve(mapped!.from).parent.isTextblock).toBe(true);
    // 用映射后的位置上屏时不得再生成第二个段落。
    const inserted = tr.doc.type.schema === schema
      ? EditorState.create({ doc: tr.doc }).tr.insertText('上屏文字', mapped!.from, mapped!.to).doc
      : null;
    expect(inserted?.childCount).toBe(1);
    expect(inserted?.textContent).toBe('上屏文字');
  });
});

describe('clampEditorTextRangeToDoc', () => {
  it('pulls block-boundary positions onto the nearest inline position', () => {
    const doc = stateWith('hi').doc;
    // 0 是 doc 起点、doc.content.size 是段落之后 —— 两者都不是 inline 位置。
    expect(clampEditorTextRangeToDoc({ from: 0, to: 0 }, doc)).toEqual({ from: 1, to: 1 });
    expect(clampEditorTextRangeToDoc({ from: doc.content.size, to: doc.content.size }, doc)).toEqual({
      from: 3,
      to: 3,
    });
  });

  it('clamps out-of-bounds offsets and normalizes inverted ranges', () => {
    const doc = stateWith('hi').doc;
    expect(clampEditorTextRangeToDoc({ from: 999, to: 999 }, doc)).toEqual({ from: 3, to: 3 });
    expect(clampEditorTextRangeToDoc({ from: 3, to: 1 }, doc)).toEqual({ from: 1, to: 3 });
  });

  // 只有折叠锚点该被吸附。非折叠区间的两端是"要替换什么"的一部分:全选(AllSelection)
  // 后开始听写,区间就是 0..content.size;把两端往里收会把外层节点(列表包装等)留在
  // 替换范围外,上屏文字于是塞进第一个列表项,而不是替换整篇。
  it('preserves the endpoints of a non-collapsed (AllSelection) range', () => {
    const doc = stateWith('hello').doc;
    expect(clampEditorTextRangeToDoc({ from: 0, to: doc.content.size }, doc)).toEqual({
      from: 0,
      to: doc.content.size,
    });
  });

  it('keeps a mapped non-collapsed range spanning the whole document', () => {
    const state = stateWith('hello');
    const size = state.doc.content.size;
    // 无关的 doc 变更(此处在区间内插入)不该让整篇替换范围被收进段落内。
    const tr = state.tr.insertText('X', 3);
    const mapped = mapEditorTextRange({ from: 0, to: size }, tr);

    expect(mapped!.from).toBe(0);
    expect(mapped!.to).toBe(tr.doc.content.size);
  });
});

// 上屏范围必须从事务推导:替换区间可以从 block 边界开始(全选后听写就是
// 0..content.size),ProseMirror 把 inline 文本 fit 进段落后字形落在边界之后。用插入
// 前的 from 记录会让润色回填读到截断文本而丢弃润色,预览与词典学习 watch 也一起错位。
describe('resolveInsertedTextRange', () => {
  it('reports where the text landed after a whole-document replacement', () => {
    const state = stateWith('旧的内容');
    const to = state.doc.content.size;
    const tr = state.tr.insertText('上屏文字', 0, to);
    const range = resolveInsertedTextRange(tr, 0, '上屏文字'.length);

    expect(tr.doc.childCount).toBe(1);
    expect(range).toEqual({ start: 1, end: 1 + '上屏文字'.length });
    expect(tr.doc.textBetween(range.start, range.end)).toBe('上屏文字');
  });

  it('reports the inserted span for an ordinary collapsed insertion', () => {
    const state = stateWith('abc');
    const tr = state.tr.insertText('XY', 2, 2);
    const range = resolveInsertedTextRange(tr, 2, 2);

    expect(range).toEqual({ start: 2, end: 4 });
    expect(tr.doc.textBetween(range.start, range.end)).toBe('XY');
  });
});
