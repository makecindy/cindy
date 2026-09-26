import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('electron', () => ({ net: { fetch: mocks.fetch } }));
import { executeStreaming } from '../streaming';
import { writeMeta } from '../resume';
import { withRetry } from '../retry';

afterEach(() => vi.restoreAllMocks());

it('cancellation while waiting for data cannot publish a completed artifact', async () =>
  fixture(async (_, opts) => {
    const abort = new AbortController();
    mocks.fetch.mockReset().mockImplementation(
      async (_url, init) =>
        new Response(
          new ReadableStream({
            start(c) {
              init.signal.addEventListener('abort', () => c.error(new Error('aborted')), {
                once: true,
              });
            },
          }),
        ),
    );
    const work = execute({ ...opts, signal: abort.signal });
    const rejected = expect(work).rejects.toMatchObject({ code: 'ABORTED' });
    await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(1));
    abort.abort();
    await rejected;
    await expect(fs.stat(opts.targetPath)).rejects.toMatchObject({ code: 'ENOENT' });
  }));
async function fixture(run: (root: string, opts: any) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'download-stream-test-'));
  const body = Buffer.from('abcdef');
  try {
    await run(root, {
      url: 'https://example.invalid/file',
      targetPath: path.join(root, 'artifact'),
      expectedSize: 6,
      maxBytes: 6,
      sha256: createHash('sha256').update(body).digest('hex'),
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}
const execute = (opts: any) => executeStreaming({ opts, logger: {}, resumedFromBytes: 0 });

it('validates each redirect and never sends credentials', async () =>
  fixture(async (_, opts) => {
    mocks.fetch
      .mockReset()
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: 'https://cdn.invalid/file' } }),
      )
      .mockResolvedValueOnce(new Response('abcdef'));
    const urls: string[] = [];
    await expect(
      execute({ ...opts, validateUrl: (u: string) => urls.push(u) }),
    ).resolves.toMatchObject({ size: 6 });
    expect(urls).toEqual([opts.url, 'https://cdn.invalid/file']);
    for (const [, request] of mocks.fetch.mock.calls)
      expect(request).toMatchObject({ credentials: 'omit', redirect: 'manual' });
  }));

it('rejects a forbidden redirect before fetching it without retrying the original URL', async () =>
  fixture(async (_, opts) => {
    mocks.fetch
      .mockReset()
      .mockResolvedValue(
        new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } }),
      );
    const onRetry = vi.fn();
    await expect(
      withRetry(
        () =>
          execute({
            ...opts,
            validateUrl: (u: string) => {
              if (u !== opts.url) throw Error('denied');
            },
          }),
        { logger: {}, onRetry, config: { baseDelayMs: 0, maxDelayMs: 0 } },
      ),
    ).rejects.toMatchObject({ code: 'INVALID_ARG' });
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  }));

it('does not retry malformed redirect targets or a rejected initial URL', async () =>
  fixture(async (_, opts) => {
    const onRetry = vi.fn();
    mocks.fetch
      .mockReset()
      .mockResolvedValue(
        new Response(null, { status: 302, headers: { location: 'https://[invalid' } }),
      );
    await expect(
      withRetry(() => execute(opts), {
        logger: {},
        onRetry,
        config: { baseDelayMs: 0, maxDelayMs: 0 },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ARG' });
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
    mocks.fetch.mockClear();
    await expect(
      withRetry(
        () =>
          execute({
            ...opts,
            validateUrl: () => {
              throw Error('denied');
            },
          }),
        { logger: {}, onRetry },
      ),
    ).rejects.toMatchObject({ code: 'INVALID_ARG' });
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(onRetry).not.toHaveBeenCalled();
  }));

it('still retries a transient network failure', async () =>
  fixture(async (_, opts) => {
    const onRetry = vi.fn();
    mocks.fetch
      .mockReset()
      .mockRejectedValueOnce(new Error('connection reset'))
      .mockResolvedValueOnce(new Response('abcdef'));
    await expect(
      withRetry(() => execute(opts), {
        logger: {},
        onRetry,
        config: { baseDelayMs: 0, maxDelayMs: 0 },
      }),
    ).resolves.toMatchObject({ size: 6 });
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledTimes(1);
  }));

it('cleans both sidecars on oversized and short bodies', async () =>
  fixture(async (_, opts) => {
    for (const body of ['abc', 'abcdefg']) {
      mocks.fetch.mockReset().mockResolvedValue(new Response(body));
      await expect(execute(opts)).rejects.toMatchObject({ code: 'CHECKSUM' });
      await expect(fs.stat(opts.targetPath + '.part')).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fs.stat(opts.targetPath + '.meta.json')).rejects.toMatchObject({
        code: 'ENOENT',
      });
    }
  }));

it('resumes a verified prefix and hashes it exactly once', async () =>
  fixture(async (_, opts) => {
    await fs.writeFile(opts.targetPath + '.part', 'abc');
    writeMeta(opts.targetPath, {
      url: opts.url,
      expectedSize: 6,
      expectedSha256: opts.sha256,
      downloadedBytes: 3,
      etag: 'v1',
      lastModified: null,
      createdAt: '',
      updatedAt: '',
    });
    mocks.fetch.mockReset().mockResolvedValue(
      new Response('def', {
        status: 206,
        headers: { 'content-range': 'bytes 3-5/6', 'content-length': '3' },
      }),
    );
    await expect(execute(opts)).resolves.toMatchObject({ size: 6 });
    expect(mocks.fetch.mock.calls[0][1].headers).toMatchObject({
      Range: 'bytes=3-',
      'If-Range': 'v1',
    });
    expect(await fs.readFile(opts.targetPath, 'utf8')).toBe('abcdef');
  }));

it('does not pull another chunk while disk write is pending', async () =>
  fixture(async (_, opts) => {
    let pulls = 0,
      release!: () => void,
      started!: () => void;
    const waiting = new Promise<void>((r) => (started = r)),
      gate = new Promise<void>((r) => (release = r));
    const open = fs.open.bind(fs);
    vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await open(...args),
        write = handle.writeFile.bind(handle);
      let first = true;
      vi.spyOn(handle, 'writeFile').mockImplementation(
        async (...data: Parameters<typeof handle.writeFile>) => {
          if (first) {
            first = false;
            started();
            await gate;
          }
          return write(...data);
        },
      );
      return handle;
    });
    mocks.fetch.mockReset().mockResolvedValue(
      new Response(
        new ReadableStream(
          {
            pull(c) {
              pulls++;
              if (pulls === 1) c.enqueue(Buffer.from('abc'));
              else if (pulls === 2) c.enqueue(Buffer.from('def'));
              else c.close();
            },
          },
          { highWaterMark: 0 },
        ),
      ),
    );
    const work = execute(opts);
    await waiting;
    try {
      expect(pulls).toBe(1);
    } finally {
      release();
    }
    await expect(work).resolves.toMatchObject({ size: 6 });
  }));
