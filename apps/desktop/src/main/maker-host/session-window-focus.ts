import { BrowserWindow, type WebContents } from 'electron';

// MainLayout reports its visible session on route changes. This is only a
// prompt-placement hint: the native dialog still requires an explicit click.
const focusedSessionByWebContents = new Map<number, string | null>();

export function noteSessionWindowFocus(sender: WebContents, sessionId: string | null): void {
  if (!focusedSessionByWebContents.has(sender.id)) {
    sender.once('destroyed', () => focusedSessionByWebContents.delete(sender.id));
  }
  focusedSessionByWebContents.set(sender.id, sessionId);
}

export function clearSessionWindowFocus(): void {
  focusedSessionByWebContents.clear();
}

export function focusedWindowForSession(sessionId: string): BrowserWindow | null {
  const window = BrowserWindow.getFocusedWindow();
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return null;
  return focusedSessionByWebContents.get(window.webContents.id) === sessionId ? window : null;
}
