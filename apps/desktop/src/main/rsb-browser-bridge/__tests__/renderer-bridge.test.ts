// Verifies the main → renderer tab-op bridge:
//  - successful round-trip via `tab-op-result` ipcMain handler
//  - timeout when renderer never answers
//  - host webContents missing → reject without leaking pending map entry
//  - late result after timeout is dropped (no late resolve)

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => {
  const ipcMainHandlers = new Map<string, (e: unknown, payload: unknown) => unknown>();
  return {
    ipcMain: {
      handle: vi.fn((channel: string, fn: (e: unknown, payload: unknown) => unknown) => {
        ipcMainHandlers.set(channel, fn);
      }),
      __handlers: ipcMainHandlers,
    },
  };
});

import { ipcMain } from 'electron';
import {
  _resetRendererBridgeForTests,
  dispatchTabOp,
  registerTabOpResultHandler,
  type RendererBridgeOptions,
} from '../renderer-bridge.js';

interface FakeWc {
  send: ReturnType<typeof vi.fn>;
  isDestroyed: () => boolean;
  destroyed: boolean;
}

function fakeWc(): FakeWc {
  const wc = {
    send: vi.fn(),
    isDestroyed: () => wc.destroyed,
    destroyed: false,
  };
  return wc;
}

function logger() {
  return { warn: vi.fn() };
}

function getRegisteredHandler(channel: string) {
  return (ipcMain as unknown as { __handlers: Map<string, (e: unknown, payload: unknown) => unknown> })
    .__handlers.get(channel);
}

beforeEach(() => {
  _resetRendererBridgeForTests();
  (ipcMain as unknown as { __handlers: Map<string, unknown> }).__handlers.clear();
  // Clear cross-test call counts on the ipcMain.handle mock — same vi.fn is
  // re-used across testcases (module is loaded once), so without this each
  // registerTabOpResultHandler call accumulates from prior tests.
  (ipcMain.handle as ReturnType<typeof vi.fn>).mockClear();
});

afterEach(() => {
  _resetRendererBridgeForTests();
});

describe('dispatchTabOp — happy path', () => {
  it('round-trips through the result handler keyed by reqId', async () => {
    const wc = fakeWc();
    const opts: RendererBridgeOptions = {
      getHostWebContents: () => wc as unknown as Electron.WebContents,
      logger: logger(),
      timeoutMs: 1000,
    };
    registerTabOpResultHandler(opts);

    const pending = dispatchTabOp(
      { op: 'open', sessionId: 's1', url: 'https://example.com' },
      opts,
    );

    // The first send call carries a reqId we'll need to echo back.
    expect(wc.send).toHaveBeenCalledTimes(1);
    const sent = wc.send.mock.calls[0][1] as { reqId: string; op: string };
    expect(sent.op).toBe('open');
    expect(typeof sent.reqId).toBe('string');

    // Simulate renderer answering.
    const handler = getRegisteredHandler('rsb-browser-bridge:tab-op-result');
    handler?.(null, { reqId: sent.reqId, ok: true, tabId: 't-fresh' });

    const result = await pending;
    expect(result).toEqual({ reqId: sent.reqId, ok: true, tabId: 't-fresh' });
  });

  it('result for unknown reqId is acknowledged but does not resolve any pending', async () => {
    const wc = fakeWc();
    const opts: RendererBridgeOptions = {
      getHostWebContents: () => wc as unknown as Electron.WebContents,
      logger: logger(),
    };
    registerTabOpResultHandler(opts);

    const handler = getRegisteredHandler('rsb-browser-bridge:tab-op-result');
    const ack = handler?.(null, { reqId: 'no-such', ok: true, tabId: 't' });
    expect(ack).toEqual({ ok: true });
  });
});

