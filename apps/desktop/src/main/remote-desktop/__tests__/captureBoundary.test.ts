import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  DESKTOP_AUDIO_RETRY_MS,
  DESKTOP_LOCAL,
  type DesktopHostCommand,
} from '../../../shared/remoteDesktop';

vi.hoisted(() => {
  vi.stubGlobal('process', { ...process, platform: 'darwin', getSystemVersion: () => '26.0' });
});

const h = vi.hoisted(() => ({
  wayland: false,
  hyprland: false,
  linuxInput: false,
  linuxAudio: false,
  unlocked: vi.fn(async () => true),
  powerHandlers: new Map<string, () => void>(),
  audioRead: vi.fn(() => new Uint8Array(8)),
  audioStart: vi.fn(),
  audioStop: vi.fn(),
  hyprlandFrame: vi.fn(async () => 'anBlZw=='),
  hyprlandStop: vi.fn(),
  handlers: new Map<string, any>(),
  screenHandlers: new Map<string, any>(),
  geometryMatches: vi.fn(() => true),
  windows: [] as any[],
  deps: null as any,
  permissionDeps: null as any,
  lease: 'lease',
  ready: false,
  source: null as null | Promise<any[]>,
  owner: null as any,
  dispose: vi.fn(),
  stop: vi.fn(),
  stopAndRestore: vi.fn(async () => {}),
  waitForGeometry: vi.fn(async (..._args: any[]) => {}),
  quit: new Map<string, { fn: () => unknown; phase: string }>(),
  releaseControl: vi.fn(),
  inputFailure: null as null | (() => void),
  nativeStop: vi.fn(),
  nativeFrame: vi.fn(async () => 'frame'),
  input: vi.fn(),
  viewHeartbeat: vi.fn(),
  hostInput: vi.fn(),
  startInput: vi.fn(async () => {}),
  iceConfig: vi.fn(async (): Promise<any[]> => [
    { urls: ['turn:relay.example.test:3478'], username: 'temporary', credential: 'test-only' },
  ]),
}));
vi.mock('../waylandCapture', async (original) => ({
  ...(await original<typeof import('../waylandCapture')>()),
  isWaylandDesktop: () => h.wayland,
}));
vi.mock('../linuxInput', () => ({ readLinuxDesktopInputSupport: async () => h.linuxInput }));
vi.mock('../linuxDesktop', () => ({
  supportsLinuxDisplay: () => h.hyprland,
  supportsLinuxLock: () => false,
  waitForLinuxDisplay: vi.fn(),
  linuxMonitors: async () => [
    { name: 'eDP-2', width: 2560, height: 1600, scale: 1.6, transform: 0 },
  ],
  linuxMonitor: vi.fn(),
  linuxDisplay: () => ({ id: 'hyprland:eDP-2', name: 'eDP-2', width: 1600, height: 1000 }),
}));
vi.mock('../linuxCapture', () => ({ readLinuxCursorSupport: async () => false }));
vi.mock('../linuxSessionLock', () => ({ isLinuxDesktopUnlocked: h.unlocked }));
vi.mock('../linuxAudio', () => ({
  supportsLinuxAudio: () => h.linuxAudio,
  LinuxDesktopAudio: class {
    start = h.audioStart;
    stop = h.audioStop;
    read = h.audioRead;
  },
}));
vi.mock('../linuxMute', () => ({
  supportsLinuxMute: () => false,
  LinuxDesktopMute: class {
    async set() {}
  },
}));
vi.mock('../hyprlandCapture', () => ({
  supportsHyprlandCapture: () => h.hyprland,
  HyprlandCapture: class {
    frame = h.hyprlandFrame;
    stop = h.hyprlandStop;
  },
}));
vi.mock('../../lifecycle', () => ({
  onQuit: (name: string, fn: () => unknown, phase = 'sync') => h.quit.set(name, { fn, phase }),
}));
vi.mock('../iceConfig', () => ({ loadDesktopIceServers: h.iceConfig }));
vi.mock('../viewerDisplay', () => ({
  viewerDisplaySupported: vi.fn(async () => false),
  createViewerDisplay: vi.fn(),
  waitForDisplayRestore: h.waitForGeometry,
}));
vi.mock('electron', () => ({
  app: { on: vi.fn() },
  powerMonitor: { on: (name: string, fn: () => void) => h.powerHandlers.set(name, fn) },
  shell: {},
  nativeImage: {},
  screen: {
    on: (name: string, handler: any) => h.screenHandlers.set(name, handler),
    getAllDisplays: () => [{ id: 1 }],
  },
  systemPreferences: { getMediaAccessStatus: () => 'granted' },
  desktopCapturer: {
    getSources: () => h.source ?? Promise.resolve([{ id: 'screen:1', display_id: '1' }]),
  },
  ipcMain: { handle: (key: string, value: any) => h.handlers.set(key, value) },
  powerSaveBlocker: { start: () => 1, stop: vi.fn() },
  session: { defaultSession: {} },
}));
vi.mock('../capturePermissions', () => ({ denyAppDesktopCapture: vi.fn() }));
vi.mock('../captureWindow', () => ({
  DesktopCaptureWindow: class {
    get contents() {
      return h.owner;
    }
    assertSender(e: any) {
      if (!h.owner || e.sender !== h.owner || e.senderFrame !== h.owner.mainFrame)
        throw new Error('PERMISSION_DENIED');
    }
    registered(e: any) {
      this.assertSender(e);
      h.owner.ready();
    }
    start() {
      const win = {
        mainFrame: {},
        isDestroyed: () => win.dead,
        dead: false,
        send: vi.fn(),
        session: { setDisplayMediaRequestHandler: vi.fn() },
        ready: () => {},
        cancel: () => {},
      };
      h.windows.push(win);
      h.owner = win;
      return new Promise<void>((resolve, reject) => {
        win.ready = resolve;
        win.cancel = () => reject(new Error('DESKTOP_VIDEO_STOPPED'));
      });
    }
    dispose() {
      h.dispose();
      const owner = h.owner;
      h.owner = null;
      if (owner) {
        owner.dead = true;
        owner.cancel();
      }
    }
  },
}));
vi.mock('../controller', () => ({
  RemoteDesktopController: class {
    constructor(deps: any) {
      h.deps = deps;
    }
    state = null;
    displayId = '1';
    changingDisplay = false;
    displayGeometryMatches = h.geometryMatches;
    hasLease(value: string) {
      return value === h.lease;
    }
    stop() {
      h.stop();
      h.deps.stopVideo();
    }
    stopByUser() {
      this.stop();
    }
    stopAndRestore = h.stopAndRestore;
    releaseControl() {
      h.releaseControl();
    }
    tick() {}
    input = h.input;
    viewHeartbeat = h.viewHeartbeat;
  },
}));
vi.mock('../nativeCapture', () => ({
  NativeDesktopCapture: class {
    stop = h.nativeStop;
    frame = h.nativeFrame;
  },
}));
vi.mock('../inputHost', () => ({
  resolveDesktopInputBinary: vi.fn(async () => '/fake/desktop-input'),
  DesktopInputHost: class {
    constructor(onFailure: () => void) {
      h.inputFailure = onFailure;
    }
    stop = vi.fn();
    input = h.hostInput;
    start = h.startInput;
  },
  readDesktopDisplayModes: vi.fn(),
  setDesktopDisplayMode: vi.fn(),
  readDesktopInputPermission: vi.fn(),
  requestDesktopInputPermission: vi.fn(),
}));
vi.mock('../permissions', () => ({
  RemoteDesktopPermissionsService: class {
    constructor(deps: any) {
      h.permissionDeps = deps;
    }
    dismiss() {}
    async read() {
      return {};
    }
  },
}));
vi.mock('../windowsHost', () => ({
  readWindowsDesktopSupport: vi.fn(async () => 'ready'),
  configureWindowsDesktopSupport: vi.fn(),
}));
vi.mock('../clipboard', () => ({
  transferDesktopClipboard: vi.fn(),
  transferDesktopClipboardContent: vi.fn(),
}));
vi.mock('../../device-link/settings-store', () => ({
  readDeviceLinkSettings: () => ({}),
  writeDeviceLinkSetting: vi.fn(),
}));
vi.mock('../../security/trustedAppRenderer', () => ({ assertTrustedAppRendererEvent: vi.fn() }));
vi.mock('../../deepLink', () => ({ getDeepLinkMainWindow: vi.fn() }));
vi.mock('../../computer-permission-guide/request', () => ({
  MAC_ACCESSIBILITY_SETTINGS_URL: '',
  MAC_SCREEN_RECORDING_SETTINGS_URL: '',
}));
vi.mock('../../utils/ipcValidate', () => ({
  throwIpcError: () => {
    throw new Error('PERMISSION_DENIED');
  },
}));
import { registerRemoteDesktopIpc } from '../index';
import { PrivacyScreen } from '../privacyScreen';
const event = (owner = h.owner) => ({ sender: owner, senderFrame: owner.mainFrame });
const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
const offer = () =>
  h.deps.offer({ lease: h.lease, display: { id: '1' } }, 'sdp', undefined, false, 'attempt');
