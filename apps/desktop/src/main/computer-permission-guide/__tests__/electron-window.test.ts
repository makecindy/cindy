import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import type { BrowserWindowConstructorOptions, WebContents } from 'electron';

const originalPlatform = process.platform;
const VALID_PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgo=';

const harness = vi.hoisted(() => {
  const windows: FakeWindow[] = [];
  const nativeHostState: {
    options: Record<string, (...args: unknown[]) => void> | null;
    allOptions: Array<Record<string, (...args: unknown[]) => void>>;
  } = { options: null, allOptions: [] };
  const nativeShow = vi.fn();
  const nativeUpdate = vi.fn();
  const nativeDismiss = vi.fn();
  const cancelComputerDriverPermissionGrant = vi.fn();
  const closeComputerUseSwitchLocator = vi.fn(async () => undefined);
  let nextGuideLoadError: Error | null = null;
  const computerStatus = (permissionState: Partial<{
    status: 'missing' | 'granted' | 'unknown';
    accessibility: 'missing' | 'granted' | 'unknown';
    screenRecording: 'missing' | 'granted' | 'unknown';
    screenRecordingCapturable: 'missing' | 'granted' | 'unknown';
  }> = {}) => ({
    installed: true,
    executablePath: '/tmp/cua-driver',
    version: 'test',
    daemonRunning: true,
    installCommand: 'test',
    docsUrl: 'https://cua.ai/docs/cua-driver',
    permissionState: {
      platform: 'macos' as const,
      required: true,
      status: 'missing' as const,
      accessibility: 'missing' as const,
      screenRecording: 'missing' as const,
      screenRecordingCapturable: 'missing' as const,
      canGrant: true,
      ...permissionState,
    },
  });
  const getComputerDriverStatus = vi.fn(async (
    options?: { bypassPermissionProbeCache?: boolean },
  ) => {
    void options;
    return computerStatus();
  });
  const resumeComputerDriverPermissionProbe = vi.fn();
  const broadcastSend = vi.fn();
  const openExternal = vi.fn(async () => undefined);
  let deferWindowClosedEvents = false;
  let nextId = 100;
  const broadcastRecipient = {
    isDestroyed: () => false,
    webContents: { send: broadcastSend },
  };

  class FakeWindow {
    readonly webContents = {
      id: nextId++,
      once: vi.fn((event: string, callback: () => void) => {
        this.listeners.set(event, callback);
      }),
      on: vi.fn((event: string, callback: (...args: unknown[]) => void) => {
        this.listeners.set(event, callback);
      }),
      setWindowOpenHandler: vi.fn(),
      send: vi.fn(),
      startDrag: vi.fn(),
    };
    readonly listeners = new Map<string, (...args: unknown[]) => void>();
    readonly loadURL = vi.fn(async (url?: string) => {
      if (nextGuideLoadError && url?.includes('view=computer-permission-guide')) {
        const error = nextGuideLoadError;
        nextGuideLoadError = null;
        throw error;
      }
      this.listeners.get('did-finish-load')?.();
    });
    readonly loadFile = vi.fn(async () => {
      this.listeners.get('did-finish-load')?.();
    });
    readonly setIgnoreMouseEvents = vi.fn();
    readonly setAlwaysOnTop = vi.fn();
    readonly setVisibleOnAllWorkspaces = vi.fn();
    readonly showInactive = vi.fn();
    readonly setBounds = vi.fn();
    readonly getBounds = vi.fn(() => ({ x: 0, y: 0, width: 900, height: 700 }));
    readonly close = vi.fn(() => {
      this.destroyed = true;
      if (!deferWindowClosedEvents) this.listeners.get('closed')?.();
    });
    destroyed = false;

    constructor(readonly options: BrowserWindowConstructorOptions) {
      windows.push(this);
    }

    once(event: string, callback: (...args: unknown[]) => void): void {
      this.listeners.set(event, callback);
    }

    isDestroyed(): boolean {
      return this.destroyed;
    }

    static getAllWindows(): Array<FakeWindow | typeof broadcastRecipient> {
      return [...windows, broadcastRecipient];
    }
  }

  class FakeNativeHost {
    constructor(options: Record<string, (...args: unknown[]) => void>) {
      nativeHostState.options = options;
      nativeHostState.allOptions.push(options);
    }

    show(...args: unknown[]): Promise<boolean> {
      return nativeShow(...args);
    }

    update(...args: unknown[]): void {
      nativeUpdate(...args);
    }

    dismiss(): void {
      nativeDismiss();
    }
  }

  return {
    FakeWindow,
    FakeNativeHost,
    windows,
    nativeHostState,
    nativeShow,
    nativeUpdate,
    nativeDismiss,
    cancelComputerDriverPermissionGrant,
    closeComputerUseSwitchLocator,
    computerStatus,
    getComputerDriverStatus,
    resumeComputerDriverPermissionProbe,
    broadcastSend,
    openExternal,
    setNextGuideLoadError: (error: Error | null) => {
      nextGuideLoadError = error;
    },
    setDeferWindowClosedEvents: (defer: boolean) => {
      deferWindowClosedEvents = defer;
    },
    app: { getPath: () => '/tmp/cindy-computer-permission-guide-test' },
    nativeImage: {
      createFromDataURL: vi.fn(() => ({ isEmpty: () => false })),
    },
    locateComputerUseSwitchTarget: vi.fn(async () => (
      { status: 'unavailable' } as
        | {
          status: 'unavailable' | 'not-found';
          systemWindowBounds?: { x: number; y: number; width: number; height: number };
        }
        | {
          status: 'found';
          target: {
            x: number;
            y: number;
            permission: 'accessibility' | 'screenRecording';
            enabled: boolean | null;
          };
          systemWindowBounds?: { x: number; y: number; width: number; height: number };
        }
    )),
    isComputerDriverPermissionProbePaused: vi.fn(() => false),
    screen: {
      getDisplayMatching: vi.fn(() => ({
        workArea: { x: 0, y: 0, width: 1440, height: 900 },
      })),
      getDisplayNearestPoint: vi.fn(() => ({
        workArea: { x: 0, y: 0, width: 1440, height: 900 },
      })),
      getCursorScreenPoint: vi.fn(() => ({ x: 10, y: 10 })),
    },
  };
});

vi.mock('electron', () => ({
  app: harness.app,
  BrowserWindow: harness.FakeWindow,
  nativeImage: harness.nativeImage,
  shell: { openExternal: harness.openExternal },
  screen: harness.screen,
}));

vi.mock('../../appPresence.js', () => ({
  scheduleMainAppPresenceRestore: vi.fn(),
}));

vi.mock('../../i18n.js', () => ({
  getResolvedMainLocale: vi.fn(() => 'ja'),
}));

vi.mock('../../mcp-integrations/computer.js', () => ({
  getComputerDriverAppBundlePath: vi.fn(() => '/Applications/CuaDriver.app'),
  getComputerDriverStatus: harness.getComputerDriverStatus,
  isComputerDriverPermissionProbePaused: harness.isComputerDriverPermissionProbePaused,
  resumeComputerDriverPermissionProbe: harness.resumeComputerDriverPermissionProbe,
  cancelComputerDriverPermissionGrant: harness.cancelComputerDriverPermissionGrant,
}));

