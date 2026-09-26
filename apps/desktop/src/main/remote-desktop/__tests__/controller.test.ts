import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { RemoteDesktopController, type DesktopControllerDeps } from '../controller';
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
it('finishes native host setup before exposing a lease or allocating temporary displays', async () => {
  const h = harness();
  let done!: () => void;
  h.deps.prepare = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        done = resolve;
      }),
  );
  const starting = h.start();
  await Promise.resolve();
  expect(h.controller.state).toBeNull();
  done();
  const lease = await starting;
  expect(lease.controlling).toBe(false);
  await h.controller.request('phone', { op: 'start', displayId: '1', resume: true });
  // Resume/takeover must not reload a compositor underneath an active capture.
  expect(h.deps.prepare).toHaveBeenCalledOnce();
});
it('does not allocate a lease after host setup was cancelled', async () => {
  const h = harness();
  let done!: () => void;
  let current!: () => boolean;
  h.deps.prepare = (check) => {
    current = check;
    return new Promise<void>((resolve) => {
      done = resolve;
    });
  };
  const starting = h.start();
  await Promise.resolve();
  await h.controller.stop();
  expect(current()).toBe(false);
  done();
  await expect(starting).rejects.toThrow('DESKTOP_LEASE_EXPIRED');
  expect(h.controller.state).toBeNull();
});
describe('remote desktop authority and lifecycle', () => {
  it('registers the returned stop promise with the awaited quit phase', () => {
    const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
    const registration = source.slice(
      source.indexOf('onQuit('),
      source.indexOf("  screen.on('display-removed'"),
    );
    const register = vi.fn();
    const pending = new Promise<void>(() => {});
    const stop = vi.fn();
    const stopAndRestore = vi.fn(() => pending);
    const dismiss = vi.fn();
    const clear = vi.fn();
    const clipboardStop = vi.fn();
    new Function(
      'stopLinuxClipboardWriter',
      'onQuit',
      'clearInterval',
      'timer',
      'permissions',
      'remoteDesktop',
      registration,
    )(clipboardStop, register, clear, 1, { dismiss }, { stop, stopAndRestore });
    expect(register).toHaveBeenCalledWith('remote-desktop-restore', expect.any(Function), 'async');
    register.mock.calls.find(([name]) => name === 'remote-desktop-stop')![1]();
    expect(stop).toHaveBeenCalledOnce();
    expect(register.mock.calls.find(([name]) => name === 'remote-desktop-restore')![1]()).toBe(
      pending,
    );
    expect(clear).toHaveBeenCalledWith(1);
    expect(dismiss).toHaveBeenCalledOnce();
  });
  it.each(['stop', 'stopAndRestore'] as const)(
    'keeps %s pending until audio restoration finishes',
    async (method) => {
      const h = harness();
      await h.start();
      let finish!: () => void;
      h.deps.stopHostMute = () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        });
      let settled = false;
      const stopped = h.controller[method]().then(() => {
        settled = true;
      });
      expect(h.controller.state).toBeNull();
      expect(h.deps.stopInput).toHaveBeenCalledOnce();
      await Promise.resolve();
      expect(settled).toBe(false);
      finish();
      await stopped;
      expect(settled).toBe(true);
    },
  );
  it.each([false, true])(
    'clears safety before a temporary resolution change, interrupted=%s',
    async (interrupted) => {
      const h = harness();
      h.deps.displayModes = vi.fn(async () => [
        { id: '1', width: 1920, height: 1080, current: true },
        { id: '2', width: 3840, height: 2160, current: false },
      ]);
      h.deps.resolution = vi.fn(async (_display, _mode, before) => before());
      h.deps.stopPrivacyScreen = vi.fn();
      let finish!: () => void;
      const safety = new Promise<void>((resolve) => {
        finish = resolve;
      });
      h.deps.stopHostMute = vi.fn(() => safety);
      const { lease } = await h.start();
      await h.controller.request('phone', { op: 'control', lease, enabled: true });
      const pending = h.controller.request('phone', {
        op: 'resolution',
        lease,
        modeId: '2',
        temporary: true,
      });
      const rejected = interrupted
        ? expect(pending).rejects.toThrow('DESKTOP_LEASE_EXPIRED')
        : undefined;
      expect(h.deps.stopInput).toHaveBeenCalled();
      expect(h.deps.stopPrivacyScreen).toHaveBeenCalledOnce();
      expect(h.deps.displayModes).not.toHaveBeenCalled();
      if (interrupted) void h.controller.stop();
      finish();
      if (interrupted) {
        await rejected;
        expect(h.deps.resolution).not.toHaveBeenCalled();
      } else {
        await pending;
        expect(h.deps.resolution).toHaveBeenCalledOnce();
      }
    },
  );
  it('keeps only a live view-only presentation across signaling loss', async () => {
    const h = harness();
    const { lease } = await h.start();
    await h.controller.request('phone', { op: 'presentation', lease, enabled: true });
    h.controller.signalingLost('other-phone');
    h.controller.signalingLost('phone');
    h.controller.signalingLost();
    expect(h.deps.stopVideo).not.toHaveBeenCalled();
    for (let i = 0; i < 10; i++) {
      h.advance(10_000);
      h.controller.viewHeartbeat(lease);
      h.controller.tick();
    }
    expect(h.deps.stopVideo).not.toHaveBeenCalled();
    h.advance(12_000);
    h.controller.tick();
    expect(h.deps.stopVideo).toHaveBeenCalledOnce();
  });

  it('does not preserve foreground control or revoked presentations when signaling disappears', async () => {
    const foreground = harness();
    const { lease } = await foreground.start();
    await foreground.controller.request('phone', { op: 'control', lease, enabled: true });
    foreground.controller.signalingLost('phone');
    expect(foreground.deps.stopVideo).toHaveBeenCalledOnce();
    const revoked = harness();
    const presentation = await revoked.start();
    await revoked.controller.request('phone', {
      op: 'presentation',
      lease: presentation.lease,
      enabled: true,
    });
    revoked.revoke();
    revoked.controller.signalingLost('phone');
    revoked.controller.viewHeartbeat(presentation.lease);
    expect(revoked.deps.stopVideo).toHaveBeenCalled();
  });

  it('explicit disconnect still stops a presentation after signaling loss', async () => {
    const h = harness();
    const { lease } = await h.start();
    await h.controller.request('phone', { op: 'presentation', lease, enabled: true });
    h.controller.signalingLost('phone');
    h.controller.stopByUser();
    h.controller.viewHeartbeat(lease);
    expect(h.deps.stopVideo).toHaveBeenCalledOnce();
    await expect(h.controller.request('phone', { op: 'heartbeat', lease })).rejects.toThrow(
      'DESKTOP_STOPPED',
    );
  });

  it('fences delayed clipboard work at a desktop switch while keeping the same manual-control lease', async () => {
    const h = harness();
    let complete!: () => void;
    let current!: () => boolean;
    h.deps.clipboard = vi.fn(async (_action, _text, isCurrent) => {
      current = isCurrent;
      await new Promise<void>((resolve) => (complete = resolve));
      return 'fake-clipboard';
    });
    const { lease } = await h.start();
    await h.controller.request('phone', { op: 'control', lease, enabled: true });
    const request = h.controller.request('phone', { op: 'clipboard', lease, action: 'copy' });
    expect(current()).toBe(true);
    const stops = vi.mocked(h.deps.stopInput).mock.calls.length;
    expect(h.controller.prepareInputDesktopChange()).toBe(true);
    expect(current()).toBe(false);
    expect(h.controller.state).toEqual({ peer: 'phone', controlling: true });
    expect(h.controller.hasLease(lease)).toBe(true);
    expect(h.deps.stopInput).toHaveBeenCalledTimes(stops);
    complete();
    await expect(request).rejects.toThrow('DESKTOP_VIEW_ONLY');
    await h.controller.request('phone', { op: 'control', lease, enabled: false });
    expect(h.controller.prepareInputDesktopChange()).toBe(false);
    await h.controller.request('phone', { op: 'control', lease, enabled: true });
    h.revoke();
    expect(h.controller.prepareInputDesktopChange()).toBe(false);
    expect(h.controller.state).toBeNull();
  });

  it('does not publish selected geometry or resume control before it is observed', async () => {
    const h = harness();
    h.deps.displayModes = async () => [
      { id: '1', width: 1920, height: 1080, current: true },
      { id: '2', width: 3840, height: 2160, current: false },
    ];
    let projected!: () => void;
    h.deps.resolution = vi.fn(async (_display, _mode, beforeChange, expected) => {
      beforeChange();
      expect(expected).toMatchObject({ width: 3840, height: 2160 });
      await new Promise<void>((resolve) => {
        projected = resolve;
      });
      beforeChange();
    });
    const { lease } = await h.start();
    await h.controller.request('phone', { op: 'control', lease, enabled: true });
    const settled = vi.fn();
    const changing = h.controller
      .request('phone', {
        op: 'resolution',
        lease,
        modeId: '2',
        temporary: true,
      })
      .then(settled);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(projected).toBeTypeOf('function');
    expect(settled).not.toHaveBeenCalled();
    await expect(
      h.controller.request('phone', { op: 'control', lease, enabled: true }),
    ).rejects.toThrow();
    projected();
    await changing;
    expect(settled).toHaveBeenCalledWith(
      expect.objectContaining({
        controlling: false,
        display: expect.objectContaining({ width: 3840, height: 2160 }),
      }),
    );
  });

  it('keeps shutdown pending until resolution restoration finishes', async () => {
    const h = harness();
    h.deps.displayModes = async () => [
      { id: '1', width: 1920, height: 1080, current: true },
      { id: '2', width: 3840, height: 2160, current: false },
    ];
    h.deps.resolution = async (_display, _mode, beforeChange) => beforeChange();
    let finish!: () => void;
    h.deps.restoreResolution = vi.fn(async (_display, _mode, beforeChange) => {
      beforeChange();
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    });
    const { lease } = await h.start();
    await h.controller.request('phone', { op: 'control', lease, enabled: true });
    await h.controller.request('phone', { op: 'resolution', lease, modeId: '2', temporary: true });
    const settled = vi.fn();
    const quitting = h.controller.stopAndRestore().then(settled);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(h.controller.state).toBeNull();
    expect(settled).not.toHaveBeenCalled();
    expect(h.deps.restoreResolution).toHaveBeenCalledWith(
      '1',
      '1',
      expect.any(Function),
      expect.objectContaining({ width: 1920, height: 1080 }),
    );
    finish();
    await quitting;
    expect(settled).toHaveBeenCalledOnce();
    expect(h.deps.restoreResolution).toHaveBeenCalledOnce();
  });
  it('waits for an in-flight mode change before restoring after disconnect', async () => {
    const h = harness();
    let finish!: () => void;
    let began!: () => void;
    const started = new Promise<void>((resolve) => {
      began = resolve;
    });
    const order: string[] = [];
    h.deps.displayModes = async () => [
      { id: '1', width: 1920, height: 1080, current: true },
      { id: '2', width: 3840, height: 2160, current: false },
    ];
    h.deps.resolution = async (_display, mode, beforeChange) => {
      beforeChange();
      if (mode === '2') {
        began();
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
      }
      order.push(mode);
    };
    const { lease } = await h.start();
    await h.controller.request('phone', { op: 'control', lease, enabled: true });
    const change = h.controller.request('phone', {
      op: 'resolution',
      lease,
      modeId: '2',
      temporary: true,
    });
    const rejected = expect(change).rejects.toThrow('DESKTOP_LEASE_EXPIRED');
    await started;
    await h.controller.request('phone', { op: 'stop', lease });
    await expect(h.start()).rejects.toThrow('DESKTOP_BUSY');
    expect(order).toEqual([]);
    finish();
    await rejected;
    await h.start();
    expect(order).toEqual(['2', '1']);
  });
  it('retains the original mode after a failed restore and retries before a new lease', async () => {
    const h = harness();
    h.deps.displayModes = async () => [
      { id: '1', width: 1920, height: 1080, current: true },
      { id: '2', width: 3840, height: 2160, current: false },
    ];
    let fail = true;
    h.deps.resolution = vi.fn(async (_display, mode, beforeChange) => {
      beforeChange();
      if (mode === '1' && fail) throw new Error('restore failed');
    });
    const { lease } = await h.start();
    await h.controller.request('phone', { op: 'control', lease, enabled: true });
    await h.controller.request('phone', { op: 'resolution', lease, modeId: '2', temporary: true });
    await h.controller.request('phone', { op: 'stop', lease });
    await expect(h.start()).rejects.toThrow('restore failed');
    fail = false;
    await h.start();
    expect(h.deps.resolution).toHaveBeenLastCalledWith(
      '1',
      '1',
      expect.any(Function),
      expect.objectContaining({ width: 1920, height: 1080 }),
    );
  });
  it.each(['stop', 'timeout', 'takeover', 'revoke'] as const)(
    'restores the first system mode after multiple changes on %s',
    async (ending) => {
      const h = harness();
      let modeId = '1';
      h.deps.displayModes = async () => [
        { id: '1', width: 1920, height: 1080, current: modeId === '1' },
        { id: '2', width: 3840, height: 2160, current: modeId === '2' },
        { id: '3', width: 1280, height: 720, current: modeId === '3' },
      ];
      h.deps.resolution = vi.fn(async (_display, mode, beforeChange) => {
        beforeChange();
        modeId = mode;
      });
      const { lease } = await h.start();
      for (const mode of ['2', '3']) {
        await h.controller.request('phone', { op: 'control', lease, enabled: true });
        const next = await h.controller.request('phone', {
          op: 'resolution',
          lease,
          modeId: mode,
          temporary: true,
        });
        expect(next).toMatchObject({ lease, controlling: false });
        expect(h.controller.hasLease(lease)).toBe(true);
        expect(modeId).toBe(mode);
      }
      if (ending === 'stop') await h.controller.request('phone', { op: 'stop', lease });
      else if (ending === 'timeout') {
        h.advance(60000);
        h.controller.tick();
      } else if (ending === 'revoke') {
        h.revoke();
        h.controller.tick();
      } else await h.controller.request('other', { op: 'start', displayId: '1', takeover: true });
      if (ending === 'revoke') await vi.waitFor(() => expect(modeId).toBe('1'));
      else if (ending !== 'takeover') await h.start(); // Starting waits for restoration.
      expect(modeId).toBe('1');
      expect(h.deps.resolution).toHaveBeenCalledTimes(3);
    },
  );
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

  it.each([true, false])('uses the current privacy exit lock preference (%s)', async (enabled) => {
    const h = harness();
    h.deps.privacyScreen = vi.fn(async () => {});
    h.deps.lockScreen = vi.fn(async (current) => {
      expect(current()).toBe(true);
    });
    const { lease } = await h.start();
    await h.controller.request('phone', { op: 'control', lease, enabled: true });
    await h.controller.request('phone', {
      op: 'privacyScreen',
      lease,
      enabled: true,
      lockOnExit: true,
    });
    await h.controller.request('phone', {
      op: 'privacyScreen',
      lease,
      enabled: true,
      lockOnExit: enabled,
    });
    await h.controller.stopPrivacyByUser();
    expect(h.deps.lockScreen).toHaveBeenCalledTimes(enabled ? 1 : 0);
    expect(h.controller.state).toBeNull();
    await expect(h.controller.request('phone', { op: 'heartbeat', lease })).rejects.toThrow(
      'DESKTOP_STOPPED',
    );
  });
  it('ends privacy control even when locking fails', async () => {
    const h = harness();
    h.deps.privacyScreen = vi.fn(async () => {});
    h.deps.lockScreen = vi.fn(async () => {
      throw new Error('LOCK_FAILED');
    });
    const { lease } = await h.start();
    await h.controller.request('phone', { op: 'control', lease, enabled: true });
    await h.controller.request('phone', {
      op: 'privacyScreen',
      lease,
      enabled: true,
      lockOnExit: true,
    });
    await expect(h.controller.stopPrivacyByUser()).rejects.toThrow('LOCK_FAILED');
    expect(h.controller.state).toBeNull();
  });
  it('requires owner control and opt-in for synchronization and invalidates a delayed read on disable', async () => {
    const h = harness(),
      { lease } = await h.start();
    let finish!: (version: string) => void;
    h.deps.stopClipboardVersion = vi.fn();
    h.deps.clipboardVersion = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    await expect(
      h.controller.request('phone', { op: 'clipboardSync', lease, enabled: true }),
    ).rejects.toThrow('DESKTOP_CLIPBOARD_UNAVAILABLE');
    await h.controller.request('phone', { op: 'control', lease, enabled: true });
    await h.controller.request('phone', { op: 'clipboardSync', lease, enabled: true });
    await expect(h.controller.request('other', { op: 'clipboardVersion', lease })).rejects.toThrow(
      'DESKTOP_LEASE_EXPIRED',
    );
    const read = h.controller.request('phone', { op: 'clipboardVersion', lease });
    await h.controller.request('phone', { op: 'clipboardSync', lease, enabled: false });
    expect(h.deps.stopClipboardVersion).toHaveBeenCalledOnce();
    finish('12');
    await expect(read).rejects.toThrow('DESKTOP_LEASE_EXPIRED');
    h.controller.stop();
    expect(h.deps.stopClipboardVersion).toHaveBeenCalledTimes(2);
  });
  it('restores privacy on lease expiry and invalidates an older enable after disable', async () => {
    const h = harness(),
      { lease } = await h.start();
    let finish!: () => void;
    let oldCurrent!: () => boolean;
    h.deps.stopPrivacyScreen = vi.fn();
    h.deps.privacyScreen = async (enabled, current) => {
      if (enabled) {
        oldCurrent = current;
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
      }
    };
    await h.controller.request('phone', { op: 'control', lease, enabled: true });
    const enable = h.controller.request('phone', { op: 'privacyScreen', lease, enabled: true });
    await h.controller.request('phone', { op: 'privacyScreen', lease, enabled: false });
    expect(oldCurrent()).toBe(false);
    finish();
    await expect(enable).rejects.toThrow('DESKTOP_LEASE_EXPIRED');
    h.advance(60000);
    h.controller.tick();
    expect(h.deps.stopPrivacyScreen).toHaveBeenCalled();
  });
  it('locks only on explicit owner exit and blocks takeover until lock completes', async () => {
    const h = harness(),
      first = await h.start();
    let finish!: () => void;
    h.deps.lockScreen = vi.fn(async (current) => {
      expect(current()).toBe(true);
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    });
    await expect(
      h.controller.request('other', { op: 'stop', lease: first.lease, lockScreen: true }),
    ).rejects.toThrow('DESKTOP_LEASE_EXPIRED');
    expect(h.deps.lockScreen).not.toHaveBeenCalled();
    const locking = h.controller.request('phone', {
      op: 'stop',
      lease: first.lease,
      lockScreen: true,
    });
    await expect(
      h.controller.request('other', { op: 'start', displayId: '1', takeover: true }),
    ).rejects.toThrow('DESKTOP_BUSY');
    finish();
    await expect(locking).resolves.toEqual({ ok: true });
    expect(h.deps.lockScreen).toHaveBeenCalledTimes(1);
    await expect(
      h.controller.request('phone', { op: 'stop', lease: first.lease, lockScreen: true }),
    ).rejects.toThrow('DESKTOP_LEASE_EXPIRED');
    const second = await h.start();
    await h.controller.request('phone', { op: 'stop', lease: second.lease });
    expect(h.deps.lockScreen).toHaveBeenCalledTimes(1);
  });
  it('invalidates delayed lock preparation after revocation and reports lock failure', async () => {
    const h = harness(),
      first = await h.start();
    let finish!: () => void;
    h.deps.lockScreen = async (current) => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      expect(current()).toBe(false);
      throw new Error('DESKTOP_LOCK_FAILED');
    };
    const pending = h.controller.request('phone', {
      op: 'stop',
      lease: first.lease,
      lockScreen: true,
    });
    h.revoke();
    finish();
    await expect(pending).rejects.toThrow('DESKTOP_LOCK_FAILED');
    expect(h.controller.state).toBeNull();
  });
  it.each(['stop', 'expiry', 'revoke', 'account'])(
    'cancels an in-flight lock on %s without cancelling for another peer',
    async (reason) => {
      const h = harness();
      let account = 'first';
      h.deps.authenticationSession = () => account;
      const first = await h.start();
      let signal!: AbortSignal;
      h.deps.lockScreen = async (_current, cancellation) => {
        signal = cancellation;
        await new Promise<void>((_resolve, reject) => {
          cancellation.addEventListener('abort', () => reject(new Error('cancelled')), {
            once: true,
          });
        });
      };
      const pending = h.controller.request('phone', {
        op: 'stop',
        lease: first.lease,
        lockScreen: true,
      });
      const rejected = expect(pending).rejects.toThrow('cancelled');
      h.controller.stop('other');
      expect(signal.aborted).toBe(false);
      if (reason === 'stop') h.controller.stop('phone');
      if (reason === 'expiry') {
        h.advance(120000);
        h.controller.tick();
      }
      if (reason === 'revoke') {
        h.revoke();
        h.controller.tick();
      }
      if (reason === 'account') {
        account = 'second';
        h.controller.tick();
      }
      expect(signal.aborted).toBe(true);
      await rejected;
      expect(h.controller.state).toBeNull();
    },
  );
  it('releases a stalled fallback frame for another peer without stopping its lease', async () => {
    vi.useFakeTimers();
    try {
      const h = harness(),
        first = await h.start();
      let finish!: (value: string) => void;
      h.deps.frame = () =>
        enumerateDesktopSources(
          () =>
            new Promise<string>((yes) => {
              finish = yes;
            }),
          5000,
        );
      const stalled = h.controller.request('phone', { op: 'frame', lease: first.lease });
      const rejection = expect(stalled).rejects.toThrow('DESKTOP_VIDEO_TIMEOUT');
      const next = (await h.controller.request('other', {
        op: 'start',
        displayId: '1',
        takeover: true,
      })) as RemoteDesktopLease;
      await vi.advanceTimersByTimeAsync(5000);
      await rejection;
      const stops = vi.mocked(h.deps.stopVideo).mock.calls.length;
      h.advance(350);
      h.deps.frame = async () => 'new frame';
      await expect(
        h.controller.request('other', { op: 'frame', lease: next.lease }),
      ).resolves.toEqual({ jpeg: 'new frame' });
      finish('stale frame');
      await Promise.resolve();
      expect(h.controller.hasLease(next.lease)).toBe(true);
      expect(h.deps.stopVideo).toHaveBeenCalledTimes(stops);
    } finally {
      vi.useRealTimers();
    }
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
  it.each(['success', 'failure'] as const)(
    'releases old geometry before the native write and preserves replacements on %s',
    async (outcome) => {
      const h = harness(),
        first = await h.start();
      await h.controller.request('phone', { op: 'control', lease: first.lease, enabled: true });
      let finish!: () => void;
      h.deps.resolution = async (_display, _mode, beforeChange) => {
        beforeChange();
        expect(h.controller.displayId).toBeNull();
        expect(h.controller.hasLease(first.lease)).toBe(false);
        // The real display listener matches displayId, now null, before helper exit.
        if (h.controller.displayId === '1') h.controller.stop();
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        if (outcome === 'failure') throw new Error('native failed');
      };
      const pending = h.controller.request('phone', {
        op: 'resolution',
        lease: first.lease,
        modeId: '1',
      });
      const next = (await h.controller.request('other', {
        op: 'start',
        displayId: '1',
      })) as RemoteDesktopLease;
      const stops = vi.mocked(h.deps.stopVideo).mock.calls.length;
      finish();
      if (outcome === 'success') await expect(pending).resolves.toEqual({ ok: true });
      else await expect(pending).rejects.toThrow('native failed');
      expect(h.controller.hasLease(next.lease)).toBe(true);
      expect(h.deps.stopVideo).toHaveBeenCalledTimes(stops);
    },
  );
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
    await expect(h.controller.request('other', { op: 'start', displayId: '1' })).rejects.toThrow(
      'DESKTOP_BUSY',
    );
    await expect(
      h.controller.request('other', { op: 'start', displayId: 'missing', takeover: true }),
    ).rejects.toThrow('DESKTOP_DISPLAY_MISSING');
    expect(h.controller.hasLease(first.lease)).toBe(true);
    await expect(
      h.controller.request('other', { op: 'start', displayId: '1', takeover: true, resume: true }),
    ).rejects.toThrow('INVALID_REQUEST');
    const second = (await h.controller.request('other', {
      op: 'start',
      displayId: '1',
      takeover: true,
    })) as RemoteDesktopLease;
    expect(h.controller.hasLease(first.lease)).toBe(false);
    expect(h.controller.hasLease(second.lease)).toBe(true);
    await expect(h.controller.request('phone', { op: 'stop', lease: first.lease })).rejects.toThrow(
      'DESKTOP_STOPPED',
    );
    expect(h.controller.hasLease(second.lease)).toBe(true);
    h.controller.stop('other');
    await expect(
      h.controller.request('phone', { op: 'start', displayId: '1', resume: true }),
    ).rejects.toThrow('DESKTOP_STOPPED');
  });
  it('recovers its own display with a fresh input sequence after a lost start reply', async () => {
    const h = harness();
    const first = await h.start();
    await h.controller.request('phone', { op: 'control', lease: first.lease, enabled: true });
    h.controller.input(first.lease, 100, [{ kind: 'release' }]);
    for (const request of [{ displayId: '1' }, { displayId: 'other', resume: true }])
      await expect(h.controller.request('phone', { op: 'start', ...request })).rejects.toThrow(
        'DESKTOP_BUSY',
      );
    await expect(
      h.controller.request('other', { op: 'start', displayId: '1', resume: true }),
    ).rejects.toThrow('DESKTOP_BUSY');
    const next = (await h.controller.request('phone', {
      op: 'start',
      displayId: '1',
      resume: true,
    })) as RemoteDesktopLease;
    expect(next.lease).not.toBe(first.lease);
    expect(h.controller.hasLease(first.lease)).toBe(false);
    expect(h.deps.stopInput).toHaveBeenCalledTimes(1);
    expect(h.deps.stopVideo).toHaveBeenCalledTimes(1);
    await expect(h.controller.request('phone', { op: 'stop', lease: first.lease })).rejects.toThrow(
      'DESKTOP_LEASE_EXPIRED',
    );
    await h.controller.request('phone', { op: 'control', lease: next.lease, enabled: true });
    h.controller.input(next.lease, 0, [{ kind: 'release' }]);
    expect(h.deps.input).toHaveBeenCalledTimes(2);
    expect(h.controller.hasLease(next.lease)).toBe(true);
  });
  it.each(['cancel', 'revoke', 'host-stop', 'reject'] as const)(
    'does not revive a pending same-peer resume after %s',
    async (event) => {
      const h = harness();
      const first = await h.start();
      let resolve!: (value: Awaited<ReturnType<DesktopControllerDeps['capabilities']>>) => void;
      let reject!: (reason: Error) => void;
      const caps = await h.deps.capabilities();
      h.deps.capabilities = () =>
        new Promise((yes, no) => {
          resolve = yes;
          reject = no;
        });
      const pending = h.controller
        .request('phone', { op: 'start', displayId: '1', resume: true })
        .then(
          () => null,
          (error: unknown) => error,
        );
      expect(resolve).toBeTypeOf('function');
      await expect(
        h.controller.request('other', { op: 'start', displayId: '1', takeover: true }),
      ).rejects.toThrow('DESKTOP_BUSY');
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
    h.deps.frame = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    const frame = h.controller.request('phone', { op: 'frame', lease: first.lease });
    const next = (await h.controller.request('phone', {
      op: 'start',
      displayId: '1',
      resume: true,
    })) as RemoteDesktopLease;
    finish('old frame');
    await expect(frame).rejects.toThrow('DESKTOP_LEASE_EXPIRED');
    h.advance(350);
    h.deps.frame = vi.fn(async () => 'new frame');
    await expect(
      h.controller.request('phone', { op: 'frame', lease: next.lease }),
    ).resolves.toEqual({ jpeg: 'new frame' });
    expect(h.controller.hasLease(next.lease)).toBe(true);
    expect(h.deps.stopVideo).toHaveBeenCalledTimes(1);
  });
  it.each([false, true])(
    'bounds relay frames with cursor overlay=%s without stopping the lease',
    async (overlay) => {
      const h = harness();
      const { lease } = await h.start();
      const cursor = null;
      for (const bytes of [180_000, 180_001, 180_000]) {
        const jpeg = Buffer.alloc(bytes).toString('base64');
        h.deps.frame = vi.fn(async () => (overlay ? { jpeg, cursor } : jpeg));
        const result = await h.controller.request('phone', {
          op: 'frame',
          lease,
          cursorOverlay: overlay,
        });
        expect(result).toEqual(
          bytes > 180_000 ? { jpeg: null } : overlay ? { jpeg, cursor } : { jpeg },
        );
        h.advance(350);
      }
      expect(h.controller.hasLease(lease)).toBe(true);
      expect(h.deps.stopVideo).not.toHaveBeenCalled();
      expect(h.deps.stopInput).not.toHaveBeenCalled();
    },
  );
  it('keeps the same lease and video negotiation through an empty fallback frame', async () => {
    const h = harness();
    h.deps.frame = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce('jpeg');
    const { lease } = await h.start();
    await expect(h.controller.request('phone', { op: 'frame', lease })).resolves.toEqual({
      jpeg: null,
    });
    h.advance(350);
    await expect(h.controller.request('phone', { op: 'frame', lease })).resolves.toEqual({
      jpeg: 'jpeg',
    });
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
      return new Promise<string>((resolve) => {
        finishCopy = resolve;
      });
    };
    const copy = h.controller.request('phone', {
      op: 'clipboard',
      lease: first.lease,
      action: 'copy',
    });
    const caps = await h.deps.capabilities();
    let finishStart!: (value: typeof caps) => void;
    h.deps.capabilities = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<typeof caps>((resolve) => {
            finishStart = resolve;
          }),
      )
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
    await expect(
      h.controller.request('other', { op: 'start', displayId: '1', takeover: true }),
    ).resolves.toHaveProperty('lease');
  });
  it.each([false, true])(
    'isolates unrelated peer stop while retaining global cancellation (global=%s)',
    async (global) => {
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
    },
  );
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
    await expect(
      h.controller.request('phone', { op: 'frame', lease: lease.lease }),
    ).resolves.toEqual({ jpeg: 'jpeg' });
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
it.each(['control', 'presentation', 'failure', 'stop'] as const)(
  'releases input before failing safety restoration on %s, without stopping replacement input',
  async (kind) => {
    const h = harness(),
      { lease } = await h.start();
    await h.controller.request('phone', { op: 'control', lease, enabled: true });
    let rejectRestore!: (error: Error) => void;
    h.deps.stopHostMute = vi.fn(
      () =>
        new Promise<void>((_, reject) => {
          rejectRestore = reject;
        }),
    );
    h.deps.stopPrivacyScreen = vi.fn();
    let result: Promise<unknown> | undefined;
    if (kind === 'failure') h.controller.releaseControl();
    else if (kind === 'stop') h.controller.stop();
    else
      result = h.controller.request('phone', { op: kind, lease, enabled: kind === 'presentation' });
    // Critical cleanup cannot wait for slow/failing operating-system restoration.
    expect(h.deps.stopInput).toHaveBeenCalledOnce();
    expect(h.deps.stopPrivacyScreen).toHaveBeenCalledOnce();
    expect(h.controller.state?.controlling ?? false).toBe(false);
    const next = kind === 'stop' ? (await h.start()).lease : lease;
    await h.controller.request('phone', { op: 'control', lease: next, enabled: true });
    const rejection = result ? expect(result).rejects.toThrow('restore failed') : Promise.resolve();
    rejectRestore(new Error('restore failed'));
    await rejection;
    await Promise.resolve();
    expect(h.deps.stopInput).toHaveBeenCalledOnce();
    expect(h.controller.state?.controlling).toBe(true);
  },
);
it.each(['control', 'presentation', 'failure'] as const)(
  'revokes safety effects on %s control loss',
  async (kind) => {
    const h = harness(),
      { lease } = await h.start();
    h.deps.privacyScreen = vi.fn(async () => {});
    h.deps.hostMute = vi.fn(async () => {});
    h.deps.stopPrivacyScreen = vi.fn();
    h.deps.stopHostMute = vi.fn();
    for (const op of ['privacyScreen', 'hostMute'] as const)
      await expect(h.controller.request('phone', { op, lease, enabled: true })).rejects.toThrow(
        'DESKTOP_VIEW_ONLY',
      );
    expect(h.deps.privacyScreen).not.toHaveBeenCalled();
    expect(h.deps.hostMute).not.toHaveBeenCalled();
    await h.controller.request('phone', { op: 'control', lease, enabled: true });
    await h.controller.request('phone', { op: 'privacyScreen', lease, enabled: true });
    await h.controller.request('phone', { op: 'hostMute', lease, enabled: true });
    if (kind === 'failure') h.controller.releaseControl();
    else await h.controller.request('phone', { op: kind, lease, enabled: kind === 'presentation' });
    expect(h.deps.stopPrivacyScreen).toHaveBeenCalledOnce();
    expect(h.deps.stopHostMute).toHaveBeenCalledOnce();
    expect(h.deps.stopVideo).not.toHaveBeenCalled();
  },
);
it('joins duplicate privacy initialization and invalidates it on control loss', async () => {
  const h = harness(),
    { lease } = await h.start();
  await h.controller.request('phone', { op: 'control', lease, enabled: true });
  let ready!: () => void;
  h.deps.privacyScreen = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        ready = resolve;
      }),
  );
  const first = h.controller.request('phone', { op: 'privacyScreen', lease, enabled: true });
  const second = h.controller.request('phone', {
    op: 'privacyScreen',
    lease,
    enabled: true,
    lockOnExit: true,
  });
  let settled = false;
  void second.then(
    () => {
      settled = true;
    },
    () => {},
  );
  await Promise.resolve();
  expect(settled).toBe(false);
  expect(h.deps.privacyScreen).toHaveBeenCalledOnce();
  h.controller.releaseControl();
  const errors = Promise.all([
    expect(first).rejects.toThrow('DESKTOP_LEASE_EXPIRED'),
    expect(second).rejects.toThrow('DESKTOP_LEASE_EXPIRED'),
  ]);
  ready();
  await errors;
});
