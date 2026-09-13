import { describe, expect, it, vi } from 'vitest';
import { RemoteDesktopController, type DesktopControllerDeps } from '../controller';
import { acquireHumanDesktopInput, withAgentDesktopInput } from '../inputOwnership';
import { enumerateDesktopSources } from '../captureSource';
import type { RemoteDesktopIceReply, RemoteDesktopLease } from '@cindy/device-link';

function harness() {
  let now = 1000;
  let allowed = true;
  const deps: DesktopControllerDeps = {
    authorized: () => allowed,
    now: () => now,
    capabilities: async () => ({
      version: 1,
      enabled: allowed,
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
  };
  const controller = new RemoteDesktopController(deps);
  return {
    controller,
    deps,
    advance: (ms: number) => {
      now += ms;
    },
    revoke: () => {
      allowed = false;
    },
    start: async () =>
      controller.request('phone', { op: 'start', displayId: '1' }) as Promise<RemoteDesktopLease>,
  };
}
describe('remote desktop authority and lifecycle', () => {
  it('keeps viewing and peer isolation after native input fails, and allows explicit control recovery', async () => {
    const h = harness(),
      lease = await h.start();
    await h.controller.request('phone', { op: 'control', lease: lease.lease, enabled: true });
    h.controller.releaseControl();
    expect(h.controller.state).toEqual({ peer: 'phone', controlling: false });
    expect(h.deps.stopInput).toHaveBeenCalledOnce();
    expect(h.deps.stopVideo).not.toHaveBeenCalled();
    await expect(
      h.controller.request('phone', { op: 'heartbeat', lease: lease.lease }),
    ).resolves.toEqual({ controlling: false });
    await expect(
      h.controller.request('phone', { op: 'frame', lease: lease.lease }),
    ).resolves.toEqual({ jpeg: 'jpeg' });
    await expect(h.controller.request('other', { op: 'start', displayId: '1' })).rejects.toThrow(
      'DESKTOP_BUSY',
    );
    await expect(
      h.controller.request('phone', {
        op: 'input',
        lease: lease.lease,
        sequence: 1,
        events: [{ kind: 'move', x: 0.5, y: 0.5 }],
      }),
    ).rejects.toThrow('DESKTOP_VIEW_ONLY');
    await expect(
      h.controller.request('phone', { op: 'control', lease: lease.lease, enabled: true }),
    ).resolves.toEqual({ controlling: true });
    expect(h.deps.stopVideo).not.toHaveBeenCalled();
  });

  it('expires abandoned leases when the host status is polled', async () => {
    const h = harness();
    await h.start();
    h.advance(120_000);

    expect(h.controller.state).toBeNull();
    expect(h.deps.stopInput).toHaveBeenCalledOnce();
    expect(h.deps.stopVideo).toHaveBeenCalledOnce();
  });
  it('does not grant control after the native helper fails during startup', async () => {
    const h = harness(),
      lease = await h.start();
    let ready!: () => void;
    h.deps.startInput = () =>
      new Promise<void>((resolve) => {
        ready = resolve;
      });
    const starting = h.controller.request('phone', {
      op: 'control',
      lease: lease.lease,
      enabled: true,
    });
    h.controller.releaseControl();
    ready();
    await expect(starting).rejects.toThrow();
    expect(h.controller.state).toEqual({ peer: 'phone', controlling: false });
    expect(h.deps.stopVideo).not.toHaveBeenCalled();
  });

  it('locks only on explicit owner exit and blocks takeover until lock completes', async () => {
    const h = harness(), first = await h.start();
    let finish!: () => void;
    h.deps.lockScreen = vi.fn(async current => {
      expect(current()).toBe(true);
      await new Promise<void>(resolve => { finish = resolve; });
    });
    await expect(h.controller.request('other', { op: 'stop', lease: first.lease, lockScreen: true })).rejects.toThrow('DESKTOP_LEASE_EXPIRED');
    expect(h.deps.lockScreen).not.toHaveBeenCalled();
    const locking = h.controller.request('phone', { op: 'stop', lease: first.lease, lockScreen: true });
    await expect(h.controller.request('other', { op: 'start', displayId: '1', takeover: true })).rejects.toThrow('DESKTOP_BUSY');
    finish();
    await expect(locking).resolves.toEqual({ ok: true });
    expect(h.deps.lockScreen).toHaveBeenCalledTimes(1);
    await expect(h.controller.request('phone', { op: 'stop', lease: first.lease, lockScreen: true })).rejects.toThrow('DESKTOP_LEASE_EXPIRED');
    const second = await h.start();
    await h.controller.request('phone', { op: 'stop', lease: second.lease });
    expect(h.deps.lockScreen).toHaveBeenCalledTimes(1);
  });
  it('invalidates delayed lock preparation after revocation and reports lock failure', async () => {
    const h = harness(), first = await h.start();
    let finish!: () => void;
    h.deps.lockScreen = async current => {
      await new Promise<void>(resolve => { finish = resolve; });
      expect(current()).toBe(false);
      throw new Error('DESKTOP_LOCK_FAILED');
    };
    const pending = h.controller.request('phone', { op: 'stop', lease: first.lease, lockScreen: true });
    h.revoke(); finish();
    await expect(pending).rejects.toThrow('DESKTOP_LOCK_FAILED');
    expect(h.controller.state).toBeNull();
  });
  it.each(['stop', 'expiry', 'revoke', 'account'])('cancels an in-flight lock on %s without cancelling for another peer', async reason => {
    const h = harness();
    let account = 'first';
    h.deps.authenticationSession = () => account;
    const first = await h.start();
    let signal!: AbortSignal;
    h.deps.lockScreen = async (_current, cancellation) => {
      signal = cancellation;
      await new Promise<void>((_resolve, reject) => {
        cancellation.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
      });
    };
    const pending = h.controller.request('phone', { op: 'stop', lease: first.lease, lockScreen: true });
    const rejected = expect(pending).rejects.toThrow('cancelled');
    h.controller.stop('other');
    expect(signal.aborted).toBe(false);
    if (reason === 'stop') h.controller.stop('phone');
    if (reason === 'expiry') { h.advance(120000); h.controller.tick(); }
    if (reason === 'revoke') { h.revoke(); h.controller.tick(); }
    if (reason === 'account') { account = 'second'; h.controller.tick(); }
    expect(signal.aborted).toBe(true);
    await rejected;
    expect(h.controller.state).toBeNull();
  });
  it('releases a stalled fallback frame for another peer without stopping its lease', async () => {
    vi.useFakeTimers();
    try {
      const h = harness(), first = await h.start();
      let finish!: (value: string) => void;
      h.deps.frame = () => enumerateDesktopSources(() => new Promise<string>(yes => { finish = yes; }), 5000);
      const stalled = h.controller.request('phone', { op: 'frame', lease: first.lease });
      const rejection = expect(stalled).rejects.toThrow('DESKTOP_VIDEO_TIMEOUT');
      const next = await h.controller.request('other', { op: 'start', displayId: '1', takeover: true }) as RemoteDesktopLease;
      await vi.advanceTimersByTimeAsync(5000);
      await rejection;
      const stops = vi.mocked(h.deps.stopVideo).mock.calls.length;
      h.advance(350);
      h.deps.frame = async () => 'new frame';
      await expect(h.controller.request('other', { op: 'frame', lease: next.lease })).resolves.toEqual({ jpeg: 'new frame' });
      finish('stale frame');
      await Promise.resolve();
      expect(h.controller.hasLease(next.lease)).toBe(true);
      expect(h.deps.stopVideo).toHaveBeenCalledTimes(stops);
    } finally { vi.useRealTimers(); }
  });
  it('keeps ICE and media retries inside their peer lease, including after takeover', async () => {
    const h = harness(),
      first = await h.start();
    let finish!: (value: RemoteDesktopIceReply) => void;
    h.deps.ice = vi.fn(
      () =>
        new Promise<RemoteDesktopIceReply>((resolve) => {
          finish = resolve;
        }),
    );
    const ice = { op: 'ice', lease: first.lease, attemptId: 'a', after: 0, candidates: [] };
    await expect(h.controller.request('other', ice)).rejects.toThrow('DESKTOP_LEASE_EXPIRED');
    expect(h.deps.ice).not.toHaveBeenCalled();
    expect(h.deps.stopVideo).not.toHaveBeenCalled();
    for (const attemptId of ['a', 'b'])
      await h.controller.request('phone', {
        op: 'offer',
        lease: first.lease,
        sdp: 'offer',
        attemptId,
      });
    expect(h.deps.stopInput).not.toHaveBeenCalled();
    expect(h.controller.hasLease(first.lease)).toBe(true);
    const pending = h.controller.request('phone', ice);
    const next = (await h.controller.request('other', {
      op: 'start',
      displayId: '1',
      takeover: true,
    })) as RemoteDesktopLease;
    const stopped = vi.mocked(h.deps.stopVideo).mock.calls.length;
    finish({ attemptId: 'a', next: 0, candidates: [], complete: false });
    await expect(pending).rejects.toThrow('DESKTOP_STOPPED');
    expect(h.controller.hasLease(next.lease)).toBe(true);
    expect(h.deps.stopVideo).toHaveBeenCalledTimes(stopped);
  });
  it.each(['success', 'failure'] as const)('releases old geometry before the native write and preserves replacements on %s', async (outcome) => {
    const h = harness(), first = await h.start();
    await h.controller.request('phone', { op: 'control', lease: first.lease, enabled: true });
    let finish!: () => void;
    h.deps.resolution = async (_display, _mode, beforeChange) => {
      beforeChange();
      expect(h.controller.displayId).toBeNull();
      expect(h.controller.hasLease(first.lease)).toBe(false);
      // The real display listener matches displayId, now null, before helper exit.
      if (h.controller.displayId === '1') h.controller.stop();
      await new Promise<void>(resolve => { finish = resolve; });
      if (outcome === 'failure') throw new Error('native failed');
    };
    const pending = h.controller.request('phone', { op: 'resolution', lease: first.lease, modeId: '1' });
    const next = await h.controller.request('other', { op: 'start', displayId: '1' }) as RemoteDesktopLease;
    const stops = vi.mocked(h.deps.stopVideo).mock.calls.length;
    finish();
    if (outcome === 'success') await expect(pending).resolves.toEqual({ ok: true });
    else await expect(pending).rejects.toThrow('native failed');
    expect(h.controller.hasLease(next.lease)).toBe(true);
    expect(h.deps.stopVideo).toHaveBeenCalledTimes(stops);
  });
  it.each(['release', 'takeover', 'revoke'] as const)(
    'invalidates pending resolution after %s without stopping replacement control',
    async (action) => {
      const h = harness();
      const { lease } = await h.start();
      await h.controller.request('phone', { op: 'control', lease, enabled: true });
      let finish!: () => void;
      h.deps.resolution = vi.fn(async (_display, _mode, beforeChange) => {
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        beforeChange();
      });
      const pending = h.controller.request('phone', { op: 'resolution', lease, modeId: '1' });
      let currentLease = lease;
      if (action === 'release') {
        await h.controller.request('phone', { op: 'control', lease, enabled: false });
        await h.controller.request('phone', { op: 'control', lease, enabled: true });
      } else if (action === 'takeover') {
        const next = (await h.controller.request('other', {
          op: 'start',
          displayId: '1',
          takeover: true,
        })) as RemoteDesktopLease;
        currentLease = next.lease;
        await h.controller.request('other', { op: 'control', lease: currentLease, enabled: true });
      } else {
        h.revoke();
      }
      finish();
      await expect(pending).rejects.toThrow('DESKTOP_LEASE_EXPIRED');
      if (action !== 'revoke') {
        expect(h.controller.hasLease(currentLease)).toBe(true);
        expect(h.controller.state?.controlling).toBe(true);
      }
    },
  );
  it('takes over only explicitly and prevents the evicted device from automatically returning', async () => {
    const h = harness();
    const first = await h.start();
    await expect(h.controller.request('other', { op: 'start', displayId: '1' })).rejects.toThrow('DESKTOP_BUSY');
    await expect(h.controller.request('other', { op: 'start', displayId: 'missing', takeover: true })).rejects.toThrow('DESKTOP_DISPLAY_MISSING');
    expect(h.controller.hasLease(first.lease)).toBe(true);
    await expect(h.controller.request('other', { op: 'start', displayId: '1', takeover: true, resume: true })).rejects.toThrow('INVALID_REQUEST');
    const second = await h.controller.request('other', { op: 'start', displayId: '1', takeover: true }) as RemoteDesktopLease;
    expect(h.controller.hasLease(first.lease)).toBe(false);
    expect(h.controller.hasLease(second.lease)).toBe(true);
    await expect(h.controller.request('phone', { op: 'stop', lease: first.lease })).rejects.toThrow('DESKTOP_STOPPED');
    expect(h.controller.hasLease(second.lease)).toBe(true);
    h.controller.stop('other');
    await expect(h.controller.request('phone', { op: 'start', displayId: '1', resume: true })).rejects.toThrow('DESKTOP_STOPPED');
  });
  it('recovers its own display with a fresh input sequence after a lost start reply', async () => {
    const h = harness();
    const first = await h.start();
    await h.controller.request('phone', { op: 'control', lease: first.lease, enabled: true });
    h.controller.input(first.lease, 100, [{ kind: 'release' }]);
    for (const request of [
      { displayId: '1' },
      { displayId: 'other', resume: true },
    ]) await expect(h.controller.request('phone', { op: 'start', ...request })).rejects.toThrow('DESKTOP_BUSY');
    await expect(h.controller.request('other', { op: 'start', displayId: '1', resume: true })).rejects.toThrow('DESKTOP_BUSY');
    const next = await h.controller.request('phone', { op: 'start', displayId: '1', resume: true }) as RemoteDesktopLease;
    expect(next.lease).not.toBe(first.lease);
    expect(h.controller.hasLease(first.lease)).toBe(false);
    expect(h.deps.stopInput).toHaveBeenCalledTimes(1);
    expect(h.deps.stopVideo).toHaveBeenCalledTimes(1);
    await expect(h.controller.request('phone', { op: 'stop', lease: first.lease })).rejects.toThrow('DESKTOP_LEASE_EXPIRED');
    await h.controller.request('phone', { op: 'control', lease: next.lease, enabled: true });
    h.controller.input(next.lease, 0, [{ kind: 'release' }]);
    expect(h.deps.input).toHaveBeenCalledTimes(2);
    expect(h.controller.hasLease(next.lease)).toBe(true);
  });
  it.each(['cancel', 'revoke', 'host-stop', 'reject'] as const)(
    'does not revive a pending same-peer resume after %s', async (event) => {
      const h = harness();
      const first = await h.start();
      let resolve!: (value: Awaited<ReturnType<DesktopControllerDeps['capabilities']>>) => void;
      let reject!: (reason: Error) => void;
      const caps = await h.deps.capabilities();
      h.deps.capabilities = () => new Promise((yes, no) => { resolve = yes; reject = no; });
      const pending = h.controller.request('phone', { op: 'start', displayId: '1', resume: true })
        .then(() => null, (error: unknown) => error);
      expect(resolve).toBeTypeOf('function');
      await expect(h.controller.request('other', { op: 'start', displayId: '1', takeover: true })).rejects.toThrow('DESKTOP_BUSY');
      if (event === 'cancel') h.controller.stop('phone');
      if (event === 'revoke') h.revoke();
      if (event === 'host-stop') h.controller.stopByUser();
      if (event === 'reject') reject(new Error('capture unavailable'));
      else resolve(caps);
      expect(await pending).toBeInstanceOf(Error);
      expect(h.controller.hasLease(first.lease)).toBe(event === 'reject');
      if (event === 'reject') expect(h.deps.stopVideo).not.toHaveBeenCalled();
    },
  );
  it('rejects a late frame from the resumed lease and keeps capturing for its replacement', async () => {
    const h = harness();
    const first = await h.start();
    let finish!: (jpeg: string) => void;
    h.deps.frame = vi.fn(() => new Promise<string>((resolve) => { finish = resolve; }));
    const frame = h.controller.request('phone', { op: 'frame', lease: first.lease });
    const next = await h.controller.request('phone', { op: 'start', displayId: '1', resume: true }) as RemoteDesktopLease;
    finish('old frame');
    await expect(frame).rejects.toThrow('DESKTOP_LEASE_EXPIRED');
    h.advance(350);
    h.deps.frame = vi.fn(async () => 'new frame');
    await expect(h.controller.request('phone', { op: 'frame', lease: next.lease })).resolves.toEqual({ jpeg: 'new frame' });
    expect(h.controller.hasLease(next.lease)).toBe(true);
    expect(h.deps.stopVideo).toHaveBeenCalledTimes(1);
  });
  it.each([false, true])('bounds relay frames with cursor overlay=%s without stopping the lease', async (overlay) => {
    const h = harness();
    const { lease } = await h.start();
    const cursor = null;
    for (const bytes of [180_000, 180_001, 180_000]) {
      const jpeg = Buffer.alloc(bytes).toString('base64');
      h.deps.frame = vi.fn(async () => overlay ? { jpeg, cursor } : jpeg);
      const result = await h.controller.request('phone', { op: 'frame', lease, cursorOverlay: overlay });
      expect(result).toEqual(bytes > 180_000 ? { jpeg: null } : overlay ? { jpeg, cursor } : { jpeg });
      h.advance(350);
    }
    expect(h.controller.hasLease(lease)).toBe(true);
    expect(h.deps.stopVideo).not.toHaveBeenCalled();
    expect(h.deps.stopInput).not.toHaveBeenCalled();
  });
  it('keeps the same lease and video negotiation through an empty fallback frame', async () => {
    const h = harness();
    h.deps.frame = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce('jpeg');
    const { lease } = await h.start();
    await expect(h.controller.request('phone', { op: 'frame', lease })).resolves.toEqual({ jpeg: null });
    h.advance(350);
    await expect(h.controller.request('phone', { op: 'frame', lease })).resolves.toEqual({ jpeg: 'jpeg' });
    expect(h.controller.hasLease(lease)).toBe(true);
    expect(h.deps.stopVideo).not.toHaveBeenCalled();
  });
  it('remembers a stop after the peer went offline and isolates each peer recovery decision', async () => {
    const h = harness();
    const first = await h.start();
    h.controller.stop('phone');
    h.controller.stopByUser();
    const other = (await h.controller.request('other', {
      op: 'start',
      displayId: '1',
    })) as RemoteDesktopLease;
    h.controller.stopByUser();
    await expect(
      h.controller.request('phone', { op: 'start', displayId: '1', resume: true }),
    ).rejects.toThrow('STOPPED');
    await expect(
      h.controller.request('other', { op: 'start', displayId: '1', resume: true }),
    ).rejects.toThrow('STOPPED');
    const explicit = await h.start();
    expect(explicit.lease).not.toBe(first.lease);
    h.controller.stop('phone');
    await expect(
      h.controller.request('phone', { op: 'start', displayId: '1', resume: true }),
    ).resolves.toHaveProperty('lease');
  });
  it('distinguishes explicit host disconnect from an expired connection for recovery', async () => {
    const h = harness();
    const { lease } = await h.start();
    h.controller.stopByUser();
    await expect(
      h.controller.request('phone', { op: 'start', displayId: '1', resume: true }),
    ).rejects.toThrow('STOPPED');
    await expect(h.controller.request('phone', { op: 'heartbeat', lease })).rejects.toThrow(
      'DESKTOP_STOPPED',
    );
    expect(() => h.controller.input(lease, 1, [{ kind: 'release' }])).toThrow('DESKTOP_STOPPED');
    await expect(h.controller.request('other', { op: 'heartbeat', lease })).rejects.toThrow(
      'EXPIRED',
    );
    const next = (await h.controller.request('other', {
      op: 'start',
      displayId: '1',
    })) as RemoteDesktopLease;
    await expect(h.controller.request('phone', { op: 'stop', lease })).rejects.toThrow('STOPPED');
    await expect(
      h.controller.request('other', { op: 'heartbeat', lease: next.lease }),
    ).resolves.toEqual({ controlling: false });
    h.controller.stop();
    await expect(
      h.controller.request('other', { op: 'heartbeat', lease: next.lease }),
    ).rejects.toThrow('EXPIRED');
  });
  it('keeps the host disconnect reason when an input grant completes late', async () => {
    const h = harness();
    const { lease } = await h.start();
    let finish!: () => void;
    h.deps.startInput = () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      });
    const control = h.controller.request('phone', { op: 'control', lease, enabled: true });
    h.controller.stopByUser();
    finish();
    await expect(control).rejects.toThrow('STOPPED');
    expect(h.controller.state).toBeNull();
  });
  it('requires local opt-in for the dedicated guide and never starts a lease while guiding', async () => {
    const h = harness();
    h.deps.permissions = vi.fn(async () => ({
      screenRecording: 'missing' as const,
      accessibility: 'granted' as const,
    }));
    await h.controller.request('phone', { op: 'permissions', action: 'guide' });
    expect(h.deps.permissions).toHaveBeenCalledExactlyOnceWith('guide');
    expect(h.controller.state).toBeNull();
    h.revoke();
    await expect(
      h.controller.request('phone', { op: 'permissions', action: 'guide' }),
    ).rejects.toThrow('DISABLED');
    expect(h.deps.permissions).toHaveBeenCalledTimes(1);
  });
  it('requires screen permission to view, while missing accessibility still allows view-only', async () => {
    const h = harness();
    const caps = await h.deps.capabilities();
    h.deps.capabilities = async () => ({
      ...caps,
      permissions: { screenRecording: 'missing', accessibility: 'granted' },
    });
    await expect(h.start()).rejects.toThrow('SCREEN_PERMISSION');
    expect(h.controller.state).toBeNull();
    h.deps.capabilities = async () => ({
      ...caps,
      permissions: { screenRecording: 'granted', accessibility: 'missing' },
    });
    expect((await h.start()).controlling).toBe(false);
  });
  it('starts view-only and binds every action to the actual peer and lease', async () => {
    const h = harness();
    const { lease } = await h.start();
    expect(h.controller.state?.controlling).toBe(false);
    await expect(
      h.controller.request('other', { op: 'control', lease, enabled: true }),
    ).rejects.toThrow('EXPIRED');
    await expect(
      h.controller.request('phone', {
        op: 'input',
        lease,
        sequence: 1,
        events: [{ kind: 'release' }],
      }),
    ).rejects.toThrow('VIEW_ONLY');
    expect(h.deps.input).not.toHaveBeenCalled();
  });
  it('expires a lost phone and releases input/video; a different peer cannot stop it', async () => {
    const h = harness();
    const { lease } = await h.start();
    await h.controller.request('phone', { op: 'control', lease, enabled: true });
    h.controller.stop('other');
    expect(h.controller.state).not.toBeNull();
    h.advance(12001);
    h.controller.tick();
    expect(h.controller.state).toBeNull();
    expect(h.deps.stopInput).toHaveBeenCalled();
    expect(h.deps.stopVideo).toHaveBeenCalled();
  });
  it('never replays input and rechecks revoked authorization on the RTC path', async () => {
    const h = harness();
    const { lease } = await h.start();
    await h.controller.request('phone', { op: 'control', lease, enabled: true });
    h.controller.input(lease, 2, [{ kind: 'key', code: 'KeyA', down: true }]);
    h.controller.input(lease, 2, [{ kind: 'key', code: 'KeyA', down: true }]);
    expect(h.deps.input).toHaveBeenCalledTimes(1);
    h.revoke();
    expect(() => h.controller.input(lease, 3, [{ kind: 'release' }])).toThrow('EXPIRED');
    expect(h.deps.input).toHaveBeenCalledTimes(1);
  });
  it('discards capture completed after local stop and bounds concurrent frame capture', async () => {
    const h = harness();
    const { lease } = await h.start();
    let finish!: (value: string) => void;
    h.deps.frame = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    const first = h.controller.request('phone', { op: 'frame', lease });
    expect(await h.controller.request('phone', { op: 'frame', lease })).toEqual({ jpeg: null });
    h.controller.stop();
    finish('private-screen');
    await expect(first).rejects.toThrow('EXPIRED');
  });
  it('cannot resurrect control when the native helper becomes ready after stop', async () => {
    const h = harness();
    const { lease } = await h.start();
    let finish!: () => void;
    h.deps.startInput = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    const start = h.controller.request('phone', { op: 'control', lease, enabled: true });
    await expect(
      h.controller.request('phone', { op: 'control', lease, enabled: true }),
    ).rejects.toThrow('BUSY');
    h.controller.stop();
    finish();
    await expect(start).rejects.toThrow('EXPIRED');
    expect(h.controller.state).toBeNull();
  });
  it('arbitrates pending starts instead of allocating two leases', async () => {
    const h = harness();
    const first = h.start();
    await expect(h.start()).rejects.toThrow('BUSY');
    await first;
  });
  it('cancels a pending start when that peer disconnects', async () => {
    const h = harness();
    const first = h.start();
    h.controller.stop('phone');
    await expect(first).rejects.toThrow('DISABLED');
    expect(h.controller.state).toBeNull();
  });
  it('cancels a disconnected takeover candidate without affecting the current owner', async () => {
    const h = harness();
    const first = await h.start();
    await h.controller.request('phone', { op: 'control', lease: first.lease, enabled: true });
    let finishCopy!: (value: string) => void;
    let currentCopy!: () => boolean;
    h.deps.clipboard = (_action, _text, isCurrent) => {
      currentCopy = isCurrent;
      return new Promise<string>((resolve) => { finishCopy = resolve; });
    };
    const copy = h.controller.request('phone', { op: 'clipboard', lease: first.lease, action: 'copy' });
    const caps = await h.deps.capabilities();
    let finishStart!: (value: typeof caps) => void;
    h.deps.capabilities = vi.fn()
      .mockImplementationOnce(() => new Promise<typeof caps>((resolve) => { finishStart = resolve; }))
      .mockResolvedValue(caps);
    const next = h.controller.request('other', { op: 'start', displayId: '1', takeover: true });
    const changes = vi.mocked(h.deps.changed).mock.calls.length;
    h.controller.stop('other');
    h.controller.stop('other'); // Revocation and link cleanup can both notify the controller.
    expect(h.controller.state).toEqual({ peer: 'phone', controlling: true });
    expect(h.controller.hasLease(first.lease)).toBe(true);
    expect(h.deps.stopInput).not.toHaveBeenCalled();
    expect(h.deps.stopVideo).not.toHaveBeenCalled();
    expect(h.deps.changed).toHaveBeenCalledTimes(changes);
    expect(currentCopy()).toBe(true);
    h.controller.input(first.lease, 1, [{ kind: 'release' }]);
    expect(h.deps.input).toHaveBeenCalledTimes(1);
    finishCopy('selected');
    await expect(copy).resolves.toEqual({ text: 'selected' });
    // Authorization remains true (or may have recovered), but this start stays cancelled.
    finishStart(caps);
    await expect(next).rejects.toThrow('DESKTOP_DISABLED');
    expect(h.controller.hasLease(first.lease)).toBe(true);
    await expect(h.controller.request('other', { op: 'start', displayId: '1', takeover: true }))
      .resolves.toHaveProperty('lease');
  });
  it.each([false, true])('isolates unrelated peer stop while retaining global cancellation (global=%s)', async (global) => {
    const h = harness();
    const pending = h.start();
    if (global) h.controller.stop();
    else h.controller.stop('unrelated');
    if (global) {
      await expect(pending).rejects.toThrow('DESKTOP_DISABLED');
      expect(h.controller.state).toBeNull();
    } else {
      await expect(pending).resolves.toHaveProperty('lease');
      expect(h.deps.stopVideo).not.toHaveBeenCalled();
    }
  });
  it('releases control after an input failure without ending the lease or its media', async () => {
    const h = harness();
    const lease = await h.start();
    await h.controller.request('phone', { op: 'control', lease: lease.lease, enabled: true });
    h.controller.input(lease.lease, 1, [{ kind: 'release' }]);
    expect(h.deps.input).toHaveBeenCalledTimes(1);
    // The helper died: control goes, the picture and the lease stay.
    h.controller.releaseControl();
    expect(h.controller.state).toEqual({ peer: 'phone', controlling: false });
    expect(h.controller.hasLease(lease.lease)).toBe(true);
    expect(h.deps.stopInput).toHaveBeenCalledTimes(1);
    expect(h.deps.stopVideo).not.toHaveBeenCalled();
    expect(h.deps.changed).toHaveBeenCalled();
    // The viewer learns the truth from its own heartbeat.
    await expect(
      h.controller.request('phone', { op: 'heartbeat', lease: lease.lease }),
    ).resolves.toEqual({ controlling: false });
    // Later input is an input problem, not a lease problem.
    await expect(
      h.controller.request('phone', {
        op: 'input',
        lease: lease.lease,
        sequence: 2,
        events: [{ kind: 'release' }],
      }),
    ).rejects.toThrow('VIEW_ONLY');
    expect(h.deps.input).toHaveBeenCalledTimes(1);
    await expect(h.controller.request('phone', { op: 'frame', lease: lease.lease })).resolves.toEqual(
      { jpeg: 'jpeg' },
    );
  });
  it('lets the same viewer take control again after a release without touching the media', async () => {
    const h = harness();
    const lease = await h.start();
    await h.controller.request('phone', { op: 'control', lease: lease.lease, enabled: true });
    h.controller.releaseControl();
    await h.controller.request('phone', { op: 'control', lease: lease.lease, enabled: true });
    expect(h.controller.state).toEqual({ peer: 'phone', controlling: true });
    // Taking control again restarts the input helper on the same lease.
    expect(h.deps.startInput).toHaveBeenCalledTimes(2);
    // A second viewer is still arbitrated by the same single-viewer rules.
    await expect(h.controller.request('other', { op: 'start', displayId: '1' })).rejects.toThrow(
      'BUSY',
    );
    expect(h.deps.stopVideo).not.toHaveBeenCalled();
    expect(h.deps.stopInput).toHaveBeenCalledTimes(1);
  });
  it('ignores a release when no viewer controls anything', async () => {
    const h = harness();
    const lease = await h.start();
    h.controller.releaseControl();
    expect(h.controller.state).toEqual({ peer: 'phone', controlling: false });
    expect(h.deps.stopInput).not.toHaveBeenCalled();
    expect(h.deps.stopVideo).not.toHaveBeenCalled();
    expect(h.controller.hasLease(lease.lease)).toBe(true);
  });
});
describe('human / Agent input ownership', () => {
  it('excludes simultaneous input in both directions and releases on error', async () => {
    const release = acquireHumanDesktopInput();
    await expect(withAgentDesktopInput(async () => {})).rejects.toThrow('person');
    release();
    await expect(
      withAgentDesktopInput(async () => {
        expect(() => acquireHumanDesktopInput()).toThrow('BUSY');
        throw new Error('action');
      }),
    ).rejects.toThrow('action');
    acquireHumanDesktopInput()();
  });
});
