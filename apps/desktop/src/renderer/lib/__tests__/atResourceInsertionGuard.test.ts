import { describe, expect, it } from 'vitest';

import { isAtResourceInsertTargetCurrent } from '@/lib/atResourceInsertionGuard';

function editorWithDoc(doc: unknown) {
  return {
    isDestroyed: false,
    state: { doc },
  };
}

describe('isAtResourceInsertTargetCurrent', () => {
  it('accepts the picker result while the originating document is unchanged', () => {
    const doc = {};
    const editor = editorWithDoc(doc);

    expect(isAtResourceInsertTargetCurrent(editor, editor, doc, 'task-a', 'task-a')).toBe(true);
  });

  it('rejects a late picker result after the composer document changes', () => {
    const originDoc = {};
    const editor = editorWithDoc(originDoc);
    editor.state.doc = {};

    expect(isAtResourceInsertTargetCurrent(editor, editor, originDoc, 'task-a', 'task-a')).toBe(
      false,
    );
  });

  it('rejects a result after the composer switches tasks with the same document', () => {
    const doc = {};
    const editor = editorWithDoc(doc);

    expect(isAtResourceInsertTargetCurrent(editor, editor, doc, 'task-a', 'task-b')).toBe(false);
  });

  it('rejects a result after the composer switches editors or is destroyed', () => {
    const doc = {};
    const editor = editorWithDoc(doc);

    expect(
      isAtResourceInsertTargetCurrent(editor, editorWithDoc(doc), doc, 'task-a', 'task-a'),
    ).toBe(false);
    editor.isDestroyed = true;
    expect(isAtResourceInsertTargetCurrent(editor, editor, doc, 'task-a', 'task-a')).toBe(false);
  });
});
