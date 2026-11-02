import { describe, expect, it, vi } from 'vitest';
import type { RemoteDesktopLease, RemoteLiveScreen } from '@cindy/device-link';
import { RemoteDesktopController, type DesktopControllerDeps } from '../controller';

vi.mock('../../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), warn: vi.fn() }),
}));

const listed: RemoteLiveScreen = {
  plugin: 'sim',
  pluginName: 'Simulator',
  id: 'UDID-1',
  name: 'iPhone 17',
  platform: 'ios',
  state: 'running',
  taskIds: ['task-1'],
};
const screen = {
  plugin: 'sim',
  id: 'UDID-1',
  name: 'iPhone 17',
  platform: 'ios' as const,
  cornerRadius: 0.13,
  maxTouches: 2,
  keyboard: true,
  buttons: [{ id: 'home', icon: 'home' as const, label: 'Home' }],
};

function harness(screenRecording: 'granted' | 'missing' = 'granted') {
  let ended: (() => void) | null = null;
  let shape: { width: number; height: number } | null = null;
  const liveScreens = {
    list: vi.fn(async () => [listed]),
    open: vi.fn(async (_plugin: string, _id: string, onEnded: () => void) => {
      ended = onEnded;
      return { screen, width: 1179, height: 2556, shape: () => shape };
    }),
    close: vi.fn(),
  };
  const deps: DesktopControllerDeps = {
    authorized: () => true,
    capabilities: async () => ({
      version: 1,
      enabled: true,
      canControl: true,
      platform: 'darwin',
      displays: [{ id: '1', name: 'Main', width: 1920, height: 1080 }],
      permissions: { screenRecording, accessibility: 'missing' },
    }),
    frame: vi.fn(async () => 'jpeg'),
    startInput: vi.fn(async () => {}),
    input: vi.fn(),
    stopInput: vi.fn(),
    stopVideo: vi.fn(),
    lockScreen: vi.fn(async () => {}),
    offer: vi.fn(async () => 'answer'),
    changed: vi.fn(),
    liveScreens,
  };
  const controller = new RemoteDesktopController(deps);
  const start = (extra: Record<string, unknown> = {}) =>
    controller.request('phone', {
      op: 'start',
      displayId: 'live-screen',
      screen: { plugin: 'sim', id: 'UDID-1' },
      ...extra,
    }) as Promise<RemoteDesktopLease>;
  return {
    controller,
    deps,
    liveScreens,
    start,
    end: () => ended?.(),
    turn: (next: typeof shape) => {
      shape = next;
    },
  };
}

