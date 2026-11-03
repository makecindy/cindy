import { EventEmitter, getEventListeners } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
const requestMock = vi.hoisted(() => vi.fn());
vi.mock('electron', () => ({ net: { request: requestMock } }));
import { requestResponse } from '../http';

function nativeRequest() {
  const request = Object.assign(new EventEmitter(), {
    setHeader: vi.fn(),
    abort: vi.fn(),
    end: vi.fn(),
  });
  requestMock.mockReturnValue(request);
  return request;
}
afterEach(() => vi.resetAllMocks());
describe('Electron HTTP stream adapter', () => {
  it('returns redirect metadata without following it or waiting for a body', async () => {
    const request = nativeRequest();
    const signal = new AbortController().signal;
    const pending = requestResponse('https://publisher.test/file', { signal });
    request.emit('redirect', 302, 'GET', 'https://asset.test/file');
    const response = await pending;
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('https://asset.test/file');
    expect(request.abort).toHaveBeenCalledOnce();
    expect(getEventListeners(signal, 'abort')).toHaveLength(0);
  });
  it('streams bytes and releases the abort subscription after completion', async () => {
    const request = nativeRequest();
    const signal = new AbortController().signal;
    const incoming = Object.assign(new PassThrough(), {
      statusCode: 200,
      headers: { 'content-length': '6' },
    });
    const pending = requestResponse('https://publisher.test/file', {
      signal,
      headers: { Range: 'bytes=3-' },
    });
    request.emit('response', incoming);
    incoming.end(Buffer.from('abcdef'));
    expect(await (await pending).text()).toBe('abcdef');
    expect(request.setHeader).toHaveBeenCalledWith('range', 'bytes=3-');
    expect(getEventListeners(signal, 'abort')).toHaveLength(0);
  });
  it('propagates consumer cancellation to the native request', async () => {
    const request = nativeRequest();
    const signal = new AbortController().signal;
    const incoming = Object.assign(new PassThrough(), { statusCode: 200, headers: {} });
    const pending = requestResponse('https://publisher.test/file', { signal });
    request.emit('response', incoming);
    await (await pending).body!.cancel();
    await vi.waitFor(() => expect(request.abort).toHaveBeenCalledOnce());
    expect(getEventListeners(signal, 'abort')).toHaveLength(0);
  });
  it('bounds buffered bytes while the caller is not reading', async () => {
    const request = nativeRequest();
    const incoming = Object.assign(new PassThrough({ highWaterMark: 64 * 1024 }), {
      statusCode: 200,
      headers: {},
    });
    const pending = requestResponse('https://publisher.test/file', {});
    request.emit('response', incoming);
    const response = await pending;
    // Yield between chunks so the web-stream adapter can pull from the source.
    let accepted = 0;
    for (; accepted < 100; accepted++) {
      const more = incoming.write(Buffer.alloc(16 * 1024));
      await new Promise((resolve) => setImmediate(resolve));
      if (!more) break;
    }
    expect(accepted).toBeLessThan(20);
    await response.body!.cancel();
  });
  it('aborts while waiting for headers without retaining a signal listener', async () => {
    const request = nativeRequest();
    const controller = new AbortController();
    const pending = requestResponse('https://publisher.test/file', { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow('aborted');
    expect(request.abort).toHaveBeenCalledOnce();
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });
});