beforeEach(() => {
  vi.stubGlobal('process', { ...process, platform: 'darwin', getSystemVersion: () => '26.0' });
  vi.useFakeTimers();
  h.wayland = false;
  h.hyprland = false;
  h.linuxInput = false;
  h.linuxAudio = false;
  h.unlocked.mockReset().mockResolvedValue(true);
  h.audioRead.mockClear();
  h.audioStart.mockClear();
  h.audioStop.mockClear();
  h.hyprlandFrame.mockClear();
  h.hyprlandStop.mockClear();
  h.handlers.clear();
  h.screenHandlers.clear();
  h.geometryMatches.mockReset().mockReturnValue(true);
  h.windows.length = 0;
  h.source = null;
  h.lease = 'lease';
  h.dispose.mockClear();
  h.stop.mockClear();
  h.releaseControl.mockClear();
  h.nativeStop.mockClear();
  h.nativeFrame.mockClear();
  h.input.mockReset();
  h.viewHeartbeat.mockClear();
  // The host is constructed once at module load; keep its captured callback.
  h.releaseControl.mockClear();
  h.hostInput.mockReset();
  h.iceConfig.mockClear();
  registerRemoteDesktopIpc();
});
afterEach(() => {
  vi.restoreAllMocks();
  h.deps.stopVideo();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it.each([false, true])('only stops on added displays with privacy masks active=%s', (active) => {
  vi.spyOn(PrivacyScreen.prototype, 'active', 'get').mockReturnValue(active);
  h.screenHandlers.get('display-added')({}, { id: 2 });
  expect(h.stop).toHaveBeenCalledTimes(active ? 1 : 0);
});

it.each(['resolution', 'restoreResolution'])(
  'waits for native completion and projection on %s',
  async (method) => {
    const { setDesktopDisplayMode } = await import('../inputHost');
    let nativeDone!: () => void;
    let projected!: () => void;
    vi.mocked(setDesktopDisplayMode).mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        nativeDone = resolve;
      });
    });
    h.waitForGeometry.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        projected = resolve;
      });
    });
    const beforeChange = vi.fn();
    const settled = vi.fn();
    const expected = { width: 1920, height: 1080 };
    const pending = h.deps[method]('1', '1', beforeChange, expected).then(settled);
    expect(projected).toBeUndefined();
    nativeDone();
    for (let i = 0; i < 5; i++) await Promise.resolve();
    if (method === 'resolution') {
      expect(h.waitForGeometry).toHaveBeenLastCalledWith(
        '1',
        expected,
        beforeChange,
        expect.any(Function),
      );
      const present = h.waitForGeometry.mock.lastCall![3];
      expect(present([])).toBe(false);
      expect(present([{ id: 1 }])).toBe(true);
    } else expect(h.waitForGeometry).toHaveBeenLastCalledWith('1', expected, beforeChange);
    expect(settled).not.toHaveBeenCalled();
    projected();
    await pending;
    expect(settled).toHaveBeenCalledOnce();
  },
);

