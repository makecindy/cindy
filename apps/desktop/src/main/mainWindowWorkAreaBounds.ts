/**
 * Windows Snap (edge snap, Snap Layouts "fill", Win+Up on an already snapped
 * window) produces a rectangle that fills the work area while IsZoomed stays
 * false. electron-window-state only skips maximized / minimized / fullscreen, so
 * that rectangle is persisted as the normal restore size. The next launch then
 * creates a window whose unmaximize target is the work area itself: the
 * maximize button does nothing visible, and an auto-hidden taskbar stays shown.
 *
 * See issue #9461.
 */

export interface WorkAreaRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** DPI rounding and the 1px border Windows reports around a filled work area. */
const WORK_AREA_FILL_TOLERANCE_PX = 2;

export function boundsFillWorkArea(
  bounds: WorkAreaRect,
  workArea: WorkAreaRect,
  tolerancePx = WORK_AREA_FILL_TOLERANCE_PX,
): boolean {
  return (
    Math.abs(bounds.x - workArea.x) <= tolerancePx &&
    Math.abs(bounds.y - workArea.y) <= tolerancePx &&
    Math.abs(bounds.width - workArea.width) <= tolerancePx &&
    Math.abs(bounds.height - workArea.height) <= tolerancePx
  );
}

export interface PersistedWindowGeometry extends WorkAreaRect {
  isMaximized?: boolean;
  isFullScreen?: boolean;
}

export interface WorkAreaDisplay {
  bounds: WorkAreaRect;
  workArea: WorkAreaRect;
}

export interface WorkAreaScreen {
  getPrimaryDisplay(): WorkAreaDisplay;
  getDisplayMatching(rect: WorkAreaRect): WorkAreaDisplay;
}

/**
 * A non-maximized rectangle that fills the matching display's work area is not a
 * legal restore size. Treat it as maximized so launch calls `maximize()` and
 * Windows reports IsZoomed again. Fullscreen and already-maximized states are
 * left to their own restore path. Other platforms keep the saved geometry:
 * filling the work area there is an ordinary large window.
 */
export function shouldTreatPersistedBoundsAsMaximized(
  state: PersistedWindowGeometry,
  screenApi: WorkAreaScreen,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform !== 'win32' || state.isMaximized === true || state.isFullScreen === true) {
    return false;
  }
  if (![state.x, state.y, state.width, state.height].every(Number.isFinite)) return false;
  const display =
    state.width > 0 && state.height > 0
      ? screenApi.getDisplayMatching(state)
      : screenApi.getPrimaryDisplay();
  return boundsFillWorkArea(state, display.workArea);
}

export interface PersistableWindow {
  isMaximized(): boolean;
  isMinimized(): boolean;
  isFullScreen(): boolean;
  isSnapped?: () => boolean;
  getBounds(): WorkAreaRect;
}

/**
 * While a window is snapped (or otherwise filling the work area without being
 * maximized), electron-window-state would overwrite the last real restore size.
 * Report the previous normal bounds instead so close persists that size and the
 * next unmaximize has somewhere to return to. Returns null when the live bounds
 * are already a legal restore size.
 */
export function normalBoundsForPersistence(
  win: PersistableWindow,
  previousNormalBounds: WorkAreaRect | null,
  screenApi: Pick<WorkAreaScreen, 'getDisplayMatching'>,
  platform: NodeJS.Platform = process.platform,
): WorkAreaRect | null {
  if (platform !== 'win32' || win.isMaximized() || win.isMinimized() || win.isFullScreen()) {
    return null;
  }
  const bounds = win.getBounds();
  const snapped = win.isSnapped?.() === true;
  const fillsWorkArea = boundsFillWorkArea(bounds, screenApi.getDisplayMatching(bounds).workArea);
  if (!snapped && !fillsWorkArea) return null;
  return previousNormalBounds ?? bounds;
}

export interface ManagedWindowState {
  manage(win: PersistableWindow): void;
}

/**
 * electron-window-state binds `win.getBounds` while installing its listeners and
 * keeps calling that bound function. Leave the substitute in place for the
 * keeper, and put the real method back on the window so later callers (sidebar
 * expansion, drag) still read the live rectangle. `remember` runs after the
 * keeper's own resize/move listener, which Electron registers first.
 */
export function manageWindowStatePreservingNormalBounds(
  windowState: ManagedWindowState,
  win: PersistableWindow,
  screenApi: Pick<WorkAreaScreen, 'getDisplayMatching'>,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform !== 'win32') {
    windowState.manage(win);
    return;
  }
  let previousNormalBounds: WorkAreaRect | null = normalBoundsForPersistence(
    win,
    null,
    screenApi,
    platform,
  )
    ? null
    : { ...win.getBounds() };
  const originalGetBounds = win.getBounds.bind(win);
  const boundsForKeeper = () => {
    const live = originalGetBounds();
    return (
      normalBoundsForPersistence(
        { ...win, getBounds: () => live },
        previousNormalBounds,
        screenApi,
        platform,
      ) ?? live
    );
  };
  const remember = () => {
    if (win.isMaximized() || win.isMinimized() || win.isFullScreen()) return;
    const live = originalGetBounds();
    if (
      normalBoundsForPersistence(
        { ...win, getBounds: () => live },
        null,
        screenApi,
        platform,
      )
    ) {
      return;
    }
    previousNormalBounds = live;
  };
  win.getBounds = boundsForKeeper;
  try {
    windowState.manage(win);
  } finally {
    win.getBounds = originalGetBounds;
  }
  const originalOn = (win as PersistableWindow & {
    on?: (event: string, listener: () => void) => unknown;
  }).on?.bind(win);
  if (!originalOn) return;
  originalOn('resize', remember);
  originalOn('move', remember);
}
