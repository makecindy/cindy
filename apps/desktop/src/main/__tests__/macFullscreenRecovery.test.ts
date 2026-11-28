import { EventEmitter } from 'node:events';
import type { Rectangle } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CGS_SPACE_TYPE_FULLSCREEN,
  CGS_SPACE_TYPE_USER,
  classifyMacFullscreenDesync,
  fitBoundsInsideWorkArea,
  installMacFullscreenDesyncRecovery,
  type MacFullscreenRecoveryApp,
  type MacFullscreenRecoveryPowerMonitor,
  type MacFullscreenRecoveryScreen,
  type MacFullscreenRecoveryWindow,
} from '../macFullscreenRecovery';
import type { MacWindowFullscreenInspection } from '../macosDesktopBlur';

const NOTCH_WORK_AREA: Rectangle = { x: 0, y: 45, width: 1736, height: 1010 };
const NOTCH_FULLSCREEN_BOUNDS: Rectangle = { x: 0, y: 45, width: 1736, height: 1088 };

function createHealthyInspection(
  overrides: Partial<MacWindowFullscreenInspection> = {},
): MacWindowFullscreenInspection {
  return {
    styleMaskFullScreen: true,
    onActiveSpace: true,
    visible: true,
    spaceTypes: [CGS_SPACE_TYPE_FULLSCREEN],
    cgBounds: { ...NOTCH_FULLSCREEN_BOUNDS },
    cgOnScreen: true,
    ...overrides,
  };
}

function createFakeWindow(options: {
  bounds?: Rectangle;
  fullScreen?: boolean;
  simpleFullScreen?: boolean;
  visible?: boolean;
  minimized?: boolean;
} = {}) {
  const emitter = new EventEmitter();
  let destroyed = false;
  let visible = options.visible ?? true;
  let minimized = options.minimized ?? false;
  let fullScreen = options.fullScreen ?? false;
  let simpleFullScreen = options.simpleFullScreen ?? false;
  let bounds: Rectangle = { ...(options.bounds ?? NOTCH_FULLSCREEN_BOUNDS) };

  const send = vi.fn();
  const setFullScreen = vi.fn((flag: boolean) => {
    fullScreen = flag;
  });
  const setBounds = vi.fn((next: Rectangle) => {
    bounds = { ...next };
  });
  const setWindowButtonVisibility = vi.fn();
  const setWindowButtonPosition = vi.fn();

  const win: MacFullscreenRecoveryWindow = {
    isDestroyed: () => destroyed,
    isVisible: () => visible,
    isMinimized: () => minimized,
    isFullScreen: () => fullScreen,
    isSimpleFullScreen: () => simpleFullScreen,
    setFullScreen,
    getBounds: () => ({ ...bounds }),
    setBounds,
    setWindowButtonVisibility,
    setWindowButtonPosition,
    webContents: {
      isDestroyed: () => destroyed,
      send,
    },
    on: (event, listener) => emitter.on(event, listener),
    once: (event, listener) => emitter.once(event, listener),
    removeListener: (event, listener) => {
      if (destroyed) throw new Error('Object has been destroyed');
      emitter.removeListener(event, listener);
    },
  };

  return {
    win,
    emitter,
    send,
    setFullScreen,
    setBounds,
    setWindowButtonVisibility,
    setWindowButtonPosition,
    setDestroyed: (value: boolean) => {
      destroyed = value;
    },
    setVisible: (value: boolean) => {
      visible = value;
    },
    setMinimized: (value: boolean) => {
      minimized = value;
    },
    setFullScreenState: (value: boolean) => {
      fullScreen = value;
    },
    setSimpleFullScreenState: (value: boolean) => {
      simpleFullScreen = value;
    },
    setBoundsState: (next: Rectangle) => {
      bounds = { ...next };
    },
  };
}

