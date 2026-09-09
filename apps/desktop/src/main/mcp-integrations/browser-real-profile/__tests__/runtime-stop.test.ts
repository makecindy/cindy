import { describe, expect, it, vi } from 'vitest';
import type {
  BrowserControlRequest,
  BrowserControlResult,
} from '@cindy/browser-control-runtime';

import {
  assertManagedBrowserStopped,
  createBrowserProfileLifecycleQueue,
  managedConfigPatchBeforeStop,
  stopManagedBrowserForProfile,
  wrapRuntimeWithProfileLifecycleQueue,
} from '../runtime-stop.js';
import { RealProfileError } from '../types.js';

function result(action: 'status' | 'stop', ok: boolean, data?: unknown): BrowserControlResult {
  return { ok, action, data };
}

describe('managedConfigPatchBeforeStop', () => {
  it('never rebuilds config before stop, even when a relocated CDP port was remembered', () => {
    expect(managedConfigPatchBeforeStop({ rememberedCdpPort: 18801 })).toBeNull();
    expect(managedConfigPatchBeforeStop({ rememberedCdpPort: null })).toBeNull();
  });
});

describe('assertManagedBrowserStopped', () => {
  it('allows the switch when status says the browser is not running', () => {
    expect(() =>
      assertManagedBrowserStopped({
        status: result('status', true, { running: false }),
        stop: null,
      }),
    ).not.toThrow();
  });

  it('allows the switch after a successful stop', () => {
    expect(() =>
      assertManagedBrowserStopped({
        status: result('status', true, { running: true }),
        stop: result('stop', true, { stopped: true }),
      }),
    ).not.toThrow();
  });

  it('fails closed when status cannot be verified', () => {
    try {
      assertManagedBrowserStopped({
        status: result('status', false),
        stop: null,
      });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(RealProfileError);
      expect(err).toMatchObject({ code: 'STOP_FAILED' });
    }
  });

  it('fails closed when stop returns ok:false or is missing', () => {
    try {
      assertManagedBrowserStopped({
        status: result('status', true, { running: true }),
        stop: result('stop', false),
      });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(RealProfileError);
      expect(err).toMatchObject({ code: 'STOP_FAILED' });
    }

    expect(() =>
      assertManagedBrowserStopped({
        status: result('status', true, { running: true }),
        stop: null,
      }),
    ).toThrow(RealProfileError);
  });

  it('fails closed when stop is ok but did not actually stop the process', () => {
    try {
      assertManagedBrowserStopped({
        status: result('status', true, { running: true }),
        stop: result('stop', true, { stopped: false }),
      });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(RealProfileError);
      expect(err).toMatchObject({ code: 'STOP_FAILED' });
    }

    expect(() =>
      assertManagedBrowserStopped({
        status: result('status', true, { running: true }),
        stop: result('stop', true, {}),
      }),
    ).toThrow(RealProfileError);
  });
});

describe('stopManagedBrowserForProfile', () => {
  it('pins status and stop to the same profile', async () => {
    const call = vi.fn(async (request: BrowserControlRequest) => {
      if (request.action === 'status') return result('status', true, { running: true });
      return result('stop', true, { stopped: true });
    });

    await stopManagedBrowserForProfile({ call }, 'Cindy-real');

    expect(call).toHaveBeenNthCalledWith(1, { action: 'status', profile: 'Cindy-real' });
    expect(call).toHaveBeenNthCalledWith(2, { action: 'stop', profile: 'Cindy-real' });
  });

  it('fails closed when a successful status omits a boolean running flag', () => {
    expect(() =>
      assertManagedBrowserStopped({
        status: result('status', true, {}),
        stop: null,
      }),
    ).toThrow(RealProfileError);

    expect(() =>
      assertManagedBrowserStopped({
        status: result('status', true, { running: 'false' }),
        stop: null,
      }),
    ).toThrow(RealProfileError);
  });

  it('requires a stop when CDP is down but the managed process still has a pid', () => {
    expect(() =>
      assertManagedBrowserStopped({
        status: result('status', true, { running: false, pid: 1234 }),
        stop: null,
      }),
    ).toThrow(RealProfileError);

    expect(() =>
      assertManagedBrowserStopped({
        status: result('status', true, { running: false, pid: 1234 }),
        stop: result('stop', true, { stopped: true }),
      }),
    ).not.toThrow();
  });

  it('does not stop a different profile when the pinned profile is idle', async () => {
    const call = vi.fn(async () => result('status', true, { running: false }));

    await stopManagedBrowserForProfile({ call }, 'Cindy');

    expect(call).toHaveBeenCalledOnce();
    expect(call).toHaveBeenCalledWith({ action: 'status', profile: 'Cindy' });
  });

  it('stops the pinned process when CDP is temporarily unavailable', async () => {
    const call = vi.fn(async (request: BrowserControlRequest) =>
      request.action === 'status'
        ? result('status', true, { running: false, pid: 1234 })
        : result('stop', true, { stopped: true }),
    );

    await stopManagedBrowserForProfile({ call }, 'Cindy-real');

    expect(call).toHaveBeenNthCalledWith(1, { action: 'status', profile: 'Cindy-real' });
    expect(call).toHaveBeenNthCalledWith(2, { action: 'stop', profile: 'Cindy-real' });
  });
});

describe('browser profile lifecycle queue', () => {
  it('waits for an in-flight browser start before changing consent', async () => {
    const queue = createBrowserProfileLifecycleQueue();
    const events: string[] = [];
    let finishStart!: () => void;
    const startGate = new Promise<void>((resolve) => {
      finishStart = resolve;
    });
    const runtime = wrapRuntimeWithProfileLifecycleQueue(
      {
        call: vi.fn(async (request: BrowserControlRequest) => {
          events.push('start');
          await startGate;
          events.push('start-finished');
          return { ok: true, action: request.action };
        }),
      },
      queue,
    );

    const start = runtime.call({ action: 'start' });
    await vi.waitFor(() => expect(events).toEqual(['start']));
    const revokeConsent = queue.run(async () => {
      events.push('consent-revoked');
    });
    await Promise.resolve();
    expect(events).toEqual(['start']);

    finishStart();
    await Promise.all([start, revokeConsent]);
    expect(events).toEqual(['start', 'start-finished', 'consent-revoked']);
  });

  it('keeps later reset work behind an already queued enable operation', async () => {
    const queue = createBrowserProfileLifecycleQueue();
    const events: string[] = [];
    let finishEnable!: () => void;
    const enableGate = new Promise<void>((resolve) => {
      finishEnable = resolve;
    });

    const enable = queue.run(async () => {
      events.push('enable');
      await enableGate;
      events.push('enable-finished');
    });
    const reset = queue.run(async () => {
      events.push('reset');
    });
    await vi.waitFor(() => expect(events).toEqual(['enable']));

    finishEnable();
    await Promise.all([enable, reset]);
    expect(events).toEqual(['enable', 'enable-finished', 'reset']);
  });

  it('continues with later work after a queued operation rejects', async () => {
    const queue = createBrowserProfileLifecycleQueue();
    const failed = queue.run(async () => {
      throw new Error('start failed');
    });
    const next = queue.run(async () => 'completed');

    await expect(failed).rejects.toThrow('start failed');
    await expect(next).resolves.toBe('completed');
  });
});
