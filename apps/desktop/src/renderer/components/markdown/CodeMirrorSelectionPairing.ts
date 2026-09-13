import { EditorSelection } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

import { closingSymbolFor } from '@/lib/pairedSelection';

/** CodeMirror input boundary for wrapping one non-empty primary selection. */
export function handleCodeMirrorPairedSelection(
  view: EditorView,
  from: number,
  to: number,
  input: string,
): boolean {
  const close = closingSymbolFor(input);
  if (close === null || from === to || view.composing || view.state.selection.ranges.length !== 1) {
    return false;
  }

  view.dispatch({
    changes: [
      { from, insert: input },
      { from: to, insert: close },
    ],
    selection: EditorSelection.range(from + input.length, to + input.length),
    userEvent: 'input.type',
  });
  return true;
}

/** Shared extension used by plain-text, Markdown, and code-file editor modes. */
export const codeMirrorSelectionPairing = EditorView.inputHandler.of(
  handleCodeMirrorPairedSelection,
);