it.each([['scaleFactor'], ['bounds', 'scaleFactor'], ['bounds', 'workArea', 'scaleFactor']])(
  'keeps managed geometry after late display metrics %j',
  (...metrics) => {
    h.screenHandlers.get('display-metrics-changed')(
      {},
      { id: 1, size: { width: 1920, height: 1080 } },
      metrics,
    );
    expect(h.geometryMatches).toHaveBeenCalledWith('1', 1920, 1080);
    expect(h.stop).not.toHaveBeenCalled();
  },
);

it.each([
  [true, ['rotation']],
  [true, ['scaleFactor', 'rotation']],
  [false, ['scaleFactor']],
  [false, ['bounds', 'scaleFactor']],
])('stops on rotation or unmatched geometry (%s, %j)', (matches, metrics) => {
  h.geometryMatches.mockReturnValue(matches);
  h.screenHandlers.get('display-metrics-changed')(
    {},
    { id: 1, size: { width: 1920, height: 1080 } },
    metrics,
  );
  expect(h.stop).toHaveBeenCalledOnce();
});

it('joins resolution restoration through the shared asynchronous quit phase', async () => {
  const cleanup = h.quit.get('remote-desktop-restore')!;
  expect(cleanup.phase).toBe('async');
  let finish!: () => void;
  h.stopAndRestore.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const settled = vi.fn();
  const pending = Promise.resolve(cleanup.fn()).then(settled);
  await Promise.resolve();
  expect(settled).not.toHaveBeenCalled();
  finish();
  await pending;
  expect(settled).toHaveBeenCalledOnce();
});

it('bounds a stalled screen permission probe so the guide can finish its request', async () => {
  h.source = new Promise(() => {});
  const pending = h.permissionDeps.request(
    'screenRecording',
    () => true,
    new AbortController().signal,
  );
  const rejected = expect(pending).rejects.toThrow('DESKTOP_VIDEO_TIMEOUT');
  await vi.advanceTimersByTimeAsync(5000);
  await rejected;
  h.source = Promise.resolve([]);
  await expect(
    h.permissionDeps.request('screenRecording', () => true, new AbortController().signal),
  ).resolves.toBeUndefined();
  expect(h.stop).not.toHaveBeenCalled();
});

it('drops enumeration timeouts for one relay frame and resumes without stopping the host', async () => {
  vi.stubGlobal('process', { ...process, platform: 'linux' });
  h.source = new Promise(() => {});
  const pending = h.deps.frame('1', false);
  await vi.advanceTimersByTimeAsync(5000);
  await expect(pending).resolves.toBeNull();
  expect(h.stop).not.toHaveBeenCalled();
  h.source = Promise.resolve([]);
  await expect(h.deps.frame('1', false)).resolves.toBeNull();
  h.source = Promise.reject(new Error('DESKTOP_DISABLED'));
  await expect(h.deps.frame('1', false)).rejects.toThrow('DESKTOP_DISABLED');
});

it.each(['success', 'timeout'])(
  'keeps relay polls out of native preparation and resumes after %s',
  async (outcome) => {
    vi.stubGlobal('process', { ...process, platform: 'darwin' });
    let sourcesReady!: (sources: any[]) => void;
    h.source = new Promise((resolve) => {
      sourcesReady = resolve;
    });
    const pending = offer();
    const settled =
      outcome === 'success'
        ? expect(pending).resolves.toBe('answer')
        : expect(pending).rejects.toThrow('DESKTOP_VIDEO_TIMEOUT');
    expect(h.nativeStop).toHaveBeenCalled();
    await expect(h.deps.frame('1', true)).resolves.toBeNull();
    h.handlers.get(DESKTOP_LOCAL.REGISTER)(event());
    await flush();
    await expect(h.deps.frame('1', true)).resolves.toBeNull();
    sourcesReady([{ id: 'screen:1', display_id: '1' }]);
    await flush();
    await expect(h.deps.frame('1', true)).resolves.toBeNull();
    expect(h.nativeFrame).not.toHaveBeenCalled();
    await expect(h.handlers.get(DESKTOP_LOCAL.NATIVE_FRAME)(event(), 'lease')).resolves.toBe(
      'frame',
    );
    if (outcome === 'success') {
      const id = h.owner.send.mock.calls[0][1].id;
      h.handlers.get(DESKTOP_LOCAL.REPLY)(event(), id, 'answer');
    } else await vi.advanceTimersByTimeAsync(18_000);
    await settled;
    await h.deps.frame('1', true);
    expect(h.nativeFrame).toHaveBeenCalledTimes(2);
  },
);

it.each(['ready', 'sources'])(
  'revocation during %s prevents late capture from reviving the old offer',
  async (phase) => {
    let finish!: (sources: any[]) => void;
    if (phase === 'sources')
      h.source = new Promise((resolve) => {
        finish = resolve;
      });
    const pending = offer();
    const rejected = expect(pending).rejects.toThrow(/DESKTOP_(VIDEO_STOPPED|LEASE_EXPIRED)/);
    const old = h.owner;
    if (phase === 'sources') {
      h.handlers.get(DESKTOP_LOCAL.REGISTER)(event());
      await flush();
    }
    h.lease = 'replacement';
    h.deps.stopVideo();
    if (finish) finish([{ id: 'screen:1', display_id: '1' }]);
    old.ready();
    await rejected;
    expect(old.dead).toBe(true);
    expect(old.send).not.toHaveBeenCalled();
    expect(h.owner).toBeNull();
  },
);

