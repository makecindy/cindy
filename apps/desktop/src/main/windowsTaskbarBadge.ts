import { screen, type BrowserWindow } from 'electron';
import { createLogger } from './logger';
import { createWindowsBadgeIcon, renderWindowsBadgePng } from './windowsBadgeIcon';
import { loadWindowsTaskbarNative, type WindowsTaskbarNative } from './windowsTaskbarNative';

const log = createLogger('windowsTaskbarBadge');
const states = new WeakMap<BrowserWindow, BadgeState>();

/** The latest projection survives addon loading and Shell/DPI changes, never an old count. */
interface BadgeState {
  count: number;
  description: string;
  native?: WindowsTaskbarNative;
  loading: boolean;
  failed: boolean;
  warned: boolean;
}

export function setWindowsTaskbarBadge(
  win: BrowserWindow,
  count: number,
  description: string,
): void {
  if (process.platform !== 'win32' || win.isDestroyed()) return;
  let state = states.get(win);
  if (!state) {
    state = { count, description, loading: false, failed: false, warned: false };
    states.set(win, state);
    const current = state;
    const redraw = () => {
      if (!win.isDestroyed()) paint(win, current);
    };
    screen.on('display-added', redraw);
    screen.on('display-removed', redraw);
    screen.on('display-metrics-changed', redraw);
    win.on('show', redraw);
    win.once('closed', () => {
      screen.removeListener('display-added', redraw);
      screen.removeListener('display-removed', redraw);
      screen.removeListener('display-metrics-changed', redraw);
      states.delete(win);
    });
  }
  state.count = count;
  state.description = description;
  paint(win, state);
}

function warnOnce(state: BadgeState, error: unknown): void {
  if (state.warned) return;
  state.warned = true;
  log.warn('Native taskbar badge unavailable; using Electron overlay:', error);
}

function paint(win: BrowserWindow, state: BadgeState): void {
  if (state.native) {
    try {
      // One HICON is shared by all taskbars. Render for the densest display so
      // none has to upscale; the Shell can downsample on lower-DPI monitors.
      const scale = Math.min(8, Math.max(1, ...screen.getAllDisplays().map((d) => d.scaleFactor)));
      state.native.setOverlayIcon(
        win.getNativeWindowHandle(),
        state.count > 0 ? renderWindowsBadgePng(state.count, scale) : null,
        state.description,
      );
      return;
    } catch (error) {
      warnOnce(state, error);
      // A Shell restart can temporarily reject COM calls. Keep the bridge for
      // the next projection or TaskbarButtonCreated event, with no retry loop.
    }
  }
  try {
    win.setOverlayIcon(createWindowsBadgeIcon(state.count), state.description);
  } catch (error) {
    warnOnce(state, error);
  }
  if (state.native || state.loading || state.failed || state.count <= 0) return;
  state.loading = true;
  void loadWindowsTaskbarNative()
    .then((native) => {
      if (win.isDestroyed()) return;
      const message = native.taskbarButtonCreatedMessage();
      if (message) {
        win.hookWindowMessage(message, () => {
          // Paint after Electron's own handling of the Shell message completes.
          setImmediate(() => {
            if (!win.isDestroyed()) paint(win, state);
          });
        });
      }
      state.native = native;
      paint(win, state);
    })
    .catch((error: unknown) => {
      state.failed = true;
      warnOnce(state, error);
    })
    .finally(() => {
      state.loading = false;
    });
}
