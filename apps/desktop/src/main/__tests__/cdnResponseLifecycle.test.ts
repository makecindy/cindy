import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const requestMock = vi.hoisted(() => vi.fn());
vi.mock('electron', () => ({ app: { isPackaged: true }, net: { request: requestMock } }));
vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../canaryFlagStore', () => ({ read: () => false }));
vi.mock('../updateChannelStore', () => ({ isBetaChannelEnabled: () => false }));
vi.mock('../clientEndpointsService', () => ({ getClientEndpoint: () => 'https://cdn.example.test' }));

// Model response and request lifetimes separately: Electron's writable request
// can emit close before response data/end. Only response termination owns the body.
function transport(action: (request: EventEmitter, response: EventEmitter) => void) {
  const requests: Array<EventEmitter & { end: ReturnType<typeof vi.fn>; abort: ReturnType<typeof vi.fn> }> = [];
  const responses: Array<EventEmitter & { statusCode: number }> = [];
  requestMock.mockImplementation(() => {
    const response = Object.assign(new EventEmitter(), { statusCode: 200 });
    const request = Object.assign(new EventEmitter(), {
      end: vi.fn(() => action(request, response)),
      abort: vi.fn(() => {
        // Exercise re-entrant cleanup and error listeners on discarded bodies.
        request.emit('error', new Error('aborted'));
        if (response.listenerCount('error')) response.emit('error', new Error('aborted body'));
        response.emit('close');
      }),
    });
    requests.push(request);
    responses.push(response);
    return request;
  });
  return { requests, responses };
}

beforeEach(() => {
  vi.resetModules();
  requestMock.mockReset();
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe.each(['manifest', 'release'] as const)('%s response lifecycle', (consumer) => {
  async function start() {
    if (consumer === 'manifest') {
      const { fetchManifest } = await import('../manifestService');
      return { call: (signal?: AbortSignal) => fetchManifest(100, signal), good: '{"app":{"version":"1.0.0"}}' };
    }
    const { fetchReleaseNotesIndex } = await import('../releaseNotesService');
    return { call: fetchReleaseNotesIndex, good: '["1.0.0"]' };
  }

  it.each([403, 404, 429, 500, 503])('aborts HTTP %s without waiting for a body or changing retry classification', async (status) => {
    const { call } = await start();
    const { requests, responses } = transport((request, response) => {
      Object.assign(response, { statusCode: status });
      request.emit('response', response);
    });
    await expect(call()).resolves.toBeNull();
    expect(requests).toHaveLength(1);
    expect(requests[0].abort).toHaveBeenCalledTimes(1);
    // Late errors must remain handled after the HTTP result has settled.
    expect(() => responses[0].emit('error', new Error('late error'))).not.toThrow();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['no headers', 'unfinished 200', 'stream error', 'early response close', 'network error', 'end throws'])('releases %s and settles within the existing retry budget', async (scenario) => {
    const { call } = await start();
    const { requests } = transport((request, response) => {
      if (scenario === 'end throws') throw new Error('synchronous end failure');
      if (scenario === 'network error') { request.emit('error', new Error('offline')); return; }
      if (scenario === 'no headers') return;
      request.emit('response', response);
      response.emit('data', Buffer.from('{'));
      if (scenario === 'stream error') response.emit('error', new Error('broken stream'));
      if (scenario === 'early response close') response.emit('close');
    });
    const pending = call();
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toBeNull();
    expect(requests).toHaveLength(consumer === 'manifest' ? 1 : 4);
    for (const request of requests) expect(request.abort).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['', '{invalid'])('fully consumes invalid JSON %j without retrying', async (body) => {
    const { call } = await start();
    const { requests } = transport((request, response) => {
      request.emit('response', response);
      response.emit('data', Buffer.from(body));
      response.emit('end');
      response.emit('close');
    });
    await expect(call()).resolves.toBeNull();
    expect(requests).toHaveLength(1);
    expect(requests[0].abort).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('waits for response end despite an earlier writable request close', async () => {
    const { call, good } = await start();
    const { requests, responses } = transport((request, response) => {
      request.emit('close');
      request.emit('response', response);
      response.emit('data', Buffer.from(good));
    });
    const settled = vi.fn();
    const pending = call().then(settled);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
    responses[0].emit('end');
    responses[0].emit('close');
    await pending;
    expect(settled).toHaveBeenCalledTimes(1);
    expect(settled.mock.calls[0][0]).not.toBeNull();
    expect(requests[0].abort).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('aborts oversized 200 bodies and ignores later data/end', async () => {
    const { call } = await start();
    const { requests } = transport((request, response) => {
      request.emit('response', response);
      const chunk = Buffer.alloc(1024 * 1024, ' ');
      for (let i = 0; i < 9; i++) response.emit('data', chunk);
      response.emit('end');
    });
    await expect(call()).resolves.toBeNull();
    expect(requests).toHaveLength(1);
    expect(requests[0].abort).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('manifest caller cancellation', () => {
  it.each(['before creation', 'during creation', 'before headers', 'after headers'])('handles cancellation %s', async (when) => {
    const { fetchManifest, getCachedManifest } = await import('../manifestService');
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const { requests, responses } = transport((request, response) => {
      if (when === 'after headers') request.emit('response', response);
    });
    if (when === 'before creation') controller.abort();
    if (when === 'during creation') {
      const create = requestMock.getMockImplementation()!;
      requestMock.mockImplementation(() => { controller.abort(); return create(); });
    }
    const pending = fetchManifest(100, controller.signal);
    controller.abort();
    await expect(pending).resolves.toBeNull();
    if (when === 'before creation') expect(requestMock).not.toHaveBeenCalled();
    else {
      expect(requests[0].abort).toHaveBeenCalledTimes(1);
      expect(remove).toHaveBeenCalled();
      // A late response cannot resurrect a completed request or update cache.
      requests[0].emit('response', responses[0]);
      responses[0].emit('data', Buffer.from('{"app":{"version":"9.0.0"}}'));
      responses[0].emit('end');
      expect(getCachedManifest()).toBeNull();
      if (when === 'during creation') expect(requests[0].end).not.toHaveBeenCalled();
    }
    expect(vi.getTimerCount()).toBe(0);
  });
});