it('denies main/child-frame capture IPC and forces disposal on offer timeout', async () => {
  const pending = offer();
  const rejected = expect(pending).rejects.toThrow('DESKTOP_VIDEO_TIMEOUT');
  const owner = h.owner;
  h.handlers.get(DESKTOP_LOCAL.REGISTER)(event());
  await flush();
  for (const key of [
    DESKTOP_LOCAL.REGISTER,
    DESKTOP_LOCAL.REPLY,
    DESKTOP_LOCAL.INPUT,
    DESKTOP_LOCAL.VIEW_HEARTBEAT,
    DESKTOP_LOCAL.CAPTURE_STOP,
  ]) {
    for (const caller of [event({ mainFrame: {} }), { sender: owner, senderFrame: {} }])
      expect(() => h.handlers.get(key)(caller, 'lease')).toThrow('PERMISSION_DENIED');
  }
  await expect(
    h.handlers.get(DESKTOP_LOCAL.NATIVE_FRAME)(event({ mainFrame: {} }), 'lease'),
  ).rejects.toThrow('PERMISSION_DENIED');
  expect(owner.send).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(18_000);
  await rejected;
  expect(owner.dead).toBe(true);
  expect(h.nativeStop).toHaveBeenCalled();
});

it('drops view-only input without breaking heartbeats, but still rejects invalid or revoked input', async () => {
  const pending = offer();
  h.handlers.get(DESKTOP_LOCAL.REGISTER)(event());
  await flush();
  h.handlers.get(DESKTOP_LOCAL.REPLY)(event(), h.owner.send.mock.calls[0][1].id, 'answer');
  await pending;
  const input = h.handlers.get(DESKTOP_LOCAL.INPUT);
  h.input.mockImplementation(() => {
    throw new Error('DESKTOP_VIEW_ONLY');
  });
  expect(() => input(event(), 'lease', 1, [{ type: 'release' }])).not.toThrow();
  h.handlers.get(DESKTOP_LOCAL.VIEW_HEARTBEAT)(event(), 'lease');
  expect(h.viewHeartbeat).toHaveBeenCalledWith('lease');
  expect(h.owner.dead).toBe(false);
  expect(() => input(event(), 'old-lease', 2, [])).toThrow('PERMISSION_DENIED');
  for (const reason of [
    'DESKTOP_STOPPED',
    'DESKTOP_LEASE_EXPIRED',
    'INVALID_REQUEST',
    'DESKTOP_INPUT_UNAVAILABLE',
  ]) {
    h.input.mockImplementation(() => {
      throw new Error(reason);
    });
    expect(() => input(event(), 'lease', 2, [])).toThrow('PERMISSION_DENIED');
  }
});

it('turns an input-helper failure into a control release instead of a session stop', async () => {
  const pending = offer();
  h.handlers.get(DESKTOP_LOCAL.REGISTER)(event());
  await flush();
  h.handlers.get(DESKTOP_LOCAL.REPLY)(event(), h.owner.send.mock.calls[0][1].id, 'answer');
  await pending;
  expect(h.inputFailure).toBeTypeOf('function');
  h.inputFailure?.();
  // Input is a lease-scoped capability: the desktop session keeps its lease,
  // its capture owner and its media when the helper dies.
  expect(h.releaseControl).toHaveBeenCalledTimes(1);
  expect(h.stop).not.toHaveBeenCalled();
  expect(h.owner.dead).toBe(false);
});

it('releases control when the input host refuses a batch before injecting it', () => {
  h.hostInput.mockImplementationOnce(() => {
    throw new Error('DESKTOP_INPUT_UNAVAILABLE');
  });
  // The refusal still reaches its caller, but control no longer stays set: a
  // later take-control must actually restart the helper.
  expect(() => h.deps.input([{ kind: 'release' }])).toThrow('DESKTOP_INPUT_UNAVAILABLE');
  expect(h.releaseControl).toHaveBeenCalledTimes(1);
  expect(h.stop).not.toHaveBeenCalled();
});

it('retains the capture owner on ICE timeout and rejects old-owner replies after replacement', async () => {
  const pending = offer();
  h.handlers.get(DESKTOP_LOCAL.REGISTER)(event());
  await flush();
  const old = h.owner;
  const id = old.send.mock.calls[0][1].id;
  h.handlers.get(DESKTOP_LOCAL.REPLY)(event(), id, 'answer');
  await expect(pending).resolves.toBe('answer');
  const ice = h.deps.ice({
    op: 'ice',
    lease: 'lease',
    attemptId: 'attempt',
    after: 0,
    candidates: [],
  });
  const rejected = expect(ice).rejects.toThrow('DESKTOP_VIDEO_TIMEOUT');
  await vi.advanceTimersByTimeAsync(4000);
  await rejected;
  expect(old.dead).toBe(false);
  const next = offer();
  const nextRejected = expect(next).rejects.toThrow('DESKTOP_VIDEO_STOPPED');
  expect(old.dead).toBe(true);
  expect(() => h.handlers.get(DESKTOP_LOCAL.REPLY)(event(old), id, 'late answer')).toThrow(
    'PERMISSION_DENIED',
  );
  expect(h.owner.dead).toBe(false);
  h.deps.stopVideo();
  await nextRejected;
});

it('passes freshly fetched ICE credentials only to the active capture owner', async () => {
  const pending = offer();
  h.handlers.get(DESKTOP_LOCAL.REGISTER)(event());
  await flush();
  const command = h.owner.send.mock.calls[0][1];
  expect(command.iceServers).toEqual(await h.iceConfig());
  h.handlers.get(DESKTOP_LOCAL.REPLY)(event(), command.id, 'answer');
  await pending;
});

it('revocation while fetching ICE config prevents a late credential from starting capture', async () => {
  let finish!: (servers: any[]) => void;
  h.iceConfig.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = offer();
  const rejected = expect(pending).rejects.toThrow('DESKTOP_LEASE_EXPIRED');
  const old = h.owner;
  h.handlers.get(DESKTOP_LOCAL.REGISTER)(event());
  await flush();
  h.deps.stopVideo();
  finish([]);
  await rejected;
  expect(old.send).not.toHaveBeenCalled();
});

