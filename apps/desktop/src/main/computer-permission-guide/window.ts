/**
 * Electron Computer Use permission coach.
 *
 * System Settings covers the main Cindy window, so the macOS onboarding lives
 * in its own always-on-top BrowserWindow. A second mouse-transparent window is
 * kept behind it so renderer effects are never clipped while System Settings
 * remains fully interactive.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  app,
  BrowserWindow,
  nativeImage,
  screen,
  shell,
} from 'electron';
import type { Rectangle, WebContents } from 'electron';

import { scheduleMainAppPresenceRestore } from '../appPresence.js';
import { createLogger } from '../logger.js';
import { MAKER_PUSH } from '../maker-ipc/channels.js';
import {
  cancelComputerDriverPermissionGrant,
  getComputerDriverAppBundlePath,
  getComputerDriverStatus,
  isComputerDriverPermissionProbePaused,
  resumeComputerDriverPermissionProbe,
} from '../mcp-integrations/computer.js';
import {
  closeComputerUseSwitchLocator,
  locateComputerUseSwitchTarget,
  type ComputerUseSwitchLocationResult,
  type ComputerUseSystemWindowBounds,
} from './switch-target.js';
import {
  computeComputerPermissionGuideBounds,
  PERMISSION_GUIDE_WINDOW_WIDTH,
  PERMISSION_GUIDE_WINDOW_HEIGHT,
} from './placement.js';
import {
  MacComputerPermissionGuideNativeHost,
  type ComputerPermissionGuideNativeState,
} from './MacComputerPermissionGuideNativeHost.js';

const log = createLogger('computer-permission-guide');
// v1 was also used as evidence that the row existed. That is not safe: a
// stale record survives when the user removes CuaDriver from System Settings,
// and the old locator can then re-register the app while checking the page.
// v2 is an interaction hint only and is written after a confirmed copy drag.
const DRAG_STATE_FILE_NAME = 'cua-driver-drag-state-v2.json';
const SWITCH_OBSERVER_INTERVAL_MS = 900;
const PERMISSION_PROBE_BYPASS_MIN_INTERVAL_MS = 2_000;
const DRAG_RESTORE_TIMEOUT_MS = 12_000;
const NATIVE_ATTACH_TIMEOUT_MS = 30_000;
const DRAG_ICON_DATA_URL_PREFIX = 'data:image/png;base64,';
const MAX_DRAG_ICON_BASE64_LENGTH = 256 * 1024;
const PNG_SIGNATURE_BASE64_PREFIX = 'iVBORw0KGgo';
const MAC_ACCESSIBILITY_SETTINGS_URL =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility';
const MAC_SCREEN_RECORDING_SETTINGS_URL =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture';
const GUIDE_WINDOW_MARGIN = 16;

type ComputerStatus = Awaited<ReturnType<typeof getComputerDriverStatus>>;
type PermissionKind = 'accessibility' | 'screenRecording';
interface PermissionGuideRefreshOptions {
  bypassPermissionProbeCache?: boolean;
  freshPermissionProbe?: boolean;
  knownStatus?: ComputerStatus;
  forceBroadcast?: boolean;
  observedLocation?: ComputerUseSwitchLocationResult;
}

let guideWindow: BrowserWindow | null = null;
let backdropWindow: BrowserWindow | null = null;
let guideOwner: BrowserWindow | null = null;
let guideStatus: ComputerStatus | null = null;
let switchObserverTimer: ReturnType<typeof setInterval> | null = null;
let switchObserverPendingGeneration: number | null = null;
let lastSwitchObservation = '';
let permissionGuideUpdateQueue: Promise<void> = Promise.resolve();
let guideLifecycleGeneration = 0;
let lastPermissionProbeBypassAt: number | null = null;
let pendingObserverTrailingProbe: ReturnType<typeof setTimeout> | null = null;
let dragRestoreTimer: ReturnType<typeof setTimeout> | null = null;
let dragInProgress = false;
let draggedPermission: PermissionKind | null = null;
let permissionDragStateCache: PermissionDragState | null = null;
let nativeHost: MacComputerPermissionGuideNativeHost | null = null;
let lastSwitchLocation: ComputerUseSwitchLocationResult | null = null;
let nativeAttachTimeout: ReturnType<typeof setTimeout> | null = null;
let nativeGuideAttached = false;
let lastOpenedPermissionPaneUrl: string | null = null;

/** Per-pane lifecycle state that public macOS permission APIs do not expose. */
export interface PermissionDragState {
  accessibility: boolean;
  screenRecording: boolean;
}

