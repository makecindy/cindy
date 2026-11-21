import type { ComposerRichInputHandle } from './ComposerRichInput';

export function restoreComposerFocusAfterAttachment(
  inputRef: { readonly current: ComposerRichInputHandle | null },
  isCurrent: () => boolean,
): void {
  const editor = inputRef.current;
  if (!editor || !isCurrent()) return;
  // Dismissing native media UI can hide the keyboard while the editor keeps DOM focus.
  editor.blur();
  requestAnimationFrame(() => {
    if (isCurrent() && inputRef.current === editor) editor.focus();
  });
}