it('keeps replacement capture and its in-flight ICE exchange when revoked config arrives late', async () => {
  let finish!: (servers: any[]) => void;
  h.iceConfig.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = offer();
  const rejected = expect(pending).rejects.toThrow('DESKTOP_LEASE_EXPIRED');
  const old = h.owner;
  h.handlers.get(DESKTOP_LOCAL.REGISTER)(event());
  await flush();
  h.deps.stopVideo();
  h.lease = 'replacement';
  const next = offer();
  h.handlers.get(DESKTOP_LOCAL.REGISTER)(event());
  await flush();
  const owner = h.owner;
  const command = owner.send.mock.calls[0][1];
  h.handlers.get(DESKTOP_LOCAL.REPLY)(event(), command.id, 'new-answer');
  await expect(next).resolves.toBe('new-answer');
  const ice = h.deps.ice({
    op: 'ice',
    lease: 'replacement',
    attemptId: 'attempt',
    after: 0,
    candidates: [],
  });
  const exchange = owner.send.mock.calls.at(-1)[1];
  finish([]);
  await rejected;
  expect(old.send).not.toHaveBeenCalled();
  expect(h.owner).toBe(owner);
  expect(owner.dead).toBe(false);
  const reply = { attemptId: 'attempt', candidates: [], next: 0, complete: true };
  h.handlers.get(DESKTOP_LOCAL.REPLY)(event(), exchange.id, reply);
  await expect(ice).resolves.toEqual(reply);
});
it('routes native input failure to control release rather than capture teardown', () => {
  h.inputFailure?.();
  expect(h.releaseControl).toHaveBeenCalledOnce();
  expect(h.stop).not.toHaveBeenCalled();
  expect(h.dispose).not.toHaveBeenCalled();
});

it.each(['darwin', 'win32'])(
  'negotiates cursor-free capture on %s only when requested',
  async (platform) => {
    vi.stubGlobal('process', { ...process, platform });
    expect((await h.deps.capabilities()).cursorOverlay).toBe(true);
    for (const overlay of [false, true]) {
      const pending = h.deps.offer(
        { lease: h.lease, display: { id: '1' } },
        'sdp',
        undefined,
        overlay,
        'attempt',
      );
      h.handlers.get(DESKTOP_LOCAL.REGISTER)(event());
      await flush();
      const command = h.owner.send.mock.calls[0][1];
      expect(command.cursorOverlay).toBe(overlay);
      expect(command.nativeCapture).toBe(true);
      h.handlers.get(DESKTOP_LOCAL.REPLY)(event(), command.id, 'answer');
      await pending;
      await h.handlers.get(DESKTOP_LOCAL.NATIVE_FRAME)(event(), h.lease);
      expect(h.nativeFrame).toHaveBeenLastCalledWith('1', overlay, undefined);
      await h.deps.frame('1', overlay);
      expect(h.nativeFrame).toHaveBeenLastCalledWith('1', overlay, undefined);
    }
  },
);

it('does not advertise or select Windows overlays without a ready native service', async () => {
  vi.stubGlobal('process', { ...process, platform: 'win32' });
  const { readWindowsDesktopSupport } = await import('../windowsHost');
  vi.mocked(readWindowsDesktopSupport)
    .mockResolvedValueOnce('missing')
    .mockResolvedValueOnce('missing');
  expect((await h.deps.capabilities()).cursorOverlay).toBe(false);
  const pending = h.deps.offer(
    { lease: h.lease, display: { id: '1' } },
    'sdp',
    undefined,
    true,
    'attempt',
  );
  h.handlers.get(DESKTOP_LOCAL.REGISTER)(event());
  await flush();
  const command = h.owner.send.mock.calls[0][1];
  expect(command.cursorOverlay).toBe(false);
  expect(command.nativeCapture).toBe(false);
  h.handlers.get(DESKTOP_LOCAL.REPLY)(event(), command.id, 'answer');
  await pending;
});

it('keeps Wayland authorization and relay frames alive across bounded offer retries', async () => {
  h.wayland = true;
  const frame = h.deps.frame('wayland-portal', false, 'lease');
  h.handlers.get(DESKTOP_LOCAL.REGISTER)(event());
  await flush();
  const owner = h.owner;
  expect(owner.send.mock.calls[0][1]).toMatchObject({ op: 'prepare', lease: 'lease' });
  h.handlers.get(DESKTOP_LOCAL.REPLY)(event(), owner.send.mock.calls.at(-1)[1].id, null);
  await expect(frame).resolves.toBeNull();
  const offer = h.deps.offer({ lease: 'lease', display: { id: 'wayland-portal' } }, 'sdp');
  const rejected = expect(offer).rejects.toThrow('DESKTOP_VIDEO_TIMEOUT');
  await flush();
  h.handlers.get(DESKTOP_LOCAL.REPLY)(event(), owner.send.mock.calls.at(-1)[1].id, 'anBlZw==');
  await flush();
  await vi.advanceTimersByTimeAsync(18_000);
  await rejected;
  expect(owner.dead).toBe(false);
  expect(owner.send.mock.calls.at(-1)[1]).toMatchObject({ op: 'stop' });
  const fallback = h.deps.frame('wayland-portal', false, 'lease');
  await flush();
  h.handlers.get(DESKTOP_LOCAL.REPLY)(event(), owner.send.mock.calls.at(-1)[1].id, 'anBlZw==');
  await expect(fallback).resolves.toBe('anBlZw==');
  expect(h.windows).toHaveLength(1);
  expect(
    owner.send.mock.calls.filter(
      ([, command]: [string, DesktopHostCommand]) => command.op === 'prepare',
    ),
  ).toHaveLength(1);
  h.deps.stopVideo();
  expect(owner.dead).toBe(true);
});

