// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { DeviceLinkClient, PROTOCOL_VERSION, DEVICE_LINK_CAPABILITY_RELIABLE_TRANSPORT,
  type Envelope, type WsLike } from '@cindy/device-link';
import type { ProviderView } from '@cindy/model-providers/registry';
import { useDeviceProviders, type UseDeviceProvidersResult } from '@/device-link/useDeviceProviders';
import { clearAllDeviceProviders, evictDeviceProviders, fetchDeviceProviders, fetchDeviceProvidersFresh } from '@/device-link/deviceProvidersCache';

const state = vi.hoisted(() => ({
  context: { connectionEpoch: 1, status: 'online', recoveringDeviceIds: new Set<string>() },
  appState: 'active',
  listeners: new Set<(next: string) => void>(),
  makers: new Map<string, { listProviders: ReturnType<typeof vi.fn> }>(),
}));
vi.mock('@/device-link/DeviceLinkContext', () => ({ useDeviceLink: () => state.context }));
vi.mock('@/device-link/useMobileMakerTransport', () => ({
  useMobileMakerTransport: (id: string) => state.makers.get(id),
}));
vi.mock('@/i18n', () => ({ i18n: {} }));
vi.mock('react-native', () => ({ AppState: {
  get currentState() { return state.appState; },
  addEventListener: (_: string, listener: (next: string) => void) => {
    state.listeners.add(listener);
    return { remove: () => state.listeners.delete(listener) };
  },
} }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
let values: Record<string, UseDeviceProvidersResult>;
const catalog = (id: string) => ({ providers: [{ id } as ProviderView] });
const timeout = () => new Error('[DEVICE_LINK_TIMEOUT] no invoke-result');
function Probe({ deviceId, open }: { deviceId: string; open: boolean }) {
  values[deviceId] = useDeviceProviders(deviceId, open);
  return null;
}
async function render(deviceId = 'a', open = false, other = false) {
  await act(async () => root.render(createElement('div', null,
    createElement(Probe, { deviceId, open }),
    other ? createElement(Probe, { deviceId: 'b', open: false }) : null,
  )));
}
async function advance(ms: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}
async function foreground(next: string) {
  await act(async () => {
    state.appState = next;
    for (const listener of state.listeners) listener(next);
  });
}
beforeEach(() => {
  vi.useFakeTimers();
  state.context = { connectionEpoch: 1, status: 'online', recoveringDeviceIds: new Set() };
  state.appState = 'active';
  state.makers.clear();
  state.makers.set('a', { listProviders: vi.fn().mockRejectedValue(timeout()) });
  state.makers.set('b', { listProviders: vi.fn().mockResolvedValue(catalog('b')) });
  values = {};
  root = createRoot(document.createElement('div'));
});
afterEach(async () => {
  await act(async () => root.unmount());
  clearAllDeviceProviders();
  expect(state.listeners.size).toBe(0);
  vi.useRealTimers();
});

describe('model catalog failure recovery', () => {
  it('continues recovery when an external fresh read invalidates an ordinary in-flight read', async () => {
    const read = state.makers.get('a')!.listProviders;
    await render();
    let finish!: (value: ReturnType<typeof catalog>) => void;
    await act(async () => {
      const old = fetchDeviceProviders('a', () => new Promise((resolve) => { finish = resolve; }));
      await fetchDeviceProvidersFresh('a', () => read()).catch(() => undefined);
      finish(catalog('obsolete'));
      await old;
    });
    expect(values.a.ready).toBe(false);
    read.mockResolvedValue(catalog('current'));
    await advance(900);
    expect(values.a.ready).toBe(true);
    expect(values.a.providers[0].id).toBe('current');
  });

  it.each(['evict', 'clearAll'] as const)('continues recovery after %s and an identical immediate failure', async (operation) => {
    const read = state.makers.get('a')!.listProviders;
    read.mockRejectedValue(new Error('[DEVICE_UNRESPONSIVE] probe pending'));
    await render();
    await advance(400);
    await act(async () => {
      if (operation === 'evict') evictDeviceProviders('a');
      else clearAllDeviceProviders();
    });
    expect(read).toHaveBeenCalledTimes(2);
    expect(values.a.ready).toBe(false);
    read.mockResolvedValue(catalog('new-generation'));
    await advance(900);
    expect(read).toHaveBeenCalledTimes(3);
    expect(values.a.ready).toBe(true);
    await advance(60_000);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('keeps a second controller link and pending request intact when the first controller goes silent', async () => {
    // Three real clients behind an in-memory relay: A and B both control host.
    const sockets = new Map<string, Socket>();
    let silentA = false;
    class Socket extends EventEmitter implements WsLike {
      constructor(readonly id: string) { super(); }
      close = vi.fn(() => { this.emit('close', 1000); });
      deliver(frame: Envelope) { this.emit('message', { toString: () => JSON.stringify(frame) }); }
      send(data: string) {
        const frame = JSON.parse(data) as Envelope;
        void Promise.resolve().then(() => {
          if (frame.kind === 'hello') {
            this.deliver({ v: PROTOCOL_VERSION, kind: 'hello-ack', payload: {
              serverProtocolVersion: PROTOCOL_VERSION, deviceId: this.id, userId: 'test-user',
            } });
          } else if (frame.dst && !(silentA && (this.id === 'a' || frame.dst === 'a'))) {
            sockets.get(frame.dst)?.deliver({ ...frame, src: this.id });
          }
        });
      }
    }
    const client = (id: string) => new DeviceLinkClient({
      getWsUrl: () => 'ws://test-relay', getToken: async () => 'fake-token',
      getHello: () => ({ deviceName: id, platform: 'darwin', appVersion: 'test', remoteControlEnabled: true, busy: false }),
      createWebSocket: () => {
        const socket = new Socket(id); sockets.set(id, socket);
        return socket;
      },
      timing: { pingIntervalMs: 1_000_000, requestTimeoutMs: 50 },
    });
    const host = client('host'), a = client('a'), b = client('b');
    let heldRequest: Envelope | undefined;
    host.onFrame((frame) => {
      if (frame.kind === 'link-open') host.sendLinkAccept(frame.src!, frame.id!, {
        appVersion: 'test', allowlistHash: 'test', capabilities: [DEVICE_LINK_CAPABILITY_RELIABLE_TRANSPORT],
      });
      if (frame.kind === 'invoke') {
        if (frame.src === 'b') heldRequest = frame;
        else {
          // First request reaches host, but A then stops receiving/ACKing.
          if (!values.host?.error) silentA = true;
          host.sendInvokeResult('a', frame.id!, { ok: true, result: catalog('recovered') });
        }
      }
    });
    try {
      host.start(); a.start(); b.start();
      await advance(0);
      for (const socket of sockets.values()) socket.emit('open');
      await advance(0);
      const opening = Promise.all([a, b].map((controller) => controller.openLink('host', {
        controllerName: 'test-controller', protocolVersion: PROTOCOL_VERSION, appVersion: 'test',
      })));
      await advance(0); await opening;
      const bGeneration = b.getPeerLinkGeneration('host');
      const hostGeneration = host.getPeerLinkGeneration('b');
      const pending = b.invoke('host', { channel: 'local-db:sessions:list', args: [] }, 10_000);
      void pending.catch(() => undefined);
      const settled = vi.fn(); void pending.then(settled, settled);
      const read = vi.fn(async () => {
        const result = await a.invoke('host', { channel: 'maker:provider:list', args: [] }, values.host?.error ? 5_000 : 50);
        if (!result.ok) throw new Error(result.error?.message);
        return result.result;
      });
      state.makers.set('host', { listProviders: read });
      await render('host');
      await advance(50);
      expect(values.host.ready).toBe(false);
      expect(values.host.error).toContain('TIMEOUT');
      silentA = false;
      await advance(900);
      // Allow the reliable stream to replay the lost earlier response first.
      await advance(3_000);
      expect(values.host.ready).toBe(true);
      expect(read).toHaveBeenCalledTimes(2);
      expect(settled).not.toHaveBeenCalled();
      expect(b.isLinkReady('host')).toBe(true);
      expect(host.isLinkReady('b')).toBe(true);
      expect(b.getPeerLinkGeneration('host')).toBe(bGeneration);
      expect(host.getPeerLinkGeneration('b')).toBe(hostGeneration);
      for (const socket of sockets.values()) expect(socket.close).not.toHaveBeenCalled();
      host.sendInvokeResult('b', heldRequest!.id!, { ok: true, result: ['uninterrupted'] });
      await advance(0);
      expect(await pending).toEqual({ ok: true, result: ['uninterrupted'] });
    } finally {
      await act(async () => root.render(null));
      a.stop(); b.stop(); host.stop();
    }
  });

  it('recovers without a new relay epoch and leaves another device untouched', async () => {
    const read = state.makers.get('a')!.listProviders;
    await render('a', false, true);
    expect(values.a.ready).toBe(false);
    expect(values.a.error).toContain('TIMEOUT');
    read.mockResolvedValue(catalog('recovered'));
    await advance(900);
    expect(values.a.ready).toBe(true);
    expect(values.a.error).toBeNull();
    expect(values.a.providers[0].id).toBe('recovered');
    expect(state.makers.get('b')!.listProviders).toHaveBeenCalledTimes(1);
    expect(values.b.ready).toBe(true);
    expect(state.context.connectionEpoch).toBe(1);
    await advance(60_000);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('reopening a failed picker retries immediately, including a retained stale cache', async () => {
    const read = state.makers.get('a')!.listProviders;
    read.mockResolvedValue(catalog('old'));
    await render();
    await act(async () => {
      await fetchDeviceProvidersFresh('a', async () => { throw timeout(); }).catch(() => undefined);
    });
    expect(values.a.ready).toBe(false);
    read.mockResolvedValue(catalog('new'));
    await render('a', true);
    await advance(0);
    expect(values.a.providers[0].id).toBe('new');
    expect(values.a.error).toBeNull();
  });

  it('backs off repeated failures and pauses in background', async () => {
    const read = state.makers.get('a')!.listProviders;
    await render();
    await advance(900);
    expect(read).toHaveBeenCalledTimes(2);
    await advance(1799);
    expect(read).toHaveBeenCalledTimes(2);
    await advance(1);
    expect(read).toHaveBeenCalledTimes(3);
    await foreground('background');
    await advance(60_000);
    expect(read).toHaveBeenCalledTimes(3);
    read.mockResolvedValue(catalog('back'));
    await foreground('active');
    await advance(0);
    expect(values.a.ready).toBe(true);
  });

  it('waits for peer recovery, then retries without waiting for relay reconnect', async () => {
    state.context.recoveringDeviceIds.add('a');
    const read = state.makers.get('a')!.listProviders;
    await render();
    await advance(60_000);
    expect(read).toHaveBeenCalledTimes(1);
    state.context.recoveringDeviceIds.delete('a');
    read.mockResolvedValue(catalog('back'));
    await render();
    await advance(900);
    expect(values.a.ready).toBe(true);
  });

  it.each(['ACCESS_REVOKED', 'CHANNEL_NOT_ALLOWED', 'PERMISSION_DENIED'])('does not retry %s', async (code) => {
    const read = state.makers.get('a')!.listProviders;
    read.mockRejectedValue(new Error(`[${code}] denied`));
    await render('a', true);
    await advance(60_000);
    expect(read).toHaveBeenCalledTimes(1);
    expect(values.a.ready).toBe(false);
  });

  it.each([
    '[MODEL_VISIBILITY_NOT_READY] pending',
    "Error invoking remote method 'maker:provider:list': Error: [MODEL_VISIBILITY_NOT_READY] pending",
  ])('continues recovery after preference readiness exhausts short retries: %s', async (message) => {
    const read = state.makers.get('a')!.listProviders;
    read.mockRejectedValue(new Error(message));
    await render();
    await advance(750);
    expect(values.a.error).toContain('MODEL_VISIBILITY_NOT_READY');
    read.mockResolvedValue(catalog('ready'));
    await advance(900);
    expect(values.a.ready).toBe(true);
  });

  it('keeps backoff when transient error details change, even with the picker open', async () => {
    const read = state.makers.get('a')!.listProviders;
    let sequence = 0;
    read.mockImplementation(async () => { throw new Error(`[DEVICE_LINK_TIMEOUT] request ${++sequence}`); });
    await render('a', true);
    await advance(0);
    expect(read).toHaveBeenCalledTimes(2);
    await advance(899);
    expect(read).toHaveBeenCalledTimes(2);
    await advance(1);
    expect(read).toHaveBeenCalledTimes(3);
    await advance(1799);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('recovers a previously unresponsive device through the same delayed read', async () => {
    const read = state.makers.get('a')!.listProviders;
    read.mockRejectedValue(new Error('[DEVICE_UNRESPONSIVE] probe pending'));
    await render();
    read.mockResolvedValue(catalog('responsive'));
    await advance(900);
    expect(values.a.ready).toBe(true);
  });

  it('shares the retry with another consumer and stops scheduling after unmount', async () => {
    const read = state.makers.get('a')!.listProviders;
    await act(async () => root.render(createElement('div', null,
      createElement(Probe, { deviceId: 'a', open: false }),
      createElement(Probe, { deviceId: 'a', open: false }),
    )));
    let reject!: (error: Error) => void;
    read.mockImplementation(() => new Promise((_, fail) => { reject = fail; }));
    await advance(900);
    expect(read).toHaveBeenCalledTimes(2);
    await act(async () => root.render(null));
    await act(async () => reject(timeout()));
    await advance(60_000);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('does not schedule catalog retries while the relay is offline', async () => {
    const read = state.makers.get('a')!.listProviders;
    state.context.status = 'connecting';
    await render('a', true);
    await advance(60_000);
    expect(read).toHaveBeenCalledTimes(1);
    state.context.status = 'online';
    state.context.connectionEpoch++;
    read.mockResolvedValue(catalog('online'));
    await render('a', true);
    await advance(900);
    expect(values.a.ready).toBe(true);
  });

  it('cancels scheduled retries on device change and ignores late results in the new device UI', async () => {
    const read = state.makers.get('a')!.listProviders;
    await render();
    let resolve!: (value: ReturnType<typeof catalog>) => void;
    read.mockImplementation(() => new Promise((done) => { resolve = done; }));
    await advance(900);
    await render('b');
    await act(async () => resolve(catalog('late-a')));
    await advance(60_000);
    expect(values.b.providers[0].id).toBe('b');
    expect(read).toHaveBeenCalledTimes(2);
  });
});
