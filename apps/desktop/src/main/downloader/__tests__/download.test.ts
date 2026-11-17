import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Readable, addAbortSignal } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
const fetchMock = vi.hoisted(() => vi.fn());
vi.mock('../http', () => ({ requestResponse: fetchMock }));
vi.mock('../../logger', () => ({ createLogger: () => ({ warn: vi.fn(), debug: vi.fn() }) }));
import { download, getActive } from '../index';
import { writeMeta } from '../resume';
import * as resume from '../resume';
import * as integrity from '../integrity';

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
  vi.restoreAllMocks();
  vi.useRealTimers();
  fetchMock.mockReset();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
describe('shared verified downloads', () => {
  it.each(['complete', 'cancel'] as const)(
    'never checkpoints a one-shot authorized URL: %s',
    async (outcome) => {
      const opts = {
        ...options(),
        url: 'https://publisher.test/file?signature=synthetic-secret',
        resume: false,
      };
      const checkpoint = vi.spyOn(resume, 'writeMeta');
      const controller = new AbortController();
      let pulls = 0;
      let body!: ReadableStreamDefaultController<Uint8Array>;
      fetchMock.mockImplementation((_url, { signal }) =>
        Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>(
              {
                start(stream) {
                  body = stream;
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
      const result =
        outcome === 'cancel'
          ? expect(pending).rejects.toMatchObject({ code: 'ABORTED' })
          : expect(pending).resolves.toMatchObject({ size: 6 });
      await vi.waitFor(() => expect(pulls).toBe(2));
      expect(checkpoint).not.toHaveBeenCalled();
      expect(fs.existsSync(`${opts.targetPath}.meta.json`)).toBe(false);
      if (outcome === 'cancel') controller.abort();
      else {
        body.enqueue(Buffer.from('def'));
        body.close();
      }
      await result;
      expect(checkpoint).not.toHaveBeenCalled();
      expect(fs.existsSync(`${opts.targetPath}.meta.json`)).toBe(false);
      expect(fs.existsSync(`${opts.targetPath}.part`)).toBe(false);
    },
  );
  it.each([
    ['resume', false],
    ['cache', false],
    ['resume', true],
    ['cache', true],
  ] as const)(
    'interrupts stalled %s hashing (timeout=%s) and releases the slot',
    async (mode, timeout) => {
      const opts = options();
      if (mode === 'resume') partial(opts);
      else fs.writeFileSync(opts.targetPath, 'abcdef');
      const controller = new AbortController();
      let started!: () => void;
      const reading = new Promise<void>((resolve) => {
        started = resolve;
      });
      const stalled = new Readable({ read() {} });
      vi.spyOn(fs, 'createReadStream').mockImplementationOnce((_file, config) => {
        const signal = (config as { signal?: AbortSignal })?.signal;
        if (signal) addAbortSignal(signal, stalled);
        started();
        return stalled as fs.ReadStream;
      });
      fetchMock.mockResolvedValueOnce(
        new Response('def', {
          status: 206,
          headers: { 'content-range': 'bytes 3-5/6', 'content-length': '3' },
        }),
      );
      if (mode === 'cache') fetchMock.mockReset();
      const active = download({
        ...opts,
        signal: controller.signal,
        timeout: timeout ? { totalMs: 50 } : undefined,
      });
      const rejected = expect(active).rejects.toMatchObject({
        code: timeout ? 'TIMEOUT' : 'ABORTED',
      });
      await reading;
      const next = options('next');
      fetchMock.mockResolvedValueOnce(new Response('next'));
      const queued = download(next);
      if (!timeout) controller.abort();
      await rejected;
      expect(stalled.destroyed).toBe(true);
      await expect(queued).resolves.toMatchObject({ size: 4 });
    },
  );
  it('stops the connection deadline before slow resume hashing begins', async () => {
    vi.useFakeTimers();
    const opts = options();
    partial(opts);
    const create = integrity.createStreamingHasher;
    vi.spyOn(integrity, 'createStreamingHasher').mockImplementation((file) => {
      const hasher = create(file);
      return {
        ...hasher,
        update: async (data) => {
          if (data.length === 0) await vi.advanceTimersByTimeAsync(20_000);
          return hasher.update(data);
        },
      };
    });
    fetchMock.mockResolvedValue(
      new Response('def', {
        status: 206,
        headers: { 'content-range': 'bytes 3-5/6', 'content-length': '3' },
      }),
    );
    await expect(download(opts)).resolves.toMatchObject({ resumedFromBytes: 3, size: 6 });
    expect(fs.readFileSync(opts.targetPath, 'utf8')).toBe('abcdef');
  });
  it('finishes a verified download when checkpoint writes fail', async () => {
    const opts = options();
    const checkpoint = vi.spyOn(resume, 'writeMeta').mockImplementation(() => {
      throw new Error('sidecar locked');
    });
    fetchMock.mockResolvedValue(new Response('abcdef'));
    await expect(download(opts)).resolves.toMatchObject({ size: 6, sha256: opts.sha256 });
    expect(checkpoint).toHaveBeenCalled();
    expect(fs.readFileSync(opts.targetPath, 'utf8')).toBe('abcdef');
  });
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
  it('allows a queued download its full active budget without cancelling the current download', async () => {
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
    fetchMock.mockResolvedValueOnce(new Response('abcdef'));
    const second = download({ ...options(), timeout: { totalMs: 100 } });
    await vi.advanceTimersByTimeAsync(100);
    expect(fetchMock).toHaveBeenCalledOnce();
    release(new Response('abcdef'));
    await first;
    await expect(second).resolves.toMatchObject({ size: 6 });
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

// Regression (2026-11-17): a GitHub CLI install sat at 93% for minutes. The release CDN
// kept trickling bytes, so the 30s idle deadline never fired and nothing retried.
describe('slow and flaky connections', () => {
  let clock = 0;
  const fastRetry = { baseDelayMs: 1, jitterRatio: 0 };
  /** Serves body[from..] in `parts`, moving the clock `stepMs` before each part; 'reset' drops the connection. */
  function serve(
    body: Buffer,
    from: number,
    parts: Array<number | 'reset'>,
    stepMs = 0,
    headers: Record<string, string> = { 'accept-ranges': 'bytes' },
  ) {
    let at = from;
    let index = 0;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          const part = parts[index++];
          if (part === undefined) return controller.close();
          if (part === 'reset') return controller.error(new Error('connection reset'));
          clock += stepMs;
          controller.enqueue(new Uint8Array(body.subarray(at, at + part)));
          at += part;
        },
      },
      { highWaterMark: 0 },
    );
    return new Response(
      stream,
      from === 0
        ? { status: 200, headers: { ...headers, 'content-length': String(body.length) } }
        : {
            status: 206,
            headers: {
              ...headers,
              'content-range': `bytes ${from}-${body.length - 1}/${body.length}`,
              'content-length': String(body.length - from),
            },
          },
    );
  }
  function target(body: Buffer) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-downloader-'));
    roots.push(root);
    return {
      url: 'https://publisher.test/file',
      targetPath: path.join(root, 'archive'),
      sha256: createHash('sha256').update(body).digest('hex'),
      expectedSize: body.length,
    };
  }

  it('reconnects a trickling transfer and resumes from the bytes already written', async () => {
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const body = Buffer.alloc(10_000, 7);
    const onRetry = vi.fn();
    // 1000 bytes over 31s is far below 4 KiB/s; the reconnect then gets a healthy route.
    fetchMock
      .mockResolvedValueOnce(serve(body, 0, [1000, 1000], 31_000))
      .mockResolvedValueOnce(serve(body, 1000, [9000]));
    const opts = { ...target(body), retry: { maxAttempts: 2, ...fastRetry }, onRetry };
    await expect(download(opts)).resolves.toMatchObject({ resumedFromBytes: 1000 });
    expect(onRetry).toHaveBeenCalledWith(
      expect.objectContaining({ cause: expect.objectContaining({ timeoutReason: 'slow' }) }),
    );
    expect(fetchMock.mock.calls[1][1].headers).toMatchObject({ Range: 'bytes=1000-' });
    expect(fs.readFileSync(opts.targetPath)).toEqual(body);
  });

  const quarters = [1000, 1000, 1000, 1000];
  it.each([
    ['resume is disabled', { resume: false, retry: { maxAttempts: 2 } }, undefined, quarters],
    ['retries are disabled', { retry: { maxAttempts: 1 } }, undefined, quarters],
    ['the server cannot resume', { retry: { maxAttempts: 2 } }, {}, quarters],
    // A reconnect at offset == size cannot resume and would restart the whole file.
    ['the slow chunk completes the file', { retry: { maxAttempts: 2 } }, undefined, [4000]],
  ])('keeps a slow transfer going when %s', async (_case, policy, headers, parts) => {
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const body = Buffer.alloc(4000, 3);
    fetchMock.mockResolvedValueOnce(serve(body, 0, parts, 31_000, headers));
    const opts = { ...target(body), ...policy };
    await expect(download(opts)).resolves.toMatchObject({ size: body.length });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not spend the retry budget on drops that each kept new data', async () => {
    const part = 70 * 1024;
    const body = Buffer.alloc(part * 4, 9);
    // Three drops with maxAttempts 2 used to fail; each one here kept a 70 KiB resume point.
    fetchMock
      .mockResolvedValueOnce(serve(body, 0, [part, 'reset']))
      .mockResolvedValueOnce(serve(body, part, [part, 'reset']))
      .mockResolvedValueOnce(serve(body, part * 2, [part, 'reset']))
      .mockResolvedValueOnce(serve(body, part * 3, [part]));
    const opts = { ...target(body), retry: { maxAttempts: 2, ...fastRetry } };
    await expect(download(opts)).resolves.toMatchObject({ resumedFromBytes: part * 3 });
    expect(fs.readFileSync(opts.targetPath)).toEqual(body);
    // Drops without new data still use the budget.
    fetchMock
      .mockResolvedValueOnce(serve(body, 0, ['reset']))
      .mockResolvedValueOnce(serve(body, 0, ['reset']));
    await expect(
      download({ ...target(body), retry: { maxAttempts: 2, ...fastRetry } }),
    ).rejects.toMatchObject({
      code: 'NETWORK',
    });
  });

  // Review finding: on a link that is simply slow every 30s cut used to count as a failure,
  // so a download that finished before the reconnect feature now failed after ~3 minutes.
  it('finishes a link that stays slow: probes three new routes, then keeps the trickle', async () => {
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const body = Buffer.alloc(5000, 5);
    const onRetry = vi.fn();
    fetchMock
      .mockResolvedValueOnce(serve(body, 0, [1000, 1000], 31_000))
      .mockResolvedValueOnce(serve(body, 1000, [1000, 1000], 31_000))
      .mockResolvedValueOnce(serve(body, 2000, [1000, 1000], 31_000))
      .mockResolvedValueOnce(serve(body, 3000, [1000, 1000], 31_000));
    const opts = { ...target(body), retry: { maxAttempts: 2, ...fastRetry }, onRetry };
    await expect(download(opts)).resolves.toMatchObject({ resumedFromBytes: 3000 });
    expect(onRetry).toHaveBeenCalledTimes(3);
    expect(fs.readFileSync(opts.targetPath)).toEqual(body);
  });

  it('publishes a part that already holds every byte without downloading it again', async () => {
    const body = Buffer.alloc(3000, 1);
    const opts = target(body);
    // A pause or quit between the last byte and publication leaves a complete part behind.
    fs.writeFileSync(`${opts.targetPath}.part`, body);
    writeMeta(opts.targetPath, {
      url: opts.url,
      expectedSize: body.length,
      expectedSha256: opts.sha256,
      downloadedBytes: body.length,
      etag: null,
      lastModified: null,
      createdAt: '',
      updatedAt: '',
    });
    await expect(download(opts)).resolves.toMatchObject({ resumedFromBytes: body.length });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(fs.readFileSync(opts.targetPath)).toEqual(body);
  });

  it('reports the final bytes before verifying, never progress after it', async () => {
    const body = Buffer.alloc(3000, 2);
    const events: string[] = [];
    fetchMock.mockResolvedValueOnce(serve(body, 0, [1000, 2000]));
    await download({
      ...target(body),
      onProgress: (e) => events.push(`progress:${e.loaded}`),
      onVerifying: () => events.push('verifying'),
    });
    expect(events.slice(-2)).toEqual(['progress:3000', 'verifying']);
  });
});