it('only grants the system-selected Wayland surface once, and never to a replacement lease', async () => {
  h.wayland = true;
  let select!: (sources: any[]) => void;
  h.source = new Promise((resolve) => {
    select = resolve;
  });
  const frame = h.deps.frame('wayland-portal', false, 'lease');
  const rejected = expect(frame).rejects.toThrow('DESKTOP_VIDEO_STOPPED');
  h.handlers.get(DESKTOP_LOCAL.REGISTER)(event());
  await flush();
  const owner = h.owner;
  const handler = owner.session.setDisplayMediaRequestHandler.mock.calls[0][0];
  const callback = vi.fn();
  handler({ frame: owner.mainFrame, videoRequested: true, audioRequested: false }, callback);
  expect(callback).not.toHaveBeenCalled();
  const duplicate = vi.fn();
  handler({ frame: owner.mainFrame, videoRequested: true, audioRequested: false }, duplicate);
  expect(duplicate).toHaveBeenCalledWith({});
  h.deps.stopVideo();
  h.lease = 'replacement';
  let selectReplacement!: (sources: any[]) => void;
  h.source = new Promise((resolve) => {
    selectReplacement = resolve;
  });
  const replacementFrame = h.deps.frame('wayland-portal', false, 'replacement');
  h.handlers.get(DESKTOP_LOCAL.REGISTER)(event());
  await flush();
  const replacementOwner = h.owner;
  const replacementHandler =
    replacementOwner.session.setDisplayMediaRequestHandler.mock.calls[0][0];
  const replacementCallback = vi.fn();
  replacementHandler(
    { frame: replacementOwner.mainFrame, videoRequested: true, audioRequested: false },
    replacementCallback,
  );
  expect(replacementCallback).not.toHaveBeenCalled();
  select([{ id: 'screen:0:0', display_id: '' }]);
  await flush();
  await rejected;
  expect(callback).toHaveBeenCalledExactlyOnceWith({});
  expect(owner.dead).toBe(true);
  const source = { id: 'screen:1:0', display_id: '' };
  selectReplacement([source]);
  await flush();
  expect(replacementCallback).toHaveBeenCalledExactlyOnceWith({ video: source });
  h.handlers.get(DESKTOP_LOCAL.REPLY)(event(), replacementOwner.send.mock.calls.at(-1)[1].id, null);
  await replacementFrame;
});

it('accepts empty PipeWire display IDs only through the authorized portal selection', async () => {
  h.wayland = true;
  const source = { id: 'screen:0:0', display_id: '' };
  h.source = Promise.resolve([source]);
  const frame = h.deps.frame('wayland-portal', false, 'lease');
  h.handlers.get(DESKTOP_LOCAL.REGISTER)(event());
  await flush();
  const owner = h.owner;
  const handler = owner.session.setDisplayMediaRequestHandler.mock.calls[0][0];
  const denied = vi.fn();
  handler({ frame: {}, videoRequested: true }, denied);
  expect(denied).toHaveBeenCalledWith({});
  const callback = vi.fn();
  handler({ frame: owner.mainFrame, videoRequested: true, audioRequested: false }, callback);
  await flush();
  expect(callback).toHaveBeenCalledExactlyOnceWith({ video: source });
  h.handlers.get(DESKTOP_LOCAL.REPLY)(event(), owner.send.mock.calls.at(-1)[1].id, null);
  await frame;
});

it('settles a Wayland offer timeout even if its capture owner disappears before peer cleanup', async () => {
  h.wayland = true;
  const pending = h.deps.offer({ lease: 'lease', display: { id: 'wayland-portal' } }, 'sdp');
  const rejected = expect(pending).rejects.toThrow('DESKTOP_VIDEO_TIMEOUT');
  h.handlers.get(DESKTOP_LOCAL.REGISTER)(event());
  await flush();
  const owner = h.owner;
  h.handlers.get(DESKTOP_LOCAL.REPLY)(event(), owner.send.mock.calls.at(-1)[1].id, 'anBlZw==');
  await flush();
  owner.send.mockImplementation(() => {
    throw new Error('destroyed');
  });
  await vi.advanceTimersByTimeAsync(18_000);
  await rejected;
  expect(owner.dead).toBe(true);
});

it('keeps consent outside the offer timeout and starts video after a late selection', async () => {
  h.wayland = true;
  const lease = { lease: 'lease', display: { id: 'wayland-portal' } };
  const waiting = h.deps.offer(lease, 'sdp');
  const rejected = expect(waiting).rejects.toThrow('DESKTOP_CAPTURE_PENDING');
  h.handlers.get(DESKTOP_LOCAL.REGISTER)(event());
  await flush();
  const owner = h.owner;
  h.handlers.get(DESKTOP_LOCAL.REPLY)(event(), owner.send.mock.calls.at(-1)[1].id, null);
  await rejected;
  await vi.advanceTimersByTimeAsync(90_000);
  expect(owner.dead).toBe(false);
  expect(
    owner.send.mock.calls.some(
      ([, command]: [string, DesktopHostCommand]) => command.op === 'offer',
    ),
  ).toBe(false);
  const next = h.deps.offer(lease, 'sdp');
  await flush();
  h.handlers.get(DESKTOP_LOCAL.REPLY)(event(), owner.send.mock.calls.at(-1)[1].id, 'anBlZw==');
  await flush();
  expect(owner.send.mock.calls.at(-1)[1].op).toBe('offer');
  h.handlers.get(DESKTOP_LOCAL.REPLY)(event(), owner.send.mock.calls.at(-1)[1].id, 'answer');
  await expect(next).resolves.toBe('answer');
  expect(h.windows).toHaveLength(1);
});

it('uses native Hyprland capture for video and relay without opening a portal picker', async () => {
  h.wayland = h.hyprland = true;
  // Source enumeration would never resolve: neither transport may depend on it.
  h.source = new Promise(() => {});
  await expect(h.deps.frame('wayland-portal', false, 'lease')).resolves.toBe('anBlZw==');
  expect(h.windows).toHaveLength(0);
  await expect(h.deps.frame('wayland-portal', false, 'wrong')).rejects.toThrow(
    'DESKTOP_LEASE_EXPIRED',
  );
  expect(h.hyprlandFrame).toHaveBeenCalledTimes(1);
  const result = h.deps.offer({ lease: 'lease', display: { id: 'wayland-portal' } }, 'sdp');
  h.handlers.get(DESKTOP_LOCAL.REGISTER)(event());
  await flush();
  const command = h.owner.send.mock.calls.at(-1)[1];
  expect(command).toMatchObject({
    op: 'offer',
    nativeCapture: true,
    continuousNativeCapture: true,
  });
  expect(() => structuredClone(command)).not.toThrow();
  expect(command.portalCapture).toBeUndefined();
  await expect(h.handlers.get(DESKTOP_LOCAL.NATIVE_FRAME)(event(), 'lease')).resolves.toBe(
    'anBlZw==',
  );
  h.handlers.get(DESKTOP_LOCAL.REPLY)(event(), command.id, 'answer');
  await expect(result).resolves.toBe('answer');
  h.deps.stopVideo();
  expect(h.hyprlandStop).toHaveBeenCalled();
});

