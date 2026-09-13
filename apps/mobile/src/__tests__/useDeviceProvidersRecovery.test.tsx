// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderView } from '@cindy/model-providers/registry';
import { useDeviceProviders, type UseDeviceProvidersResult } from '@/device-link/useDeviceProviders';
import { clearAllDeviceProviders, fetchDeviceProvidersFresh } from '@/device-link/deviceProvidersCache';

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

  it('continues recovery after model preference readiness exhausts its short retries', async () => {
    const read = state.makers.get('a')!.listProviders;
    read.mockRejectedValue(new Error('[MODEL_VISIBILITY_NOT_READY] pending'));
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
