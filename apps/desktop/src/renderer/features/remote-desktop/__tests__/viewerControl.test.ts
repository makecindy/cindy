import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type {
  RememberedViewerResolution,
  RemoteDesktopViewerApi,
  RemoteViewerChannelRequest,
} from '../../../../shared/remoteDesktopViewer';
import { DesktopViewerController, type ViewerSnapshot } from '../viewerController';

const runtime = vi.hoisted(() => ({
  post: null as ((message: Record<string, unknown>) => void) | null,
  receive: vi.fn(),
}));
vi.mock('@cindy/maker-shared/remote-desktop-viewer', () => ({
  mountRemoteDesktopViewer: (_root: HTMLElement, post: typeof runtime.post) => {
    runtime.post = post;
    return { receive: runtime.receive, dispose: vi.fn() };
  },
}));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
let controller: DesktopViewerController;
let snapshot: ViewerSnapshot;
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
});
afterEach(() => {
  controller?.dispose();
  vi.useRealTimers();
});
async function fixture(
  firstControl?: Promise<{ controlling: boolean }>,
  resolutionRestore = false,
  options: {
    caps?: Record<string, unknown>;
    remembered?: RememberedViewerResolution | null;
    root?: { clientWidth: number; clientHeight: number };
    api?: Partial<RemoteDesktopViewerApi>;
  } = {},
) {
  const control = vi.fn(async (enabled: boolean) => ({ controlling: enabled }));
  if (firstControl) control.mockImplementationOnce(() => firstControl);
  const heartbeat = vi.fn(async () => ({ controlling: true }));
  const clipboard = vi.fn(async () => {});
  const resolution = vi.fn(async (modeId: string) => ({
    lease: 'lease',
    controlling: false,
    display:
      modeId === 'hd'
        ? { id: 'one', width: 1920, height: 1080 }
        : { id: 'one', width: 3840, height: 2160 },
  }));
  let remembered = options.remembered ?? null;
  const memory = vi.fn(
    async (
      _generation: number,
      _displayId: string,
      value?: RememberedViewerResolution | null,
    ) => {
      if (value !== undefined) remembered = value;
      return remembered;
    },
  );
  const api = {
    state: async () => ({
      generation: 1,
      active: true,
      target: { deviceId: 'host', name: 'Computer' },
    }),
    onActive: () => () => {},
    onLocale: () => () => {},
    onCloseRequested: () => () => {},
    ice: async () => [],
    clipboard,
    close: async () => {},
    fullscreen: async () => {},
    resize: async () => {},
    rendererReady: async () => {},
    presentationReady: async () => {},
    inputFocus: async () => {},
    request: async (_generation, request) => {
      switch (request.op) {
        case 'capabilities':
          return {
            version: 1,
            enabled: true,
            canControl: true,
            viewerDisplay: true,
            viewerDisplayRestore: true,
            resolutionRestore,
            clipboardText: true,
            automaticReconnect: true,
            displays: [{ id: 'one', name: 'Display', width: 1280, height: 720 }],
            ...options.caps,
          };
        case 'start':
          return {
            lease: 'lease',
            controlling: request.control === true,
            display: { id: 'one', width: 1280, height: 720 },
          };
        case 'control':
          return control(request.enabled);
        case 'heartbeat':
          return heartbeat();
        case 'displayModes':
          return [
            { id: '640', width: 640, height: 1242, current: false },
            { id: '4k', width: 3840, height: 2160, current: false },
          ];
        case 'resolution':
          return resolution(request.modeId);
        case 'viewerDisplay':
          return {
            lease: 'lease',
            controlling: request.control === true,
            display: { id: 'viewer', width: request.width, height: request.height },
            ...(request.keepVideo ? { videoKept: true } : {}),
          };
        case 'restoreViewerDisplay':
          return {
            lease: 'lease',
            controlling: false,
            display: { id: 'one', width: 1280, height: 720 },
          };
        case 'frame':
          return { jpeg: null };
        default:
          return {};
      }
    },
    resolution: memory,
    ...options.api,
  } satisfies RemoteDesktopViewerApi;
  controller = new DesktopViewerController(
    api,
    (options.root ?? {}) as HTMLElement,
    (state) => {
      snapshot = state;
    },
  );
  await vi.advanceTimersByTimeAsync(0);
  return { control, heartbeat, clipboard, resolution, memory, api };
}
const present = () => runtime.post?.({ type: 'streaming', epoch: 'lease' });
const mode4k = { id: '4k', width: 3840, height: 2160, current: false };
const portrait = { id: '640', width: 640, height: 1242, current: false };
const inputEnabled = () =>
  runtime.receive.mock.calls.filter(([message]) => message.type === 'control').at(-1)?.[0]
    .enabled ?? false;