vi.mock('../switch-target.js', () => ({
  locateComputerUseSwitchTarget: harness.locateComputerUseSwitchTarget,
  closeComputerUseSwitchLocator: harness.closeComputerUseSwitchLocator,
}));

vi.mock('../MacComputerPermissionGuideNativeHost.js', () => ({
  MacComputerPermissionGuideNativeHost: harness.FakeNativeHost,
}));

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function finishTestDrag(guide: typeof import('../window')): void {
  const sender = harness.windows[1].webContents as unknown as WebContents;
  guide.startComputerPermissionAppDrag(sender, VALID_PNG_DATA_URL);
  guide.finishComputerPermissionAppDrag(sender, true);
}

function writeDragState(state: {
  accessibility: boolean;
  screenRecording: boolean;
}): void {
  const directory = '/tmp/cindy-computer-permission-guide-test/computer-permission-guide';
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    `${directory}/cua-driver-drag-state-v2.json`,
    `${JSON.stringify(state)}\n`,
    'utf8',
  );
}

function permissionProbeCalls(bypass: boolean): unknown[][] {
  return harness.getComputerDriverStatus.mock.calls.filter(
    ([options]) => Boolean(options?.bypassPermissionProbeCache) === bypass,
  );
}

const fullPermissionProbeCalls = (): unknown[][] => permissionProbeCalls(true);
const normalPermissionProbeCalls = (): unknown[][] => permissionProbeCalls(false);

type SwitchLocation = Awaited<
  ReturnType<typeof harness.locateComputerUseSwitchTarget>
>;

function foundSwitchLocation(
  enabled: boolean | null,
  {
    x = 901,
    y = 442,
    permission = 'accessibility',
  }: {
    x?: number;
    y?: number;
    permission?: 'accessibility' | 'screenRecording';
  } = {},
): SwitchLocation {
  return {
    status: 'found',
    target: { x, y, permission, enabled },
  };
}

async function expectPermissionProbeCounts(
  full: number,
  normal?: number,
): Promise<void> {
  await vi.waitFor(() => {
    expect(fullPermissionProbeCalls()).toHaveLength(full);
    if (normal !== undefined) {
      expect(normalPermissionProbeCalls()).toHaveLength(normal);
    }
  });
}

async function startObserverThrottleTest(
  firstLocation: SwitchLocation,
  ...nextLocations: SwitchLocation[]
): Promise<typeof import('../window')> {
  vi.useFakeTimers();
  vi.setSystemTime(10_000);
  const locations = [firstLocation, ...nextLocations];
  for (const location of locations.slice(0, -1)) {
    harness.locateComputerUseSwitchTarget.mockResolvedValueOnce(location);
  }
  harness.locateComputerUseSwitchTarget.mockResolvedValue(
    nextLocations.at(-1) ?? firstLocation,
  );

  const guide = await import('../window');
  await guide.showComputerPermissionGuideWindow(null, harness.computerStatus());
  finishTestDrag(guide);
  await expectPermissionProbeCounts(1, 0);
  return guide;
}

