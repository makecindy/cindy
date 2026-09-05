import { Extension } from '@tiptap/core';
import { Plugin, TextSelection } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

import { closingSymbolFor } from '@/lib/pairedSelection';

/** Wrap a ProseMirror selection without flattening inline structured nodes. */
export function handlePairedSelectionInput(
  view: EditorView,
  from: number,
  to: number,
  input: string,
): boolean {
  const close = closingSymbolFor(input);
  if (
    close === null ||
    from === to ||
    view.composing ||
    !(view.state.selection instanceof TextSelection)
  ) {
    return false;
  }

  const transaction = view.state.tr.insertText(close, to).insertText(input, from);
  transaction.setSelection(
    TextSelection.create(transaction.doc, from + input.length, to + input.length),
  );
  view.dispatch(transaction.scrollIntoView());
  return true;
}

/** Tiptap input rule for VS Code-style wrapping of selected composer content. */
export const SelectionPairing = Extension.create({
  name: 'selectionPairing',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          handleTextInput: handlePairedSelectionInput,
        },
      }),
    ];
  },
});
