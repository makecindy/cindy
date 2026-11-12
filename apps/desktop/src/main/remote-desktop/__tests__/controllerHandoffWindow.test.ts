import { describe, expect, it, vi } from 'vitest';
import type { RemoteDesktopLease } from '@cindy/device-link';
import {
  RemoteDesktopController,
  type DesktopControllerDeps,
  type DesktopHandoffWindow,
} from '../controller';

const target: DesktopHandoffWindow = {
  requestId: 'req1',
  windowId: 4242,
  pid: 77,
  displayId: '2',
  app: 'Game',
  title: 'Sign in',
  width: 800,
  height: 600,
};

function harness(pending: DesktopHandoffWindow | null = target) {
  const deps: DesktopControllerDeps = {
    authorized: () => true,
    capabilities: async () => ({
      version: 1,
      enabled: true,
      canControl: true,
      platform: 'darwin',
      displays: [
        { id: '1', name: 'Main', width: 1920, height: 1080 },
        { id: '2', name: 'Side', width: 1440, height: 900 },
      ],
    }),
    frame: vi.fn(async () => 'jpeg'),
    startInput: vi.fn(async () => {}),
    handoffWindow: vi.fn(async (requestId: string) =>
      pending && pending.requestId === requestId ? pending : null,
    ),
    input: vi.fn(),
    stopInput: vi.fn(),
    stopVideo: vi.fn(),
    offer: vi.fn(async () => 'answer'),
    lockScreen: vi.fn(async () => {}),
    clipboard: vi.fn(async () => 'host clipboard'),
    displayModes: vi.fn(async () => []),
    changed: vi.fn(),
  };
  const controller = new RemoteDesktopController(deps);
  const open = (extra: Record<string, unknown> = {}) =>
    controller.request('phone', {
      op: 'start',
      displayId: '1',
      handoff: 'req1',
      ...extra,
    }) as Promise<RemoteDesktopLease>;
  return { controller, deps, open };
}

describe('代输入 live view leases', () => {
  it('advertises the window view and opens the window the host picks, at its shape', async () => {
    const h = harness();
    const caps = (await h.controller.request('phone', { op: 'capabilities' })) as {
      handoffWindow?: boolean;
    };
    expect(caps.handoffWindow).toBe(true);
    const lease = await h.open({ control: true });
    expect(h.deps.handoffWindow).toHaveBeenCalledWith('req1', 'phone');
    expect(lease.display).toMatchObject({ id: '2', width: 800, height: 600 });
    expect(lease.window).toEqual({ app: 'Game', title: 'Sign in' });
    expect(lease.controlling).toBe(true);
    // Input is confined to the window from the first event.
    expect(h.deps.startInput).toHaveBeenCalledWith('2', target);
    expect(h.controller.handoffWindow(lease.lease)).toEqual(target);
  });

  it('refuses a request that is not waiting for the owner, and hosts without the view', async () => {
    await expect(harness(null).open()).rejects.toThrow('DESKTOP_HANDOFF_ENDED');
    const h = harness();
    delete h.deps.handoffWindow;
    const caps = (await h.controller.request('phone', { op: 'capabilities' })) as object;
    expect(caps).not.toHaveProperty('handoffWindow');
    await expect(h.open()).rejects.toThrow('DESKTOP_HANDOFF_UNAVAILABLE');
    expect(h.controller.state).toBeNull();
  });

  it('allows only what stays inside the window', async () => {
    const h = harness();
    const { lease } = await h.open({ control: true });
    for (const request of [
      { op: 'clipboard', lease, action: 'copy' },
      { op: 'displayModes', lease },
      { op: 'privacyScreen', lease, enabled: true },
      { op: 'windowAction', lease, action: 'desktop' },
      { op: 'viewerDisplay', lease, width: 1280, height: 720 },
    ])
      await expect(h.controller.request('phone', request)).rejects.toThrow(
        'DESKTOP_HANDOFF_WINDOW_ONLY',
      );
    expect(h.deps.clipboard).not.toHaveBeenCalled();
    expect(h.deps.displayModes).not.toHaveBeenCalled();
    await h.controller.request('phone', { op: 'input', lease, sequence: 1, events: [{ kind: 'move', x: 0.5, y: 0.5 }] });
    expect(h.deps.input).toHaveBeenCalledOnce();
    expect(await h.controller.request('phone', { op: 'heartbeat', lease, lockOnExit: true })).toEqual({
      controlling: true,
    });
    // Leaving a look at one window never locks the computer.
    await h.controller.request('phone', { op: 'stop', lease, lockScreen: true });
    expect(h.deps.lockScreen).not.toHaveBeenCalled();
    expect(h.controller.state).toBeNull();
  });

  it('resumes only as the same request, and ends when the request ends', async () => {
    const h = harness();
    const first = await h.open();
    const resumed = await h.open({ resume: true });
    expect(resumed.lease).not.toBe(first.lease);
    expect(h.controller.handoffWindow(resumed.lease)).toEqual(target);
    await expect(
      h.controller.request('phone', { op: 'start', displayId: '2', resume: true }),
    ).rejects.toThrow('DESKTOP_BUSY');
    h.controller.endHandoff('another');
    expect(h.controller.state).not.toBeNull();
    h.controller.endHandoff('req1');
    expect(h.controller.state).toBeNull();
  });

  it('ends with the request, and tells the card when the view closes', async () => {
    const h = harness();
    let waiting = true;
    const ended: string[] = [];
    h.deps.handoffCurrent = () => waiting;
    h.deps.handoffEnded = (requestId) => ended.push(requestId);
    await h.open();
    h.controller.tick();
    expect(h.controller.state).not.toBeNull();
    waiting = false;
    h.controller.tick();
    expect(h.controller.state).toBeNull();
    expect(ended).toEqual(['req1']);
    // A whole-display lease is not a 代输入 view and says nothing.
    await h.controller.request('phone', { op: 'start', displayId: '1' });
    await h.controller.stop();
    expect(ended).toEqual(['req1']);
  });
});
