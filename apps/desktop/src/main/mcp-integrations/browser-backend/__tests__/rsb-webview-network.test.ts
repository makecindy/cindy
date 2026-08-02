import { describe, expect, it, vi } from 'vitest';
import type { WebContents } from 'electron';

import { RsbWebviewNetwork } from '../rsb-webview-network.js';

function networkHarness() {
  let attached = false;
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const sendCommand = vi.fn(async (method: string) => {
    if (method === 'Network.enable') return {};
    if (method === 'Network.getResponseBody') {
      return { body: '{"ok":true}', base64Encoded: false };
    }
    throw new Error(`unexpected command: ${method}`);
  });
  const electronDebugger = {
    isAttached: () => attached,
    attach: vi.fn(() => {
      attached = true;
    }),
    detach: vi.fn(() => {
      attached = false;
    }),
    sendCommand,
    on: (event: string, listener: (...args: unknown[]) => void) => {
      const group = listeners.get(event) ?? new Set();
      group.add(listener);
      listeners.set(event, group);
    },
    removeListener: (event: string, listener: (...args: unknown[]) => void) => {
      listeners.get(event)?.delete(listener);
    },
  };
  const wc = {
    debugger: electronDebugger,
    once: vi.fn(),
  } as unknown as WebContents;
  const emit = (event: string, ...args: unknown[]) => {
    for (const listener of listeners.get(event) ?? []) listener({}, ...args);
  };
  return { wc, emit, electronDebugger, sendCommand };
}

