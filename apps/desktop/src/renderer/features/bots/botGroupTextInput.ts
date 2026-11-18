/** Full-text offsets are shared by textarea, collapsed paste editing, @ picks and dictation. */
export type BotGroupTextInput = Pick<
  HTMLTextAreaElement,
  'value' | 'selectionStart' | 'selectionEnd' | 'maxLength' | 'focus' | 'setSelectionRange'
> & { element?: HTMLElement };

export function botGroupInputElement(input: BotGroupTextInput | null): HTMLElement | null {
  return input?.element ?? (input as HTMLTextAreaElement | null);
}
