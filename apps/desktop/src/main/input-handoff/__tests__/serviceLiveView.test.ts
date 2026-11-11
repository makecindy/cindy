import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InputHandoffSnapshot } from '@cindy/device-link';
import { InputHandoffService } from '../service.js';
import { fakeDesktop } from './fakeDesktop.js';

const services: InputHandoffService[] = [];
afterEach(() => services.splice(0).forEach((s) => s.cleanupAll()));

function harness(options: { live?: boolean; allowed?: boolean } = {}) {
  const desktop = fakeDesktop({ live: options.live ?? true });
  const snapshots: InputHandoffSnapshot[] = [];
  const allowed = options.allowed ?? true;
  let clock = 0;
  const service = new InputHandoffService({
    broadcast: (_channel, payload) => {
      const request = (payload as { request?: InputHandoffSnapshot }).request;
      if (request) snapshots.push(request);
    },
    createDriver: () => desktop.driver,
    hostPid: 1,
    remoteInputAvailable: () => true,
    liveViewAvailable: () => allowed,
    continueAgent: async () => {},
    terminalRetentionMs: 0,
    sessionTiming: { now: () => clock, sleep: async (ms) => { clock += ms; }, finishingDelayMs: 5 },
  });
  services.push(service);
  const latest = () => snapshots[snapshots.length - 1]!;
  return { desktop, service, latest };
}

async function startReady(h: ReturnType<typeof harness>) {
  const started = h.service.start({ sessionId: 'task', purpose: 'Sign in to Example', target: { app: 'Example' } });
  if (!started.ok) throw new Error(started.errorCode);
  await vi.waitFor(() => expect(h.latest().phase).toBe('ready'));
  return started.requestId;
}

describe('代输入 live view of the window', () => {
  it('is offered while waiting and shows only the window the request is about', async () => {
    const h = harness();
    const requestId = await startReady(h);
    expect(h.latest().liveView).toBe(true);
    expect(await h.service.liveWindow(requestId)).toEqual({
      pid: 10,
      app: 'Example',
      title: 'Sign in',
      windowId: 910,
      frame: [0, 0, 800, 600],
    });
    expect(h.desktop.raised).toEqual([10]);
    expect(await h.service.liveWindow('some-other-request')).toBeNull();
  });

  it('is not offered where remote desktop is off, or the window cannot be singled out', async () => {
    const off = harness({ allowed: false });
    const requestId = await startReady(off);
    expect(off.latest().liveView).toBeUndefined();
    expect(await off.service.liveWindow(requestId)).toBeNull();
    expect(off.desktop.raised).toEqual([]);
    const none = harness({ live: false });
    expect(await none.service.liveWindow(await startReady(none))).toBeNull();
    expect(none.latest().liveView).toBeUndefined();
  });

  it('catches the card up after the owner works in the live view, and stops once the request ends', async () => {
    const h = harness();
    const requestId = await startReady(h);
    // In the live view the owner typed the account name and continued; the card still shows the old step.
    h.desktop.advanceOutside('password');
    h.service.liveViewEnded(requestId);
    await vi.waitFor(() =>
      expect(h.latest().controls.some((c) => 'label' in c && c.label === 'Password')).toBe(true),
    );
    expect(
      h.service.resolve(requestId, { kind: 'input_handoff', action: 'cancel', expectedRevision: h.latest().revision }),
    ).toBe(true);
    await vi.waitFor(() => expect(h.latest().terminal).toBe(true));
    expect(h.latest().liveView).toBeUndefined();
    expect(h.service.isCurrent(requestId)).toBe(false);
    expect(await h.service.liveWindow(requestId)).toBeNull();
  });
});
