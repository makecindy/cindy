import type { BrowserWindow, Rectangle } from 'electron';

type StartupWindow = {
  isDestroyed: () => boolean;
  setFullScreen: (value: boolean) => void;
  show: () => void;
};

type Schedule = (callback: () => void) => void;

type FullscreenStateWindow = Pick<
  BrowserWindow,
  'getBounds' | 'isDestroyed' | 'isFullScreen' | 'isSimpleFullScreen' | 'on' | 'webContents'
>;

export function readWindowFullscreenState(
  window: Pick<FullscreenStateWindow, 'isFullScreen' | 'isSimpleFullScreen'> | null,
): boolean {
  return Boolean(window && (window.isFullScreen() || window.isSimpleFullScreen()));
}

/** Keeps each renderer synchronized with the native state of its own window. */
export function installWindowFullscreenStateBroadcast(
  window: FullscreenStateWindow,
  options: {
    getDisplayBounds?: (windowBounds: Rectangle) => Pick<Rectangle, 'width' | 'height'>;
  } = {},
): void {
  let inFullscreen = readWindowFullscreenState(window);
  const publish = (fullscreen: boolean): void => {
    if (window.isDestroyed() || window.webContents.isDestroyed?.()) return;
    window.webContents.send('fullscreen-change', fullscreen);
  };

  window.on('enter-full-screen', () => {
    inFullscreen = true;
    publish(true);
  });
  window.on('leave-full-screen', () => {
    if (!inFullscreen) return;
    inFullscreen = false;
    publish(false);
  });
  window.on('resize', () => {
    if (!inFullscreen || !options.getDisplayBounds) return;
    const bounds = window.getBounds();
    const display = options.getDisplayBounds(bounds);
    if (bounds.width < display.width || bounds.height < display.height) {
      inFullscreen = false;
      publish(false);
    }
  });
}

export function showMainWindowAndRestoreFullscreen(
  window: StartupWindow,
  options: {
    platform?: NodeJS.Platform;
    restoreFullscreen?: boolean;
    schedule?: Schedule;
  } = {},
): void {
  window.show();

  const platform = options.platform ?? process.platform;
  if (platform !== 'darwin' || !options.restoreFullscreen) return;

  const schedule = options.schedule ?? ((callback) => setImmediate(callback));
  schedule(() => {
    if (!window.isDestroyed()) window.setFullScreen(true);
  });
}
