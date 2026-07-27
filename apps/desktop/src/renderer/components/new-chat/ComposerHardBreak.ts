import HardBreak from '@tiptap/extension-hard-break';
import { Plugin } from '@tiptap/pm/state';
import type { Editor } from '@tiptap/core';
import { applyListContinuation } from '@/lib/composerListContinuation';

/**
 * Apply the composer's modified-Enter behavior. Kept beside the extension so
 * ChatInput owns only the stable keyboard boundary, not document semantics.
 */
export function applyComposerHardBreak(editor: Editor): boolean {
  if (applyListContinuation(editor.view)) return true;
  return editor.commands.setHardBreak();
}

/**
 * Composer-owned hard-break schema and IME boundary.
 */
export const ComposerHardBreak = HardBreak.extend({
  // HardBreak owns only the schema/command here. ChatInput invokes the helper
  // above from its stable key boundary so extension ordering cannot decide
  // whether modified Enter reaches the composer behavior.
  addKeyboardShortcuts() {
    return {};
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          handleDOMEvents: {
            // ProseMirror already skips handleKeyDown while `view.composing`,
            // but an IME keydown may still report `isComposing` after the view
            // has ended its composition. Stop that Enter before any composer
            // handler can mutate the document. Do not preventDefault: the IME
            // still owns candidate confirmation.
            keydown: (view, event) =>
              event.key === 'Enter' && (event.isComposing || view.composing),
          },
        },
      }),
    ];
  },
});