it('advertises native Wayland geometry to existing viewers without a 16:9 placeholder', async () => {
  h.wayland = h.hyprland = true;
  const settings = await import('../../device-link/settings-store');
  const { screen } = await import('electron');
  vi.spyOn(settings, 'readDeviceLinkSettings').mockReturnValue({
    remoteDesktopEnabled: true,
    remoteControlEnabled: true,
  } as any);
  vi.spyOn(screen, 'getAllDisplays').mockReturnValue([
    { id: 1, bounds: { x: 0, y: 0, width: 1600, height: 1000 } },
  ] as any);
  expect((await h.deps.capabilities()).displays).toEqual([
    { id: 'hyprland:eDP-2', name: 'eDP-2', width: 1600, height: 1000 },
  ]);
});

it.each([true, false])(
  'advertises Linux control only after the native protocol probe succeeds: %s',
  async (supported) => {
    const platform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux' });
    try {
      h.wayland = h.hyprland = true;
      h.linuxInput = supported;
      const settings = await import('../../device-link/settings-store');
      const { screen } = await import('electron');
      vi.spyOn(settings, 'readDeviceLinkSettings').mockReturnValue({
        remoteDesktopEnabled: true,
        remoteControlEnabled: true,
      } as any);
      vi.spyOn(screen, 'getAllDisplays').mockReturnValue([
        { id: 1, bounds: { x: 0, y: 0, width: 1600, height: 1000 } },
      ] as any);
      expect((await h.deps.capabilities()).canControl).toBe(supported);
    } finally {
      Object.defineProperty(process, 'platform', { value: platform });
    }
  },
);

it.each([false, true])(
  'refuses native input outside the full Hyprland surface: %s',
  async (hyprland) => {
    const platform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux' });
    try {
      h.wayland = true;
      h.hyprland = hyprland;
      h.linuxInput = !hyprland;
      h.startInput.mockClear();
      await expect(h.deps.startInput('wayland-portal')).rejects.toThrow(
        'DESKTOP_INPUT_UNSUPPORTED',
      );
      expect(h.startInput).not.toHaveBeenCalled();
      h.hyprland = h.linuxInput = true;
      await h.deps.startInput('wayland-portal');
      expect(h.startInput).toHaveBeenCalledExactlyOnceWith('wayland-portal');
    } finally {
      Object.defineProperty(process, 'platform', { value: platform });
    }
  },
);

it('binds Linux audio to the exact capture window, opted-in video lease and stop', async () => {
  h.wayland = h.hyprland = h.linuxAudio = true;
  const result = h.deps.offer({ lease: 'lease', display: { id: 'wayland-portal' } }, 'sdp', {
    audio: true,
  });
  h.handlers.get(DESKTOP_LOCAL.REGISTER)(event());
  await flush();
  const command = h.owner.send.mock.calls.at(-1)[1];
  expect(command.nativeAudio).toBe(true);
  expect(h.audioStart).toHaveBeenCalledOnce();
  const read = h.handlers.get(DESKTOP_LOCAL.NATIVE_AUDIO);
  await expect(read(event(), 'lease')).resolves.toHaveLength(8);
  h.unlocked.mockResolvedValue(false);
  h.audioStop.mockClear();
  await expect(read(event(), 'lease')).rejects.toThrow('PERMISSION_DENIED');
  expect(h.audioStop).toHaveBeenCalledOnce();
  await expect(read(event({ mainFrame: {} }), 'lease')).rejects.toThrow('PERMISSION_DENIED');
  await expect(read(event(), 'old-lease')).rejects.toThrow('PERMISSION_DENIED');
  h.handlers.get(DESKTOP_LOCAL.REPLY)(event(), command.id, 'answer');
  await result;
  const owner = h.owner;
  h.deps.stopVideo();
  expect(h.audioStop).toHaveBeenCalled();
  await expect(read(event(owner), 'lease')).rejects.toThrow('PERMISSION_DENIED');
  expect(h.audioRead).toHaveBeenCalledOnce();
});

it('does not start Linux audio while locked or unknown, and denies samples after locking', async () => {
  h.wayland = h.hyprland = h.linuxAudio = true;
  h.unlocked.mockResolvedValue(false);
  const result = h.deps.offer({ lease: 'lease', display: { id: 'wayland-portal' } }, 'sdp', {
    audio: true,
  });
  h.handlers.get(DESKTOP_LOCAL.REGISTER)(event());
  await flush();
  expect(h.audioStart).not.toHaveBeenCalled();
  const command = h.owner.send.mock.calls.at(-1)[1];
  h.handlers.get(DESKTOP_LOCAL.REPLY)(event(), command.id, 'answer');
  await result;
  const read = h.handlers.get(DESKTOP_LOCAL.NATIVE_AUDIO);
  await expect(read(event(), 'lease')).rejects.toThrow('PERMISSION_DENIED');
  expect(h.audioRead).not.toHaveBeenCalled();
  h.audioStop.mockClear();
  h.powerHandlers.get('lock-screen')!();
  expect(h.audioStop).toHaveBeenCalledOnce();
  h.powerHandlers.get('unlock-screen')!();
  expect(h.audioStop).toHaveBeenCalledTimes(2);
  expect(h.audioStart).not.toHaveBeenCalled();
});

