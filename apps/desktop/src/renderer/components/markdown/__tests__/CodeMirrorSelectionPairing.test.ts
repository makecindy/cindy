// @vitest-environment jsdom

import { EditorState, EditorSelection } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it } from 'vitest';

import { handleCodeMirrorPairedSelection } from '../CodeMirrorSelectionPairing';

let view: EditorView | null = null;

afterEach(() => {
  view?.destroy();
  view = null;
});

function createView(doc: string, from: number, to: number): EditorView {
  view = new EditorView({
    parent: document.body,
    state: EditorState.create({
      doc,
      selection: EditorSelection.range(from, to),
    }),
  });
  return view;
}

describe('CodeMirror selection pairing', () => {
  it('wraps the selection in one undoable input transaction', () => {
    const editor = createView('before abc after', 7, 10);

    expect(handleCodeMirrorPairedSelection(editor, 7, 10, '[')).toBe(true);

    expect(editor.state.doc.toString()).toBe('before [abc] after');
    expect(editor.state.selection.main.from).toBe(8);
    expect(editor.state.selection.main.to).toBe(11);
  });

  it('leaves a collapsed selection and unsupported input to CodeMirror', () => {
    const editor = createView('abc', 1, 1);

    expect(handleCodeMirrorPairedSelection(editor, 1, 1, '(')).toBe(false);
    expect(handleCodeMirrorPairedSelection(editor, 0, 1, 'x')).toBe(false);
    expect(editor.state.doc.toString()).toBe('abc');
  });
});
