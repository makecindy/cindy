/**
 * ChatInput reuses one Tiptap editor across session switches. A send the user
 * already requested must still go to that source session, even after the live
 * editor has been swapped to the next task's draft.
 *
 * Restore is immediate: the next task must not keep showing the source
 * session's refining text or a locked Send button. The in-flight send then
 * uses a frozen snapshot, optionally patched with the final refined span.
 */

export function editorOwnsSourceDraft(input: {
  editorDestroyed: boolean;
  editorStorageKey: string | undefined;
  sourceStorageKey: string | undefined;
}): boolean {
  return !input.editorDestroyed && input.editorStorageKey === input.sourceStorageKey;
}

export function voiceLocksCurrentComposer(input: {
  isBusy: boolean;
  ownerStorageKey: string | undefined;
  currentStorageKey: string | undefined;
}): boolean {
  return input.isBusy && input.ownerStorageKey === input.currentStorageKey;
}

export function applyRefinementToSerializedText(
  text: string,
  basedOnText: string,
  refinedText: string,
): string {
  if (!basedOnText || basedOnText === refinedText) return text;
  const index = text.lastIndexOf(basedOnText);
  if (index === -1) return text;
  return text.slice(0, index) + refinedText + text.slice(index + basedOnText.length);
}

/**
 * After a session switch the live attachment/comment refs belong to the next
 * task. A send that started on the source session must keep using the source
 * draft extras, never the newly restored composer.
 */
export function resolveSourceOwnedComposerExtras<TAttachment, TComment>(input: {
  editorOwnsSource: boolean;
  liveAttachments: readonly TAttachment[];
  liveComments: readonly TComment[];
  sourceAttachments?: readonly TAttachment[];
  sourceComments?: readonly TComment[];
}): { attachments: TAttachment[]; comments: TComment[] } {
  if (input.editorOwnsSource) {
    return {
      attachments: [...input.liveAttachments],
      comments: [...input.liveComments],
    };
  }
  return {
    attachments: [...(input.sourceAttachments ?? [])],
    comments: [...(input.sourceComments ?? [])],
  };
}
