import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
const fetchMock = vi.hoisted(() => vi.fn());
vi.mock('../http', () => ({ requestResponse: fetchMock }));
vi.mock('../../logger', () => ({ createLogger: () => ({ warn: vi.fn(), debug: vi.fn() }) }));
import { download, getActive } from '../index';
import { writeMeta } from '../resume';

const roots: string[] = [];
const hash = (body: string) => createHash('sha256').update(body).digest('hex');
function options(body = 'abcdef') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-downloader-'));
  roots.push(root);
  return {
    url: 'https://publisher.test/file',
    targetPath: path.join(root, 'archive'),
    sha256: hash(body),
    expectedSize: body.length,
    retry: { maxAttempts: 1 },
  };
}
function partial(opts: ReturnType<typeof options>, body = 'abc') {
  fs.writeFileSync(`${opts.targetPath}.part`, body);
  writeMeta(opts.targetPath, {
    url: opts.url,
    expectedSize: opts.expectedSize,
    expectedSha256: opts.sha256,
    downloadedBytes: body.length,
    etag: 'v1',
    lastModified: null,
    createdAt: '',
    updatedAt: '',
  });
}
afterEach(() => {
  vi.useRealTimers();
  fetchMock.mockReset();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
describe('shared verified downloads', () => {
  it('resumes and hashes the prior bytes exactly once', async () => {
    const opts = options();
    partial(opts);
    fetchMock.mockResolvedValue(
      new Response('def', {
        status: 206,
        headers: { 'content-range': 'bytes 3-5/6', 'content-length': '3' },
      }),
    );
    await expect(download(opts)).resolves.toMatchObject({ resumedFromBytes: 3, size: 6 });
    expect(fs.readFileSync(opts.targetPath, 'utf8')).toBe('abcdef');
    expect(fetchMock).toHaveBeenCalledWith(
      opts.url,
      expect.objectContaining({
        headers: expect.objectContaining({ Range: 'bytes=3-', 'If-Range': 'v1' }),
      }),
    );
    expect(fs.existsSync(`${opts.targetPath}.meta.json`)).toBe(false);
  });
  it('uses a full response when the server ignores Range', async () => {
    const opts = options();
    partial(opts);
    fetchMock.mockResolvedValue(new Response('abcdef'));
    await expect(download(opts)).resolves.toMatchObject({ resumedFromBytes: 0 });
    expect(fs.readFileSync(opts.targetPath, 'utf8')).toBe('abcdef');
  });
  it('rejects wrong resume offsets before appending', async () => {
    const opts = options();
    partial(opts);
    fetchMock.mockResolvedValue(
      new Response('def', { status: 206, headers: { 'content-range': 'bytes 2-4/6' } }),
    );
    await expect(download(opts)).rejects.toMatchObject({ code: 'NETWORK' });
    expect(fs.existsSync(opts.targetPath)).toBe(false);
    expect(fs.existsSync(`${opts.targetPath}.part`)).toBe(false);
  });
  it('checks every redirect before contacting the destination', async () => {
    const opts = options();
    fetchMock.mockResolvedValue(
      new Response(null, { status: 302, headers: { location: 'https://untrusted.test/file' } }),
    );
    await expect(
      download({ ...opts, isUrlAllowed: (url) => new URL(url).hostname === 'publisher.test' }),
    ).rejects.toMatchObject({ code: 'URL_POLICY' });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
  it('follows allowed redirects and rejects redirect loops', async () => {
    const opts = options();
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: '/asset' } }))
      .mockResolvedValueOnce(new Response('abcdef'));
    await download({ ...opts, isUrlAllowed: (url) => new URL(url).hostname === 'publisher.test' });
    expect(fetchMock.mock.calls[1][0]).toBe('https://publisher.test/asset');
    fetchMock.mockClear();
    fetchMock.mockImplementation(
      async () => new Response(null, { status: 302, headers: { location: '/loop' } }),
    );
    await expect(download(options())).rejects.toMatchObject({ code: 'URL_POLICY' });
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });
  it('does not allow a forbidden URL to use a cached file', async () => {
    const opts = options();
    fs.writeFileSync(opts.targetPath, 'abcdef');
    await expect(download({ ...opts, isUrlAllowed: () => false })).rejects.toMatchObject({
      code: 'URL_POLICY',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('checks cache size as well as hash', async () => {
    const opts = options();
    fs.writeFileSync(opts.targetPath, 'abcdef');
    await expect(download(opts)).resolves.toMatchObject({ fromCache: true });
    fetchMock.mockResolvedValue(new Response('abcdef'));
    await expect(download({ ...opts, expectedSize: 3 })).rejects.toMatchObject({ code: 'SIZE' });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fs.readFileSync(opts.targetPath, 'utf8')).toBe('abcdef');
  });
  it('preserves an existing valid target on corrupt replacement', async () => {
    const opts = options();
    fs.writeFileSync(opts.targetPath, 'old');
    fetchMock.mockResolvedValue(new Response('xxxxxx'));
    await expect(download(opts)).rejects.toMatchObject({ code: 'CHECKSUM' });
    expect(fs.readFileSync(opts.targetPath, 'utf8')).toBe('old');
    expect(fs.existsSync(`${opts.targetPath}.part`)).toBe(false);
  });
  it('does not overwrite a target created during an exclusive download', async () => {
    const opts = options();
    fetchMock.mockImplementation(async () => {
      fs.writeFileSync(opts.targetPath, 'other');
      return new Response('abcdef');
    });
    await expect(
      download({ ...opts, existingTarget: 'error', resume: false }),
    ).rejects.toMatchObject({ code: 'EXISTS' });
    expect(fs.readFileSync(opts.targetPath, 'utf8')).toBe('other');
    expect(fs.existsSync(`${opts.targetPath}.part`)).toBe(false);
  });
  it('stops an oversized chunk before writing it', async () => {
    const opts = options();
    fetchMock.mockResolvedValue(new Response('abcdefg'));
    await expect(download({ ...opts, expectedSize: undefined, maxBytes: 6 })).rejects.toMatchObject(
      { code: 'SIZE' },
    );
    expect(fs.existsSync(`${opts.targetPath}.part`)).toBe(false);
    expect(fs.existsSync(opts.targetPath)).toBe(false);
  });
  it('cancels an active stream, then resumes from the completed writes', async () => {
    const opts = options();
    const controller = new AbortController();
    let pulls = 0;
    fetchMock.mockImplementation((_url, { signal }) =>
      Promise.resolve(
        new Response(
          new ReadableStream(
            {
              start(stream) {
                signal.addEventListener('abort', () => stream.error(new Error('aborted')), {
                  once: true,
                });
              },
              pull(stream) {
                if (++pulls === 1) stream.enqueue(Buffer.from('abc'));
              },
            },
            { highWaterMark: 0 },
          ),
        ),
      ),
    );
    const pending = download({ ...opts, signal: controller.signal });
    const rejection = expect(pending).rejects.toMatchObject({ code: 'ABORTED' });
    await vi.waitFor(() => expect(pulls).toBe(2));
    controller.abort();
    await rejection;
    expect(fs.readFileSync(`${opts.targetPath}.part`, 'utf8')).toBe('abc');
    fetchMock.mockResolvedValue(
      new Response('def', { status: 206, headers: { 'content-range': 'bytes 3-5/6' } }),
    );
    await expect(download(opts)).resolves.toMatchObject({ resumedFromBytes: 3 });
  });
  it('never publishes after cancellation during streaming progress', async () => {
    const body = 'a'.repeat(300 * 1024);
    const opts = options(body);
    const controller = new AbortController();
    fetchMock.mockResolvedValue(new Response(body));
    await expect(
      download({
        ...opts,
        signal: controller.signal,
        onProgress: (p) => {
          if (p.loaded === body.length) controller.abort();
        },
      }),
    ).rejects.toMatchObject({ code: 'ABORTED' });
    expect(fs.existsSync(opts.targetPath)).toBe(false);
  });
  it('applies a total deadline while queued without cancelling the active download', async () => {
    vi.useFakeTimers();
    let release!: (response: Response) => void;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    const first = download(options());
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const second = expect(
      download({ ...options(), timeout: { totalMs: 100 } }),
    ).rejects.toMatchObject({ code: 'TIMEOUT' });
    await vi.advanceTimersByTimeAsync(100);
    await second;
    expect(fetchMock).toHaveBeenCalledOnce();
    release(new Response('abcdef'));
    await first;
    expect(getActive()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('does not share a target with different URL policy or cancellation ownership', async () => {
    let release!: (response: Response) => void;
    const opts = options();
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    const first = download(opts);
    const same = download(opts);
    expect(same).toBe(first);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    await expect(download({ ...opts, redirect: 'error' })).rejects.toMatchObject({
      code: 'INVALID_ARG',
    });
    await expect(download({ ...opts, signal: new AbortController().signal })).rejects.toMatchObject(
      { code: 'INVALID_ARG' },
    );
    release(new Response('abcdef'));
    await first;
  });
  it('retries a server failure using the common retry policy', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response('abcdef'));
    await download({ ...options(), retry: { maxAttempts: 2, baseDelayMs: 1, jitterRatio: 0 } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
