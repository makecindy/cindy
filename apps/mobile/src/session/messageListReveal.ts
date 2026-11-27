import { createContext } from 'react';

/** Inline editors inside a message (e.g. a mail draft body) report a window-space
 * rect; the message list scrolls just enough to keep it between the header and
 * the composer/keyboard. Null outside a message list. */
export const MessageListRevealContext = createContext<((rect: { top: number; bottom: number }) => void) | null>(null);

/** A focused inline editor keeps the keyboard during list drags. Release on blur
 * or unmount; separate leases prevent one editor from clearing another's focus. */
export const MessageListKeepKeyboardContext = createContext<(() => () => void) | null>(null);
