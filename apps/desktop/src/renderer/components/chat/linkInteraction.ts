import type { KeyboardEvent, MouseEvent as ReactMouseEvent } from 'react';

/** Leave the current reading surface intact; all message link renderers share this gesture. */
export function isSeparateLinkActivation(event: {
  shiftKey?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
  button?: number;
}): boolean {
  return Boolean(event.shiftKey || event.metaKey || event.ctrlKey || event.button === 1);
}

/** Give anchors and inline chips the same keyboard activation, retaining modifiers. */
export function activateInlineLinkFromKeyboard(event: KeyboardEvent<HTMLElement>): void {
  if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
    );
    return;
  }
  if (event.key !== 'Enter' && event.key !== ' ') return;
  event.preventDefault();
  event.currentTarget.dispatchEvent(
    new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      shiftKey: event.shiftKey,
      metaKey: event.metaKey,
      ctrlKey: event.ctrlKey,
      altKey: event.altKey,
    }),
  );
}

/** Keyboard context menus anchor to the focused link, never the screen's top-left. */
export function linkMenuPosition(event: ReactMouseEvent<HTMLElement>): { x: number; y: number } {
  if (event.clientX || event.clientY) return { x: event.clientX, y: event.clientY };
  const rect = event.currentTarget.getBoundingClientRect();
  return { x: rect.left, y: rect.bottom };
}
