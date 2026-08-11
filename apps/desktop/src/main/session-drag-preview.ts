import { BrowserWindow, screen } from 'electron';

import type { SessionDragPreviewPalette } from '../shared/sessionDragPreview.js';
import { isAppContentWindow } from './windowFocusClassifier.js';
import { openSessionInNewWindowIfDroppedOutside } from './secondary-windows.js';
import { buildSessionDragPreviewHtml } from './sessionDragPreviewHtml.js';
import { createLogger } from './logger.js';
import { SessionDragNativeOpenCoordinator } from './sessionDragNativeOpenCoordinator.js';
import { SessionDragReleaseNativeHost } from './sessionDragReleaseNativeHost.js';
import { SessionDragPreviewController } from './sessionDragPreviewController.js';

const PREVIEW_WIDTH = 320;
const PREVIEW_HEIGHT = 68;
const log = createLogger('session-drag-preview/window');

function createSessionDragPreviewWindow(label: string, palette: SessionDragPreviewPalette) {
  const preview = new BrowserWindow({
    width: PREVIEW_WIDTH,
    height: PREVIEW_HEIGHT,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    closable: false,
    focusable: false,
    hasShadow: false,
    skipTaskbar: process.platform !== 'darwin',
    backgroundColor: '#00000000',
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      plugins: false,
      navigateOnDragDrop: false,
    },
  });
  preview.setIgnoreMouseEvents(true, { forward: true });
  preview.setAlwaysOnTop(true, 'floating', 1);

  let resolveReady: () => void = () => undefined;
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  preview.webContents.once('did-finish-load', resolveReady);
  preview.once('closed', resolveReady);
  void preview
    .loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(
        buildSessionDragPreviewHtml(label, palette),
      )}`,
    )
    .catch((error: unknown) => {
      log.warn('session drag preview failed to load', {
        errorName: error instanceof Error ? error.name : typeof error,
      });
      resolveReady();
    });

  return {
    ready,
    isDestroyed: () => preview.isDestroyed(),
    setPosition: (x: number, y: number, animate?: boolean) => preview.setPosition(x, y, animate),
    setOpacity: (opacity: number) => preview.setOpacity(opacity),
    showInactive: () => preview.showInactive(),
    hide: () => preview.hide(),
    close: () => preview.close(),
  };
}

let nativeReleaseHost: SessionDragReleaseNativeHost | null = null;
const nativeOpenCoordinator = new SessionDragNativeOpenCoordinator<BrowserWindow>();
const controller = new SessionDragPreviewController({
  screen,
  getAppWindowBounds: () =>
    BrowserWindow.getAllWindows()
      .filter((win) => isAppContentWindow(win) && win.isVisible() && !win.isMinimized())
      .map((win) => win.getBounds()),
  createPreviewWindow: createSessionDragPreviewWindow,
  onStopped: (token) => {
    nativeOpenCoordinator.stop(token);
    nativeReleaseHost?.disarm();
  },
});
nativeReleaseHost = new SessionDragReleaseNativeHost({
  onMouseUp: (token) => {
    nativeOpenCoordinator.handleNativeRelease(
      token,
      () => controller.endByToken(token),
      ({ owner, sessionId, deviceId }) =>
        openSessionInNewWindowIfDroppedOutside(sessionId, owner, owner, deviceId),
    );
  },
});

export function beginSessionDragPreview(
  sourceWindow: BrowserWindow,
  label: string,
  sessionId: string,
  deviceId: string | null | undefined,
  palette: SessionDragPreviewPalette,
): void {
  const token = controller.begin(sourceWindow, label, palette);
  if (token !== null) {
    nativeOpenCoordinator.begin(token, sourceWindow, sessionId, deviceId);
    void nativeReleaseHost?.arm(token);
  }
}

export function endSessionDragPreview(sourceWindow: BrowserWindow): void {
  controller.end(sourceWindow);
}

export function consumeNativeSessionDragOpenResult(
  sourceWindow: BrowserWindow,
  sessionId: string,
  deviceId?: string | null,
): boolean | null {
  return nativeOpenCoordinator.consumeNativeResult(sourceWindow, sessionId, deviceId);
}

export function prewarmSessionDragReleaseHelper(): void {
  void nativeReleaseHost?.prewarm();
}

export function disposeSessionDragPreview(): void {
  controller.end();
  nativeReleaseHost?.dispose();
}
