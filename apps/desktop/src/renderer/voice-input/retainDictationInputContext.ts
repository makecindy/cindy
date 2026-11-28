import type { Editor } from '@tiptap/core';

// EditContext is available in desktop Chromium ahead of our TypeScript DOM types.
type EditContextHost = HTMLElement & { editContext?: EventTarget | null };
type EditContextWindow = Window & { EditContext?: new () => EventTarget };

export function retainDictationInputContext(editor: Editor): (() => void) | undefined {
  const view = editor.view;
  const host: EditContextHost = view.dom;
  const doc = host.ownerDocument;
  const EditContext = (doc.defaultView as EditContextWindow | null)?.EditContext;
  if (!EditContext || !('editContext' in host) || host.editContext || view.composing) return;
  const focusFromBody = doc.activeElement === doc.body && doc.hasFocus();
  if (doc.activeElement !== host && !focusFromBody) return;

  // macOS otherwise reactivates its input UI on unlock, which can flash a
  // full-screen window. Input to this empty context never edits the draft.
  const context = new EditContext();
  const previousReadOnly = host.ariaReadOnly;
  host.editContext = context;
  // Chromium exposes an EditContext host as editable to assistive technology.
  host.ariaReadOnly = 'true';
  if (focusFromBody) host.focus({ preventScroll: true });

  return () => {
    if (host.editContext === context) host.editContext = null;
    if (host.ariaReadOnly === 'true') host.ariaReadOnly = previousReadOnly;
  };
}