describe('live screen leases', () => {
  it('advertises and lists screens only with a provider, after authorization', async () => {
    const h = harness();
    expect(await h.controller.request('phone', { op: 'capabilities' })).toMatchObject({
      liveScreens: true,
    });
    expect(await h.controller.request('phone', { op: 'screens' })).toEqual({ screens: [listed] });
    const plain = new RemoteDesktopController({ ...h.deps, liveScreens: undefined });
    expect(await plain.request('phone', { op: 'capabilities' })).not.toHaveProperty('liveScreens');
    await expect(plain.request('phone', { op: 'screens' })).rejects.toThrow(
      'DESKTOP_SCREEN_UNAVAILABLE',
    );
    const revoked = new RemoteDesktopController({ ...h.deps, authorized: () => false });
    await expect(revoked.request('phone', { op: 'screens' })).rejects.toThrow('DESKTOP_DISABLED');
  });

  it('starts as the screen it was asked for, with control and no desktop permission or input helper', async () => {
    const h = harness('missing');
    const lease = await h.start({ control: true });
    expect(h.liveScreens.open).toHaveBeenCalledWith('sim', 'UDID-1', expect.any(Function));
    expect(lease).toMatchObject({
      controlling: true,
      screen,
      display: { id: 'live-screen:UDID-1', name: 'iPhone 17', width: 1179, height: 2556 },
    });
    expect(h.deps.startInput).not.toHaveBeenCalled();
    expect(h.controller.liveScreen(lease.lease)).toEqual(screen);
  });

  it('passes device input to the host and refuses desktop pointers, and the reverse for desktops', async () => {
    const h = harness();
    const { lease } = await h.start({ control: true });
    const touch = { kind: 'touch', touches: [{ id: 0, x: 0.5, y: 0.5, phase: 'began' }] };
    h.controller.input(lease, 1, [
      touch,
      { kind: 'press', button: 'home' },
      { kind: 'text', text: '你好' },
    ]);
    expect(h.deps.input).toHaveBeenCalledOnce();
    expect(() => h.controller.input(lease, 2, [{ kind: 'move', x: 0, y: 0 }])).toThrow(
      'INVALID_REQUEST',
    );

    const desktop = harness();
    const plain = (await desktop.controller.request('phone', {
      op: 'start',
      displayId: '1',
      control: true,
    })) as RemoteDesktopLease;
    expect(() => desktop.controller.input(plain.lease, 1, [touch])).toThrow('INVALID_REQUEST');
  });

  it('allows only operations that stay on the screen', async () => {
    const h = harness();
    const { lease } = await h.start({ control: true });
    // The relay still picture is never the desktop: a viewer polling it just gets nothing.
    expect(await h.controller.request('phone', { op: 'frame', lease })).toEqual({ jpeg: null });
    expect(h.deps.frame).not.toHaveBeenCalled();
    for (const request of [
      { op: 'clipboard', lease, action: 'copy' },
      { op: 'displayModes', lease },
      { op: 'privacyScreen', lease, enabled: true },
      { op: 'windowAction', lease, action: 'list' },
    ])
      await expect(h.controller.request('phone', request)).rejects.toThrow('DESKTOP_SCREEN_ONLY');
    expect(
      await h.controller.request('phone', { op: 'heartbeat', lease, lockOnExit: true }),
    ).toEqual({
      controlling: true,
    });
    // Once the screen describes itself, heartbeats carry what it shows now.
    h.turn({ width: 2556, height: 1179 });
    expect(await h.controller.request('phone', { op: 'heartbeat', lease })).toEqual({
      controlling: true,
      shape: { width: 2556, height: 1179 },
    });
    // Ending a look at a simulator never locks the computer.
    await h.controller.request('phone', { op: 'stop', lease, lockScreen: true });
    expect(h.deps.lockScreen).not.toHaveBeenCalled();
    expect(h.liveScreens.close).toHaveBeenCalledOnce();
    expect(h.controller.state).toBeNull();
  });

  it('keeps one remote lease per computer: busy without takeover, replaced with it', async () => {
    const h = harness();
    await h.controller.request('phone', { op: 'start', displayId: '1' });
    await expect(h.start()).rejects.toThrow('DESKTOP_BUSY');
    expect(h.liveScreens.open).not.toHaveBeenCalled();
    const lease = await h.start({ takeover: true });
    expect(lease.screen?.id).toBe('UDID-1');
    expect(h.deps.stopVideo).toHaveBeenCalled();
    // A desktop takeover ends the screen and closes it in the plugin.
    await h.controller.request('phone', { op: 'start', displayId: '1', takeover: true });
    expect(h.liveScreens.close).toHaveBeenCalledOnce();
  });

  it('ends the lease when the plugin drops the screen, and never keeps a lease whose open failed', async () => {
    const h = harness();
    await h.start();
    h.end();
    await Promise.resolve();
    expect(h.controller.state).toBeNull();

    h.liveScreens.open.mockRejectedValueOnce(new Error('DESKTOP_SCREEN_NOT_RUNNING'));
    await expect(h.start()).rejects.toThrow('DESKTOP_SCREEN_NOT_RUNNING');
    expect(h.controller.state).toBeNull();
  });
});
