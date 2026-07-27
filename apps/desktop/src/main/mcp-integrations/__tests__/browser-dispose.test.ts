import { describe, expect, it, vi } from 'vitest';

import {
  stopRuntimeForQuit,
  stopRuntimeForQuitIfUsed,
  trackBrowserRuntimeUsage,
} from '../browser-dispose.js';
import type { BrowserControlRequest, BrowserControlResult } from '@cindy/browser-control-runtime';

function fakeLogger() {
  return { info: vi.fn(), warn: vi.fn() };
}

describe('stopRuntimeForQuit', () => {
  it('sends a stop action on the quit path', async () => {
    const call = vi.fn<(req: BrowserControlRequest) => Promise<BrowserControlResult>>(async () => ({
      ok: true,
      action: 'stop',
      status: 200,
    }));
    const logger = fakeLogger();

    await stopRuntimeForQuit({ call }, logger);

    expect(call).toHaveBeenCalledTimes(1);
    expect(call.mock.calls[0][0]).toEqual({ action: 'stop' });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('warns but does not throw when stop returns not-ok', async () => {
    const call = vi.fn(
      async (): Promise<BrowserControlResult> => ({
        ok: false,
        action: 'stop',
        errorCode: 'BROWSER_RUNTIME_ACTION_FAILED',
        message: 'boom',
      }),
    );
    const logger = fakeLogger();

    await expect(stopRuntimeForQuit({ call }, logger)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('swallows a thrown error (shutdown must not stall)', async () => {
    const call = vi.fn(async (): Promise<BrowserControlResult> => {
      throw new Error('dispatch exploded');
    });
    const logger = fakeLogger();

    await expect(stopRuntimeForQuit({ call }, logger)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});

describe('stopRuntimeForQuitIfUsed', () => {
  it('skips the stop dispatch entirely when the runtime was never used', async () => {
    // The vendored dispatch bridge boots the browser control service before
    // routing ANY action — so "never used" must mean zero calls, not a no-op stop.
    const call = vi.fn<(req: BrowserControlRequest) => Promise<BrowserControlResult>>(async () => ({
      ok: true,
      action: 'stop',
      status: 200,
    }));
    const tracked = trackBrowserRuntimeUsage({ call });
    const logger = fakeLogger();

    await stopRuntimeForQuitIfUsed(tracked, logger);

    expect(call).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('never used this session'),
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('stops normally when the runtime saw traffic this session', async () => {
    const call = vi.fn<(req: BrowserControlRequest) => Promise<BrowserControlResult>>(
      async (req) => ({ ok: true, action: req.action, status: 200 }),
    );
    const tracked = trackBrowserRuntimeUsage({ call });
    const logger = fakeLogger();

    await tracked.call({ action: 'status' });
    await stopRuntimeForQuitIfUsed(tracked, logger);

    expect(call).toHaveBeenCalledTimes(2);
    expect(call.mock.calls[1][0]).toEqual({ action: 'stop' });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('does not count a rejected call as usage — service liveness unproven', async () => {
    // Review P1: marking at dispatch time would treat a failed-boot call as
    // "service is up", and the quit-time stop would then re-run the boot.
    const call = vi.fn<(req: BrowserControlRequest) => Promise<BrowserControlResult>>(async () => {
      throw new Error('dispatch exploded');
    });
    const tracked = trackBrowserRuntimeUsage({ call });
    const logger = fakeLogger();

    await expect(tracked.call({ action: 'status' })).rejects.toThrow('dispatch exploded');
    await stopRuntimeForQuitIfUsed(tracked, logger);

    expect(call).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('never used this session'));
  });

  it('does not count an ok:false result as usage — startup failures surface as not-ok', async () => {
    const call = vi.fn<(req: BrowserControlRequest) => Promise<BrowserControlResult>>(
      async (req) => ({ ok: false, action: req.action, status: 500 }),
    );
    const tracked = trackBrowserRuntimeUsage({ call });
    const logger = fakeLogger();

    await tracked.call({ action: 'status' });
    await stopRuntimeForQuitIfUsed(tracked, logger);

    expect(call).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('never used this session'));
  });

  it('does not count a stop dispatch as usage — teardown is not traffic', async () => {
    // Review P1: ExternalChromeBackend.dispose (backend switching) sends a
    // stop through the same wrapper; counting it would make the quit path
    // dispatch a second stop that re-boots the service.
    const call = vi.fn<(req: BrowserControlRequest) => Promise<BrowserControlResult>>(
      async (req) => ({ ok: true, action: req.action, status: 200 }),
    );
    const tracked = trackBrowserRuntimeUsage({ call });
    const logger = fakeLogger();

    await tracked.call({ action: 'stop' });
    await stopRuntimeForQuitIfUsed(tracked, logger);

    expect(call).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('never used this session'));
  });
});
