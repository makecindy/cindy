/**
 * Bring the main window back in front of the user (tray "Open Cindy", tray
 * activation, second-instance, app activate).
 *
 * Native Wayland (Ozone `wayland`) cannot use the X11/Windows/macOS path:
 * - xdg-shell has no "unminimize" request, so `restore()` after `minimize()`
 *   only flips Electron's own state while the compositor keeps the window
 *   minimized.
 * - Electron's StatusNotifierItem does not implement
 *   `ProvideXdgActivationToken`, so a tray click carries no activation token
 *   and `focus()` is not honoured by GNOME (it shows "… is ready" instead).
 * - A minimize performed by the compositor (Dock, Super+H) is not reported to
 *   the client at all: Electron keeps `isMinimized() === false` and
 *   `isVisible() === true`.
 * Re-mapping the toplevel (hide + show) is the only client-side request the
 * compositor treats as a new window to place and focus. `restore()` must run
 * first so Electron does not map it again in its minimized state.
 * Verified on Ubuntu 24.04 GNOME Shell 46 + AppIndicator, Electron 42 (#6240).
 * Trade-off: Wayland clients cannot choose their position, so a re-mapped
 * window is placed again by the compositor.
 */
export interface PresentableWindow {
  isVisible(): boolean;
  isMinimized(): boolean;
  isFocused(): boolean;
  show(): void;
  hide(): void;
  restore(): void;
  focus(): void;
}

export interface PresentMainWindowOptions {
  /** True only when Electron actually runs on the Ozone Wayland backend. */
  nativeWayland: boolean;
}

/**
 * Use the resolved Ozone backend, not the session type: `--ozone-platform=x11` runs on XWayland.
 * Electron 42 resolves the default `--ozone-platform-hint=auto` and writes the chosen backend
 * back to this switch, so it reads `wayland` on a Wayland session even when launched without
 * flags (verified on Ubuntu 24.04 GNOME, #6240).
 */
export function isLinuxNativeWayland(platform: NodeJS.Platform, ozonePlatform: string): boolean {
  return platform === 'linux' && ozonePlatform.trim().toLowerCase() === 'wayland';
}

export function presentMainWindow(win: PresentableWindow, options: PresentMainWindowOptions): void {
  if (options.nativeWayland && (win.isMinimized() || !win.isFocused())) {
    // Electron may believe the window is on screen while the compositor has
    // it minimized, so a visible but unfocused window is re-mapped too.
    if (win.isMinimized()) win.restore();
    win.hide();
    win.show();
  } else {
    if (!win.isVisible()) win.show();
    if (win.isMinimized()) win.restore();
  }
  win.focus();
}
