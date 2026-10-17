import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { RemoteDesktopRequest } from '@cindy/device-link';
import type { RemoteDesktopViewerApi } from '../../../../shared/remoteDesktopViewer';
import { RemoteViewerConnection } from '../../../../main/remote-desktop-viewer/connection';
import { DesktopViewerController, type ViewerSnapshot } from '../viewerController';

const runtime = vi.hoisted(() => ({
  post: null as ((message: Record<string, unknown>) => void) | null,
  receive: vi.fn(),
}));
const diagnosticLog = vi.hoisted(() => vi.fn());
vi.mock('@/lib/logger', () => ({ createLogger: () => ({ debug: diagnosticLog }) }));
vi.mock('../../../../shared/remoteDesktopDiagnostics', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../shared/remoteDesktopDiagnostics')>()),
  desktopDiagnosticId: async () => 'hashed-session',
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
  options: {
    legacyTimeout?: boolean;
    delayStart?: boolean;
    busy?: boolean;
    alwaysTimeout?: boolean;
    portal?: boolean;
    heartbeat?: () => Promise<{ controlling: boolean }>;
  } = {},
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
        if (options.alwaysTimeout) throw new Error('INVOKE_TIMEOUT');
        if (options.legacyTimeout && ++capabilityAttempts === 1) throw new Error('INVOKE_TIMEOUT');
        return {
          version: 1,
          enabled: true,
          canControl: true,
          connectionTakeover: true,
          automaticReconnect: options.legacyTimeout ? undefined : true,
          displays: (options.portal ? ['wayland-portal'] : ['one', 'two', 'three']).map((id) => ({
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
      if (request.op === 'heartbeat' && options.heartbeat) return options.heartbeat();
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
    resize: async () => {},
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

it('dumps recent heartbeat results only on failure and preserves the timeout/retry policy', async () => {
  let calls = 0;
  const current = await fixture({
    heartbeat: async () => {
      if (++calls === 2) throw new Error('INVOKE_TIMEOUT');
      if (calls === 3) throw new Error('DESKTOP_LEASE_EXPIRED');
      return { controlling: true };
    },
  });
  runtime.post?.({ type: 'streaming', epoch: 'lease-one' });
  await vi.advanceTimersByTimeAsync(6000);
  expect(snapshot.status).toBe('live');
  expect(diagnosticLog).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(3000);
  expect(snapshot.status).toBe('reconnecting');
  expect(diagnosticLog).toHaveBeenCalledOnce();
  const data = diagnosticLog.mock.calls[0][1];
  expect(data).toMatchObject({
    source: 'heartbeat',
    code: 'DESKTOP_LEASE_EXPIRED',
    session: 'hashed-session',
    streaming: true,
    lastRequestFailure: { operation: 'heartbeat', code: 'DESKTOP_LEASE_EXPIRED' },
  });
  expect(data.heartbeats.map((sample: { result: string }) => sample.result)).toEqual([
    'controlling',
    'INVOKE_TIMEOUT',
    'DESKTOP_LEASE_EXPIRED',
  ]);
  expect(
    data.heartbeats.every(
      (sample: { requestedAt: number; settledAt: number }) =>
        sample.settledAt >= sample.requestedAt,
    ),
  ).toBe(true);
  expect(JSON.stringify(data)).not.toContain('lease-one');
  await vi.advanceTimersByTimeAsync(3000);
  expect(current.requests.filter((r) => r.op === 'start')).toHaveLength(2);
});

it('does not attach a late old heartbeat result to a replacement display lease', async () => {
  let reject!: (error: Error) => void;
  let count = 0;
  await fixture({
    heartbeat: async () => {
      if (++count === 1)
        return new Promise((_resolve, fail) => {
          reject = fail;
        });
      throw new Error('DESKTOP_LEASE_EXPIRED');
    },
  });
  runtime.post?.({ type: 'streaming', epoch: 'lease-one' });
  await vi.advanceTimersByTimeAsync(3000);
  controller.selectDisplay('two');
  await vi.advanceTimersByTimeAsync(0);
  runtime.post?.({ type: 'streaming', epoch: 'lease-two' });
  reject(new Error('private old failure'));
  await vi.advanceTimersByTimeAsync(0);
  expect(diagnosticLog).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(3000);
  const data = diagnosticLog.mock.calls[0][1];
  expect(data.heartbeats).toHaveLength(1);
  expect(data.heartbeats[0].result).toBe('DESKTOP_LEASE_EXPIRED');
  expect(JSON.stringify(data)).not.toContain('private');
});

it('retries an initial capabilities timeout on a legacy host without inventing a resume', async () => {
  const current = await fixture({ legacyTimeout: true });
  await vi.advanceTimersByTimeAsync(3001);
  runtime.post?.({ type: 'streaming', epoch: 'lease-one' });
  expect(snapshot).toMatchObject({ ready: true, controlling: true, error: null });
  expect(current.requests.filter((request) => request.op === 'start')).toEqual([
    { op: 'start', displayId: 'one', lockOnExit: false },
  ]);
});

it('stops repeated connection failures at the total deadline and allows manual retry', async () => {
  const options = { alwaysTimeout: true };
  const current = await fixture(options);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(snapshot).toMatchObject({ error: 'connectionTimeout', ready: false });
  const attempts = current.requests.length;
  await vi.advanceTimersByTimeAsync(60_000);
  expect(current.requests).toHaveLength(attempts);
  options.alwaysTimeout = false;
  controller.retry();
  await vi.advanceTimersByTimeAsync(0);
  runtime.post?.({ type: 'framePresented', epoch: 'lease-one' });
  await vi.advanceTimersByTimeAsync(60_000);
  expect(snapshot).toMatchObject({ error: null, ready: true });
});

it('times out a lease that never presents a frame and releases only that lease', async () => {
  const current = await fixture();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(snapshot).toMatchObject({ error: 'connectionTimeout', ready: false });
  expect(current.requests.filter((r) => r.op === 'stop')).toEqual([
    { op: 'stop', lease: 'lease-one' },
  ]);
  runtime.post?.({ type: 'streaming', epoch: 'lease-one' });
  expect(snapshot.error).toBe('connectionTimeout');
});

it.each(['streaming', 'framePresented'])(
  'allows portal consent after 60 seconds before %s',
  async (type) => {
    const current = await fixture({ portal: true });
    await vi.advanceTimersByTimeAsync(90_000);
    expect(snapshot).toMatchObject({ error: null, ready: false });
    expect(current.hostLease()).toBe('lease-wayland-portal');
    runtime.post?.({ type, epoch: 'lease-wayland-portal' });
    await vi.advanceTimersByTimeAsync(200_000);
    expect(snapshot).toMatchObject({ error: null, ready: true });
    expect(current.requests.filter((r) => r.op === 'stop')).toEqual([]);
  },
);

it('keeps the portal deadline bounded across fallback and rejects a late frame', async () => {
  const current = await fixture({ portal: true });
  await vi.advanceTimersByTimeAsync(90_000);
  runtime.post?.({ type: 'fallback', epoch: 'lease-wayland-portal' });
  await vi.advanceTimersByTimeAsync(89_999);
  expect(snapshot.error).toBeNull();
  await vi.advanceTimersByTimeAsync(1);
  expect(snapshot.error).toBe('connectionTimeout');
  expect(current.hostLease()).toBeNull();
  runtime.post?.({ type: 'streaming', epoch: 'lease-wayland-portal' });
  expect(snapshot.ready).toBe(false);
});

it('retires a portal start arriving after the extended deadline', async () => {
  const current = await fixture({ portal: true, delayStart: true });
  await vi.advanceTimersByTimeAsync(180_000);
  expect(snapshot.error).toBe('connectionTimeout');
  current.start.resolve();
  await vi.advanceTimersByTimeAsync(0);
  expect(current.hostLease()).toBeNull();
  expect(snapshot).toMatchObject({ error: 'connectionTimeout', ready: false });
});

it('retires a start reply arriving after the connection deadline', async () => {
  const current = await fixture({ delayStart: true });
  await vi.advanceTimersByTimeAsync(60_000);
  expect(snapshot.error).toBe('connectionTimeout');
  current.start.resolve();
  current.stop.resolve();
  await vi.advanceTimersByTimeAsync(0);
  expect(current.hostLease()).toBeNull();
  expect(snapshot).toMatchObject({ error: 'connectionTimeout', ready: false });
});

it('releases the lease and cancels the deadline when the viewer is disposed', async () => {
  const current = await fixture();
  controller.dispose();
  await vi.advanceTimersByTimeAsync(150_000);
  expect(current.hostLease()).toBeNull();
  expect(current.requests.filter((r) => r.op === 'stop')).toEqual([
    { op: 'stop', lease: 'lease-one' },
  ]);
  expect(vi.getTimerCount()).toBe(0);
});

it('keeps a healthy viewer on the same host connected when another viewer times out', async () => {
  const leases = new Set<string>();
  const snapshots = new Map<string, ViewerSnapshot>();
  const createViewer = (peer: string) => {
    const api = {
      state: async () => ({
        target: { deviceId: 'host', name: 'Computer' },
        active: true,
        generation: 1,
      }),
      onActive: () => () => {},
      onLocale: () => () => {},
      onCloseRequested: () => () => {},
      ice: async () => [],
      clipboard: async () => {},
      close: async () => {},
      fullscreen: async () => {},
      resize: async () => {},
      rendererReady: async () => {},
      presentationReady: async () => {},
      inputFocus: async () => {},
      request: async (_generation: number, request: RemoteDesktopRequest) => {
        if (request.op === 'capabilities')
          return {
            version: 1,
            enabled: true,
            canControl: true,
            automaticReconnect: true,
            displays: [{ id: 'one', width: 1280, height: 720 }],
          };
        if (request.op === 'start') {
          leases.add(peer);
          return {
            lease: peer,
            controlling: false,
            display: { id: 'one', width: 1280, height: 720 },
          };
        }
        if (request.op === 'stop') leases.delete(request.lease);
        if (request.op === 'control' || request.op === 'heartbeat') return { controlling: true };
        return { controlling: false, jpeg: null };
      },
    } satisfies RemoteDesktopViewerApi;
    return new DesktopViewerController(api, {} as HTMLElement, (value) =>
      snapshots.set(peer, value),
    );
  };
  const stalled = createViewer('stalled');
  try {
    controller = createViewer('healthy');
    await vi.advanceTimersByTimeAsync(0);
    runtime.post?.({ type: 'streaming', epoch: 'healthy' });
    await vi.advanceTimersByTimeAsync(150_000);
    expect(snapshots.get('stalled')?.error).toBe('connectionTimeout');
    expect(snapshots.get('healthy')).toMatchObject({ ready: true, error: null });
    expect([...leases]).toEqual(['healthy']);
  } finally {
    stalled.dispose();
  }
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
      { op: 'start', displayId: 'one', lockOnExit: false },
      { op: 'start', displayId: latest, lockOnExit: false },
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
    lockOnExit: false,
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
