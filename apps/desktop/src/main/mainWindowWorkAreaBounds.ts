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

export interface WindowRestorePlan {
  /** Call maximize() after the window exists. */
  restoreMaximized: boolean;
  /**
   * The saved rectangle is the work area itself, so it cannot be the
   * unmaximize target. Create at the keeper's default size instead.
   */
  replaceWithDefaultSize: boolean;
}

/**
 * Decide the next launch from what was written to window-state.json.
 * A real maximize flag wins. A work-area rectangle saved without that flag
 * (older builds) is still treated as maximized, and its rectangle is discarded.
 */
export function planWindowRestore(
  state: PersistedWindowGeometry,
  screenApi: WorkAreaScreen,
  options: { restoringMacFullscreen?: boolean; platform?: NodeJS.Platform } = {},
): WindowRestorePlan {
  if (options.restoringMacFullscreen) {
    return { restoreMaximized: false, replaceWithDefaultSize: false };
  }
  const alreadyMaximized = state.isMaximized === true;
  const snapFilledWorkArea =
    !alreadyMaximized &&
    shouldTreatPersistedBoundsAsMaximized(
      { ...state, isMaximized: false },
      screenApi,
      options.platform,
    );
  return {
    restoreMaximized: alreadyMaximized || snapFilledWorkArea,
    replaceWithDefaultSize: snapFilledWorkArea,
  };
}

export interface PersistableWindow {
  isMaximized(): boolean;
  isMinimized(): boolean;
  isFullScreen(): boolean;
  getBounds(): WorkAreaRect;
  isSnapped?: () => boolean;
  on?(event: string, listener: () => void): unknown;
  removeListener?(event: string, listener: () => void): unknown;
  maximize?(): void;
  setFullScreen?(flag: boolean): void;
}

export interface PersistedBoundsDecision {
  /** Last legal restore rectangle. Null when the live bounds are already legal. */
  bounds: WorkAreaRect | null;
  /**
   * The window is filling the work area without IsZoomed. Keep the restore
   * rectangle, but tell the keeper the user left it maximized so the next
   * launch calls maximize() instead of opening the old small window.
   */
  reportMaximized: boolean;
}

/**
 * While a window is snapped (or otherwise filling the work area without being
 * maximized), electron-window-state would overwrite the last real restore size.
 * Report the previous normal bounds instead so close persists that size and the
 * next unmaximize has somewhere to return to. `bounds` is null when the live
 * rectangle is already a legal restore size.
 */
export function persistedBoundsDecision(
  win: PersistableWindow,
  previousNormalBounds: WorkAreaRect | null,
  screenApi: Pick<WorkAreaScreen, 'getDisplayMatching'>,
  platform: NodeJS.Platform = process.platform,
): PersistedBoundsDecision {
  if (platform !== 'win32' || win.isMaximized() || win.isMinimized() || win.isFullScreen()) {
    return { bounds: null, reportMaximized: false };
  }
  const bounds = win.getBounds();
  const snapped = win.isSnapped?.() === true;
  const fillsWorkArea = boundsFillWorkArea(bounds, screenApi.getDisplayMatching(bounds).workArea);
  if (!snapped && !fillsWorkArea) return { bounds: null, reportMaximized: false };
  return { bounds: previousNormalBounds ?? bounds, reportMaximized: true };
}

export function normalBoundsForPersistence(
  win: PersistableWindow,
  previousNormalBounds: WorkAreaRect | null,
  screenApi: Pick<WorkAreaScreen, 'getDisplayMatching'>,
  platform: NodeJS.Platform = process.platform,
): WorkAreaRect | null {
  return persistedBoundsDecision(win, previousNormalBounds, screenApi, platform).bounds;
}

export interface ManagedWindowState {
  manage(win: PersistableWindow): void;
}

/**
 * Spreading a BrowserWindow copies only own properties and drops prototype
 * methods (`isMaximized` / `isMinimized` / `isFullScreen` / `isSnapped`). The
 * keeper calls those methods, plus `on` / `removeListener` / `maximize`, on the
 * object it was given. Forward them to the real window so `this` stays valid.
 */
export function windowStateView(
  win: PersistableWindow,
  getBounds: () => WorkAreaRect,
  reportMaximized: () => boolean = () => false,
): PersistableWindow {
  return {
    isMaximized: () => reportMaximized() || win.isMaximized(),
    isMinimized: () => win.isMinimized(),
    isFullScreen: () => win.isFullScreen(),
    isSnapped: () => win.isSnapped?.() === true,
    getBounds,
    on: win.on ? (event, listener) => win.on?.(event, listener) : undefined,
    removeListener: win.removeListener
      ? (event, listener) => win.removeListener?.(event, listener)
      : undefined,
    maximize: win.maximize ? () => win.maximize?.() : undefined,
    setFullScreen: win.setFullScreen ? (flag) => win.setFullScreen?.(flag) : undefined,
  };
}

/**
 * The keeper is given a view, not the BrowserWindow. Its `getBounds` stays
 * substituted for the life of the listeners; the real window is left alone so
 * later callers (sidebar expansion, drag) still read the live rectangle.
 * `remember` is registered after `manage`: Electron emits listeners in
 * registration order, so the keeper reads the previous normal size first.
 *
 * A work-area fill is saved as the last normal rectangle plus `isMaximized`,
 * matching what a real maximize already persists. Next launch then restores the
 * maximized window instead of the small one the user had before snapping.
 */
export function manageWindowStatePreservingNormalBounds(
  windowState: ManagedWindowState,
  win: PersistableWindow,
  screenApi: Pick<WorkAreaScreen, 'getDisplayMatching'>,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform !== 'win32') {
    windowState.manage(windowStateView(win, () => win.getBounds()));
    return;
  }
  let previousNormalBounds: WorkAreaRect | null = persistedBoundsDecision(
    win,
    null,
    screenApi,
    platform,
  ).reportMaximized
    ? null
    : { ...win.getBounds() };
  const originalGetBounds = win.getBounds.bind(win);
  const boundsForKeeper = () => {
    const live = originalGetBounds();
    const decision = persistedBoundsDecision(
      windowStateView(win, () => live),
      previousNormalBounds,
      screenApi,
      platform,
    );
    return decision.bounds ?? live;
  };
  const remember = () => {
    if (win.isMaximized() || win.isMinimized() || win.isFullScreen()) return;
    const live = originalGetBounds();
    if (
      persistedBoundsDecision(windowStateView(win, () => live), null, screenApi, platform)
        .reportMaximized
    ) {
      return;
    }
    previousNormalBounds = live;
  };
  const reportMaximized = () =>
    persistedBoundsDecision(
      windowStateView(win, originalGetBounds),
      previousNormalBounds,
      screenApi,
      platform,
    ).reportMaximized;
  const view = windowStateView(win, boundsForKeeper, reportMaximized);
  windowState.manage(view);
  view.on?.('resize', remember);
  view.on?.('move', remember);
}