function getPermissionDragStatePath(): string {
  return path.join(app.getPath('userData'), 'computer-permission-guide', DRAG_STATE_FILE_NAME);
}

/** Read whether the user has already attempted the app drag for each pane. */
export function readPermissionDragState(): PermissionDragState {
  if (permissionDragStateCache) return { ...permissionDragStateCache };
  try {
    const parsed = JSON.parse(
      fs.readFileSync(getPermissionDragStatePath(), 'utf8'),
    ) as Partial<PermissionDragState>;
    permissionDragStateCache = {
      accessibility: parsed.accessibility === true,
      screenRecording: parsed.screenRecording === true,
    };
  } catch {
    permissionDragStateCache = { accessibility: false, screenRecording: false };
  }
  return { ...permissionDragStateCache };
}

function writePermissionDragState(state: PermissionDragState): void {
  permissionDragStateCache = { ...state };
  const filePath = getPermissionDragStatePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(state)}\n`, 'utf8');
}

function clearPermissionDragState(permission: PermissionKind): void {
  const state = readPermissionDragState();
  if (!state[permission]) return;
  state[permission] = false;
  writePermissionDragState(state);
  log.debug('cleared stale permission drag state because the row is absent', { permission });
}

function loadPermissionView(
  window: BrowserWindow,
  view: 'computer-permission-guide' | 'computer-permission-backdrop',
): void {
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    const url = new URL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
    url.searchParams.set('view', view);
    void window.loadURL(url.toString());
    return;
  }
  void window.loadFile(
    path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    { query: { view } },
  );
}

function closeWindow(window: BrowserWindow | null): void {
  if (window && !window.isDestroyed()) window.close();
}

function guideBoundsForWorkArea(workArea: Rectangle): Rectangle {
  const width = Math.min(PERMISSION_GUIDE_WINDOW_WIDTH, workArea.width);
  const height = Math.min(PERMISSION_GUIDE_WINDOW_HEIGHT, workArea.height);
  return {
    x: workArea.x + workArea.width - width - Math.min(GUIDE_WINDOW_MARGIN, workArea.width - width),
    y: workArea.y + workArea.height - height - Math.min(GUIDE_WINDOW_MARGIN, workArea.height - height),
    width,
    height,
  };
}

function currentDisplay(): Electron.Display {
  if (guideOwner && !guideOwner.isDestroyed()) {
    return screen.getDisplayMatching(guideOwner.getBounds());
  }
  return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
}

function positionGuideAtSystemSettings(systemWindowBounds: ComputerUseSystemWindowBounds): void {
  if (!guideWindow || guideWindow.isDestroyed()) return;
  const display = screen.getDisplayMatching(systemWindowBounds);
  const guideBounds = computeComputerPermissionGuideBounds(
    systemWindowBounds,
    display.workArea,
  );
  guideWindow.setBounds(guideBounds, false);
  guideWindow.setAlwaysOnTop(true, 'floating', 1);
  if (backdropWindow && !backdropWindow.isDestroyed()) {
    backdropWindow.setBounds(display.workArea, false);
  }
}

function hasPermissionGuide(): boolean {
  return Boolean(
    nativeHost
    || (guideWindow && !guideWindow.isDestroyed()),
  );
}

function isGuideLifecycleActive(generation: number): boolean {
  return generation === guideLifecycleGeneration && hasPermissionGuide();
}

function isOwnedNativeHost(
  generation: number,
  host: MacComputerPermissionGuideNativeHost,
): boolean {
  return isGuideLifecycleActive(generation) && nativeHost === host;
}

function cancelPendingObserverTrailingProbe(): void {
  if (pendingObserverTrailingProbe) clearTimeout(pendingObserverTrailingProbe);
  pendingObserverTrailingProbe = null;
}

function resetPermissionProbeBypassThrottle(): void {
  cancelPendingObserverTrailingProbe();
  lastPermissionProbeBypassAt = null;
}

function resetGuideLifecycleUpdates(): void {
  guideLifecycleGeneration += 1;
  permissionGuideUpdateQueue = Promise.resolve();
  resetPermissionProbeBypassThrottle();
}

function beginGuideLifecycle(): void {
  resetGuideLifecycleUpdates();
  guideStatus = null;
  lastSwitchObservation = '';
  lastSwitchLocation = null;
}

function serializePermissionGuideUpdate(
  label: string,
  update: (generation: number) => Promise<void> | void,
  generation = guideLifecycleGeneration,
): Promise<void> {
  const queuedUpdate = permissionGuideUpdateQueue.then(async () => {
    if (!isGuideLifecycleActive(generation)) return;
    try {
      await update(generation);
    } catch (error) {
      log.debug(`${label} failed`, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
  permissionGuideUpdateQueue = queuedUpdate;
  return queuedUpdate;
}

function scheduleObserverTrailingPermissionProbe(generation: number): void {
  if (pendingObserverTrailingProbe) return;
  const lastBypassAt = lastPermissionProbeBypassAt;
  if (lastBypassAt === null) return;

  const delay = Math.max(
    0,
    lastBypassAt + PERMISSION_PROBE_BYPASS_MIN_INTERVAL_MS - Date.now(),
  );
  const pendingProbe = setTimeout(() => {
    if (pendingObserverTrailingProbe !== pendingProbe) return;
    void serializePermissionGuideUpdate(
      'Computer Use switch observer trailing permission probe',
      async (currentGeneration) => {
        if (pendingObserverTrailingProbe !== pendingProbe) return;
        pendingObserverTrailingProbe = null;
        await refreshElectronPermissionGuideStateSerialized({
          bypassPermissionProbeCache: true,
        }, currentGeneration);
      },
      generation,
    );
  }, delay);
  pendingObserverTrailingProbe = pendingProbe;
}

function broadcastPermissionGuideStatus(status: ComputerStatus): void {
  guideStatus = status;
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(MAKER_PUSH.COMPUTER_PERMISSION_GUIDE_STATUS_CHANGED, status);
    }
  }
}

function broadcastPermissionGuideCancelled(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(MAKER_PUSH.COMPUTER_PERMISSION_GUIDE_CANCELLED);
    }
  }
}

function clearNativeAttachTimeout(): void {
  if (!nativeAttachTimeout) return;
  clearTimeout(nativeAttachTimeout);
  nativeAttachTimeout = null;
}

function armNativeAttachTimeout(
  generation: number,
  ownerHost: MacComputerPermissionGuideNativeHost,
): void {
  clearNativeAttachTimeout();
  if (
    !isOwnedNativeHost(generation, ownerHost)
    || nativeGuideAttached
    || lastSwitchLocation?.systemWindowBounds
  ) {
    return;
  }
  const timeout = setTimeout(() => {
    if (nativeAttachTimeout === timeout) nativeAttachTimeout = null;
    if (
      !isOwnedNativeHost(generation, ownerHost)
      || nativeGuideAttached
      || lastSwitchLocation?.systemWindowBounds
    ) {
      return;
    }
    log.warn('native Computer Use permission coach did not attach to System Settings in time');
    closeComputerPermissionGuideWindow();
    broadcastPermissionGuideCancelled();
  }, NATIVE_ATTACH_TIMEOUT_MS);
  nativeAttachTimeout = timeout;
}

function rememberSwitchLocation(location: ComputerUseSwitchLocationResult): void {
  if (location.status === 'unavailable' && lastSwitchLocation) {
    if (location.systemWindowBounds) {
      lastSwitchLocation = {
        ...lastSwitchLocation,
        systemWindowBounds: location.systemWindowBounds,
      };
      clearNativeAttachTimeout();
    }
    return;
  }
  lastSwitchLocation = location;
  if (location.systemWindowBounds) clearNativeAttachTimeout();
}

export function getComputerPermissionPaneUrl(status: ComputerStatus | null): string | null {
  switch (missingPermission(status)) {
    case 'accessibility':
      return MAC_ACCESSIBILITY_SETTINGS_URL;
    case 'screenRecording':
      return MAC_SCREEN_RECORDING_SETTINGS_URL;
    default:
      return null;
  }
}

export function seedOpenedPermissionPane(url: string): void {
  if (
    url === MAC_ACCESSIBILITY_SETTINGS_URL
    || url === MAC_SCREEN_RECORDING_SETTINGS_URL
  ) {
    lastOpenedPermissionPaneUrl = url;
  }
}

export async function openComputerPermissionPaneForStatus(
  status: ComputerStatus | null,
): Promise<void> {
  if (process.platform !== 'darwin') return;
  const url = getComputerPermissionPaneUrl(status);
  if (!url || lastOpenedPermissionPaneUrl === url) return;
  lastOpenedPermissionPaneUrl = url;
  try {
    await shell.openExternal(url);
    log.debug('opened Computer Use permission pane', { url });
  } catch (error) {
    log.warn('failed to open Computer Use permission pane', {
      url,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function missingPermission(status: ComputerStatus | null): PermissionKind | null {
  if (status?.permissionState?.accessibility !== 'granted') return 'accessibility';
  if (
    status.permissionState.screenRecording !== 'granted'
    || status.permissionState.screenRecordingCapturable !== 'granted'
  ) {
    return 'screenRecording';
  }
  return null;
}

function observationKey(location: ComputerUseSwitchLocationResult): string {
  if (location.status !== 'found') return location.status;
  return [
    location.status,
    location.target.permission ?? 'unknown',
    location.target.enabled === null ? 'unknown' : String(location.target.enabled),
  ].join(':');
}

async function refreshElectronPermissionGuideState(
  options: PermissionGuideRefreshOptions = {},
): Promise<void> {
  if (options.bypassPermissionProbeCache && !options.knownStatus) {
    cancelPendingObserverTrailingProbe();
  }
  return serializePermissionGuideUpdate(
    'Electron permission guide status refresh',
    (generation) => {
      if (options.bypassPermissionProbeCache && !options.knownStatus) {
        cancelPendingObserverTrailingProbe();
      }
      return refreshElectronPermissionGuideStateSerialized(options, generation);
    },
  );
}

async function refreshElectronPermissionGuideStateSerialized(
  options: PermissionGuideRefreshOptions,
  generation: number,
): Promise<void> {
  if (options.knownStatus) guideStatus = options.knownStatus;
  const statusSnapshot = options.knownStatus ?? guideStatus;
  let observedLocation = options.observedLocation ?? null;
  if (isComputerDriverPermissionProbePaused()) {
    const dragState = readPermissionDragState();
    const activePermission = missingPermission(statusSnapshot) ?? 'accessibility';
    // Starting CuaDriver's MCP locator is not passive on macOS: the driver
    // may appear in the Accessibility list as a side effect of the probe.
    // Do not inspect the page until this flow has a confirmed drag result.
    if (!dragState[activePermission]) {
      nativeHost?.update(nativeStateFrom(
        statusSnapshot,
        {
          ...dragState,
          [activePermission]: false,
        },
        lastSwitchLocation,
      ));
      if (options.forceBroadcast && statusSnapshot) {
        broadcastPermissionGuideStatus(statusSnapshot);
      }
      return;
    }

    if (!observedLocation) {
      observedLocation = await locateComputerUseSwitchTarget();
      if (!isGuideLifecycleActive(generation)) return;
      rememberSwitchLocation(observedLocation);
      if (observedLocation.systemWindowBounds) {
        positionGuideAtSystemSettings(observedLocation.systemWindowBounds);
      }
    }
    if (observedLocation.status === 'not-found') {
      const permission = missingPermission(statusSnapshot) ?? 'accessibility';
      // A persisted drag flag only records a past interaction. The live
      // System Settings row is the source of truth; if the locator cannot
      // find it, do not render the switch step from stale history.
      clearPermissionDragState(permission);
      nativeHost?.update(nativeStateFrom(
        statusSnapshot,
        readPermissionDragState(),
        lastSwitchLocation,
      ));
      if (options.forceBroadcast && statusSnapshot) {
        broadcastPermissionGuideStatus(statusSnapshot);
      }
      return;
    }
    if (observedLocation.status === 'unavailable') {
      nativeHost?.update(nativeStateFrom(
        statusSnapshot,
        readPermissionDragState(),
        lastSwitchLocation,
      ));
      if (options.forceBroadcast && statusSnapshot) {
        broadcastPermissionGuideStatus(statusSnapshot);
      }
      return;
    }

    const state = readPermissionDragState();
    const permission = observedLocation.target.permission
      ?? missingPermission(statusSnapshot)
      ?? 'accessibility';
    state[permission] = true;
    writePermissionDragState(state);
    resumeComputerDriverPermissionProbe();
    log.info('CuaDriver row appeared; resumed the live permission runtime', { permission });
  }

  let status = options.knownStatus;
  if (!status) {
    if (options.bypassPermissionProbeCache) {
      lastPermissionProbeBypassAt = Date.now();
    }
    status = await getComputerDriverStatus({
      forcePermissionProbe: true,
      ...(options.bypassPermissionProbeCache
        ? { bypassPermissionProbeCache: true }
        : {}),
      ...(options.freshPermissionProbe
        ? { freshPermissionProbe: true }
        : {}),
    });
  }
  if (!isGuideLifecycleActive(generation)) return;
  const state = readPermissionDragState();
  nativeHost?.update(nativeStateFrom(status, state, lastSwitchLocation));
  void openComputerPermissionPaneForStatus(status);
  broadcastPermissionGuideStatus(status);
}

async function observePermissionSwitchSerialized(generation: number): Promise<void> {
  const statusSnapshot = guideStatus;
  const dragState = readPermissionDragState();
  const activePermission = missingPermission(statusSnapshot) ?? 'accessibility';
  // See refreshElectronPermissionGuideState: querying through CuaDriver
  // before the drag is itself capable of creating the row. This ownership
  // gate follows the active pane even after the global probe resumes.
  if (!dragState[activePermission]) {
    lastSwitchObservation = 'awaiting-drag';
    return;
  }
  const location = await locateComputerUseSwitchTarget();
  if (!isGuideLifecycleActive(generation)) return;
  rememberSwitchLocation(location);
  if (location.systemWindowBounds) {
    positionGuideAtSystemSettings(location.systemWindowBounds);
  }
  const nextObservation = observationKey(location);
  const changed = lastSwitchObservation !== nextObservation;
  lastSwitchObservation = nextObservation;
  if (location.status === 'found') {
    const state = readPermissionDragState();
    const permission = location.target.permission
      ?? missingPermission(statusSnapshot)
      ?? 'accessibility';
    if (!state[permission]) {
      state[permission] = true;
      writePermissionDragState(state);
    }
  }
  if (changed) {
    const bypassIntervalElapsed = lastPermissionProbeBypassAt === null
      || Date.now() - lastPermissionProbeBypassAt
        >= PERMISSION_PROBE_BYPASS_MIN_INTERVAL_MS;
    if (bypassIntervalElapsed) {
      await refreshElectronPermissionGuideStateSerialized({
        // Restart daemon so it picks up newly granted permissions —
        // macOS may kill it on Screen Recording changes, but the
        // autostart throttle can block revival without fresh.
        freshPermissionProbe: true,
        bypassPermissionProbeCache: true,
        observedLocation: location,
      }, generation);
    } else {
      scheduleObserverTrailingPermissionProbe(generation);
      await refreshElectronPermissionGuideStateSerialized({
        observedLocation: location,
      }, generation);
    }
  }
}

async function observePermissionSwitch(): Promise<void> {
  const generation = guideLifecycleGeneration;
  if (!hasPermissionGuide() || switchObserverPendingGeneration === generation) return;
  switchObserverPendingGeneration = generation;
  try {
    await serializePermissionGuideUpdate(
      'Computer Use switch observer',
      observePermissionSwitchSerialized,
    );
  } finally {
    if (switchObserverPendingGeneration === generation) {
      switchObserverPendingGeneration = null;
    }
  }
}

function startSwitchObserver(): void {
  if (switchObserverTimer) return;
  switchObserverTimer = setInterval(() => {
    void observePermissionSwitch();
  }, SWITCH_OBSERVER_INTERVAL_MS);
  void observePermissionSwitch();
}

function stopSwitchObserver(): void {
  if (switchObserverTimer) clearInterval(switchObserverTimer);
  switchObserverTimer = null;
  switchObserverPendingGeneration = null;
  lastSwitchObservation = '';
}

function restoreGuideAfterDrag(): void {
  if (dragRestoreTimer) clearTimeout(dragRestoreTimer);
  dragRestoreTimer = null;
  dragInProgress = false;
  draggedPermission = null;
  if (guideWindow && !guideWindow.isDestroyed()) {
    guideWindow.setIgnoreMouseEvents(false);
    guideWindow.setAlwaysOnTop(true, 'floating', 1);
    guideWindow.showInactive();
  }
}

function armDragRestore(): void {
  if (dragRestoreTimer) clearTimeout(dragRestoreTimer);
  dragRestoreTimer = setTimeout(() => {
    log.debug('restoring Electron permission guide after drag fallback');
    restoreGuideAfterDrag();
    void refreshElectronPermissionGuideState();
  }, DRAG_RESTORE_TIMEOUT_MS);
}

/** Refresh the visible Electron coach after an explicit status check. */
export function refreshComputerPermissionGuideWindow(status?: ComputerStatus): void {
  if (status) {
    if (!hasPermissionGuide()) {
      broadcastPermissionGuideStatus(status);
      return;
    }
    void serializePermissionGuideUpdate('explicit permission guide status refresh', () => {
      nativeHost?.update(nativeStateFrom(status, readPermissionDragState(), lastSwitchLocation));
      broadcastPermissionGuideStatus(status);
    });
    return;
  }
  void refreshElectronPermissionGuideState();
}

function closeElectronPermissionGuideWindow(): void {
  clearNativeAttachTimeout();
  const currentGuide = guideWindow;
  const currentBackdrop = backdropWindow;
  guideWindow = null;
  backdropWindow = null;
  guideOwner = null;
  // Attaching the native AppKit coach closes only the hidden Electron
  // fallback. Keep the preflight snapshot alive for its observer; clearing it
  // here would make the native flow fall back to Accessibility after attach.
  if (!nativeHost) guideStatus = null;
  // The native AppKit coach still relies on this read-only AX observer to
  // notice each System Settings toggle. Stop it only when the whole guide is
  // being closed, not when native takes over from the Electron fallback.
  if (!nativeHost) {
    stopSwitchObserver();
    resetPermissionProbeBypassThrottle();
  }
  restoreGuideAfterDrag();
  closeWindow(currentGuide);
  closeWindow(currentBackdrop);
  scheduleMainAppPresenceRestore('computer-permission-guide-closed');
}

/** Close both the native AppKit coach and the Electron fallback. */
export function closeComputerPermissionGuideWindow(): void {
  resetGuideLifecycleUpdates();
  clearNativeAttachTimeout();
  nativeGuideAttached = false;
  lastOpenedPermissionPaneUrl = null;
  resumeComputerDriverPermissionProbe();
  nativeHost?.dismiss();
  nativeHost = null;
  lastSwitchLocation = null;
  void closeComputerUseSwitchLocator();
  closeElectronPermissionGuideWindow();
}

/** Return true only for IPC emitted by the independent guide renderer. */
export function isComputerPermissionGuideWebContents(sender: WebContents): boolean {
  return Boolean(
    guideWindow
    && !guideWindow.isDestroyed()
    && guideWindow.webContents.id === sender.id,
  );
}

function isValidComputerPermissionDragIconDataUrl(value: unknown): value is string {
  if (typeof value !== 'string' || !value.startsWith(DRAG_ICON_DATA_URL_PREFIX)) {
    return false;
  }
  const encoded = value.slice(DRAG_ICON_DATA_URL_PREFIX.length);
  return (
    encoded.length > 0
    && encoded.length <= MAX_DRAG_ICON_BASE64_LENGTH
    && encoded.length % 4 === 0
    && encoded.startsWith(PNG_SIGNATURE_BASE64_PREFIX)
    && /^[A-Za-z0-9+/]+={0,2}$/.test(encoded)
  );
}

/** Start a native file drag for the real Computer Use.app bundle. */
export function startComputerPermissionAppDrag(
  sender: WebContents,
  iconDataUrl: unknown,
): void {
  if (!isComputerPermissionGuideWebContents(sender)) return;
  const appBundlePath = getComputerDriverAppBundlePath();
  const hasValidIcon = isValidComputerPermissionDragIconDataUrl(iconDataUrl);
  if (!appBundlePath || !hasValidIcon) {
    log.warn('Computer Use app drag is unavailable', {
      hasAppBundle: Boolean(appBundlePath),
      hasValidIcon,
    });
    return;
  }
  let icon: Electron.NativeImage;
  try {
    icon = nativeImage.createFromDataURL(iconDataUrl);
  } catch (error) {
    log.warn('Computer Use app drag icon could not be decoded', {
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  if (icon.isEmpty()) {
    log.warn('Computer Use app drag icon is empty');
    return;
  }

  dragInProgress = true;
  draggedPermission = missingPermission(guideStatus) ?? 'accessibility';
  guideWindow?.setIgnoreMouseEvents(true, { forward: true });
  armDragRestore();
  try {
    sender.startDrag({ file: appBundlePath, icon });
  } catch (error) {
    log.warn('Computer Use Electron app drag failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    restoreGuideAfterDrag();
  }
}

/** Finish the current drag, persist its step, and check for the new row once. */
export function finishComputerPermissionAppDrag(sender: WebContents): void {
  if (!isComputerPermissionGuideWebContents(sender) || !dragInProgress) return;
  const permission = draggedPermission;
  restoreGuideAfterDrag();
  cancelPendingObserverTrailingProbe();
  void serializePermissionGuideUpdate(
    'Electron permission guide drag completion refresh',
    async (generation) => {
      cancelPendingObserverTrailingProbe();
      if (permission) {
        const state = readPermissionDragState();
        state[permission] = true;
        writePermissionDragState(state);
      }
      await refreshElectronPermissionGuideStateSerialized({
        freshPermissionProbe: true,
        bypassPermissionProbeCache: true,
      }, generation);
    },
  );
}

/** Show (or bring back) the independent Electron permission coach. */
export async function showComputerPermissionGuideWindow(
  owner: BrowserWindow | null,
  initialStatus?: ComputerStatus,
): Promise<void> {
  if (process.platform !== 'darwin') return;
  const existingGuide = hasPermissionGuide();
  if (!existingGuide) beginGuideLifecycle();
  const generation = guideLifecycleGeneration;
  guideOwner = owner && !owner.isDestroyed() ? owner : null;
  if (!existingGuide && initialStatus) guideStatus = initialStatus;
  if (nativeHost || (guideWindow && !guideWindow.isDestroyed())) {
    await refreshElectronPermissionGuideState({
      bypassPermissionProbeCache: true,
      ...(initialStatus ? { knownStatus: initialStatus } : {}),
    });
    if (isGuideLifecycleActive(generation)) startSwitchObserver();
    return;
  }
  const display = currentDisplay();
  const guideBounds = guideBoundsForWorkArea(display.workArea);
  let fallbackRequested = false;
  let backdropLoaded = false;
  let guideLoaded = false;
  const showElectronFallback = (): void => {
    if (!fallbackRequested || !backdropLoaded || !guideLoaded) return;
    if (
      generation !== guideLifecycleGeneration
      || backdropWindow !== backdrop
      || guideWindow !== guide
    ) {
      return;
    }
    if (!backdrop.isDestroyed()) {
      backdrop.setAlwaysOnTop(true, 'floating');
      backdrop.setVisibleOnAllWorkspaces(true, {
        visibleOnFullScreen: true,
        skipTransformProcessType: true,
      });
      backdrop.showInactive();
    }
    if (!guide.isDestroyed()) {
      guide.setAlwaysOnTop(true, 'floating', 1);
      guide.setVisibleOnAllWorkspaces(true, {
        visibleOnFullScreen: true,
        skipTransformProcessType: true,
      });
      guide.showInactive();
      startSwitchObserver();
      scheduleMainAppPresenceRestore('computer-permission-guide-shown');
    }
  };

  const backdrop = new BrowserWindow({
    ...display.workArea,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: false,
    show: false,
    skipTaskbar: false,
    hiddenInMissionControl: true,
    alwaysOnTop: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      backgroundThrottling: false,
      spellcheck: false,
    },
  });
  backdropWindow = backdrop;
  backdrop.setIgnoreMouseEvents(true, { forward: true });
  backdrop.webContents.once('did-finish-load', () => {
    if (
      generation !== guideLifecycleGeneration
      || backdropWindow !== backdrop
      || backdrop.isDestroyed()
    ) {
      return;
    }
    backdropLoaded = true;
    showElectronFallback();
  });
  backdrop.once('closed', () => {
    if (
      generation === guideLifecycleGeneration
      && backdropWindow === backdrop
    ) {
      backdropWindow = null;
    }
  });
  loadPermissionView(backdrop, 'computer-permission-backdrop');

  const guide = new BrowserWindow({
    ...guideBounds,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: true,
    acceptFirstMouse: true,
    show: false,
    skipTaskbar: false,
    hiddenInMissionControl: true,
    alwaysOnTop: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      backgroundThrottling: false,
      spellcheck: false,
    },
  });
  guideWindow = guide;
  guide.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  guide.webContents.once('did-finish-load', () => {
    if (
      !isGuideLifecycleActive(generation)
      || guideWindow !== guide
      || guide.isDestroyed()
    ) {
      return;
    }
    guideLoaded = true;
    showElectronFallback();
  });
  guide.once('closed', () => {
    if (
      generation !== guideLifecycleGeneration
      || guideWindow !== guide
    ) {
      return;
    }
    guideWindow = null;
    if (!nativeHost) {
      stopSwitchObserver();
      resetPermissionProbeBypassThrottle();
    }
    restoreGuideAfterDrag();
    if (backdropWindow === backdrop) {
      backdropWindow = null;
      closeWindow(backdrop);
    }
    scheduleMainAppPresenceRestore('computer-permission-guide-closed');
  });
  guide.webContents.on('render-process-gone', (_event, details) => {
    log.warn('computer permission guide renderer exited', { reason: details.reason });
  });
  loadPermissionView(guide, 'computer-permission-guide');

  // Resolve a persisted drag hint against the live System Settings row before
  // the native panel gets its first frame. Otherwise a removed CuaDriver can
  // briefly render the switch coach and then fall back to the drag coach.
  await refreshElectronPermissionGuideState({
    bypassPermissionProbeCache: true,
    ...(initialStatus ? { knownStatus: initialStatus } : {}),
  });
  if (!isGuideLifecycleActive(generation)) return;

  // Keep the Electron coach loaded but hidden while the native AppKit guide
  // starts. It is a failure fallback only; showing it eagerly creates a
  // visible old-dialog -> native-dialog swap whenever helper startup is slow.
  const appBundlePath = getComputerDriverAppBundlePath();
  if (appBundlePath) {
    nativeGuideAttached = false;
    const ownsNativeHost = (): boolean => (
      isOwnedNativeHost(generation, pendingNativeHost)
    );
    const pendingNativeHost = new MacComputerPermissionGuideNativeHost({
      onAttached: () => {
        if (!ownsNativeHost()) return;
        nativeGuideAttached = true;
        clearNativeAttachTimeout();
        closeElectronPermissionGuideWindow();
        log.info('native Computer Use permission coach attached to System Settings');
      },
      onCloseRequested: () => {
        if (!ownsNativeHost()) return;
        cancelComputerDriverPermissionGrant();
        closeComputerPermissionGuideWindow();
        broadcastPermissionGuideCancelled();
      },
      onCompleted: () => {
        if (!ownsNativeHost()) return;
        closeComputerPermissionGuideWindow();
      },
      onExited: () => {
        if (!ownsNativeHost()) return;
        if (!nativeGuideAttached) {
          clearNativeAttachTimeout();
          nativeHost = null;
          fallbackRequested = true;
          showElectronFallback();
          log.warn(
            'native Computer Use permission coach exited before attaching; '
            + 'showing Electron fallback',
          );
          return;
        }
        log.warn('native Computer Use permission coach exited unexpectedly');
        closeComputerPermissionGuideWindow();
        broadcastPermissionGuideCancelled();
      },
      onAuthSheetDismissed: () => {
        if (!ownsNativeHost()) return;
        log.info('auth sheet dismissed; rechecking permissions');
        cancelPendingObserverTrailingProbe();
        void serializePermissionGuideUpdate(
          'auth sheet dismissed permission recheck',
          async (gen) => {
            cancelPendingObserverTrailingProbe();
            await refreshElectronPermissionGuideStateSerialized({
              freshPermissionProbe: true,
              bypassPermissionProbeCache: true,
              forceBroadcast: true,
            }, gen);
          },
          generation,
        );
      },
      onDragBegan: (permission) => {
        if (!ownsNativeHost()) return;
        log.debug('native Computer Use permission drag began', { permission });
      },
      onDragEnded: (permission, operation) => {
        if (!ownsNativeHost()) return;
        log.debug('native Computer Use permission drag ended', { permission, operation });
        cancelPendingObserverTrailingProbe();
        void serializePermissionGuideUpdate(
          'native permission guide drag completion refresh',
          async (generation) => {
            cancelPendingObserverTrailingProbe();
            if ((operation & 1) !== 0) {
              const state = readPermissionDragState();
              state[permission] = true;
              writePermissionDragState(state);
            }
            // Restart the daemon to pick up newly granted permissions.
            // macOS may kill it on Screen Recording changes, but the
            // autostart throttle can block revival; fresh bypasses it.
            await refreshElectronPermissionGuideStateSerialized({
              freshPermissionProbe: true,
              bypassPermissionProbeCache: true,
              forceBroadcast: true,
            }, generation);
          },
          generation,
        );
      },
    });
    nativeHost = pendingNativeHost;
    void pendingNativeHost.show(
      appBundlePath,
      nativeStateFrom(guideStatus, readPermissionDragState(), lastSwitchLocation),
    ).then((started) => {
      // 关闭可能发生在 helper 启动完成之前;旧实例不能重新挂超时或唤起 fallback。
      if (!ownsNativeHost()) return;
      if (started) {
        armNativeAttachTimeout(generation, pendingNativeHost);
        // Keep observing the real checkbox for the full two-step native flow.
        // This is what advances Accessibility -> Screen Recording and closes
        // the coach after the second toggle.
        startSwitchObserver();
        return;
      }
      fallbackRequested = true;
      showElectronFallback();
      log.warn('native Computer Use permission coach unavailable; showing Electron fallback');
    });
  } else {
    fallbackRequested = true;
    showElectronFallback();
  }
}

function nativeStateFrom(
  status: ComputerStatus | null,
  dragState: PermissionDragState,
  location: ComputerUseSwitchLocationResult | null,
): ComputerPermissionGuideNativeState {
  const permissionState = status?.permissionState;
  const target = location?.status === 'found' ? location.target : null;
  return {
    accessibilityGranted: permissionState?.accessibility === 'granted',
    screenRecordingGranted: permissionState?.screenRecording === 'granted'
      && permissionState.screenRecordingCapturable !== 'missing',
    draggedAccessibility: dragState.accessibility,
    draggedScreenRecording: dragState.screenRecording,
    ...(target ? { switchTargetX: target.x, switchTargetY: target.y } : {}),
    ...(location?.status === 'found' && location.systemWindowBounds
      ? {
          switchWindowWidth: location.systemWindowBounds.width,
          switchWindowHeight: location.systemWindowBounds.height,
        }
      : {}),
  };
}