it('keeps high-resolution system modes on a restorable lease', async () => {
  const f = await fixture(undefined, true);
  present();
  await controller.resolution(mode4k);
  expect(f.resolution).toHaveBeenCalledWith('4k');
  expect(
    runtime.receive.mock.calls.some(([m]) => m.type === 'videoSettings' && m.width === 3840),
  ).toBe(true);
});

it('does not silently make a persistent resolution change on an older host', async () => {
  const f = await fixture();
  present();
  await expect(controller.resolution(mode4k)).rejects.toThrow('DESKTOP_DISPLAY_MODES_UNAVAILABLE');
  expect(f.resolution).not.toHaveBeenCalled();
});

it('matches the viewer ratio without replacing the lease or resetting input sequence', async () => {
  const f = await fixture();
  present();
  await controller.fitDisplay(500, 1000);
  expect(snapshot.displayId).toBe('one');
  expect(snapshot.controlling).toBe(true);
  expect(f.control).toHaveBeenLastCalledWith(true);
  expect(runtime.receive).toHaveBeenCalledWith({
    type: 'videoSettings',
    width: 960,
    height: 1920,
    restore: false,
    audio: false,
  });
  expect(runtime.receive.mock.calls.filter(([m]) => m.type === 'init')).toHaveLength(1);
});

it('changes portrait resolution using the same temporary screen lease', async () => {
  await fixture();
  present();
  await controller.fitDisplay(500, 1000);
  await controller.resolution(portrait);
  expect(snapshot.controlling).toBe(true);
  expect(snapshot.displayId).toBe('one');
  expect(runtime.receive).toHaveBeenCalledWith({
    type: 'videoSettings',
    width: 640,
    height: 1242,
    restore: false,
    audio: false,
  });
  expect(runtime.receive.mock.calls.filter(([m]) => m.type === 'init')).toHaveLength(1);
});

it('orders quick copy/paste shortcuts and reports transfer failure without reconnecting', async () => {
  const current = await fixture();
  present();
  const gate = deferred<void>();
  current.clipboard.mockImplementationOnce(() => gate.promise);
  runtime.post?.({ type: 'clipboard', action: 'copy', epoch: 'lease' });
  runtime.post?.({ type: 'clipboard', action: 'paste', epoch: 'lease' });
  await vi.advanceTimersByTimeAsync(0);
  expect(current.clipboard).toHaveBeenCalledExactlyOnceWith(1, 'copy');
  gate.resolve();
  await vi.advanceTimersByTimeAsync(0);
  expect(current.clipboard).toHaveBeenLastCalledWith(1, 'paste');
  current.clipboard.mockRejectedValueOnce(new Error('CLIPBOARD_UNAVAILABLE'));
  runtime.post?.({ type: 'clipboard', action: 'copy', epoch: 'lease' });
  runtime.post?.({ type: 'clipboard', action: 'paste', epoch: 'lease' });
  await vi.advanceTimersByTimeAsync(0);
  expect(current.clipboard).toHaveBeenCalledTimes(3);
  expect(snapshot).toMatchObject({
    clipboardError: true,
    controlling: true,
    ready: true,
    error: null,
  });
  runtime.post?.({ type: 'clipboard', action: 'copy', epoch: 'lease' });
  await vi.advanceTimersByTimeAsync(0);
  expect(snapshot.clipboardError).toBe(false);
  expect(current.clipboard).toHaveBeenCalledTimes(4);
});