function createEnv(workArea: Rectangle = NOTCH_WORK_AREA) {
  const screenEmitter = new EventEmitter();
  const powerEmitter = new EventEmitter();
  const appEmitter = new EventEmitter();

  const screenApi: MacFullscreenRecoveryScreen = {
    getDisplayMatching: vi.fn(() => ({ workArea: { ...workArea } })),
    on: (event, listener) => screenEmitter.on(event, listener),
    removeListener: (event, listener) => screenEmitter.removeListener(event, listener),
  };
  const powerMonitorApi: MacFullscreenRecoveryPowerMonitor = {
    on: (event, listener) => powerEmitter.on(event, listener),
    removeListener: (event, listener) => powerEmitter.removeListener(event, listener),
  };
  const appApi: MacFullscreenRecoveryApp = {
    on: (event, listener) => appEmitter.on(event, listener),
    removeListener: (event, listener) => appEmitter.removeListener(event, listener),
  };

  return { screenEmitter, powerEmitter, appEmitter, screenApi, powerMonitorApi, appApi };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('classifyMacFullscreenDesync', () => {
  it('treats a settled fullscreen window in a type-4 fullscreen space as healthy', () => {
    expect(
      classifyMacFullscreenDesync(createHealthyInspection(), NOTCH_FULLSCREEN_BOUNDS),
    ).toBeNull();
  });

  it('detects when a fullscreen window only belongs to regular desktop space(s)', () => {
    const desynced = createHealthyInspection({
      spaceTypes: [CGS_SPACE_TYPE_USER],
      cgBounds: { x: 33, y: 0, width: 1736, height: 1088 },
    });
    expect(classifyMacFullscreenDesync(desynced, NOTCH_FULLSCREEN_BOUNDS)).toBe(
      'space-not-fullscreen',
    );
  });

  it('never classifies empty spaces, hidden windows, or non-fullscreen styleMask as desync', () => {
    expect(
      classifyMacFullscreenDesync(
        createHealthyInspection({ spaceTypes: [] }),
        NOTCH_FULLSCREEN_BOUNDS,
      ),
    ).toBeNull();
    expect(
      classifyMacFullscreenDesync(
        createHealthyInspection({ visible: false, spaceTypes: [CGS_SPACE_TYPE_USER] }),
        NOTCH_FULLSCREEN_BOUNDS,
      ),
    ).toBeNull();
    expect(
      classifyMacFullscreenDesync(
        createHealthyInspection({
          styleMaskFullScreen: false,
          spaceTypes: [CGS_SPACE_TYPE_USER],
        }),
        NOTCH_FULLSCREEN_BOUNDS,
      ),
    ).toBeNull();
    expect(
      classifyMacFullscreenDesync(
        createHealthyInspection({
          spaceTypes: [CGS_SPACE_TYPE_USER, CGS_SPACE_TYPE_FULLSCREEN],
        }),
        NOTCH_FULLSCREEN_BOUNDS,
      ),
    ).toBeNull();
  });

  it('falls back to WindowServer bounds divergence only when CGS space query is unavailable or fails', () => {
    const diverged = createHealthyInspection({
      spaceTypes: null,
      cgOnScreen: true,
      cgBounds: { x: 33, y: 0, width: 1736, height: 1088 },
    });
    expect(classifyMacFullscreenDesync(diverged, NOTCH_FULLSCREEN_BOUNDS)).toBe(
      'cg-bounds-mismatch',
    );

    // An explicit empty list ([]) means WindowServer reported zero spaces
    // (ordered-out/transitioning) and must not fall back to cgBounds.
    const emptySpacesWithDivergedBounds = createHealthyInspection({
      spaceTypes: [],
      cgOnScreen: true,
      cgBounds: { x: 33, y: 0, width: 1736, height: 1088 },
    });
    expect(
      classifyMacFullscreenDesync(emptySpacesWithDivergedBounds, NOTCH_FULLSCREEN_BOUNDS),
    ).toBeNull();

    const withinTolerance = createHealthyInspection({
      spaceTypes: null,
      cgOnScreen: true,
      cgBounds: { x: 8, y: 45, width: 1736, height: 1088 },
    });
    expect(classifyMacFullscreenDesync(withinTolerance, NOTCH_FULLSCREEN_BOUNDS)).toBeNull();

    const offScreen = createHealthyInspection({
      spaceTypes: null,
      cgOnScreen: false,
      cgBounds: { x: 33, y: 0, width: 1736, height: 1088 },
    });
    expect(classifyMacFullscreenDesync(offScreen, NOTCH_FULLSCREEN_BOUNDS)).toBeNull();
  });
});

describe('fitBoundsInsideWorkArea', () => {
  it('returns null when bounds already fit inside the work area', () => {
    expect(
      fitBoundsInsideWorkArea({ x: 100, y: 80, width: 1280, height: 800 }, NOTCH_WORK_AREA, {
        width: 800,
        height: 600,
      }),
    ).toBeNull();
  });

  it('clamps an oversized and shifted desktop window back into the visible work area', () => {
    expect(
      fitBoundsInsideWorkArea({ x: 96, y: 112, width: 1736, height: 1088 }, NOTCH_WORK_AREA, {
        width: 800,
        height: 600,
      }),
    ).toEqual({ x: 0, y: 45, width: 1736, height: 1010 });
  });

  it('handles secondary displays with non-zero origins', () => {
    const secondaryWorkArea: Rectangle = { x: 1736, y: 25, width: 1920, height: 1055 };
    expect(
      fitBoundsInsideWorkArea({ x: 3000, y: 10, width: 1200, height: 900 }, secondaryWorkArea, {
        width: 800,
        height: 600,
      }),
    ).toEqual({ x: 2456, y: 25, width: 1200, height: 900 });
  });
});

describe('installMacFullscreenDesyncRecovery', () => {
  it('is a no-op outside macOS', () => {
    const fake = createFakeWindow({ fullScreen: true });
    const env = createEnv();
    const inspect = vi.fn(() => createHealthyInspection({ spaceTypes: [CGS_SPACE_TYPE_USER] }));

    const dispose = installMacFullscreenDesyncRecovery(fake.win, {
      platform: 'win32',
      screen: env.screenApi,
      powerMonitor: env.powerMonitorApi,
      app: env.appApi,
      inspect,
    });

    expect(env.screenEmitter.listenerCount('display-removed')).toBe(0);
    expect(inspect).not.toHaveBeenCalled();
    dispose();
  });

  it('waits for fullscreen entry to settle and requires two-step confirmation before recovering', () => {
    vi.useFakeTimers();
    const fake = createFakeWindow({ fullScreen: false });
    const env = createEnv();
    const inspection = createHealthyInspection({ spaceTypes: [CGS_SPACE_TYPE_USER] });
    const inspect = vi.fn(() => inspection);
    const log = { info: vi.fn(), warn: vi.fn() };

    installMacFullscreenDesyncRecovery(fake.win, {
      platform: 'darwin',
      windowLabel: 'main',
      trafficLightPosition: { x: 12, y: 16 },
      minSize: { width: 800, height: 600 },
      screen: env.screenApi,
      powerMonitor: env.powerMonitorApi,
      app: env.appApi,
      inspect,
      log,
    });

    // Enter fullscreen; probes during the 2s settle window must be ignored.
    fake.setFullScreenState(true);
    fake.emitter.emit('enter-full-screen');
    fake.emitter.emit('focus');
    env.screenEmitter.emit('display-removed');
    expect(inspect).not.toHaveBeenCalled();

    // Settle elapses: probe 1 arms the 1s confirmation timer, does not recover yet.
    vi.advanceTimersByTime(2_000);
    expect(inspect).toHaveBeenCalledTimes(1);
    expect(fake.setFullScreen).not.toHaveBeenCalled();

    // Rapid intermediate events do not reset or duplicate confirmation.
    vi.advanceTimersByTime(500);
    fake.emitter.emit('focus');
    expect(fake.setFullScreen).not.toHaveBeenCalled();

    // Confirmation elapses: probe 2 confirms desync and exits fullscreen.
    vi.advanceTimersByTime(500);
    expect(fake.setFullScreen).toHaveBeenCalledWith(false);

    // Native leave-full-screen arrives while bounds are still oversized/off-screen.
    fake.setBoundsState({ x: 96, y: 112, width: 1736, height: 1088 });
    fake.emitter.emit('leave-full-screen');

    expect(fake.setWindowButtonVisibility).toHaveBeenCalledWith(true);
    expect(fake.setWindowButtonPosition).toHaveBeenCalledWith({ x: 12, y: 16 });
    expect(fake.setBounds).toHaveBeenCalledWith({ x: 0, y: 45, width: 1736, height: 1010 });
    expect(fake.send).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledOnce();
    expect(log.info).toHaveBeenCalledOnce();
  });

  it('cancels confirmation when a normal user leave-full-screen completes during the delay', () => {
    vi.useFakeTimers();
    const fake = createFakeWindow({ fullScreen: true });
    const env = createEnv();
    const inspect = vi.fn(() => createHealthyInspection({ spaceTypes: [CGS_SPACE_TYPE_USER] }));

    installMacFullscreenDesyncRecovery(fake.win, {
      platform: 'darwin',
      screen: env.screenApi,
      powerMonitor: env.powerMonitorApi,
      app: env.appApi,
      inspect,
      log: { info: vi.fn(), warn: vi.fn() },
    });

    vi.advanceTimersByTime(2_000);
    expect(fake.setFullScreen).not.toHaveBeenCalled();

    // Normal exit finishes after 400ms before the 1s confirmation fires.
    vi.advanceTimersByTime(400);
    fake.setFullScreenState(false);
    fake.emitter.emit('leave-full-screen');

    vi.advanceTimersByTime(2_000);
    expect(fake.setFullScreen).not.toHaveBeenCalled();
    expect(fake.setBounds).not.toHaveBeenCalled();
    expect(fake.setWindowButtonVisibility).not.toHaveBeenCalled();
  });

  it('respects plugin UI region suppression when restoring window buttons', () => {
    vi.useFakeTimers();
    const fake = createFakeWindow({ fullScreen: true });
    const env = createEnv();
    const inspect = vi.fn(() => createHealthyInspection({ spaceTypes: [CGS_SPACE_TYPE_USER] }));

    installMacFullscreenDesyncRecovery(fake.win, {
      platform: 'darwin',
      trafficLightPosition: { x: 12, y: 16 },
      shouldShowWindowButtons: () => false,
      screen: env.screenApi,
      powerMonitor: env.powerMonitorApi,
      app: env.appApi,
      inspect,
      log: { info: vi.fn(), warn: vi.fn() },
    });

    vi.advanceTimersByTime(3_000);
    expect(fake.setFullScreen).toHaveBeenCalledWith(false);
    fake.emitter.emit('leave-full-screen');

    expect(fake.setWindowButtonVisibility).not.toHaveBeenCalled();
    expect(fake.setWindowButtonPosition).not.toHaveBeenCalled();
  });

  it('syncs renderer and restores controls when setFullScreen(false) exits silently without leave-full-screen', () => {
    vi.useFakeTimers();
    const fake = createFakeWindow({ fullScreen: true });
    const env = createEnv();
    const inspect = vi.fn(() => createHealthyInspection({ spaceTypes: [CGS_SPACE_TYPE_USER] }));

    installMacFullscreenDesyncRecovery(fake.win, {
      platform: 'darwin',
      trafficLightPosition: { x: 12, y: 16 },
      minSize: { width: 800, height: 600 },
      screen: env.screenApi,
      powerMonitor: env.powerMonitorApi,
      app: env.appApi,
      inspect,
      log: { info: vi.fn(), warn: vi.fn() },
    });

    vi.advanceTimersByTime(3_000);
    expect(fake.setFullScreen).toHaveBeenCalledWith(false);
    expect(fake.win.isFullScreen()).toBe(false);

    // No leave-full-screen event arrives; timeout finishes recovery and syncs renderer.
    vi.advanceTimersByTime(1_500);
    expect(fake.setWindowButtonVisibility).toHaveBeenCalledWith(true);
    expect(fake.setWindowButtonPosition).toHaveBeenCalledWith({ x: 12, y: 16 });
    expect(fake.setBounds).toHaveBeenCalledWith({ x: 0, y: 45, width: 1736, height: 1010 });
    expect(fake.send).toHaveBeenCalledWith('fullscreen-change', false);
  });

  it('still finalizes traffic lights and bounds when leave-full-screen arrives after the 1.5s timeout', () => {
    vi.useFakeTimers();
    const fake = createFakeWindow({ fullScreen: true });
    // Simulate a slow native fullscreen exit where isFullScreen() stays true past 1.5s.
    fake.setFullScreen.mockImplementation(() => {});
    const env = createEnv();
    const inspect = vi.fn(() => createHealthyInspection({ spaceTypes: [CGS_SPACE_TYPE_USER] }));
    const log = { info: vi.fn(), warn: vi.fn() };

    installMacFullscreenDesyncRecovery(fake.win, {
      platform: 'darwin',
      trafficLightPosition: { x: 12, y: 16 },
      minSize: { width: 800, height: 600 },
      screen: env.screenApi,
      powerMonitor: env.powerMonitorApi,
      app: env.appApi,
      inspect,
      log,
    });

    // Confirmation triggers setFullScreen(false) at t = 3s.
    vi.advanceTimersByTime(3_000);
    expect(fake.setFullScreen).toHaveBeenCalledTimes(1);

    // Timeout elapses at t = 4.5s while AppKit is still exiting.
    vi.advanceTimersByTime(1_500);
    expect(fake.setWindowButtonVisibility).not.toHaveBeenCalled();

    // Delayed leave-full-screen finally arrives at t = 5.2s with off-screen bounds.
    vi.advanceTimersByTime(700);
    fake.setFullScreenState(false);
    fake.setBoundsState({ x: 96, y: 112, width: 1736, height: 1088 });
    fake.emitter.emit('leave-full-screen');

    expect(fake.setWindowButtonVisibility).toHaveBeenCalledWith(true);
    expect(fake.setWindowButtonPosition).toHaveBeenCalledWith({ x: 12, y: 16 });
    expect(fake.setBounds).toHaveBeenCalledWith({ x: 0, y: 45, width: 1736, height: 1010 });
    expect(fake.send).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledOnce();
  });

  it('bounds retries with cooldown when setFullScreen(false) fails to clear fullscreen', () => {
    vi.useFakeTimers();
    const fake = createFakeWindow({ fullScreen: true });
    fake.setFullScreen.mockImplementation(() => {
      // Simulate AppKit ignoring setFullScreen(false).
    });
    const env = createEnv();
    const inspect = vi.fn(() => createHealthyInspection({ spaceTypes: [CGS_SPACE_TYPE_USER] }));
    const log = { info: vi.fn(), warn: vi.fn() };

    installMacFullscreenDesyncRecovery(fake.win, {
      platform: 'darwin',
      screen: env.screenApi,
      powerMonitor: env.powerMonitorApi,
      app: env.appApi,
      inspect,
      log,
      maxRecoveryAttempts: 2,
      recoveryCooldownMs: 10_000,
    });

    // Attempt 1 at t = 3s.
    vi.advanceTimersByTime(3_000);
    expect(fake.setFullScreen).toHaveBeenCalledTimes(1);

    // Recovery times out at t = 4.5s, cooldown prevents immediate retry.
    vi.advanceTimersByTime(6_000);
    fake.emitter.emit('focus');
    vi.advanceTimersByTime(2_000);
    expect(fake.setFullScreen).toHaveBeenCalledTimes(1);

    // Cooldown expires after t = 13s; focus triggers attempt 2 + 1s confirmation.
    vi.advanceTimersByTime(3_000);
    fake.emitter.emit('focus');
    vi.advanceTimersByTime(1_000);
    expect(fake.setFullScreen).toHaveBeenCalledTimes(2);

    // Exhausted budget: further events/polls do not loop.
    vi.advanceTimersByTime(30_000);
    fake.emitter.emit('focus');
    vi.advanceTimersByTime(5_000);
    expect(fake.setFullScreen).toHaveBeenCalledTimes(2);
  });

  it('ignores simpleFullScreen windows completely', () => {
    vi.useFakeTimers();
    const fake = createFakeWindow({ fullScreen: true, simpleFullScreen: true });
    const env = createEnv();
    const inspect = vi.fn(() => createHealthyInspection({ spaceTypes: [CGS_SPACE_TYPE_USER] }));

    installMacFullscreenDesyncRecovery(fake.win, {
      platform: 'darwin',
      screen: env.screenApi,
      powerMonitor: env.powerMonitorApi,
      app: env.appApi,
      inspect,
    });

    vi.advanceTimersByTime(10_000);
    fake.emitter.emit('focus');
    vi.advanceTimersByTime(5_000);
    expect(inspect).not.toHaveBeenCalled();
    expect(fake.setFullScreen).not.toHaveBeenCalled();
  });

  it('detects desync on periodic poll while already focused without needing a focus/display event', () => {
    vi.useFakeTimers();
    const fake = createFakeWindow({ fullScreen: true });
    const env = createEnv();
    let inspection = createHealthyInspection();
    const inspect = vi.fn(() => inspection);

    installMacFullscreenDesyncRecovery(fake.win, {
      platform: 'darwin',
      screen: env.screenApi,
      powerMonitor: env.powerMonitorApi,
      app: env.appApi,
      inspect,
      log: { info: vi.fn(), warn: vi.fn() },
    });

    // Settle healthy.
    vi.advanceTimersByTime(2_000);
    expect(fake.setFullScreen).not.toHaveBeenCalled();

    // WindowServer drops the window onto Desktop Space while still focused.
    inspection = createHealthyInspection({ spaceTypes: [CGS_SPACE_TYPE_USER] });
    vi.advanceTimersByTime(5_000);
    expect(fake.setFullScreen).not.toHaveBeenCalled();

    // Confirmation finishes 1s later.
    vi.advanceTimersByTime(1_000);
    expect(fake.setFullScreen).toHaveBeenCalledWith(false);
  });

  it('removes all global listeners and timers on closed without throwing on a destroyed window', () => {
    vi.useFakeTimers();
    const fake = createFakeWindow({ fullScreen: true });
    const env = createEnv();
    const inspect = vi.fn(() => createHealthyInspection());

    installMacFullscreenDesyncRecovery(fake.win, {
      platform: 'darwin',
      screen: env.screenApi,
      powerMonitor: env.powerMonitorApi,
      app: env.appApi,
      inspect,
    });

    expect(env.screenEmitter.listenerCount('display-added')).toBe(1);
    expect(env.screenEmitter.listenerCount('display-removed')).toBe(1);
    expect(env.screenEmitter.listenerCount('display-metrics-changed')).toBe(1);
    expect(env.powerEmitter.listenerCount('resume')).toBe(1);
    expect(env.powerEmitter.listenerCount('unlock-screen')).toBe(1);
    expect(env.appEmitter.listenerCount('activate')).toBe(1);

    // Electron marks the native window destroyed before emitting 'closed'.
    fake.setDestroyed(true);
    expect(() => fake.emitter.emit('closed')).not.toThrow();

    expect(env.screenEmitter.listenerCount('display-added')).toBe(0);
    expect(env.screenEmitter.listenerCount('display-removed')).toBe(0);
    expect(env.screenEmitter.listenerCount('display-metrics-changed')).toBe(0);
    expect(env.powerEmitter.listenerCount('resume')).toBe(0);
    expect(env.powerEmitter.listenerCount('unlock-screen')).toBe(0);
    expect(env.appEmitter.listenerCount('activate')).toBe(0);
  });
});
