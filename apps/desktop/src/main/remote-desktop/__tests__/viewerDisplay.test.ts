import { describe, expect, it, vi } from 'vitest';
import { RemoteDesktopController, type DesktopControllerDeps } from '../controller';
import type { RemoteDesktopLease } from '@cindy/device-link';
import type { ViewerDisplayHandle } from '../viewerDisplay';

function fixture() {
  const handle: ViewerDisplayHandle = {
    displayId: '2',
    resize: vi.fn(async (width, height) => ({ id: '2', name: 'Viewer', width, height })),
    restore: vi.fn(async () => ({ id: '1', name: 'Main', width: 1920, height: 1080 })),
    dispose: vi.fn(),
  };
  const deps: DesktopControllerDeps = {
    authorized: () => true,
    capabilities: async () => ({
      version: 1,
      enabled: true,
      canControl: true,
      platform: 'darwin',
      displays: [{ id: '1', name: 'Main', width: 1920, height: 1080 }],
    }),
    frame: vi.fn(async () => 'jpeg'),
    startInput: vi.fn(async () => {}),
    input: vi.fn(),
    stopInput: vi.fn(),
    stopVideo: vi.fn(),
    offer: vi.fn(async () => 'answer'),
    changed: vi.fn(),
    createViewerDisplay: vi.fn(async () => handle),
  };
  const host = new RemoteDesktopController(deps);
  const start = async (control = true) => {
    const lease = (await host.request('phone', {
      op: 'start',
      displayId: '1',
    })) as RemoteDesktopLease;
    if (control) await host.request('phone', { op: 'control', lease: lease.lease, enabled: true });
    return lease;
  };
  return { host, deps, handle, start };
}

