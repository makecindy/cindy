import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DESKTOP_LOCAL } from '../../../shared/remoteDesktop';

const h = vi.hoisted(() => ({
  handlers: new Map<string, any>(),
  windows: [] as any[],
  deps: null as any,
  permissionDeps: null as any,
  lease: 'lease',
  ready: false,
  source: null as null | Promise<any[]>,
  owner: null as any,
  dispose: vi.fn(),
  stop: vi.fn(),
  releaseControl: vi.fn(),
  inputFailure: null as null | (() => void),
  nativeStop: vi.fn(),
  nativeFrame: vi.fn(async () => 'frame'),
  input: vi.fn(),
  viewHeartbeat: vi.fn(),
  hostInput: vi.fn(),
  iceConfig: vi.fn(async (): Promise<any[]> => [
    { urls: ['turn:relay.example.test:3478'], username: 'temporary', credential: 'test-only' },
  ]),
}));
vi.mock('../iceConfig', () => ({ loadDesktopIceServers: h.iceConfig }));
vi.mock('electron', () => ({
  app: { on: vi.fn() },
  powerMonitor: { on: vi.fn() },
  shell: {},
  nativeImage: {},
  screen: { on: vi.fn(), getAllDisplays: () => [{ id: 1 }] },
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
  DesktopInputHost: class {
    constructor(onFailure: () => void) {
      h.inputFailure = onFailure;
    }
    stop = vi.fn();
    input = h.hostInput;
  },
  readDesktopDisplayModes: vi.fn(),
  setDesktopDisplayMode: vi.fn(),
  readDesktopInputPermission: vi.fn(),
  requestDesktopInputPermission: vi.fn(),
}));
vi.mock('../permissions', () => ({
  RemoteDesktopPermissionsService: class {
    constructor(deps: any) { h.permissionDeps = deps; }
    dismiss() {}
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
const event = (owner = h.owner) => ({ sender: owner, senderFrame: owner.mainFrame });
const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
const offer = () =>
  h.deps.offer({ lease: h.lease, display: { id: '1' } }, 'sdp', undefined, false, 'attempt');
beforeEach(() => {
  vi.useFakeTimers();
  h.handlers.clear();
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
  h.deps.stopVideo();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('bounds a stalled screen permission probe so the guide can finish its request', async () => {
  h.source = new Promise(() => {});
  const pending = h.permissionDeps.request('screenRecording', () => true, new AbortController().signal);
  const rejected = expect(pending).rejects.toThrow('DESKTOP_VIDEO_TIMEOUT');
  await vi.advanceTimersByTimeAsync(5000);
  await rejected;
  h.source = Promise.resolve([]);
  await expect(h.permissionDeps.request('screenRecording', () => true, new AbortController().signal)).resolves.toBeUndefined();
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

it.each(['success', 'timeout'])('keeps relay polls out of native preparation and resumes after %s', async (outcome) => {
  vi.stubGlobal('process', { ...process, platform: 'darwin' });
  let sourcesReady!: (sources: any[]) => void;
  h.source = new Promise((resolve) => { sourcesReady = resolve; });
  const pending = offer();
  const settled = outcome === 'success'
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
  await expect(h.handlers.get(DESKTOP_LOCAL.NATIVE_FRAME)(event(), 'lease')).resolves.toBe('frame');
  if (outcome === 'success') {
    const id = h.owner.send.mock.calls[0][1].id;
    h.handlers.get(DESKTOP_LOCAL.REPLY)(event(), id, 'answer');
  } else await vi.advanceTimersByTimeAsync(18_000);
  await settled;
  await h.deps.frame('1', true);
  expect(h.nativeFrame).toHaveBeenCalledTimes(2);
});

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
  h.input.mockImplementation(() => { throw new Error('DESKTOP_VIEW_ONLY'); });
  expect(() => input(event(), 'lease', 1, [{ type: 'release' }])).not.toThrow();
  h.handlers.get(DESKTOP_LOCAL.VIEW_HEARTBEAT)(event(), 'lease');
  expect(h.viewHeartbeat).toHaveBeenCalledWith('lease');
  expect(h.owner.dead).toBe(false);
  expect(() => input(event(), 'old-lease', 2, [])).toThrow('PERMISSION_DENIED');
  for (const reason of ['DESKTOP_STOPPED', 'DESKTOP_LEASE_EXPIRED', 'INVALID_REQUEST', 'DESKTOP_INPUT_UNAVAILABLE']) {
    h.input.mockImplementation(() => { throw new Error(reason); });
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
  h.iceConfig.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
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
    op: 'ice', lease: 'replacement', attemptId: 'attempt', after: 0, candidates: [],
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
