import { nativeTheme, type BrowserWindow } from 'electron';
import { createLogger } from './logger';
import { loadWindowsTaskbarNative, type WindowsTaskbarNative } from './windowsTaskbarNative';

const log = createLogger('windowsWindowDarkMode');
const requested = new WeakMap<BrowserWindow, boolean>();
const tracked = new Set<BrowserWindow>();
let native: WindowsTaskbarNative | null | undefined;
let loading: Promise<void> | undefined;
let warned = false;

function warnOnce(error: unknown): void {
  if (warned) return;
  warned = true;
  log.warn('Window dark mode unavailable; the system backdrop follows the Windows setting:', error);
}

function paint(win: BrowserWindow): void {
  const dark = requested.get(win);
  if (!native || dark === undefined || win.isDestroyed()) return;
  try {
    if (!native.setWindowDarkMode(win.getNativeWindowHandle(), dark)) warnOnce('rejected');
  } catch (error) {
    warnOnce(error);
  }
}

// Electron re-derives every window's mode from the Windows setting when that
// setting changes; re-assert Cindy's own theme after its handling completes.
function repaintAll(): void {
  setImmediate(() => {
    for (const win of tracked) paint(win);
  });
}

/**
 * Windows 11 tints the Acrylic/Mica system backdrop by each window's own
 * light/dark mode. Follow Cindy's resolved theme instead of the Windows
 * setting, so a dark theme never shows a white-tinted backdrop once the desktop
 * shows through. Only this process's own windows; no IPC, setting or persistence.
 */
export function setWindowsWindowDarkMode(
  win: BrowserWindow,
  dark: boolean,
  load: () => Promise<WindowsTaskbarNative> = loadWindowsTaskbarNative,
): void {
  if (process.platform !== 'win32' || win.isDestroyed()) return;
  requested.set(win, dark);
  if (!tracked.has(win)) {
    if (tracked.size === 0) nativeTheme.on('updated', repaintAll);
    tracked.add(win);
    win.once('closed', () => {
      tracked.delete(win);
      if (tracked.size === 0) nativeTheme.removeListener('updated', repaintAll);
    });
  }
  if (native) {
    paint(win);
    return;
  }
  if (native === null) return;
  // A missing compiler/addon must not trigger another load on every theme change.
  loading ??= load()
    .then((loaded) => {
      native = loaded;
      for (const entry of tracked) paint(entry);
    })
    .catch((error: unknown) => {
      native = null;
      warnOnce(error);
    });
}

/** Test-only reset of the module-level bridge state. */
export function resetWindowsWindowDarkModeForTest(): void {
  for (const win of tracked) requested.delete(win);
  tracked.clear();
  nativeTheme.removeListener('updated', repaintAll);
  native = undefined;
  loading = undefined;
  warned = false;
}