it('drops queued clipboard work after host control is lost and ignores stale shortcut epochs', async () => {
  const current = await fixture();
  present();
  const gate = deferred<void>();
  current.clipboard.mockImplementationOnce(() => gate.promise);
  runtime.post?.({ type: 'clipboard', action: 'copy', epoch: 'old-lease' });
  runtime.post?.({ type: 'clipboard', action: 'invalid', epoch: 'lease' });
  expect(current.clipboard).not.toHaveBeenCalled();
  runtime.post?.({ type: 'clipboard', action: 'copy', epoch: 'lease' });
  runtime.post?.({ type: 'clipboard', action: 'paste', epoch: 'lease' });
  await vi.advanceTimersByTimeAsync(0);
  current.heartbeat.mockResolvedValue({ controlling: false });
  await vi.advanceTimersByTimeAsync(3000);
  gate.resolve();
  await vi.advanceTimersByTimeAsync(0);
  expect(current.clipboard).toHaveBeenCalledExactlyOnceWith(1, 'copy');
});

it.each([true, false])(
  'keeps actions and real input aligned when control finishes before video: %s',
  async (controlFirst) => {
    const gate = deferred<{ controlling: boolean }>();
    const f = await fixture(gate.promise);
    if (!controlFirst) present();
    expect(snapshot).toMatchObject({ controlling: false, controlPending: true });
    expect(inputEnabled()).toBe(false);
    gate.resolve({ controlling: true });
    await vi.advanceTimersByTimeAsync(0);
    if (controlFirst) {
      expect(snapshot.controlling).toBe(false);
      present();
    }
    expect(snapshot).toMatchObject({ controlling: true, controlPending: false, ready: true });
    expect(inputEnabled()).toBe(true);
    controller.releaseInput(); // Opening a menu releases held keys, not the control lease.
    await controller.clipboard('copy');
    expect(f.clipboard).toHaveBeenCalledOnce();
    expect(snapshot.controlling).toBe(true);
    expect(inputEnabled()).toBe(true);
  },
);

it('does not present a usable desktop when the host refuses initial control', async () => {
  const f = await fixture(Promise.resolve({ controlling: false }));
  present();
  expect(f.control).toHaveBeenCalledExactlyOnceWith(true);
  expect(snapshot).toMatchObject({ ready: false, controlling: false, error: 'controlUnavailable' });
});

it('shows a reconnectable error when host input is busy during control acquisition', async () => {
  const firstControl = Promise.reject(new Error('[PRECONDITION_FAILED] DESKTOP_INPUT_BUSY'));
  const f = await fixture(firstControl);
  await vi.advanceTimersByTimeAsync(0);
  expect(snapshot).toMatchObject({ ready: false, controlling: false, error: 'controlUnavailable' });
  controller.retry();
  await vi.advanceTimersByTimeAsync(0);
  present();
  expect(f.control).toHaveBeenCalledTimes(2);
  expect(snapshot).toMatchObject({ ready: true, controlling: true, error: null });
});

it('stops input and viewing after input queue overflow', async () => {
  await fixture();
  present();
  runtime.post?.({ type: 'inputOverflow', epoch: 'lease' });
  expect(snapshot).toMatchObject({ controlling: false, ready: false, error: 'controlUnavailable' });
  expect(runtime.receive).toHaveBeenCalledWith({ type: 'stop', preserveFrame: true });
  await expect(controller.clipboard('paste')).rejects.toThrow('DESKTOP_VIEW_ONLY');
});

it('ignores a pre-transition heartbeat without briefly disabling newly granted control', async () => {
  const gate = deferred<{ controlling: boolean }>();
  const f = await fixture(gate.promise);
  present();
  f.heartbeat.mockResolvedValueOnce({ controlling: false });
  await vi.advanceTimersByTimeAsync(3000);
  gate.resolve({ controlling: true });
  await vi.advanceTimersByTimeAsync(0);
  expect(snapshot.controlling).toBe(true);
  expect(inputEnabled()).toBe(true);
});

it('requires control again after the host revokes it and the viewer reconnects', async () => {
  const f = await fixture();
  present();
  f.heartbeat.mockResolvedValue({ controlling: false });
  await vi.advanceTimersByTimeAsync(3000);
  expect(snapshot.controlling).toBe(false);
  expect(snapshot.ready).toBe(false);
  expect(snapshot.error).toBe('controlUnavailable');
  expect(runtime.receive).toHaveBeenCalledWith({ type: 'stop', preserveFrame: true });
  controller.retry();
  await vi.advanceTimersByTimeAsync(0);
  present();
  expect(f.control).toHaveBeenCalledTimes(2);
  expect(snapshot.controlling).toBe(true);
  expect(inputEnabled()).toBe(true);
});

