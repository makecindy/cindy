import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { RemoteDesktopViewerApi } from '../../../../shared/remoteDesktopViewer';
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
) {
  const control = vi.fn(async (enabled: boolean) => ({ controlling: enabled }));
  if (firstControl) control.mockImplementationOnce(() => firstControl);
  const heartbeat = vi.fn(async () => ({ controlling: true }));
  const clipboard = vi.fn(async () => {});
  const resolution = vi.fn(async (_modeId: string) => ({
    lease: 'lease',
    controlling: false,
    display: { id: 'one', width: 3840, height: 2160 },
  }));
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
          };
        case 'start':
          return {
            lease: 'lease',
            controlling: false,
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
            controlling: false,
            display: { id: 'viewer', width: request.width, height: request.height },
          };
        case 'frame':
          return { jpeg: null };
        default:
          return {};
      }
    },
  } satisfies RemoteDesktopViewerApi;
  controller = new DesktopViewerController(api, {} as HTMLElement, (state) => {
    snapshot = state;
  });
  await vi.advanceTimersByTimeAsync(0);
  return { control, heartbeat, clipboard, resolution, api };
}
const present = () => runtime.post?.({ type: 'streaming', epoch: 'lease' });
const inputEnabled = () =>
  runtime.receive.mock.calls.filter(([message]) => message.type === 'control').at(-1)?.[0]
    .enabled ?? false;

it('keeps high-resolution system modes on a restorable lease', async () => {
  const f = await fixture(undefined, true);
  present();
  await controller.resolution('4k');
  expect(f.resolution).toHaveBeenCalledWith('4k');
  expect(
    runtime.receive.mock.calls.some(([m]) => m.type === 'videoSettings' && m.width === 3840),
  ).toBe(true);
});

it('does not silently make a persistent resolution change on an older host', async () => {
  const f = await fixture();
  present();
  await expect(controller.resolution('4k')).rejects.toThrow('DESKTOP_DISPLAY_MODES_UNAVAILABLE');
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
    audio: false,
  });
  expect(runtime.receive.mock.calls.filter(([m]) => m.type === 'init')).toHaveLength(1);
});

it('changes portrait resolution using the same temporary screen lease', async () => {
  await fixture();
  present();
  await controller.fitDisplay(500, 1000);
  await controller.resolution('640');
  expect(snapshot.controlling).toBe(true);
  expect(snapshot.displayId).toBe('one');
  expect(runtime.receive).toHaveBeenCalledWith({
    type: 'videoSettings',
    width: 640,
    height: 1242,
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
    audio: false,
  });
  expect(snapshot.controlling).toBe(true);
  expect(f.control).toHaveBeenLastCalledWith(true);
});
