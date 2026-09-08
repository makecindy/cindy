// Verifies requests reach the runtime verbatim, status identifies the backend,
// other results pass through unchanged, and dispose
// goes through the same `stopRuntimeForQuit` contract (logs-and-swallows).

import { describe, expect, it, vi } from 'vitest';

import type { BrowserControlRequest, BrowserControlResult } from '@cindy/browser-control-runtime';

import { ExternalChromeBackend } from '../external-chrome-backend.js';

function fakeLogger() {
  return { warn: vi.fn() };
}

describe('ExternalChromeBackend', () => {
  it('reports kind = "external"', () => {
    const call = vi.fn();
    const backend = new ExternalChromeBackend({ call }, fakeLogger());
    expect(backend.kind).toBe('external');
  });

  it('identifies the external backend while preserving runtime status fields', async () => {
    const result: BrowserControlResult = { ok: true, action: 'status', status: 200, data: { ready: true } };
    const call = vi.fn<(req: BrowserControlRequest) => Promise<BrowserControlResult>>(async () => result);
    const backend = new ExternalChromeBackend({ call }, fakeLogger());

    const got = await backend.call({ action: 'status' });

    expect(call).toHaveBeenCalledTimes(1);
    expect(call.mock.calls[0][0]).toEqual({ action: 'status' });
    expect(got).toEqual({ ...result, data: { ready: true, backend: 'external' } });
    expect(result.data).toEqual({ ready: true });
  });

  it('passes complex requests through unchanged', async () => {
    const call = vi.fn<(req: BrowserControlRequest) => Promise<BrowserControlResult>>(
      async () => ({ ok: true, action: 'act' }),
    );
    const backend = new ExternalChromeBackend({ call }, fakeLogger());

    const req: BrowserControlRequest = {
      action: 'act',
      targetId: 'tab-1',
      request: { kind: 'click', ref: 'ref-7' },
    };
    await backend.call(req);

    expect(call.mock.calls[0][0]).toBe(req);
  });

  it('dispose() sends a stop and resolves on success', async () => {
    const call = vi.fn<(req: BrowserControlRequest) => Promise<BrowserControlResult>>(
      async () => ({ ok: true, action: 'stop' }),
    );
    const logger = fakeLogger();
    const backend = new ExternalChromeBackend({ call }, logger);

    await backend.dispose();

    expect(call).toHaveBeenCalledTimes(1);
    expect(call.mock.calls[0][0]).toEqual({ action: 'stop' });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('dispose() swallows runtime errors (quit path must not stall)', async () => {
    const call = vi.fn<(req: BrowserControlRequest) => Promise<BrowserControlResult>>(async () => {
      throw new Error('boom');
    });
    const logger = fakeLogger();
    const backend = new ExternalChromeBackend({ call }, logger);

    await expect(backend.dispose()).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});