describe('viewer-sized desktop ownership', () => {
  it('hides the helper display during and across stopped-lease restoration', async () => {
    const f = fixture();
    const lease = await f.start();
    await f.host.request('phone', {
      op: 'viewerDisplay',
      lease: lease.lease,
      width: 900,
      height: 1600,
    });
    const caps = await f.deps.capabilities();
    caps.displays.push({ id: '2', name: 'Viewer', width: 900, height: 1600 });
    f.deps.capabilities = async () => caps;
    let finish!: () => void;
    f.handle.restore = () =>
      new Promise((resolve) => {
        finish = () => resolve(lease.display);
      });
    f.host.stop('phone');
    expect(await f.host.request('other', { op: 'capabilities' })).toMatchObject({
      displays: [{ id: '1' }],
    });
    let read!: () => void;
    f.deps.capabilities = () =>
      new Promise((resolve) => {
        read = () => resolve(caps);
      });
    const pending = f.host.request('other', { op: 'capabilities' });
    finish();
    await Promise.resolve();
    await Promise.resolve();
    read();
    expect(await pending).toMatchObject({ displays: [{ id: '1' }] });
  });
  it('retires the handle when the source display was unplugged', async () => {
    const f = fixture(),
      lease = await f.start();
    await f.host.request('phone', {
      op: 'viewerDisplay',
      lease: lease.lease,
      width: 900,
      height: 1600,
    });
    const restore = vi.mocked(f.handle.restore!);
    restore.mockResolvedValue({ id: '1', name: 'Display', width: 0, height: 0 });
    await f.host.request('phone', { op: 'control', lease: lease.lease, enabled: true });
    await f.host.request('phone', { op: 'restoreViewerDisplay', lease: lease.lease });
    expect(restore).toHaveBeenCalledOnce();
  });
  it('enumerates source modes across matching, repeated resizing and restoration', async () => {
    const f = fixture(),
      lease = await f.start();
    const modes = [{ id: '400', width: 3840, height: 2160, current: false }];
    f.deps.displayModes = vi.fn(async (id) => (id === '1' ? modes : []));
    for (const op of ['viewerDisplay', 'viewerDisplay', 'restoreViewerDisplay'] as const) {
      await f.host.request('phone', { op: 'control', lease: lease.lease, enabled: true });
      await f.host.request('phone', { op, lease: lease.lease, width: 900, height: 1600 });
      expect(await f.host.request('phone', { op: 'displayModes', lease: lease.lease })).toEqual(
        modes,
      );
      expect(f.deps.displayModes).toHaveBeenLastCalledWith('1');
    }
  });

  it.each(['success', 'cancel', 'failure'] as const)(
    'restores before applying a system mode to the source (%s)',
    async (outcome) => {
      const f = fixture(),
        lease = await f.start();
      await f.host.request('phone', {
        op: 'viewerDisplay',
        lease: lease.lease,
        width: 900,
        height: 1600,
      });
      await f.host.request('phone', { op: 'control', lease: lease.lease, enabled: true });
      let settle!: () => void;
      const restoration = new Promise<RemoteDesktopLease['display']>((resolve, reject) => {
        settle = () =>
          outcome === 'failure' ? reject(new Error('RESTORE_FAILED')) : resolve(lease.display);
      });
      f.handle.restore = vi.fn(() => restoration);
      f.deps.resolution = vi.fn(async (_id, _mode, beforeChange) => beforeChange());
      const pending = f.host.request('phone', {
        op: 'resolution',
        lease: lease.lease,
        modeId: '400',
      });
      expect(f.deps.resolution).not.toHaveBeenCalled();
      await expect(
        f.host.request('other', { op: 'start', displayId: '1', takeover: true }),
      ).rejects.toThrow('DESKTOP_BUSY');
      if (outcome === 'cancel') f.host.stop('phone');
      settle();
      if (outcome === 'success') {
        await pending;
        expect(f.deps.resolution).toHaveBeenCalledWith('1', '400', expect.any(Function));
        expect(f.handle.restore).toHaveBeenCalledOnce();
      } else {
        await expect(pending).rejects.toThrow(
          outcome === 'cancel' ? 'DESKTOP_LEASE_EXPIRED' : 'RESTORE_FAILED',
        );
        expect(f.deps.resolution).not.toHaveBeenCalled();
      }
      expect(f.host.state).toBeNull();
    },
  );

  it.each([false, true])(
    'waits for restored geometry before starting a new lease (takeover=%s)',
    async (takeover) => {
      const f = fixture(),
        lease = await f.start();
      await f.host.request('phone', {
        op: 'viewerDisplay',
        lease: lease.lease,
        width: 900,
        height: 1600,
      });
      let finish!: () => void;
      let restored = false;
      f.deps.capabilities = async () => ({
        version: 1,
        enabled: true,
        canControl: true,
        platform: 'darwin',
        displays: [
          { id: '1', name: 'Main', width: restored ? 1920 : 900, height: restored ? 1080 : 1600 },
        ],
      });
      f.handle.restore = vi.fn(
        () =>
          new Promise<RemoteDesktopLease['display']>((resolve) => {
            finish = () => {
              restored = true;
              resolve({ id: '1', name: 'Main', width: 1920, height: 1080 });
            };
          }),
      );
      if (!takeover) f.host.stop('phone');
      const pending = f.host.request('other', { op: 'start', displayId: '1', takeover });
      await Promise.resolve();
      expect(f.host.state).toBeNull();
      expect(f.handle.restore).toHaveBeenCalledOnce();
      await expect(f.host.request('third', { op: 'start', displayId: '1' })).rejects.toThrow(
        'DESKTOP_BUSY',
      );
      finish();
      const next = (await pending) as RemoteDesktopLease;
      expect(next.display).toMatchObject({ id: '1', width: 1920, height: 1080 });
      expect(f.host.hasLease(next.lease)).toBe(true);
    },
  );

  it('retains failed restoration for retry and does not accept a stale display', async () => {
    const f = fixture(),
      lease = await f.start();
    await f.host.request('phone', {
      op: 'viewerDisplay',
      lease: lease.lease,
      width: 900,
      height: 1600,
    });
    vi.mocked(f.handle.restore!).mockRejectedValueOnce(new Error('DISPLAY_NOT_RESTORED'));
    f.host.stop();
    await expect(f.start()).rejects.toThrow('DISPLAY_NOT_RESTORED');
    expect(f.host.state).toBeNull();
    await f.start();
    expect(f.handle.restore).toHaveBeenCalledTimes(2);
  });
  it('finishes restoration on exit without waiting for another connection', async () => {
    const f = fixture(),
      lease = await f.start();
    await f.host.request('phone', {
      op: 'viewerDisplay',
      lease: lease.lease,
      width: 900,
      height: 1600,
    });
    f.host.stop();
    await Promise.resolve();
    await Promise.resolve();
    expect(f.handle.restore).toHaveBeenCalledOnce();
    // Later local display changes must not trigger restoration of an already retired handle.
    vi.mocked(f.handle.restore!).mockRejectedValue(new Error('LOCAL_MODE_CHANGED'));
    await f.start();
    expect(f.handle.restore).toHaveBeenCalledOnce();
  });
  it('waits for held inputs to release and cancels before creating a display after disconnect', async () => {
    const f = fixture(),
      lease = await f.start();
    let release!: () => void;
    f.deps.releaseInput = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    const pending = f.host.request('phone', {
      op: 'viewerDisplay',
      lease: lease.lease,
      width: 900,
      height: 1600,
    });
    expect(f.deps.createViewerDisplay).not.toHaveBeenCalled();
    f.host.stop('phone');
    release();
    await expect(pending).rejects.toThrow('DESKTOP_LEASE_EXPIRED');
    expect(f.deps.createViewerDisplay).not.toHaveBeenCalled();
  });
  it('keeps the lease, replaces geometry and requires fresh control before input', async () => {
    const f = fixture(),
      lease = await f.start();
    const result = await f.host.request('phone', {
      op: 'viewerDisplay',
      lease: lease.lease,
      width: 900,
      height: 1600,
    });
    expect(result).toEqual({
      lease: lease.lease,
      display: { id: '2', name: 'Viewer', width: 900, height: 1600 },
      controlling: false,
    });
    expect(f.host.hasLease(lease.lease)).toBe(true);
    await expect(
      f.host.request('phone', {
        op: 'input',
        lease: lease.lease,
        sequence: 1,
        events: [{ kind: 'move', x: 0.5, y: 0.5 }],
      }),
    ).rejects.toThrow('DESKTOP_VIEW_ONLY');
    await f.host.request('phone', { op: 'control', lease: lease.lease, enabled: true });
    expect(f.deps.startInput).toHaveBeenLastCalledWith('2');
    await f.host.request('phone', {
      op: 'viewerDisplay',
      lease: lease.lease,
      width: 1600,
      height: 900,
    });
    expect(f.deps.createViewerDisplay).toHaveBeenCalledTimes(1);
    f.host.stop();
    expect(f.handle.dispose).toHaveBeenCalledOnce();
  });

  it('restores the original display without replacing the lease and can match again', async () => {
    const f = fixture(),
      lease = await f.start();
    await f.host.request('phone', {
      op: 'viewerDisplay',
      lease: lease.lease,
      width: 900,
      height: 1600,
    });
    await expect(
      f.host.request('phone', { op: 'restoreViewerDisplay', lease: lease.lease }),
    ).rejects.toThrow('DESKTOP_VIEW_ONLY');
    await f.host.request('phone', { op: 'control', lease: lease.lease, enabled: true });
    const result = await f.host.request('phone', {
      op: 'restoreViewerDisplay',
      lease: lease.lease,
    });
    expect(result).toEqual({
      lease: lease.lease,
      controlling: false,
      display: { id: '1', name: 'Main', width: 1920, height: 1080 },
    });
    expect(f.handle.restore).toHaveBeenCalledOnce();
    expect(f.host.hasLease(lease.lease)).toBe(true);
    expect(f.host.displayGeometryMatches('1', 1920, 1080)).toBe(true);
    await f.host.request('phone', { op: 'control', lease: lease.lease, enabled: true });
    await f.host.request('phone', {
      op: 'viewerDisplay',
      lease: lease.lease,
      width: 1600,
      height: 900,
    });
    expect(f.deps.createViewerDisplay).toHaveBeenCalledTimes(2);
  });

  it('rejects view-only and foreign peers without changing displays', async () => {
    const f = fixture(),
      lease = await f.start(false);
    const request = { op: 'viewerDisplay', lease: lease.lease, width: 900, height: 1600 };
    await expect(f.host.request('phone', request)).rejects.toThrow('DESKTOP_VIEW_ONLY');
    await expect(f.host.request('other', request)).rejects.toThrow('DESKTOP_LEASE_EXPIRED');
    expect(f.deps.createViewerDisplay).not.toHaveBeenCalled();
  });

  it('disposes a late native handle after disconnect and cannot revive the lease', async () => {
    const f = fixture(),
      lease = await f.start();
    let resolve!: (handle: ViewerDisplayHandle) => void;
    f.deps.createViewerDisplay = () =>
      new Promise((done) => {
        resolve = done;
      });
    const pending = f.host.request('phone', {
      op: 'viewerDisplay',
      lease: lease.lease,
      width: 900,
      height: 1600,
    });
    f.host.stop('phone');
    resolve(f.handle);
    await expect(pending).rejects.toThrow('DESKTOP_LEASE_EXPIRED');
    expect(f.handle.dispose).toHaveBeenCalledOnce();
    expect(f.handle.resize).not.toHaveBeenCalled();
    expect(f.host.state).toBeNull();
  });

  it('drops old geometry input/frames while resizing and bounds concurrent changes', async () => {
    const f = fixture(),
      lease = await f.start();
    let finish!: () => void;
    f.handle.resize = () =>
      new Promise((resolve) => {
        finish = () => resolve({ id: '2', name: 'Viewer', width: 900, height: 1600 });
      });
    const request = { op: 'viewerDisplay', lease: lease.lease, width: 900, height: 1600 };
    const pending = f.host.request('phone', request);
    await Promise.resolve();
    expect(f.host.changingDisplay).toBe(true);
    await expect(f.host.request('phone', request)).rejects.toThrow('DESKTOP_DISPLAY_BUSY');
    await expect(
      f.host.request('other', { op: 'start', displayId: '1', takeover: true }),
    ).rejects.toThrow('DESKTOP_BUSY');
    f.host.input(lease.lease, 1, [{ kind: 'move', x: 0.5, y: 0.5 }]);
    expect(f.deps.input).not.toHaveBeenCalled();
    expect(await f.host.request('phone', { op: 'frame', lease: lease.lease })).toEqual({
      jpeg: null,
    });
    finish();
    await pending;
    expect(f.host.changingDisplay).toBe(false);
  });

  it('ends the lease and releases the temporary display on native failure', async () => {
    const f = fixture(),
      lease = await f.start();
    f.handle.resize = async () => {
      throw new Error('DISPLAY_MIRROR_FAILED');
    };
    await expect(
      f.host.request('phone', {
        op: 'viewerDisplay',
        lease: lease.lease,
        width: 900,
        height: 1600,
      }),
    ).rejects.toThrow();
    expect(f.handle.dispose).toHaveBeenCalledOnce();
    expect(f.host.state).toBeNull();
  });
});
