import { app, BrowserWindow, ipcMain, screen } from 'electron';
import { assertTrustedAppRendererEvent, isTrustedAppRendererWindow } from './security/trustedAppRenderer';
import { throwIpcError } from './utils/ipcValidate';
import { SidebarWindowExpansion } from './sidebarWindowExpansion';

export function registerSidebarWindowExpansionIpc(): void {
  const expansion = new SidebarWindowExpansion();
  const watch = (win: BrowserWindow) => {
    let userResized = false;
    win.on('will-resize', (_event, next) => {
      if (next.width !== win.getBounds().width) userResized = true;
    });
    win.on('resized', () => {
      if (!userResized) return;
      userResized = false;
      if (win.isDestroyed() || win.isMaximized() || win.isFullScreen() || win.isSimpleFullScreen() ||
          !isTrustedAppRendererWindow(win)) return;
      win.webContents.send('window-sidebar-user-resize');
    });
  };
  BrowserWindow.getAllWindows().forEach(watch);
  app.on('browser-window-created', (_event, win) => watch(win));
  // Local chrome only; never expose this through device-link.
  ipcMain.handle('window-sidebar-expansion', (event, width: unknown, shrink: unknown, adopt: unknown) => {
    assertTrustedAppRendererEvent(event);
    if (typeof width !== 'number' || !Number.isFinite(width) || width < 0 || width > 16000) {
      throwIpcError('INVALID_PARAMS', 'Invalid sidebar expansion width');
    }
    if (shrink !== undefined && (typeof shrink !== 'number' || !Number.isFinite(shrink) || shrink < 0 || shrink > 16000)) {
      throwIpcError('INVALID_PARAMS', 'Invalid sidebar shrink width');
    }
    if (adopt !== undefined && typeof adopt !== 'boolean') {
      throwIpcError('INVALID_PARAMS', 'Invalid sidebar geometry mode');
    }
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return 0;
    // The renderer speaks CSS pixels; native bounds scale with the page zoom factor.
    const zoom = win.webContents.getZoomFactor();
    const scale = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
    const nativeShrink = typeof shrink === 'number' ? shrink * scale : undefined;
    const delta = adopt === true
      ? expansion.adopt(win, nativeShrink ?? 0)
      : expansion.update(win, width * scale, screen.getDisplayMatching(win.getBounds()).workArea, nativeShrink);
    return delta / scale;
  });
}
