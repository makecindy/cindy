import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { RemoteDesktopRequest } from '@cindy/device-link';
import type { RemoteDesktopViewerApi } from '../../../../shared/remoteDesktopViewer';
import { RemoteViewerConnection } from '../../../../main/remote-desktop-viewer/connection';
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

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
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
  options: { legacyTimeout?: boolean; delayStart?: boolean; busy?: boolean } = {},
) {
  const start = deferred();
  const stop = deferred();
  const requests: RemoteDesktopRequest[] = [];
  let capabilityAttempts = 0;
  let startAttempts = 0;
  let hostLease: string | null = null;
  const connection = new RemoteViewerConnection({
    owner: () => 'account',
    readClipboard: () => '',
    writeClipboard: () => {},
    request: async (_device, request, check) => {
      check();
      requests.push(request);
      if (request.op === 'capabilities') {
        if (options.legacyTimeout && ++capabilityAttempts === 1) throw new Error('INVOKE_TIMEOUT');
        return {
          version: 1,
          enabled: true,
          canControl: true,
          connectionTakeover: true,
          automaticReconnect: options.legacyTimeout ? undefined : true,
          displays: ['one', 'two', 'three'].map((id) => ({
            id,
            name: id,
            width: 1280,
            height: 720,
          })),
        };
      }
      if (request.op === 'start') {
        startAttempts++;
        if (options.busy && !request.takeover) throw new Error('DESKTOP_BUSY');
        if (options.delayStart && startAttempts === 1) await start.promise;
        if (hostLease) throw new Error('DESKTOP_BUSY');
        hostLease = 'lease-' + request.displayId;
        return {
          lease: hostLease,
          controlling: false,
          display: { id: request.displayId, width: 1280, height: 720 },
        };
      }
      if (request.op === 'stop') {
        if (options.delayStart && request.lease === 'lease-one') await stop.promise;
        if (hostLease === request.lease) hostLease = null;
        return {};
      }
      if (request.op === 'control' || request.op === 'heartbeat') return { controlling: true };
      return { jpeg: null };
    },
  });
  connection.bind({ deviceId: 'host', name: 'Computer' });
  connection.setActive(true);
  const api = {
    state: async () => connection.snapshot(),
    onActive: () => () => {},
    onLocale: () => () => {},
    onCloseRequested: () => () => {},
    ice: async () => [],
    clipboard: async () => {},
    close: async () => {},
    fullscreen: async () => {},
    rendererReady: async () => {},
    presentationReady: async () => {},
    inputFocus: async () => {},
    request: async (generation, request, attempt) => {
      const reply = await connection.request(generation, request, attempt);
      if (!reply.ok) throw new Error('[PRECONDITION_FAILED] ' + reply.code);
      return reply.result;
    },
  } satisfies RemoteDesktopViewerApi;
  controller = new DesktopViewerController(api, {} as HTMLElement, (value) => {
    snapshot = value;
  });
  await vi.advanceTimersByTimeAsync(0);
  const restart = (rebind = false) => {
    controller.dispose();
    connection.deactivate();
    if (rebind) connection.bind({ deviceId: 'host', name: 'Computer' });
    connection.setActive(true);
    controller = new DesktopViewerController(api, {} as HTMLElement, (value) => {
      snapshot = value;
    });
  };
  return { start, stop, requests, restart, hostLease: () => hostLease };
}

it('retries an initial capabilities timeout on a legacy host without inventing a resume', async () => {
  const current = await fixture({ legacyTimeout: true });
  await vi.advanceTimersByTimeAsync(3001);
  runtime.post?.({ type: 'streaming', epoch: 'lease-one' });
  expect(snapshot).toMatchObject({ ready: true, controlling: true, error: null });
  expect(current.requests.filter((request) => request.op === 'start')).toEqual([
    { op: 'start', displayId: 'one' },
  ]);
});

it.each([['two'], ['two', 'three']])(
  'connects only the final display after a cancelled start and its stop settle: %j',
  async (...displays) => {
    const current = await fixture({ delayStart: true });
    for (const display of displays) controller.selectDisplay(display);
    await vi.advanceTimersByTimeAsync(0);
    expect(current.requests.filter((request) => request.op === 'start')).toHaveLength(1);
    current.start.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(current.requests.filter((request) => request.op === 'stop')).toEqual([
      { op: 'stop', lease: 'lease-one' },
    ]);
    expect(current.requests.filter((request) => request.op === 'start')).toHaveLength(1);
    current.stop.resolve();
    await vi.advanceTimersByTimeAsync(0);
    const latest = displays.at(-1)!;
    runtime.post?.({ type: 'streaming', epoch: 'lease-' + latest });
    await vi.advanceTimersByTimeAsync(9000);
    expect(snapshot).toMatchObject({
      ready: true,
      controlling: true,
      error: null,
      displayId: latest,
    });
    expect(current.hostLease()).toBe('lease-' + latest);
    expect(current.requests.filter((request) => request.op === 'start')).toEqual([
      { op: 'start', displayId: 'one' },
      { op: 'start', displayId: latest },
    ]);
  },
);

it('still requires explicit confirmation to take over another viewer', async () => {
  const current = await fixture({ busy: true });
  await vi.advanceTimersByTimeAsync(15000);
  expect(snapshot).toMatchObject({ error: 'connectionBusy', ready: false });
  expect(current.requests.filter((request) => request.op === 'start')).toHaveLength(1);
  controller.retry();
  await vi.advanceTimersByTimeAsync(0);
  expect(current.requests.filter((request) => request.op === 'start').at(-1)).toEqual({
    op: 'start',
    displayId: 'one',
    takeover: true,
  });
});

it.each([false, true])(
  'waits across Renderer replacement or window reuse before restarting: rebind=%s',
  async (rebind) => {
    const current = await fixture({ delayStart: true });
    current.restart(rebind);
    await vi.advanceTimersByTimeAsync(0);
    expect(current.requests.filter((request) => request.op === 'start')).toHaveLength(1);
    current.start.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(current.requests.filter((request) => request.op === 'start')).toHaveLength(1);
    expect(current.requests.filter((request) => request.op === 'stop')).toEqual([
      { op: 'stop', lease: 'lease-one' },
    ]);
    current.stop.resolve();
    await vi.advanceTimersByTimeAsync(0);
    runtime.post?.({ type: 'streaming', epoch: 'lease-one' });
    await vi.advanceTimersByTimeAsync(9000);
    expect(snapshot).toMatchObject({ ready: true, error: null, controlling: true });
    expect(current.requests.filter((request) => request.op === 'start')).toHaveLength(2);
    expect(current.hostLease()).toBe('lease-one');
  },
);

it('waits for an established lease to stop before a replacement Renderer starts', async () => {
  const current = await fixture({ delayStart: true });
  current.start.resolve();
  await vi.advanceTimersByTimeAsync(0);
  runtime.post?.({ type: 'streaming', epoch: 'lease-one' });
  current.restart();
  await vi.advanceTimersByTimeAsync(0);
  expect(current.requests.filter((request) => request.op === 'start')).toHaveLength(1);
  current.stop.resolve();
  await vi.advanceTimersByTimeAsync(0);
  runtime.post?.({ type: 'streaming', epoch: 'lease-one' });
  expect(snapshot).toMatchObject({ ready: true, error: null, controlling: true });
  expect(current.hostLease()).toBe('lease-one');
});
