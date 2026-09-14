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
async function fixture(firstControl?: Promise<{ controlling: boolean }>) {
  const control = vi.fn(async (enabled: boolean) => ({ controlling: enabled }));
  if (firstControl) control.mockImplementationOnce(() => firstControl);
  const heartbeat = vi.fn(async () => ({ controlling: true }));
  const clipboard = vi.fn(async () => {});
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
  return { control, heartbeat, clipboard };
}
const present = () => runtime.post?.({ type: 'streaming', epoch: 'lease' });
const inputEnabled = () =>
  runtime.receive.mock.calls.filter(([message]) => message.type === 'control').at(-1)?.[0]
    .enabled ?? false;

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

it('drops queued clipboard work after control is released and ignores stale shortcut epochs', async () => {
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
  await controller.setControl(false);
  await controller.setControl(true);
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

it('pauses actions and input during release and does not send duplicate control requests', async () => {
  const f = await fixture();
  present();
  const gate = deferred<{ controlling: boolean }>();
  f.control.mockImplementationOnce(() => gate.promise);
  const pending = controller.setControl(false);
  await controller.setControl(true);
  expect(f.control).toHaveBeenCalledTimes(2); // Initial grant + one release.
  expect(snapshot).toMatchObject({ controlling: false, controlPending: true });
  expect(inputEnabled()).toBe(false);
  await expect(controller.clipboard('paste')).rejects.toThrow('DESKTOP_VIEW_ONLY');
  runtime.receive.mockClear();
  controller.keys(['MetaLeft', 'KeyD']);
  expect(runtime.receive).not.toHaveBeenCalled();
  gate.resolve({ controlling: false });
  await pending;
  expect(snapshot).toMatchObject({ controlling: false, controlPending: false });
  expect(f.clipboard).not.toHaveBeenCalled();
});

it('ignores a pre-transition heartbeat without briefly disabling newly granted control', async () => {
  const f = await fixture();
  present();
  await controller.setControl(false);
  const gate = deferred<{ controlling: boolean }>();
  f.heartbeat.mockImplementationOnce(() => gate.promise);
  await vi.advanceTimersByTimeAsync(3000);
  await controller.setControl(true);
  gate.resolve({ controlling: false });
  await vi.advanceTimersByTimeAsync(0);
  expect(snapshot.controlling).toBe(true);
  expect(inputEnabled()).toBe(true);
});

it('retains view-only after the host revokes control and the viewer reconnects', async () => {
  const f = await fixture();
  present();
  f.heartbeat.mockResolvedValue({ controlling: false });
  await vi.advanceTimersByTimeAsync(3000);
  expect(snapshot.controlling).toBe(false);
  expect(inputEnabled()).toBe(false);
  controller.retry();
  await vi.advanceTimersByTimeAsync(0);
  present();
  expect(f.control).toHaveBeenCalledOnce();
  expect(snapshot.controlling).toBe(false);
  expect(inputEnabled()).toBe(false);
});

it('does not re-enable input when a failed release is followed by another video frame', async () => {
  const f = await fixture();
  present();
  f.control.mockRejectedValueOnce(new Error('INVOKE_TIMEOUT'));
  await controller.setControl(false);
  present();
  expect(snapshot).toMatchObject({ controlling: false, controlPending: false });
  expect(inputEnabled()).toBe(false);
  await vi.advanceTimersByTimeAsync(3000);
  expect(f.control).toHaveBeenLastCalledWith(false);
  expect(inputEnabled()).toBe(false);
});