it('keeps confirmed control on an input timeout until the heartbeat settles it', async () => {
  const f = await fixture();
  present();
  const original = f.api.request;
  vi.spyOn(f.api, 'request').mockImplementation(async (generation, request) => {
    if (request.op === 'input') throw new Error('[PRECONDITION_FAILED] INVOKE_TIMEOUT');
    return original(generation, request);
  });
  runtime.post?.({
    type: 'input',
    epoch: 'lease',
    sequence: 1,
    events: [{ kind: 'release' }],
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(snapshot).toMatchObject({ controlling: true, ready: true, error: null });
  expect(inputEnabled()).toBe(true);
});

it('leaves the desktop when the host rejects an input batch', async () => {
  const f = await fixture();
  present();
  const original = f.api.request;
  vi.spyOn(f.api, 'request').mockImplementation(async (generation, request) => {
    if (request.op === 'input') throw new Error('[PRECONDITION_FAILED] DESKTOP_VIEW_ONLY');
    return original(generation, request);
  });
  runtime.post?.({
    type: 'input',
    epoch: 'lease',
    sequence: 1,
    events: [{ kind: 'release' }],
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(snapshot).toMatchObject({ ready: false, controlling: false, error: 'controlUnavailable' });
});

it('coalesces rapid quality changes and waits for the current negotiation to present', async () => {
  await fixture();
  present();
  runtime.receive.mockClear();
  controller.settings({ quality: 'saver' });
  controller.settings({ quality: 'hd' });
  await vi.advanceTimersByTimeAsync(0);
  expect(
    runtime.receive.mock.calls.filter(([message]) => message.type === 'videoSettings'),
  ).toHaveLength(1);
  controller.settings({ quality: 'auto' });
  await vi.advanceTimersByTimeAsync(0);
  expect(
    runtime.receive.mock.calls.filter(([message]) => message.type === 'videoSettings'),
  ).toHaveLength(1);
  present();
  expect(
    runtime.receive.mock.calls.filter(([message]) => message.type === 'videoSettings'),
  ).toHaveLength(2);
  expect(snapshot.settings.quality).toBe('auto');
});

it('expires stale bitrate and latency samples', async () => {
  await fixture();
  present();
  runtime.post?.({
    type: 'network',
    epoch: 'lease',
    transport: 'direct',
    bytesPerSecond: 2048,
    latencyMs: 12,
  });
  expect(snapshot.receiveRate).toBe(2048);
  await vi.advanceTimersByTimeAsync(6000);
  expect(snapshot.receiveRate).toBeNull();
  expect(snapshot.latency).toBeNull();
});

it('does not let a fallback screenshot interrupt a pending video-settings negotiation', async () => {
  await fixture();
  runtime.post?.({ type: 'framePresented', epoch: 'lease' });
  runtime.receive.mockClear();
  controller.settings({ quality: 'saver' });
  await vi.advanceTimersByTimeAsync(0);
  controller.settings({ quality: 'auto' });
  await vi.advanceTimersByTimeAsync(0);
  runtime.post?.({ type: 'framePresented', epoch: 'lease' });
  expect(
    runtime.receive.mock.calls.filter(([message]) => message.type === 'videoSettings'),
  ).toHaveLength(1);
  runtime.post?.({ type: 'fallback', epoch: 'lease' });
  expect(
    runtime.receive.mock.calls.filter(([message]) => message.type === 'videoSettings'),
  ).toHaveLength(2);
});

it.each(['enable', 'biometric'] as const)(
  'retries the failed %s action rather than silently switching to automatic unlock',
  async (action) => {
    const { api } = await fixture();
    present();
    const credential = vi
      .fn()
      .mockRejectedValueOnce(new Error('CREDENTIAL_UNAVAILABLE'))
      .mockResolvedValue({
        available: true,
        autoUnlock: true,
        biometricAvailable: true,
        biometricVerification: true,
      });
    Object.assign(api, { credential });
    await controller.credential(action, true);
    controller.retryCredential();
    await vi.advanceTimersByTimeAsync(0);
    expect(credential).toHaveBeenNthCalledWith(2, 1, action, true);
    expect(snapshot.credentialNotice).toBeNull();
  },
);

it('requests window content sized for the actual desktop plus toolbar', async () => {
  const { api } = await fixture();
  present();
  const resize = vi.spyOn(api, 'resize');
  controller.actualSize();
  expect(runtime.receive).toHaveBeenCalledWith({ type: 'actualSize' });
  expect(resize).toHaveBeenCalledWith(1, 1280, 780);
});

it('passes actual logical geometry to rendering and reacquires control after fitting', async () => {
  const f = await fixture();
  const original = f.api.request;
  vi.spyOn(f.api, 'request').mockImplementation(async (generation, request) =>
    request.op === 'viewerDisplay'
      ? {
          lease: 'lease',
          controlling: false,
          display: { id: 'viewer', width: 960, height: 710 },
          viewerDisplayRequest: { width: request.width, height: request.height },
        }
      : original(generation, request),
  );
  present();
  await controller.fitDisplay(1920, 1420);
  expect(runtime.receive).toHaveBeenCalledWith({
    type: 'videoSettings',
    width: 960,
    height: 710,
    restore: false,
    audio: false,
  });
  expect(snapshot.controlling).toBe(true);
  expect(f.control).toHaveBeenLastCalledWith(true);
});

const sent = (type: string) =>
  runtime.receive.mock.calls.filter(([message]) => message.type === type).map(([m]) => m);

it('keeps the running video when the host confirms a live display switch', async () => {
  const f = await fixture(undefined, false, { caps: { liveDisplaySwitch: true } });
  const request = vi.spyOn(f.api, 'request');
  present();
  runtime.receive.mockClear();
  await controller.fitDisplay(500, 1000);
  expect(request).toHaveBeenCalledWith(
    1,
    expect.objectContaining({ op: 'viewerDisplay', keepVideo: true }),
    undefined,
  );
  expect(sent('displayGeometry')).toEqual([
    { type: 'displayGeometry', width: 960, height: 1920, restore: false },
  ]);
  expect(sent('videoSettings')).toEqual([]);
  expect(snapshot).toMatchObject({ transport: 'video', status: 'live', controlling: true });
});

it('rebuilds the video when a live-switch host does not confirm keeping it', async () => {
  const f = await fixture(undefined, true, { caps: { liveDisplaySwitch: true } });
  present();
  runtime.receive.mockClear();
  await controller.resolution(mode4k);
  expect(f.resolution).toHaveBeenCalledWith('4k');
  expect(sent('displayGeometry')).toEqual([]);
  expect(sent('videoSettings')).toEqual([
    { type: 'videoSettings', width: 3840, height: 2160, restore: true, audio: false },
  ]);
});

it('applies a listed mode without reading the mode list again', async () => {
  const f = await fixture(undefined, true);
  const request = vi.spyOn(f.api, 'request');
  present();
  await controller.resolution(mode4k);
  expect(request.mock.calls.some(([, r]) => r.op === 'displayModes')).toBe(false);
});

it('offers same-ratio choices after fitting and restores the original display', async () => {
  const f = await fixture();
  const request = vi.spyOn(f.api, 'request');
  present();
  // Host modes keep the monitor's ratio: the portrait mode is not offered.
  expect((await controller.resolutionModes()).map((mode) => mode.id)).toEqual(['4k']);
  expect(controller.viewerDisplayMatched(500, 1000)).toBe(false);
  await controller.fitDisplay(500, 1000);
  expect(snapshot.fittedDisplay).toEqual({ width: 960, height: 1920 });
  expect(controller.viewerDisplayMatched(500, 1000)).toBe(true);
  expect(controller.viewerDisplayMatched(1000, 500)).toBe(false);
  const fitted = await controller.resolutionModes();
  expect(fitted.every((mode) => Math.abs(mode.width / mode.height - 0.5) < 0.003)).toBe(true);
  expect(fitted.find((mode) => mode.current)).toMatchObject({ width: 960, height: 1920 });
  await controller.resolution(fitted[0]);
  expect(request).toHaveBeenLastCalledWith(
    1,
    expect.objectContaining({ op: 'control', enabled: true }),
    undefined,
  );
  expect(snapshot.fittedDisplay).toEqual({ width: 960, height: 1920 });
  await controller.fitDisplay(500, 1000);
  expect(request.mock.calls.some(([, r]) => r.op === 'restoreViewerDisplay')).toBe(true);
  expect(snapshot.fittedDisplay).toBeNull();
  expect(f.memory).toHaveBeenLastCalledWith(1, 'one', null);
});

it('remembers system modes per monitor and forgets the computer’s own mode', async () => {
  const f = await fixture(undefined, true);
  const original = f.api.request;
  vi.spyOn(f.api, 'request').mockImplementation(async (generation, r) =>
    r.op === 'displayModes'
      ? [{ ...mode4k, current: true }, { id: 'hd', width: 1920, height: 1080, current: false }]
      : original(generation, r),
  );
  present();
  const [own, hd] = await controller.resolutionModes();
  await controller.resolution(hd);
  expect(f.memory).toHaveBeenLastCalledWith(1, 'one', {
    kind: 'mode',
    modeId: 'hd',
    width: 1920,
    height: 1080,
  });
  await controller.resolution(own);
  expect(f.memory).toHaveBeenLastCalledWith(1, 'one', null);
});

it('reapplies a remembered system mode once control and the first frame are ready', async () => {
  const f = await fixture(undefined, true, {
    remembered: { kind: 'mode', modeId: 'stale-id', width: 3840, height: 2160 },
  });
  present();
  await vi.advanceTimersByTimeAsync(0);
  // Mode IDs may change; the same size still matches.
  expect(f.resolution).toHaveBeenCalledExactlyOnceWith('4k');
  expect(snapshot.controlling).toBe(true);
  present();
  await vi.advanceTimersByTimeAsync(0);
  expect(f.resolution).toHaveBeenCalledOnce();
});

it('refits a remembered fit to the current window at the remembered size', async () => {
  const f = await fixture(undefined, false, {
    remembered: { kind: 'fit', width: 1280, height: 960 },
    root: { clientWidth: 1000, clientHeight: 500 },
  });
  const request = vi.spyOn(f.api, 'request');
  present();
  await vi.advanceTimersByTimeAsync(0);
  expect(request).toHaveBeenCalledWith(
    1,
    expect.objectContaining({ op: 'viewerDisplay', width: 1280, height: 640 }),
    undefined,
  );
  expect(snapshot.fittedDisplay).toEqual({ width: 1920, height: 960 });
});

it('does not retry a remembered choice that failed in this window', async () => {
  const f = await fixture(undefined, true, {
    remembered: { kind: 'mode', modeId: '4k', width: 3840, height: 2160 },
  });
  f.resolution.mockRejectedValueOnce(new Error('DESKTOP_DISPLAY_FAILED'));
  present();
  await vi.advanceTimersByTimeAsync(0);
  expect(f.resolution).toHaveBeenCalledOnce();
  f.heartbeat.mockResolvedValueOnce({ controlling: false });
  await vi.advanceTimersByTimeAsync(3000);
  controller.retry();
  await vi.advanceTimersByTimeAsync(0);
  present();
  await vi.advanceTimersByTimeAsync(0);
  expect(f.resolution).toHaveBeenCalledOnce();
});

const channelFixture = async (caps: Record<string, unknown> = { channelRequests: true }) => {
  let forward: ((message: RemoteViewerChannelRequest) => void) | null = null;
  const channelReply = vi.fn(async () => {});
  const f = await fixture(undefined, false, {
    caps,
    api: {
      onChannelRequest: (listener: (message: RemoteViewerChannelRequest) => void) => {
        forward = listener;
        return () => {};
      },
      channelReply,
    },
  });
  const ask = (request: Record<string, unknown>, id = 'id-1', generation = 1) =>
    forward?.({ generation, id, request: request as RemoteViewerChannelRequest['request'] });
  return { ...f, channelReply, ask };
};
const control = { op: 'control', lease: 'lease', enabled: true };

it('carries Main’s small requests over the live media data channel', async () => {
  const f = await channelFixture();
  present();
  f.ask(control);
  const [channel] = sent('channelRequest') as { id: string; request: unknown }[];
  expect(channel).toMatchObject({ id: 'id-1', request: control });
  runtime.post?.({
    type: 'channelReply',
    epoch: 'lease',
    id: 'id-1',
    ok: true,
    result: { controlling: true },
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(f.channelReply).toHaveBeenCalledWith(1, 'id-1', {
    kind: 'result',
    value: { controlling: true },
  });
});

it('maps channel refusals to the relay and real failures to errors', async () => {
  const f = await channelFixture();
  present();
  f.ask(control, 'busy');
  runtime.post?.({ type: 'channelReply', epoch: 'lease', id: 'busy', ok: false, error: 'DESKTOP_CHANNEL_BUSY' });
  f.ask({ op: 'displayModes', lease: 'lease' }, 'large');
  runtime.post?.({ type: 'channelReply', epoch: 'lease', id: 'large', ok: false, error: 'DESKTOP_REPLY_TOO_LARGE' });
  f.ask(control, 'failed');
  runtime.post?.({ type: 'channelReply', epoch: 'lease', id: 'failed', ok: false, error: 'DESKTOP_VIEW_ONLY' });
  f.ask(control, 'unsent');
  runtime.post?.({ type: 'channelRequestState', epoch: 'lease', id: 'unsent', sent: false });
  await vi.advanceTimersByTimeAsync(0);
  expect(f.channelReply).toHaveBeenCalledWith(1, 'busy', { kind: 'relay' });
  expect(f.channelReply).toHaveBeenCalledWith(1, 'large', { kind: 'relay' });
  expect(f.channelReply).toHaveBeenCalledWith(1, 'failed', { kind: 'error', code: 'DESKTOP_VIEW_ONLY' });
  expect(f.channelReply).toHaveBeenCalledWith(1, 'unsent', { kind: 'relay' });
});

it('returns requests to the relay without video, support, the current lease or generation', async () => {
  const unsupported = await channelFixture({});
  present();
  unsupported.ask(control);
  await vi.advanceTimersByTimeAsync(0);
  expect(unsupported.channelReply).toHaveBeenLastCalledWith(1, 'id-1', { kind: 'relay' });
  controller.dispose();
  const f = await channelFixture();
  f.ask(control, 'before-video');
  present();
  f.ask({ ...control, lease: 'old' }, 'old-lease');
  f.ask(control, 'old-generation', 0);
  f.ask({ op: 'heartbeat', lease: 'lease' }, 'not-allowed');
  await vi.advanceTimersByTimeAsync(0);
  for (const id of ['before-video', 'old-lease', 'not-allowed'])
    expect(f.channelReply).toHaveBeenCalledWith(1, id, { kind: 'relay' });
  expect(f.channelReply).toHaveBeenCalledWith(0, 'old-generation', { kind: 'relay' });
  expect(sent('channelRequest')).toEqual([]);
});

it('settles carried requests as unknown when the media peer falls back', async () => {
  const f = await channelFixture();
  present();
  f.ask(control);
  runtime.post?.({ type: 'fallback', epoch: 'lease' });
  await vi.advanceTimersByTimeAsync(0);
  expect(f.channelReply).toHaveBeenCalledWith(1, 'id-1', { kind: 'error', code: 'INVOKE_TIMEOUT' });
});

it('needs no separate control request when the host grants it with the lease and display changes', async () => {
  const f = await fixture(undefined, false, { caps: { autoControl: true } });
  const request = vi.spyOn(f.api, 'request');
  present();
  expect(f.control).not.toHaveBeenCalled();
  expect(snapshot).toMatchObject({ controlling: true, ready: true });
  await controller.fitDisplay(500, 1000);
  expect(request).toHaveBeenCalledWith(
    1,
    expect.objectContaining({ op: 'viewerDisplay', control: true }),
    undefined,
  );
  expect(f.control).not.toHaveBeenCalled();
  expect(snapshot.controlling).toBe(true);
});

it('waits for auto-unlock to finish before reapplying a remembered resolution', async () => {
  const unlock = deferred<{
    available: boolean;
    autoUnlock: boolean;
    biometricAvailable: boolean;
    biometricVerification: boolean;
  }>();
  const credential = vi.fn(() => unlock.promise);
  const f = await fixture(undefined, true, {
    caps: { platform: 'darwin', autoControl: true },
    remembered: { kind: 'mode', modeId: '4k', width: 3840, height: 2160 },
    api: { credential },
  });
  present();
  await vi.advanceTimersByTimeAsync(0);
  expect(credential).toHaveBeenCalledWith(1, 'unlock', undefined);
  expect(f.resolution).not.toHaveBeenCalled();
  unlock.resolve({
    available: true,
    autoUnlock: true,
    biometricAvailable: false,
    biometricVerification: false,
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(f.resolution).toHaveBeenCalledExactlyOnceWith('4k');
});