it('does not read or stop replacement Linux audio after a delayed lock check', async () => {
  h.wayland = h.hyprland = h.linuxAudio = true;
  const result = h.deps.offer({ lease: 'lease', display: { id: 'wayland-portal' } }, 'sdp', {
    audio: true,
  });
  h.handlers.get(DESKTOP_LOCAL.REGISTER)(event());
  await flush();
  const command = h.owner.send.mock.calls.at(-1)[1];
  h.handlers.get(DESKTOP_LOCAL.REPLY)(event(), command.id, 'answer');
  await result;
  let resolve!: (value: boolean) => void;
  h.unlocked.mockImplementationOnce(
    () =>
      new Promise<boolean>((done) => {
        resolve = done;
      }),
  );
  const pending = h.handlers.get(DESKTOP_LOCAL.NATIVE_AUDIO)(event(), 'lease');
  h.deps.stopVideo();
  h.audioStop.mockClear();
  resolve(false);
  await expect(pending).rejects.toThrow('PERMISSION_DENIED');
  expect(h.audioStop).not.toHaveBeenCalled();
  expect(h.audioRead).not.toHaveBeenCalled();
});

it.each(['unlock', 'relock', 'stop'])(
  'resumes Linux audio only for a still-current confirmed unlock: %s',
  async (outcome) => {
    h.wayland = h.hyprland = h.linuxAudio = true;
    const result = h.deps.offer({ lease: 'lease', display: { id: 'wayland-portal' } }, 'sdp', {
      audio: true,
    });
    h.handlers.get(DESKTOP_LOCAL.REGISTER)(event());
    await flush();
    const command = h.owner.send.mock.calls.at(-1)[1];
    h.handlers.get(DESKTOP_LOCAL.REPLY)(event(), command.id, 'answer');
    await result;
    h.audioStart.mockClear();
    let resolve!: (value: boolean) => void;
    h.unlocked.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    h.powerHandlers.get('unlock-screen')!();
    if (outcome === 'relock') h.powerHandlers.get('lock-screen')!();
    if (outcome === 'stop') h.deps.stopVideo();
    resolve(true);
    await flush();
    if (outcome === 'unlock') {
      expect(h.audioStart).toHaveBeenCalledOnce();
      expect(h.owner.send.mock.calls.at(-1)[1]).toMatchObject({
        op: 'capture-reset',
        lease: 'lease',
        nativeAudio: true,
      });
    } else expect(h.audioStart).not.toHaveBeenCalled();
  },
);

it.each([true, false])(
  'bounds same-screen audio recovery after the initial grant was consumed=%s',
  async (consumed) => {
    const pending = h.deps.offer(
      { lease: h.lease, display: { id: '1' } },
      'sdp',
      { audio: true, fps: 30, bitrate: 0 },
      true,
      'attempt',
    );
    h.handlers.get(DESKTOP_LOCAL.REGISTER)(event());
    await flush();
    const owner = h.owner;
    const grant = owner.session.setDisplayMediaRequestHandler.mock.calls[0][0];
    const callback = vi.fn();
    const request = { frame: owner.mainFrame, videoRequested: true, audioRequested: true };
    if (consumed) {
      grant(request, callback);
      expect(callback).toHaveBeenLastCalledWith({
        video: { id: 'screen:1', display_id: '1' },
        audio: 'loopback',
      });
    }
    h.handlers.get(DESKTOP_LOCAL.REPLY)(event(), owner.send.mock.calls[0][1].id, 'answer');
    await pending;
    // An OS denial can happen before the first display grant is consumed.
    // The answered video lease still permits only bounded audio recovery.
    for (const invalid of [
      { ...request, frame: {} },
      { ...request, audioRequested: false },
      { ...request, videoRequested: false },
    ]) {
      grant(invalid, callback);
      expect(callback).toHaveBeenLastCalledWith({});
    }
    for (let i = consumed ? 1 : 0; i < 1 + DESKTOP_AUDIO_RETRY_MS.length; i++) {
      grant(request, callback);
      expect(callback).toHaveBeenLastCalledWith({
        video: { id: 'screen:1', display_id: '1' },
        audio: 'loopback',
      });
    }
    grant(request, callback);
    expect(callback).toHaveBeenLastCalledWith({});
    expect(owner.dead).toBe(false);
  },
);

it('revokes audio recovery with the lease and never grants it to an audio-off replacement', async () => {
  const pending = h.deps.offer(
    { lease: h.lease, display: { id: '1' } },
    'sdp',
    { audio: true, fps: 30, bitrate: 0 },
    true,
    'attempt',
  );
  h.handlers.get(DESKTOP_LOCAL.REGISTER)(event());
  await flush();
  const oldOwner = h.owner;
  const oldGrant = oldOwner.session.setDisplayMediaRequestHandler.mock.calls[0][0];
  h.handlers.get(DESKTOP_LOCAL.REPLY)(event(), oldOwner.send.mock.calls[0][1].id, 'answer');
  await pending;
  h.lease = 'replacement';
  const callback = vi.fn();
  const oldRequest = { frame: oldOwner.mainFrame, videoRequested: true, audioRequested: true };
  oldGrant(oldRequest, callback);
  expect(callback).toHaveBeenLastCalledWith({});
  const replacement = offer();
  h.handlers.get(DESKTOP_LOCAL.REGISTER)(event());
  await flush();
  const owner = h.owner;
  const grant = owner.session.setDisplayMediaRequestHandler.mock.calls[0][0];
  oldGrant(oldRequest, callback);
  expect(callback).toHaveBeenLastCalledWith({});
  const request = { ...oldRequest, frame: owner.mainFrame };
  grant(request, callback);
  expect(callback).toHaveBeenLastCalledWith({ video: { id: 'screen:1', display_id: '1' } });
  h.handlers.get(DESKTOP_LOCAL.REPLY)(event(), owner.send.mock.calls[0][1].id, 'answer');
  await replacement;
  grant(request, callback);
  expect(callback).toHaveBeenLastCalledWith({});
  expect(owner.dead).toBe(false);
});