describe('RsbWebviewNetwork', () => {
  it('buffers request outcomes and returns a bounded response body', async () => {
    const harness = networkHarness();
    const network = new RsbWebviewNetwork({ warn: vi.fn() });
    await network.observe(harness.wc);

    const pendingBody = network.readResponseBody(harness.wc, {
      url: '/api/items',
      maxChars: 5,
    });
    await Promise.resolve();
    harness.emit('message', 'Network.requestWillBeSent', {
      requestId: 'request-1',
      type: 'XHR',
      request: { method: 'POST', url: 'https://example.test/api/items' },
    });
    harness.emit('message', 'Network.responseReceived', {
      requestId: 'request-1',
      response: {
        url: 'https://example.test/api/items',
        status: 201,
        headers: {
          'content-type': 'application/json',
          'set-cookie': 'secret=hidden',
        },
      },
    });
    harness.emit('message', 'Network.loadingFinished', { requestId: 'request-1' });

    expect(network.readRequests(harness.wc)).toEqual([
      expect.objectContaining({
        id: 'request-1',
        method: 'POST',
        resourceType: 'xhr',
        status: 201,
        ok: true,
      }),
    ]);
    await expect(pendingBody).resolves.toEqual({
      url: 'https://example.test/api/items',
      status: 201,
      headers: { 'content-type': 'application/json' },
      body: '{"ok"',
      truncated: true,
    });
  });

  it('clears buffered metadata without leaking sensitive request headers', async () => {
    const harness = networkHarness();
    const network = new RsbWebviewNetwork({ warn: vi.fn() });
    await network.observe(harness.wc);
    harness.emit('message', 'Network.requestWillBeSent', {
      requestId: 'request-2',
      type: 'Fetch',
      request: {
        method: 'GET',
        url: 'https://example.test/private',
        headers: { authorization: 'Bearer secret' },
      },
    });

    expect(network.readRequests(harness.wc, { filter: '/private', clear: true })).toHaveLength(1);
    expect(network.readRequests(harness.wc)).toEqual([]);
    expect(JSON.stringify(network.diagnostics())).not.toContain('secret');
  });

  it('waits for a new matching response instead of reusing response history', async () => {
    const harness = networkHarness();
    const network = new RsbWebviewNetwork({ warn: vi.fn() });
    await network.observe(harness.wc);
    harness.emit('message', 'Network.requestWillBeSent', {
      requestId: 'request-old',
      type: 'XHR',
      request: { method: 'GET', url: 'https://example.test/api/state' },
    });
    harness.emit('message', 'Network.responseReceived', {
      requestId: 'request-old',
      response: { url: 'https://example.test/api/state', status: 200 },
    });
    harness.emit('message', 'Network.loadingFinished', { requestId: 'request-old' });

    const pendingBody = network.readResponseBody(harness.wc, {
      url: '/api/state',
      timeoutMs: 1_000,
    });
    await Promise.resolve();
    expect(harness.sendCommand).not.toHaveBeenCalledWith(
      'Network.getResponseBody',
      { requestId: 'request-old' },
    );
    harness.emit('message', 'Network.requestWillBeSent', {
      requestId: 'request-new',
      type: 'XHR',
      request: { method: 'GET', url: 'https://example.test/api/state' },
    });
    harness.emit('message', 'Network.responseReceived', {
      requestId: 'request-new',
      response: { url: 'https://example.test/api/state', status: 200 },
    });
    harness.emit('message', 'Network.loadingFinished', { requestId: 'request-new' });

    await expect(pendingBody).resolves.toMatchObject({
      url: 'https://example.test/api/state',
      body: '{"ok":true}',
    });
    expect(harness.sendCommand).toHaveBeenCalledWith(
      'Network.getResponseBody',
      { requestId: 'request-new' },
    );
  });

  it('removes URL credentials from request and response output', async () => {
    const harness = networkHarness();
    const network = new RsbWebviewNetwork({ warn: vi.fn() });
    await network.observe(harness.wc);
    const pendingBody = network.readResponseBody(harness.wc, {
      url: '/private',
      timeoutMs: 1_000,
    });
    await Promise.resolve();
    harness.emit('message', 'Network.requestWillBeSent', {
      requestId: 'request-secret',
      type: 'XHR',
      request: {
        method: 'GET',
        url: 'https://user:password@example.test/private',
      },
    });
    harness.emit('message', 'Network.responseReceived', {
      requestId: 'request-secret',
      response: {
        url: 'https://user:password@example.test/private',
        status: 200,
      },
    });
    harness.emit('message', 'Network.loadingFinished', { requestId: 'request-secret' });

    expect(network.readRequests(harness.wc)[0].url).toBe('https://example.test/private');
    await expect(pendingBody).resolves.toMatchObject({
      url: 'https://example.test/private',
    });
  });

  it('waits for an actual quiet network window', async () => {
    const harness = networkHarness();
    const network = new RsbWebviewNetwork({ warn: vi.fn() });
    await network.observe(harness.wc);

    harness.emit('message', 'Network.requestWillBeSent', {
      requestId: 'request-idle',
      type: 'Fetch',
      request: { method: 'GET', url: 'https://example.test/data' },
    });
    const pending = network.waitForIdle(harness.wc, { timeoutMs: 2_000, idleMs: 50 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    harness.emit('message', 'Network.loadingFinished', { requestId: 'request-idle' });
    await expect(pending).resolves.toBeUndefined();
  });

  it('stops pending body and idle waits without debugger commands after dispose', async () => {
    vi.useFakeTimers();
    try {
      const harness = networkHarness();
      const network = new RsbWebviewNetwork({ warn: vi.fn() });
      await network.observe(harness.wc);

      const pendingBody = network.readResponseBody(harness.wc, {
        url: '/api/items',
        timeoutMs: 1_000,
      });
      const pendingIdle = network.waitForIdle(harness.wc, {
        timeoutMs: 1_000,
        idleMs: 500,
      });
      const bodyRejected = expect(pendingBody).rejects.toThrow('network monitor is disposed');
      const idleRejected = expect(pendingIdle).rejects.toThrow('network monitor is disposed');
      await Promise.resolve();
      network.dispose();
      await vi.advanceTimersByTimeAsync(100);

      await bodyRejected;
      await idleRejected;
      expect(harness.sendCommand).not.toHaveBeenCalledWith(
        'Network.getResponseBody',
        expect.anything(),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
