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

import { mapEditorTextRange } from '../editorRangeMapping';

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
});