describe('Electron Computer Use permission guide window', () => {
  beforeEach(() => {
    vi.resetModules();
    harness.windows.splice(0);
    harness.nativeHostState.options = null;
    harness.nativeHostState.allOptions.splice(0);
    harness.setDeferWindowClosedEvents(false);
    harness.nativeShow.mockReset();
    harness.nativeShow.mockResolvedValue(true);
    harness.nativeUpdate.mockReset();
    harness.nativeDismiss.mockReset();
    harness.cancelComputerDriverPermissionGrant.mockReset();
    harness.closeComputerUseSwitchLocator.mockReset();
    harness.closeComputerUseSwitchLocator.mockResolvedValue(undefined);
    harness.getComputerDriverStatus.mockReset();
    harness.getComputerDriverStatus.mockResolvedValue(harness.computerStatus());
    harness.resumeComputerDriverPermissionProbe.mockReset();
    harness.broadcastSend.mockReset();
    harness.openExternal.mockReset();
    harness.openExternal.mockResolvedValue(undefined);
    harness.setNextGuideLoadError(null);
    harness.locateComputerUseSwitchTarget.mockResolvedValue({ status: 'unavailable' });
    harness.locateComputerUseSwitchTarget.mockClear();
    harness.isComputerDriverPermissionProbePaused.mockReturnValue(false);
    fs.rmSync(
      '/tmp/cindy-computer-permission-guide-test/computer-permission-guide',
      { recursive: true, force: true },
    );
    vi.stubGlobal('MAIN_WINDOW_VITE_DEV_SERVER_URL', 'http://127.0.0.1:5173');
    vi.stubGlobal('MAIN_WINDOW_VITE_NAME', 'main_window');
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'darwin',
    });
  });

  afterEach(async () => {
    const guide = await import('../window');
    guide.closeComputerPermissionGuideWindow();
    vi.useRealTimers();
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: originalPlatform,
    });
  });

  it('creates the guide and mouse-transparent backdrop routes', async () => {
    const guide = await import('../window');
    await guide.showComputerPermissionGuideWindow(null);

    expect(harness.windows).toHaveLength(2);
    expect(harness.windows[0].loadURL).toHaveBeenCalledWith(
      expect.stringContaining('view=computer-permission-backdrop'),
    );
    expect(harness.windows[1].loadURL).toHaveBeenCalledWith(
      expect.stringContaining('view=computer-permission-guide'),
    );
    const requiredSecurityPreferences = {
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
    };
    expect(harness.windows[0].options.webPreferences).toMatchObject(
      requiredSecurityPreferences,
    );
    expect(harness.windows[1].options.webPreferences).toMatchObject(
      requiredSecurityPreferences,
    );
    for (const permissionWindow of harness.windows) {
      expect(permissionWindow.webContents.setWindowOpenHandler).toHaveBeenCalledOnce();
      const preventDefault = vi.fn();
      permissionWindow.listeners.get('will-navigate')?.({ preventDefault });
      expect(preventDefault).toHaveBeenCalledOnce();
    }
    expect(guide.isComputerPermissionGuideWebContents(
      harness.windows[1].webContents as unknown as WebContents,
    )).toBe(true);
    expect(guide.isComputerPermissionGuideWebContents(
      harness.windows[0].webContents as unknown as WebContents,
    )).toBe(false);
    expect(guide.getComputerPermissionGuideStatus(
      harness.windows[1].webContents as unknown as WebContents,
    )).toEqual(harness.computerStatus());
    expect(guide.getComputerPermissionGuideStatus(
      harness.windows[0].webContents as unknown as WebContents,
    )).toBeNull();
  });

  it('closes the persistent switch locator when the whole guide closes', async () => {
    const guide = await import('../window');
    await guide.showComputerPermissionGuideWindow(null);

    guide.closeComputerPermissionGuideWindow();

    expect(harness.closeComputerUseSwitchLocator).toHaveBeenCalledOnce();
  });

  it('selects and deduplicates the System Settings permission pane URL', async () => {
    const guide = await import('../window');
    const status = (permissionState: Record<string, string>) =>
      ({ permissionState } as unknown as Parameters<typeof guide.getComputerPermissionPaneUrl>[0]);

    expect(guide.getComputerPermissionPaneUrl(status({
      accessibility: 'missing',
      screenRecording: 'missing',
    }))).toBe(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
    );
    expect(guide.getComputerPermissionPaneUrl(status({
      accessibility: 'granted',
      screenRecording: 'missing',
    }))).toBe(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
    );
    expect(guide.getComputerPermissionPaneUrl(status({
      accessibility: 'granted',
      screenRecording: 'granted',
      screenRecordingCapturable: 'granted',
    }))).toBeNull();

    await guide.openComputerPermissionPaneForStatus(status({
      accessibility: 'missing',
      screenRecording: 'missing',
    }));
    await guide.openComputerPermissionPaneForStatus(status({
      accessibility: 'missing',
      screenRecording: 'missing',
    }));
    expect(harness.openExternal).toHaveBeenCalledOnce();
  });

  it('retries opening a permission pane after shell launch failure', async () => {
    harness.openExternal
      .mockRejectedValueOnce(new Error('launch failed'))
      .mockResolvedValueOnce(undefined);
    const guide = await import('../window');
    const missingAccessibility = {
      permissionState: {
        accessibility: 'missing',
        screenRecording: 'missing',
      },
    } as unknown as Parameters<typeof guide.openComputerPermissionPaneForStatus>[0];

    await guide.openComputerPermissionPaneForStatus(missingAccessibility);
    await guide.openComputerPermissionPaneForStatus(missingAccessibility);

    expect(harness.openExternal).toHaveBeenCalledTimes(2);
  });

  it('starts the native guide at the first missing permission without showing the old fallback', async () => {
    vi.useFakeTimers();
    const guide = await import('../window');
    const initialStatus = harness.computerStatus({ accessibility: 'granted' });

    await guide.showComputerPermissionGuideWindow(null, initialStatus);
    await vi.waitFor(() => {
      expect(harness.nativeShow).toHaveBeenCalledWith(
        '/Applications/CuaDriver.app',
        expect.objectContaining({
          accessibilityGranted: true,
          screenRecordingGranted: false,
        }),
        'ja',
      );
    });

    expect(harness.windows[0].showInactive).not.toHaveBeenCalled();
    expect(harness.windows[1].showInactive).not.toHaveBeenCalled();

    harness.isComputerDriverPermissionProbePaused.mockReturnValue(true);
    harness.nativeHostState.options?.onAttached?.();
    expect(harness.closeComputerUseSwitchLocator).not.toHaveBeenCalled();
    harness.nativeUpdate.mockClear();
    harness.nativeHostState.options?.onDragEnded?.('screenRecording', 0);
    await vi.waitFor(() => {
      expect(harness.nativeUpdate).toHaveBeenCalledWith(expect.objectContaining({
        accessibilityGranted: true,
        screenRecordingGranted: false,
      }));
    });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(harness.nativeDismiss).not.toHaveBeenCalled();
  });

  it('routes native cancellation and completion through whole-guide locator teardown', async () => {
    const guide = await import('../window');
    await guide.showComputerPermissionGuideWindow(null);
    await vi.waitFor(() => {
      expect(harness.nativeShow).toHaveBeenCalled();
    });

    harness.nativeHostState.options?.onCloseRequested?.();
    expect(harness.cancelComputerDriverPermissionGrant).toHaveBeenCalledOnce();
    expect(harness.closeComputerUseSwitchLocator).toHaveBeenCalledOnce();

    await guide.showComputerPermissionGuideWindow(null);
    await vi.waitFor(() => {
      expect(harness.nativeShow).toHaveBeenCalledTimes(2);
    });
    harness.nativeHostState.options?.onCompleted?.();
    expect(harness.closeComputerUseSwitchLocator).toHaveBeenCalledTimes(2);
  });

  it('cancels an unattached native guide after the Electron safety timeout', async () => {
    vi.useFakeTimers();
    const guide = await import('../window');
    await guide.showComputerPermissionGuideWindow(null);
    await vi.waitFor(() => {
      expect(harness.nativeShow).toHaveBeenCalled();
    });

    await vi.advanceTimersByTimeAsync(30_000);

    expect(harness.nativeDismiss).toHaveBeenCalledOnce();
    expect(harness.closeComputerUseSwitchLocator).toHaveBeenCalledOnce();
    expect(harness.broadcastSend).toHaveBeenCalledWith(
      'maker:computer:permission-guide-cancelled',
    );
  });

  it('keeps the attach timeout armed when the locator finds window bounds first', async () => {
    vi.useFakeTimers();
    const nativeStarted = createDeferred<boolean>();
    harness.nativeShow.mockReturnValueOnce(nativeStarted.promise);
    harness.locateComputerUseSwitchTarget.mockResolvedValue({
      status: 'not-found',
      systemWindowBounds: { x: 200, y: 100, width: 1000, height: 500 },
    });
    harness.isComputerDriverPermissionProbePaused.mockReturnValue(true);
    const guide = await import('../window');
    const show = guide.showComputerPermissionGuideWindow(null);

    await vi.waitFor(() => {
      expect(harness.nativeShow).toHaveBeenCalledOnce();
    });
    finishTestDrag(guide);
    await vi.waitFor(() => {
      expect(harness.locateComputerUseSwitchTarget).toHaveBeenCalled();
    });
    nativeStarted.resolve(true);
    await show;

    await vi.advanceTimersByTimeAsync(30_000);

    expect(harness.nativeDismiss).toHaveBeenCalledOnce();
    expect(harness.broadcastSend).toHaveBeenCalledWith(
      'maker:computer:permission-guide-cancelled',
    );
  });

  it('shows the Electron fallback only when the native guide cannot start', async () => {
    harness.nativeShow.mockResolvedValueOnce(false);
    const guide = await import('../window');

    await guide.showComputerPermissionGuideWindow(null);

    await vi.waitFor(() => {
      expect(harness.windows[0].showInactive).toHaveBeenCalledOnce();
      expect(harness.windows[1].showInactive).toHaveBeenCalledOnce();
    });
  });

  it('fully tears down the lifecycle when the Electron fallback closes normally', async () => {
    harness.nativeShow.mockResolvedValueOnce(false);
    const guide = await import('../window');
    const initialStatus = harness.computerStatus();

    await guide.showComputerPermissionGuideWindow(null, initialStatus);
    await vi.waitFor(() => {
      expect(harness.windows[1].showInactive).toHaveBeenCalledOnce();
    });
    harness.resumeComputerDriverPermissionProbe.mockClear();
    harness.closeComputerUseSwitchLocator.mockClear();
    harness.openExternal.mockClear();

    harness.windows[1].close();

    expect(harness.resumeComputerDriverPermissionProbe).toHaveBeenCalledOnce();
    expect(harness.closeComputerUseSwitchLocator).toHaveBeenCalledOnce();
    expect(harness.windows[0].close).toHaveBeenCalledOnce();
    expect(harness.nativeDismiss).not.toHaveBeenCalled();
    expect(harness.cancelComputerDriverPermissionGrant).toHaveBeenCalledOnce();
    expect(harness.broadcastSend).toHaveBeenCalledWith(
      'maker:computer:permission-guide-cancelled',
    );

    await guide.openComputerPermissionPaneForStatus(initialStatus);
    expect(harness.openExternal).toHaveBeenCalledOnce();
  });

  it('does not report cancellation when the completed Electron fallback closes', async () => {
    harness.nativeShow.mockResolvedValueOnce(false);
    const guide = await import('../window');
    const completeStatus = harness.computerStatus({
      status: 'granted',
      accessibility: 'granted',
      screenRecording: 'granted',
      screenRecordingCapturable: 'granted',
    });

    await guide.showComputerPermissionGuideWindow(null, completeStatus);
    await vi.waitFor(() => {
      expect(harness.windows[1].showInactive).toHaveBeenCalledOnce();
    });
    harness.cancelComputerDriverPermissionGrant.mockClear();
    harness.broadcastSend.mockClear();

    harness.windows[1].close();

    expect(harness.cancelComputerDriverPermissionGrant).not.toHaveBeenCalled();
    expect(harness.broadcastSend).not.toHaveBeenCalledWith(
      'maker:computer:permission-guide-cancelled',
    );
    expect(harness.closeComputerUseSwitchLocator).toHaveBeenCalled();
  });

  it('shows the Electron fallback when the native guide exits before attaching', async () => {
    const nativeStarted = createDeferred<boolean>();
    harness.nativeShow.mockReturnValueOnce(nativeStarted.promise);
    const guide = await import('../window');

    await guide.showComputerPermissionGuideWindow(null);
    harness.nativeHostState.options?.onExited?.();

    await vi.waitFor(() => {
      expect(harness.windows[0].showInactive).toHaveBeenCalledOnce();
      expect(harness.windows[1].showInactive).toHaveBeenCalledOnce();
    });
    expect(harness.closeComputerUseSwitchLocator).not.toHaveBeenCalled();
    expect(harness.broadcastSend).not.toHaveBeenCalledWith(
      'maker:computer:permission-guide-cancelled',
    );

    nativeStarted.resolve(false);
    await Promise.resolve();
    expect(harness.windows[0].showInactive).toHaveBeenCalledOnce();
    expect(harness.windows[1].showInactive).toHaveBeenCalledOnce();
  });

  it('keeps the fallback alive when a started native guide exits before attaching', async () => {
    vi.useFakeTimers();
    harness.nativeShow.mockResolvedValueOnce(true);
    const guide = await import('../window');

    await guide.showComputerPermissionGuideWindow(null);
    await vi.waitFor(() => {
      expect(harness.nativeShow).toHaveBeenCalledOnce();
    });
    harness.nativeHostState.options?.onExited?.();
    await vi.waitFor(() => {
      expect(harness.windows[0].showInactive).toHaveBeenCalledOnce();
      expect(harness.windows[1].showInactive).toHaveBeenCalledOnce();
    });

    await vi.advanceTimersByTimeAsync(30_000);

    expect(harness.windows[0].close).not.toHaveBeenCalled();
    expect(harness.windows[1].close).not.toHaveBeenCalled();
    expect(harness.broadcastSend).not.toHaveBeenCalledWith(
      'maker:computer:permission-guide-cancelled',
    );
  });

  it('closes the guide and resumes permission probes when its renderer exits', async () => {
    const guide = await import('../window');
    await guide.showComputerPermissionGuideWindow(null);
    harness.resumeComputerDriverPermissionProbe.mockClear();
    harness.closeComputerUseSwitchLocator.mockClear();
    harness.broadcastSend.mockClear();

    harness.windows[1].listeners.get('render-process-gone')?.(
      {},
      { reason: 'crashed' },
    );

    expect(harness.resumeComputerDriverPermissionProbe).toHaveBeenCalledOnce();
    expect(harness.nativeDismiss).toHaveBeenCalledOnce();
    expect(harness.closeComputerUseSwitchLocator).toHaveBeenCalledOnce();
    expect(harness.broadcastSend).toHaveBeenCalledWith(
      'maker:computer:permission-guide-cancelled',
    );
  });

  it('closes the guide and resumes permission probes when its renderer fails to load', async () => {
    harness.setNextGuideLoadError(new Error('load failed'));
    const guide = await import('../window');

    await guide.showComputerPermissionGuideWindow(null);

    await vi.waitFor(() => {
      expect(harness.resumeComputerDriverPermissionProbe).toHaveBeenCalledOnce();
      expect(harness.closeComputerUseSwitchLocator).toHaveBeenCalledOnce();
      expect(harness.broadcastSend).toHaveBeenCalledWith(
        'maker:computer:permission-guide-cancelled',
      );
    });
    expect(harness.windows[0].close).toHaveBeenCalledOnce();
    expect(harness.windows[1].close).toHaveBeenCalledOnce();
  });

  it('cancels the guide when the attached native guide exits unexpectedly', async () => {
    const guide = await import('../window');
    await guide.showComputerPermissionGuideWindow(null);
    harness.nativeHostState.options?.onAttached?.();
    harness.closeComputerUseSwitchLocator.mockClear();
    harness.broadcastSend.mockClear();

    harness.nativeHostState.options?.onExited?.();

    expect(harness.closeComputerUseSwitchLocator).toHaveBeenCalledOnce();
    expect(harness.broadcastSend).toHaveBeenCalledWith(
      'maker:computer:permission-guide-cancelled',
    );
  });

  it('does not reuse a persisted drag from an earlier guide lifecycle', async () => {
    writeDragState({ accessibility: true, screenRecording: true });
    harness.isComputerDriverPermissionProbePaused.mockReturnValue(true);
    const guide = await import('../window');
    await guide.showComputerPermissionGuideWindow(null);

    await vi.waitFor(() => {
      expect(harness.windows).toHaveLength(2);
    });
    expect(harness.locateComputerUseSwitchTarget).not.toHaveBeenCalled();
    expect(guide.readPermissionDragState()).toEqual({
      accessibility: false,
      screenRecording: false,
    });
  });

  it('reuses an observer-provided location instead of locating twice', async () => {
    const nativeStarted = createDeferred<boolean>();
    harness.nativeShow.mockReturnValueOnce(nativeStarted.promise);
    harness.locateComputerUseSwitchTarget.mockResolvedValue({
      status: 'found',
      target: {
        x: 901,
        y: 442,
        permission: 'accessibility',
        enabled: false,
      },
      systemWindowBounds: { x: 200, y: 100, width: 1000, height: 500 },
    });
    const guide = await import('../window');
    const initialStatus = harness.computerStatus();

    await guide.showComputerPermissionGuideWindow(null, initialStatus);
    finishTestDrag(guide);
    await vi.waitFor(() => {
      expect(harness.nativeUpdate).toHaveBeenCalled();
    });
    harness.nativeUpdate.mockClear();
    harness.isComputerDriverPermissionProbePaused.mockReturnValue(true);
    nativeStarted.resolve(true);

    await vi.waitFor(() => {
      expect(harness.nativeUpdate).toHaveBeenCalledWith(expect.objectContaining({
        switchTargetX: 901,
        switchTargetY: 442,
      }));
    });
    expect(harness.locateComputerUseSwitchTarget).toHaveBeenCalledOnce();
  });

  it('establishes the first full bypass on drag completion', async () => {
    await startObserverThrottleTest(foundSwitchLocation(false));
  });

  it('coalesces an observer burst into one immediate and one trailing full bypass', async () => {
    await startObserverThrottleTest(
      foundSwitchLocation(false),
      foundSwitchLocation(true, { x: 902 }),
      { status: 'not-found' },
    );
    await vi.advanceTimersByTimeAsync(1_800);
    await expectPermissionProbeCounts(1, 2);

    await vi.advanceTimersByTimeAsync(200);
    await expectPermissionProbeCounts(2, 2);
  });

  it('runs the trailing observer probe with current lifecycle state', async () => {
    await startObserverThrottleTest(
      foundSwitchLocation(false),
      foundSwitchLocation(true, { x: 902 }),
      foundSwitchLocation(false, {
        x: 950,
        y: 460,
        permission: 'screenRecording',
      }),
    );
    await vi.advanceTimersByTimeAsync(900);
    await expectPermissionProbeCounts(1, 1);

    harness.isComputerDriverPermissionProbePaused.mockReturnValue(true);
    await vi.advanceTimersByTimeAsync(1_100);
    await vi.waitFor(() => {
      expect(harness.nativeUpdate).toHaveBeenLastCalledWith(expect.objectContaining({
        switchTargetX: 950,
        switchTargetY: 460,
      }));
    });
    expect(harness.locateComputerUseSwitchTarget).toHaveBeenCalledTimes(3);
    expect(fullPermissionProbeCalls()).toHaveLength(2);
  });

  it('invalidates trailing work armed by an older queued observer at the explicit issue boundary', async () => {
    const blockedRefresh = createDeferred<Awaited<ReturnType<
      typeof harness.getComputerDriverStatus
    >>>();
    const guide = await startObserverThrottleTest(
      foundSwitchLocation(false),
      foundSwitchLocation(false),
    );
    harness.getComputerDriverStatus.mockImplementationOnce(() => blockedRefresh.promise);
    guide.refreshComputerPermissionGuideWindow();
    await expectPermissionProbeCounts(1, 1);

    await vi.advanceTimersByTimeAsync(900);
    const explicitRefresh = guide.showComputerPermissionGuideWindow(null);
    await vi.advanceTimersByTimeAsync(600);
    blockedRefresh.resolve(harness.computerStatus());
    await explicitRefresh;
    await expectPermissionProbeCounts(2, 2);

    await vi.advanceTimersByTimeAsync(500);
    await expectPermissionProbeCounts(2, 2);
  });

  it('lets an explicit bypass supersede a fired-but-queued observer trailing callback', async () => {
    const blockedRefresh = createDeferred<Awaited<ReturnType<
      typeof harness.getComputerDriverStatus
    >>>();
    const guide = await startObserverThrottleTest(
      foundSwitchLocation(false),
      foundSwitchLocation(false),
    );
    await vi.advanceTimersByTimeAsync(900);
    await expectPermissionProbeCounts(1, 1);

    harness.getComputerDriverStatus.mockImplementationOnce(() => blockedRefresh.promise);
    guide.refreshComputerPermissionGuideWindow();
    await expectPermissionProbeCounts(1, 2);
    await vi.advanceTimersByTimeAsync(1_100);
    const explicitRefresh = guide.showComputerPermissionGuideWindow(null);
    blockedRefresh.resolve(harness.computerStatus());
    await explicitRefresh;
    await expectPermissionProbeCounts(2, 2);

    await vi.advanceTimersByTimeAsync(2_000);
    await expectPermissionProbeCounts(2, 2);
  });

  it('invalidates a fired-but-queued lifecycle-A trailing callback on close and reopen', async () => {
    const blockedRefresh = createDeferred<Awaited<ReturnType<
      typeof harness.getComputerDriverStatus
    >>>();
    const guide = await startObserverThrottleTest(
      foundSwitchLocation(false),
      foundSwitchLocation(false),
    );
    await vi.advanceTimersByTimeAsync(900);
    await expectPermissionProbeCounts(1, 1);

    harness.getComputerDriverStatus.mockImplementationOnce(() => blockedRefresh.promise);
    guide.refreshComputerPermissionGuideWindow();
    await expectPermissionProbeCounts(1, 2);
    await vi.advanceTimersByTimeAsync(1_100);

    guide.closeComputerPermissionGuideWindow();
    await guide.showComputerPermissionGuideWindow(null, harness.computerStatus());
    await expectPermissionProbeCounts(1, 2);

    blockedRefresh.resolve(harness.computerStatus());
    await vi.advanceTimersByTimeAsync(900);
    await expectPermissionProbeCounts(1, 2);
  });

  it('keeps observer probing across the 2,000ms throttle boundary', async () => {
    const unchangedLocation = foundSwitchLocation(false);
    await startObserverThrottleTest(
      unchangedLocation,
      unchangedLocation,
      foundSwitchLocation(true, { x: 903 }),
    );
    await vi.advanceTimersByTimeAsync(2_700);
    await expectPermissionProbeCounts(2, 2);
  });

  it('keeps probing when the located switch state remains unknown', async () => {
    await startObserverThrottleTest(
      foundSwitchLocation(null),
      foundSwitchLocation(null),
      foundSwitchLocation(null),
      foundSwitchLocation(null),
      foundSwitchLocation(null),
    );

    await vi.advanceTimersByTimeAsync(4_000);
    await expectPermissionProbeCounts(3);
  });

  it('serializes explicit and observer refreshes in invocation order', async () => {
    const nativeStarted = createDeferred<boolean>();
    const olderLocation = createDeferred<{
      status: 'found';
      target: {
        x: number;
        y: number;
        permission: 'accessibility';
        enabled: boolean;
      };
    }>();
    harness.nativeShow.mockReturnValueOnce(nativeStarted.promise);
    harness.locateComputerUseSwitchTarget
      .mockImplementationOnce(() => olderLocation.promise)
      .mockResolvedValueOnce({
        status: 'found',
        target: {
          x: 920,
          y: 450,
          permission: 'accessibility',
          enabled: false,
        },
      });
    const guide = await import('../window');
    const initialStatus = harness.computerStatus();

    await guide.showComputerPermissionGuideWindow(null, initialStatus);
    finishTestDrag(guide);
    await vi.waitFor(() => {
      expect(harness.nativeUpdate).toHaveBeenCalled();
    });
    harness.nativeUpdate.mockClear();
    harness.isComputerDriverPermissionProbePaused.mockReturnValue(true);
    guide.refreshComputerPermissionGuideWindow();
    await vi.waitFor(() => {
      expect(harness.locateComputerUseSwitchTarget).toHaveBeenCalledOnce();
    });

    nativeStarted.resolve(true);
    await Promise.resolve();
    expect(harness.locateComputerUseSwitchTarget).toHaveBeenCalledOnce();

    olderLocation.resolve({
      status: 'found',
      target: {
        x: 700,
        y: 410,
        permission: 'accessibility',
        enabled: false,
      },
    });

    await vi.waitFor(() => {
      expect(harness.locateComputerUseSwitchTarget).toHaveBeenCalledTimes(2);
      expect(harness.nativeUpdate).toHaveBeenLastCalledWith(expect.objectContaining({
        switchTargetX: 920,
        switchTargetY: 450,
      }));
    });
  });

  it('ignores an old lifecycle refresh result after close and reopen', async () => {
    const oldStatus = createDeferred<Awaited<ReturnType<
      typeof harness.getComputerDriverStatus
    >>>();
    const reopenedNativeStarted = createDeferred<boolean>();
    const guide = await import('../window');
    const initialStatus = harness.computerStatus();
    await guide.showComputerPermissionGuideWindow(null, initialStatus);
    await vi.waitFor(() => {
      expect(harness.nativeShow).toHaveBeenCalledOnce();
    });

    harness.getComputerDriverStatus.mockImplementationOnce(() => oldStatus.promise);
    guide.refreshComputerPermissionGuideWindow();
    await vi.waitFor(() => {
      expect(harness.getComputerDriverStatus).toHaveBeenCalledOnce();
    });
    guide.closeComputerPermissionGuideWindow();

    harness.nativeShow.mockReturnValueOnce(reopenedNativeStarted.promise);
    await guide.showComputerPermissionGuideWindow(null, initialStatus);
    harness.nativeUpdate.mockClear();
    harness.broadcastSend.mockClear();
    oldStatus.resolve(harness.computerStatus({
      status: 'granted',
      accessibility: 'granted',
      screenRecording: 'granted',
      screenRecordingCapturable: 'granted',
    }));
    await Promise.resolve();
    await Promise.resolve();

    expect(harness.nativeUpdate).not.toHaveBeenCalled();
    expect(harness.broadcastSend).not.toHaveBeenCalledWith(
      'maker:computer:permission-guide-status-changed',
      expect.objectContaining({
        permissionState: expect.objectContaining({ status: 'granted' }),
      }),
    );
  });

  it('does not continue an old show after its preflight settles following close and reopen', async () => {
    const oldStatus = createDeferred<Awaited<ReturnType<
      typeof harness.getComputerDriverStatus
    >>>();
    harness.getComputerDriverStatus.mockImplementationOnce(() => oldStatus.promise);
    const guide = await import('../window');
    const oldShow = guide.showComputerPermissionGuideWindow(null);
    await vi.waitFor(() => {
      expect(harness.getComputerDriverStatus).toHaveBeenCalledOnce();
    });

    guide.closeComputerPermissionGuideWindow();
    await guide.showComputerPermissionGuideWindow(null, harness.computerStatus());
    await vi.waitFor(() => {
      expect(harness.nativeShow).toHaveBeenCalledOnce();
    });

    oldStatus.resolve(harness.computerStatus());
    await oldShow;
    await Promise.resolve();

    expect(harness.nativeShow).toHaveBeenCalledOnce();
    expect(harness.nativeHostState.allOptions).toHaveLength(1);
  });

  it('ignores callbacks from a native host owned by a closed lifecycle', async () => {
    const guide = await import('../window');
    await guide.showComputerPermissionGuideWindow(null, harness.computerStatus());
    await vi.waitFor(() => {
      expect(harness.nativeHostState.allOptions).toHaveLength(1);
    });
    const staleOptions = harness.nativeHostState.allOptions[0];

    guide.closeComputerPermissionGuideWindow();
    await guide.showComputerPermissionGuideWindow(null, harness.computerStatus());
    await vi.waitFor(() => {
      expect(harness.nativeHostState.allOptions).toHaveLength(2);
    });
    const reopenedBackdrop = harness.windows[2];
    const reopenedGuide = harness.windows[3];
    harness.nativeDismiss.mockClear();
    harness.nativeUpdate.mockClear();
    harness.cancelComputerDriverPermissionGrant.mockClear();
    harness.closeComputerUseSwitchLocator.mockClear();

    staleOptions.onDragBegan?.('accessibility');
    staleOptions.onDragEnded?.('accessibility', 1);
    staleOptions.onAttached?.();
    staleOptions.onCompleted?.();
    staleOptions.onCloseRequested?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(harness.nativeUpdate).not.toHaveBeenCalled();
    expect(harness.nativeDismiss).not.toHaveBeenCalled();
    expect(harness.cancelComputerDriverPermissionGrant).not.toHaveBeenCalled();
    expect(harness.closeComputerUseSwitchLocator).not.toHaveBeenCalled();
    expect(reopenedBackdrop.close).not.toHaveBeenCalled();
    expect(reopenedGuide.close).not.toHaveBeenCalled();
  });

  it('ignores a delayed closed event from the previous Electron lifecycle', async () => {
    harness.setDeferWindowClosedEvents(true);
    const guide = await import('../window');
    await guide.showComputerPermissionGuideWindow(null, harness.computerStatus());
    const staleGuide = harness.windows[1];

    guide.closeComputerPermissionGuideWindow();
    await guide.showComputerPermissionGuideWindow(null, harness.computerStatus());
    const reopenedBackdrop = harness.windows[2];
    const reopenedGuide = harness.windows[3];
    staleGuide.listeners.get('closed')?.();

    expect(reopenedBackdrop.close).not.toHaveBeenCalled();
    expect(reopenedGuide.setIgnoreMouseEvents).not.toHaveBeenCalledWith(false);
  });

  it('does not locate an active second permission before its drag when probing is resumed', async () => {
    const guide = await import('../window');
    await guide.showComputerPermissionGuideWindow(
      null,
      harness.computerStatus({ accessibility: 'granted' }),
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(harness.isComputerDriverPermissionProbePaused).toHaveReturnedWith(false);
    expect(harness.locateComputerUseSwitchTarget).not.toHaveBeenCalled();
  });

  it('applies an active re-show status before starting an observer during native startup', async () => {
    writeDragState({ accessibility: true, screenRecording: false });
    const nativeStarted = createDeferred<boolean>();
    harness.nativeShow.mockReturnValueOnce(nativeStarted.promise);
    const guide = await import('../window');
    await guide.showComputerPermissionGuideWindow(null, harness.computerStatus());

    await guide.showComputerPermissionGuideWindow(
      null,
      harness.computerStatus({ accessibility: 'granted' }),
    );
    await Promise.resolve();

    expect(harness.locateComputerUseSwitchTarget).not.toHaveBeenCalled();
  });

  it('updates the active native guide with a newer same-lifecycle re-show status', async () => {
    harness.isComputerDriverPermissionProbePaused.mockReturnValue(true);
    const deferredPreflight = createDeferred<{ status: 'unavailable' }>();
    harness.locateComputerUseSwitchTarget.mockReturnValueOnce(deferredPreflight.promise);
    const guide = await import('../window');
    await guide.showComputerPermissionGuideWindow(
      null,
      harness.computerStatus(),
    );
    finishTestDrag(guide);
    await vi.waitFor(() => {
      expect(harness.locateComputerUseSwitchTarget).toHaveBeenCalledOnce();
    });

    const showB = guide.showComputerPermissionGuideWindow(
      null,
      harness.computerStatus({ accessibility: 'granted' }),
    );
    deferredPreflight.resolve({ status: 'unavailable' });
    await showB;

    await vi.waitFor(() => {
      expect(harness.nativeUpdate).toHaveBeenCalledWith(expect.objectContaining({
        accessibilityGranted: true,
        screenRecordingGranted: false,
      }));
    });
  });

  it('keeps an older observer bound to its status snapshot when an active guide is re-shown', async () => {
    const nativeStarted = createDeferred<boolean>();
    const olderLocation = createDeferred<{ status: 'not-found' }>();
    harness.nativeShow.mockReturnValueOnce(nativeStarted.promise);
    harness.locateComputerUseSwitchTarget.mockImplementationOnce(() => olderLocation.promise);
    const guide = await import('../window');
    const accessibilityStatus = harness.computerStatus();
    await guide.showComputerPermissionGuideWindow(null, accessibilityStatus);
    harness.nativeHostState.options?.onDragEnded?.('accessibility', 1);
    harness.nativeHostState.options?.onDragEnded?.('screenRecording', 1);
    await vi.waitFor(() => {
      expect(guide.readPermissionDragState()).toEqual({
        accessibility: true,
        screenRecording: true,
      });
    });

    harness.isComputerDriverPermissionProbePaused.mockReturnValue(true);
    nativeStarted.resolve(true);
    await vi.waitFor(() => {
      expect(harness.locateComputerUseSwitchTarget).toHaveBeenCalledOnce();
    });

    const screenRecordingStatus = harness.computerStatus({ accessibility: 'granted' });
    const reshow = guide.showComputerPermissionGuideWindow(null, screenRecordingStatus);
    olderLocation.resolve({ status: 'not-found' });
    await reshow;

    expect(harness.nativeUpdate).toHaveBeenLastCalledWith(expect.objectContaining({
      accessibilityGranted: true,
      draggedAccessibility: false,
      draggedScreenRecording: true,
    }));
  });

  it('keeps a valid location when a paused refresh has no confirmed drag for the active pane', async () => {
    const nativeStarted = createDeferred<boolean>();
    harness.nativeShow.mockReturnValueOnce(nativeStarted.promise);
    harness.locateComputerUseSwitchTarget.mockResolvedValueOnce({
      status: 'found',
      target: {
        x: 905,
        y: 446,
        permission: 'accessibility',
        enabled: false,
      },
    });
    const guide = await import('../window');
    const accessibilityMissingStatus = harness.computerStatus();

    await guide.showComputerPermissionGuideWindow(null, accessibilityMissingStatus);
    finishTestDrag(guide);
    await vi.waitFor(() => {
      expect(harness.nativeUpdate).toHaveBeenCalled();
    });
    harness.isComputerDriverPermissionProbePaused.mockReturnValue(true);
    guide.refreshComputerPermissionGuideWindow();
    await vi.waitFor(() => {
      expect(harness.locateComputerUseSwitchTarget).toHaveBeenCalledOnce();
    });
    harness.locateComputerUseSwitchTarget.mockResolvedValueOnce({ status: 'unavailable' });
    harness.nativeUpdate.mockClear();
    guide.refreshComputerPermissionGuideWindow();
    await vi.waitFor(() => {
      expect(harness.nativeUpdate).toHaveBeenCalledWith(expect.objectContaining({
        switchTargetX: 905,
        switchTargetY: 446,
      }));
    });
    guide.refreshComputerPermissionGuideWindow({
      ...accessibilityMissingStatus,
      permissionState: {
        ...accessibilityMissingStatus.permissionState,
        accessibility: 'granted',
      },
    });
    await vi.waitFor(() => {
      expect(harness.nativeUpdate).toHaveBeenCalledWith(expect.objectContaining({
        accessibilityGranted: true,
      }));
    });
    harness.nativeUpdate.mockClear();
    guide.refreshComputerPermissionGuideWindow();

    await vi.waitFor(() => {
      expect(harness.nativeUpdate).toHaveBeenCalledWith(expect.objectContaining({
        draggedScreenRecording: false,
        switchTargetX: 905,
        switchTargetY: 446,
      }));
    });
    expect(harness.locateComputerUseSwitchTarget).toHaveBeenCalledTimes(2);
  });

  it('keeps the preflight guide step when a paused status refresh is synthetic', async () => {
    const nativeStarted = createDeferred<boolean>();
    harness.nativeShow.mockReturnValueOnce(nativeStarted.promise);
    harness.isComputerDriverPermissionProbePaused.mockReturnValue(true);
    const guide = await import('../window');
    const preflightStatus = harness.computerStatus({ accessibility: 'granted' });
    const show = guide.showComputerPermissionGuideWindow(null, preflightStatus);
    await vi.waitFor(() => {
      expect(harness.nativeShow).toHaveBeenCalledOnce();
    });
    harness.nativeUpdate.mockClear();
    harness.broadcastSend.mockClear();
    harness.windows[1].webContents.send.mockClear();

    const pausedStatus = harness.computerStatus({
      screenRecording: 'unknown',
      screenRecordingCapturable: 'unknown',
    });
    guide.refreshComputerPermissionGuideWindow(pausedStatus);

    await vi.waitFor(() => {
      expect(harness.nativeUpdate).toHaveBeenCalledWith(expect.objectContaining({
        accessibilityGranted: true,
        screenRecordingGranted: false,
        draggedScreenRecording: false,
      }));
    });
    expect(harness.broadcastSend).toHaveBeenCalledWith(
      'maker:computer:permission-guide-status-changed',
      pausedStatus,
    );
    expect(harness.windows[1].webContents.send).toHaveBeenCalledWith(
      'maker:computer:permission-guide-status-changed',
      preflightStatus,
    );
    expect(guide.getComputerPermissionGuideStatus(
      harness.windows[1].webContents as unknown as WebContents,
    )).toBe(preflightStatus);
    expect(harness.locateComputerUseSwitchTarget).not.toHaveBeenCalled();

    nativeStarted.resolve(true);
    await show;
  });

  it('clears a historical drag hint when the live System Settings row is absent', async () => {
    const guide = await import('../window');
    await guide.showComputerPermissionGuideWindow(null);
    await vi.waitFor(() => {
      expect(harness.nativeShow).toHaveBeenCalled();
    });

    harness.isComputerDriverPermissionProbePaused.mockReturnValue(true);
    harness.locateComputerUseSwitchTarget.mockResolvedValue({ status: 'not-found' });
    const sender = harness.windows[1].webContents as unknown as WebContents;
    guide.startComputerPermissionAppDrag(sender, VALID_PNG_DATA_URL);
    await expect(guide.finishComputerPermissionAppDrag(sender, true)).resolves.toBe(false);

    await vi.waitFor(() => {
      expect(harness.nativeUpdate).toHaveBeenCalledWith(expect.objectContaining({
        accessibilityGranted: false,
        draggedAccessibility: false,
      }));
    });
  });

  it('accepts a copied drag only after the live System Settings row appears', async () => {
    const guide = await import('../window');
    await guide.showComputerPermissionGuideWindow(null);
    await vi.waitFor(() => {
      expect(harness.nativeShow).toHaveBeenCalled();
    });

    harness.isComputerDriverPermissionProbePaused.mockReturnValue(true);
    harness.locateComputerUseSwitchTarget.mockResolvedValue(foundSwitchLocation(false));
    const sender = harness.windows[1].webContents as unknown as WebContents;
    guide.startComputerPermissionAppDrag(sender, VALID_PNG_DATA_URL);

    await expect(guide.finishComputerPermissionAppDrag(sender, true)).resolves.toBe(true);
  });

  it('starts the real app drag only for the guide renderer and restores it on drag end', async () => {
    const guide = await import('../window');
    await guide.showComputerPermissionGuideWindow(null);
    const guideWindow = harness.windows[1];

    const sender = guideWindow.webContents as unknown as WebContents;
    guide.startComputerPermissionAppDrag(sender, VALID_PNG_DATA_URL);
    expect(guideWindow.webContents.startDrag).toHaveBeenCalledWith({
      file: '/Applications/CuaDriver.app',
      icon: expect.anything(),
    });
    expect(guideWindow.setIgnoreMouseEvents).toHaveBeenCalledWith(true, { forward: true });

    guide.finishComputerPermissionAppDrag(sender, true);
    expect(guideWindow.setIgnoreMouseEvents).toHaveBeenCalledWith(false);
  });

  it('rejects malformed and oversized drag icons before decoding', async () => {
    const guide = await import('../window');
    await guide.showComputerPermissionGuideWindow(null);
    const guideWindow = harness.windows[1];
    const sender = guideWindow.webContents as unknown as WebContents;
    harness.nativeImage.createFromDataURL.mockClear();

    guide.startComputerPermissionAppDrag(sender, 'data:text/plain;base64,aGVsbG8=');
    guide.startComputerPermissionAppDrag(sender, 'data:image/png;base64,aGVsbG8=');
    guide.startComputerPermissionAppDrag(
      sender,
      `data:image/png;base64,iVBORw0KGgo${'A'.repeat(256 * 1024)}`,
    );

    expect(harness.nativeImage.createFromDataURL).not.toHaveBeenCalled();
    expect(guideWindow.webContents.startDrag).not.toHaveBeenCalled();
  });

  it('does not start a drag when the validated icon cannot be decoded', async () => {
    const guide = await import('../window');
    await guide.showComputerPermissionGuideWindow(null);
    const guideWindow = harness.windows[1];
    const sender = guideWindow.webContents as unknown as WebContents;
    harness.nativeImage.createFromDataURL.mockImplementationOnce(() => {
      throw new Error('decode failed');
    });

    guide.startComputerPermissionAppDrag(sender, VALID_PNG_DATA_URL);

    expect(guideWindow.webContents.startDrag).not.toHaveBeenCalled();
  });

  it('centers the guide vertically on the real System Settings window', async () => {
    vi.useFakeTimers();
    harness.locateComputerUseSwitchTarget.mockResolvedValue({
      status: 'not-found',
      systemWindowBounds: { x: 200, y: 100, width: 1000, height: 500 },
    });
    const guide = await import('../window');
    await guide.showComputerPermissionGuideWindow(null);
    finishTestDrag(guide);
    const guideWindow = harness.windows[1];

    await vi.advanceTimersByTimeAsync(900);
    expect(guideWindow.setBounds).toHaveBeenCalledWith(
      { x: 736, y: 190, width: 480, height: 272 },
      false,
    );
  });

  it('uses guide dimensions from the shared placement module', async () => {
    vi.useFakeTimers();
    const { PERMISSION_GUIDE_WINDOW_WIDTH, PERMISSION_GUIDE_WINDOW_HEIGHT } =
      await import('../placement');
    expect(PERMISSION_GUIDE_WINDOW_WIDTH).toBe(480);
    expect(PERMISSION_GUIDE_WINDOW_HEIGHT).toBe(272);

    harness.locateComputerUseSwitchTarget.mockResolvedValue({
      status: 'not-found',
      systemWindowBounds: { x: 200, y: 100, width: 1000, height: 500 },
    });
    const guide = await import('../window');
    await guide.showComputerPermissionGuideWindow(null);
    finishTestDrag(guide);

    await vi.advanceTimersByTimeAsync(900);
    expect(harness.windows[1].setBounds).toHaveBeenCalledWith(
      expect.objectContaining({
        width: PERMISSION_GUIDE_WINDOW_WIDTH,
        height: PERMISSION_GUIDE_WINDOW_HEIGHT,
      }),
      false,
    );
  });

  it('does not write drag state when Electron startDrag throws', async () => {
    const guide = await import('../window');
    await guide.showComputerPermissionGuideWindow(null);
    const guideWindow = harness.windows[1];
    guideWindow.webContents.startDrag.mockImplementation(() => {
      throw new Error('drag failed');
    });

    const sender = guideWindow.webContents as unknown as WebContents;
    guide.startComputerPermissionAppDrag(sender, VALID_PNG_DATA_URL);

    const dragState = guide.readPermissionDragState();
    expect(dragState.accessibility).toBe(false);
    expect(dragState.screenRecording).toBe(false);
  });

  it('does not infer a successful drop when Chromium omits dragend', async () => {
    vi.useFakeTimers();
    const guide = await import('../window');
    await guide.showComputerPermissionGuideWindow(null);
    const guideWindow = harness.windows[1];

    const sender = guideWindow.webContents as unknown as WebContents;
    guide.startComputerPermissionAppDrag(sender, VALID_PNG_DATA_URL);

    await vi.advanceTimersByTimeAsync(12_000);

    const dragState = guide.readPermissionDragState();
    expect(dragState.accessibility).toBe(false);
    expect(dragState.screenRecording).toBe(false);
    expect(guideWindow.setIgnoreMouseEvents).toHaveBeenCalledWith(false);
    expect(harness.locateComputerUseSwitchTarget).not.toHaveBeenCalled();
  });

  it('does not persist or inspect after a cancelled Electron drag', async () => {
    const guide = await import('../window');
    await guide.showComputerPermissionGuideWindow(null);
    const sender = harness.windows[1].webContents as unknown as WebContents;

    guide.startComputerPermissionAppDrag(sender, VALID_PNG_DATA_URL);
    guide.finishComputerPermissionAppDrag(sender, false);

    expect(guide.readPermissionDragState().accessibility).toBe(false);
    expect(harness.locateComputerUseSwitchTarget).not.toHaveBeenCalled();
  });

  it('does not write drag state when the guide closes during a drag', async () => {
    const guide = await import('../window');
    await guide.showComputerPermissionGuideWindow(null);
    const guideWindow = harness.windows[1];

    const sender = guideWindow.webContents as unknown as WebContents;
    guide.startComputerPermissionAppDrag(sender, VALID_PNG_DATA_URL);

    guide.closeComputerPermissionGuideWindow();

    const dragState = guide.readPermissionDragState();
    expect(dragState.accessibility).toBe(false);
    expect(dragState.screenRecording).toBe(false);
  });

  it('keeps the in-memory drag state when persistence is unavailable', async () => {
    const guide = await import('../window');
    await guide.showComputerPermissionGuideWindow(null);
    vi.spyOn(fs, 'writeFileSync').mockImplementationOnce(() => {
      throw new Error('disk unavailable');
    });

    finishTestDrag(guide);

    await vi.waitFor(() => {
      expect(guide.readPermissionDragState().accessibility).toBe(true);
    });
  });

  it('writes drag state only after a confirmed native copy drag', async () => {
    const guide = await import('../window');
    await guide.showComputerPermissionGuideWindow(null, harness.computerStatus());
    await vi.waitFor(() => {
      expect(harness.nativeHostState.options).not.toBeNull();
    });

    harness.nativeHostState.options?.onDragBegan?.('accessibility');
    let dragState = guide.readPermissionDragState();
    expect(dragState.accessibility).toBe(false);

    harness.nativeHostState.options?.onDragEnded?.('accessibility', 0);
    await Promise.resolve();
    await Promise.resolve();
    dragState = guide.readPermissionDragState();
    expect(dragState.accessibility).toBe(false);

    harness.nativeHostState.options?.onDragEnded?.('accessibility', 1);
    await vi.waitFor(() => {
      expect(guide.readPermissionDragState().accessibility).toBe(true);
    });
  });
});