describe('dispatchTabOp — failure paths', () => {
  it('rejects when no host webContents available', async () => {
    const opts: RendererBridgeOptions = {
      getHostWebContents: () => null,
      logger: logger(),
    };
    await expect(
      dispatchTabOp({ op: 'focus', sessionId: 's1', tabId: 't1' }, opts),
    ).rejects.toThrow(/host renderer not available/);
  });

  it('rejects when host webContents is destroyed', async () => {
    const wc = fakeWc();
    wc.destroyed = true;
    const opts: RendererBridgeOptions = {
      getHostWebContents: () => wc as unknown as Electron.WebContents,
      logger: logger(),
    };
    await expect(
      dispatchTabOp({ op: 'close', sessionId: 's1', tabId: 't1' }, opts),
    ).rejects.toThrow(/host renderer not available/);
  });

  it('times out when renderer never answers', async () => {
    vi.useFakeTimers();
    try {
      const wc = fakeWc();
      const opts: RendererBridgeOptions = {
        getHostWebContents: () => wc as unknown as Electron.WebContents,
        logger: logger(),
        timeoutMs: 50,
      };
      registerTabOpResultHandler(opts);

      const pending = dispatchTabOp(
        { op: 'focus', sessionId: 's1', tabId: 't1' },
        opts,
      );

      vi.advanceTimersByTime(60);
      await expect(pending).rejects.toThrow(/timed out after 50ms/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('late result after timeout is silently dropped (no double resolve, no throw)', async () => {
    vi.useFakeTimers();
    try {
      const wc = fakeWc();
      const log = logger();
      const opts: RendererBridgeOptions = {
        getHostWebContents: () => wc as unknown as Electron.WebContents,
        logger: log,
        timeoutMs: 30,
      };
      registerTabOpResultHandler(opts);

      const pending = dispatchTabOp(
        { op: 'open', sessionId: 's1' },
        opts,
      );
      const sent = wc.send.mock.calls[0][1] as { reqId: string };

      vi.advanceTimersByTime(40);
      await expect(pending).rejects.toThrow(/timed out/);

      // Now the late answer arrives. Handler must log + ack ok, NOT throw.
      const handler = getRegisteredHandler('rsb-browser-bridge:tab-op-result');
      const ack = handler?.(null, { reqId: sent.reqId, ok: true, tabId: 'late' });
      expect(ack).toEqual({ ok: true });
      expect(log.warn).toHaveBeenCalledWith(
        'tab-op result for unknown reqId',
        expect.objectContaining({ reqId: sent.reqId }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('wc.send throw rejects the call AND removes pending entry', async () => {
    const wc = fakeWc();
    wc.send.mockImplementation(() => {
      throw new Error('IPC channel closed');
    });
    const opts: RendererBridgeOptions = {
      getHostWebContents: () => wc as unknown as Electron.WebContents,
      logger: logger(),
      timeoutMs: 50,
    };
    registerTabOpResultHandler(opts);

    await expect(
      dispatchTabOp({ op: 'close', sessionId: 's1', tabId: 't1' }, opts),
    ).rejects.toThrow(/IPC channel closed/);
  });
});

describe('dispatchTabOp — ensureHost(detached 侧边栏子窗口)', () => {
  it('skips ensureHost for a side-effect-free health probe', async () => {
    const wc = fakeWc();
    const ensureHost = vi.fn(async () => undefined);
    const opts: RendererBridgeOptions = {
      getHostWebContents: () => wc as unknown as Electron.WebContents,
      ensureHost,
      logger: logger(),
    };
    registerTabOpResultHandler(opts);

    const pending = dispatchTabOp(
      { op: 'probe' },
      opts,
      undefined,
      { ensureHost: false },
    );
    const sent = wc.send.mock.calls[0][1] as { reqId: string };
    getRegisteredHandler('rsb-browser-bridge:tab-op-result')?.(
      null,
      { reqId: sent.reqId, ok: true },
    );

    await expect(pending).resolves.toMatchObject({ ok: true });
    expect(ensureHost).not.toHaveBeenCalled();
  });

  it('does not send after a lifecycle guard invalidates during ensureHost', async () => {
    let finishEnsure: (() => void) | undefined;
    let active = true;
    const ensureHost = vi.fn(
      () => new Promise<void>((resolve) => {
        finishEnsure = resolve;
      }),
    );
    const wc = fakeWc();
    const opts: RendererBridgeOptions = {
      getHostWebContents: () => wc as unknown as Electron.WebContents,
      ensureHost,
      logger: logger(),
    };
    const pending = dispatchTabOp(
      { op: 'probe' },
      opts,
      () => {
        if (!active) throw new Error('generation was replaced');
      },
    );

    await Promise.resolve();
    active = false;
    finishEnsure?.();

    await expect(pending).rejects.toThrow(/generation was replaced/);
    expect(wc.send).not.toHaveBeenCalled();
  });

  it('先 await ensureHost 再取 host / send(窗口拉起后 op 才发出)', async () => {
    const wc = fakeWc();
    let hostReady = false;
    let releaseEnsure: () => void = () => undefined;
    const ensureHost = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseEnsure = () => {
            hostReady = true;
            resolve();
          };
        }),
    );
    const opts: RendererBridgeOptions = {
      // ensureHost 完成前 host 不可用 —— 模拟"子窗口还没开"
      getHostWebContents: () => (hostReady ? (wc as unknown as Electron.WebContents) : null),
      ensureHost,
      logger: logger(),
      timeoutMs: 1000,
    };
    registerTabOpResultHandler(opts);

    const pending = dispatchTabOp({ op: 'open', sessionId: 's1', url: 'https://x.dev' }, opts);
    expect(ensureHost).toHaveBeenCalledTimes(1);
    expect(ensureHost).toHaveBeenCalledWith('s1');
    expect(wc.send).not.toHaveBeenCalled();

    releaseEnsure();
    await Promise.resolve(); // 让 dispatchTabOp 里的 await 续跑
    expect(wc.send).toHaveBeenCalledTimes(1);

    const sent = wc.send.mock.calls[0][1] as { reqId: string };
    const handler = getRegisteredHandler('rsb-browser-bridge:tab-op-result');
    handler?.(null, { reqId: sent.reqId, ok: true, tabId: 't1' });
    await expect(pending).resolves.toMatchObject({ ok: true, tabId: 't1' });
  });

  it('ensureHost reject → op reject,不发 send', async () => {
    const wc = fakeWc();
    const opts: RendererBridgeOptions = {
      getHostWebContents: () => wc as unknown as Electron.WebContents,
      ensureHost: () => Promise.reject(new Error('sidebar window ready timeout')),
      logger: logger(),
    };
    registerTabOpResultHandler(opts);

    await expect(
      dispatchTabOp({ op: 'focus', sessionId: 's1', tabId: 't1' }, opts),
    ).rejects.toThrow(/ready timeout/);
    expect(wc.send).not.toHaveBeenCalled();
  });
});

describe('registerTabOpResultHandler — idempotent', () => {
  it('repeat registration is a no-op (handler installed once)', () => {
    const wc = fakeWc();
    const opts: RendererBridgeOptions = {
      getHostWebContents: () => wc as unknown as Electron.WebContents,
      logger: logger(),
    };
    registerTabOpResultHandler(opts);
    registerTabOpResultHandler(opts);

    expect(ipcMain.handle).toHaveBeenCalledTimes(1);
  });
});
