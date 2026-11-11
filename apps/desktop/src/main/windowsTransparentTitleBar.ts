import type { BrowserWindow } from 'electron';

const WM_SYSCOMMAND = 0x0112;
const SC_MAXIMIZE = 0xf030;
const SC_RESTORE = 0xf120;
const SYSTEM_COMMAND_MASK = 0xfff0;
const HTCAPTION = 2;

/**
 * Install only on transparent app windows. Electron drops their SC_MAXIMIZE
 * commands, and its maximize() uses work-area bounds rather than WS_MAXIMIZE.
 * The frameless caption sends SC_MAXIMIZE | HTCAPTION on double-click,
 * even when Electron considers the transparent window maximized. Handle that
 * gesture using Electron's state/API, preserving the normal restore size.
 * Own the window's single WM_SYSCOMMAND hook, including native restore intent.
 */
export function installWindowsTransparentTitleBar(
  win: Pick<
    BrowserWindow,
    | 'hookWindowMessage'
    | 'unhookWindowMessage'
    | 'once'
    | 'removeListener'
    | 'isDestroyed'
    | 'isMaximizable'
    | 'isFullScreen'
    | 'isMinimized'
    | 'isMaximized'
    | 'maximize'
    | 'unmaximize'
  >,
  beforeUnmaximize: () => void = () => {},
  platform: NodeJS.Platform = process.platform,
): () => void {
  if (platform !== 'win32') return () => {};

  let disposed = false;
  let pending: ReturnType<typeof setImmediate> | undefined;
  const onSystemCommand = (wParam: Buffer): void => {
    if (disposed || wParam.length < 4 || win.isDestroyed()) return;
    const command = wParam.readUInt32LE(0);
    if ((command & SYSTEM_COMMAND_MASK) === SC_RESTORE) {
      beforeUnmaximize();
      return;
    }
    if (
      pending !== undefined ||
      command !== (SC_MAXIMIZE | HTCAPTION) ||
      !win.isMaximizable() ||
      win.isFullScreen() ||
      win.isMinimized()
    )
      return;

    const wasMaximized = win.isMaximized();
    // Leave the native message stack first. The hook observes; it cannot cancel
    // Windows' default processing. Do not toggle twice if native state changed.
    pending = setImmediate(() => {
      pending = undefined;
      if (
        disposed ||
        win.isDestroyed() ||
        !win.isMaximizable() ||
        win.isFullScreen() ||
        win.isMinimized() ||
        win.isMaximized() !== wasMaximized
      )
        return;
      if (wasMaximized) {
        beforeUnmaximize();
        win.unmaximize();
      } else {
        win.maximize();
      }
    });
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    if (pending !== undefined) clearImmediate(pending);
    pending = undefined;
    if (win.isDestroyed()) return;
    win.unhookWindowMessage(WM_SYSCOMMAND);
    win.removeListener('closed', dispose);
  };
  win.hookWindowMessage(WM_SYSCOMMAND, onSystemCommand);
  win.once('closed', dispose);
  return dispose;
}
