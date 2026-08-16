/**
 * ChatInput reuses one Tiptap editor across session switches. While a voice
 * stop/refine/send is in flight, restoreNextDraft is deferred, so the route
 * / `storageKey` prop can already point at the next session while the editor
 * still holds the source session's document.
 *
 * A send that the user already requested must go to that source session.
 * The route having moved on is not a reason to drop it. Abort only when the
 * live editor has already been swapped away (and there is no click-time
 * snapshot to send instead).
 */

export function editorOwnsSourceDraft(input: {
  editorDestroyed: boolean;
  editorStorageKey: string | undefined;
  sourceStorageKey: string | undefined;
}): boolean {
  return !input.editorDestroyed && input.editorStorageKey === input.sourceStorageKey;
}
