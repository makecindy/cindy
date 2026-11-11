import { BrowserWindow, ipcMain, type WebContents } from 'electron';
import { NATIVE_TRACKPAD_HOST, isNativeTrackpadFrame } from '../shared/nativeTrackpad';
import { loadNativeTrackpad } from './nativeTrackpad';
import { assertTrustedAppRendererEvent } from './security/trustedAppRenderer.js';

/**
 * Two-finger trackpad samples for Cindy's own pages. Webview guests get them
 * through `installNativeTrackpad`, which hit-tests and maps inside the guest;
 * a trusted app page knows its own surface, so it only needs the raw samples
 * while the pointer is over it. The native capture is one per app and ends by
 * itself when the window stops being key, so a page that forgets to stop
 * cannot keep one alive in the background.
 */
export function registerNativeTrackpadHostIpc(platform: string = process.platform): void {
  let active: { sender: WebContents; id: number } | null = null;
  const stop = (sender?: WebContents) => {
    if (!active || (sender && active.sender !== sender)) return;
    loadNativeTrackpad()?.stop(active.id);
    active = null;
  };
  ipcMain.handle(NATIVE_TRACKPAD_HOST.START, (event) => {
    assertTrustedAppRendererEvent(event);
    if (platform !== 'darwin') return false;
    const sender = event.sender;
    const win = BrowserWindow.fromWebContents(sender);
    const bridge = loadNativeTrackpad();
    if (!win || win.isDestroyed() || !win.isFocused() || !bridge) return false;
    stop();
    const id = bridge.start(win.getNativeWindowHandle(), (text) => {
      if (sender.isDestroyed()) return;
      let frame: unknown;
      try {
        frame = JSON.parse(text);
      } catch {
        return;
      }
      if (isNativeTrackpadFrame(frame)) sender.send(NATIVE_TRACKPAD_HOST.FRAME, frame);
    });
    if (id === null) return false;
    active = { sender, id };
    return true;
  });
  ipcMain.handle(NATIVE_TRACKPAD_HOST.STOP, (event) => {
    assertTrustedAppRendererEvent(event);
    stop(event.sender);
  });
}
