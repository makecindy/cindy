/** Full-text offsets are shared by textarea, collapsed paste editing, @ picks and dictation. */
export type BotGroupInitialPaste = { before: string; text: string; selected: string; after: string };

export type BotGroupTextInput = Pick<
  HTMLTextAreaElement,
  'value' | 'selectionStart' | 'selectionEnd' | 'maxLength' | 'focus' | 'setSelectionRange'
> & { element?: HTMLElement };

export function botGroupInputElement(input: BotGroupTextInput | null): HTMLElement | null {
  return input?.element ?? (input as HTMLTextAreaElement | null);
}

/** Give a topic's input focus even when its long draft loads the editor asynchronously. */
export function focusBotGroupComposer(panel: HTMLElement | null | undefined): (() => void) | undefined {
  if (!panel) return;
  const composer = panel.querySelector('[data-bot-group-composer]');
  const findInput = () => composer?.querySelector<HTMLElement>(
    'textarea:not(:disabled), [role="textbox"][tabindex="0"]',
  );
  const input = findInput();
  const fallback = panel.querySelector<HTMLButtonElement>('header button');
  (input ?? fallback)?.focus({ preventScroll: true });
  if (input || !fallback || !composer?.querySelector('[data-bot-group-composer-loading]')) return;

  const observer = new MutationObserver(() => {
    const readyInput = findInput();
    if (!readyInput) return;
    cancel();
    if (panel.isConnected && !panel.inert && panel.ownerDocument.activeElement === fallback)
      readyInput.focus({ preventScroll: true });
  });
  const cancel = () => {
    observer.disconnect();
    fallback.removeEventListener('blur', cancel);
  };
  fallback.addEventListener('blur', cancel, { once: true });
  observer.observe(composer, { childList: true, subtree: true, attributes: true, attributeFilter: ['tabindex'] });
  return cancel;
}
