import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { PassThrough, addAbortSignal } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';

// Callers that inject `request` (plugin downloads use the SSRF-guarded fetch) must never
// fall back to Electron net.
const electron = vi.hoisted(() => ({ requestResponse: vi.fn() }));
vi.mock('../http', () => electron);

import { executeOnce } from '../transport';
import { withRetry } from '../retry';
import { DownloadError, type DownloadOptions } from '../types';
import { readMeta, writeMeta } from '../resume';

const BODY = 'abcdef';
const roots: string[] = [];
const release = vi.fn(async () => {});
const send = vi.fn();

afterEach(async () => {
  vi.restoreAllMocks();
  send.mockReset();
  release.mockClear();
  expect(electron.requestResponse).not.toHaveBeenCalled();
  for (const root of roots.splice(0)) await fsp.rm(root, { recursive: true, force: true });
});

function options(extra: Partial<DownloadOptions> = {}): DownloadOptions {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'download-request-test-'));
  roots.push(root);
  return {
    url: 'https://example.invalid/file',
    targetPath: path.join(root, 'artifact'),
    expectedSize: BODY.length,
    maxBytes: BODY.length,
    sha256: createHash('sha256').update(BODY).digest('hex'),
    request: async (url, init) => ({ response: await send(url, init), release }),
    ...extra,
  };
}
const execute = (opts: DownloadOptions) => executeOnce({ opts, logger: {}, resumedFromBytes: 0 });
const retrying = (opts: DownloadOptions, onRetry = vi.fn()) =>
  withRetry(() => execute(opts), {
    logger: {},
    onRetry,
    config: { baseDelayMs: 0, maxDelayMs: 0 },
  });
const resumed = (body: string) =>
  new Response(body, {
    status: 206,
    headers: {
      'content-range': `bytes ${BODY.length - body.length}-${BODY.length - 1}/${BODY.length}`,
      'content-length': String(body.length),
    },
  });
function partial(opts: DownloadOptions, body = 'abc', etag: string | null = 'v1') {
  fs.writeFileSync(`${opts.targetPath}.part`, body);
  writeMeta(opts.targetPath, {
    url: opts.url,
    expectedSize: opts.expectedSize ?? null,
    expectedSha256: opts.sha256,
    downloadedBytes: body.length,
    etag,
    lastModified: null,
    createdAt: '',
    updatedAt: '',
  });
}

it('routes every hop through the injected request, validating and releasing each one', async () => {
  const urls: string[] = [];
  const opts = options({ isUrlAllowed: (u) => urls.push(u) > 0 });
  send
    .mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { location: 'https://cdn.invalid/file' } }),
    )
    .mockResolvedValueOnce(new Response(BODY));
  await expect(execute(opts)).resolves.toMatchObject({ size: BODY.length });
  expect(send.mock.calls.map(([url]) => url)).toEqual([opts.url, 'https://cdn.invalid/file']);
  for (const [, init] of send.mock.calls) expect(init).toMatchObject({ redirect: 'manual' });
  // The entry URL is checked before the attempt and again at the first hop.
  expect(urls).toEqual([opts.url, opts.url, 'https://cdn.invalid/file']);
  expect(release).toHaveBeenCalledTimes(2);
  expect(fs.readFileSync(opts.targetPath, 'utf8')).toBe(BODY);
});

it('treats a refusal from the injected request as final instead of retrying it', async () => {
  const onRetry = vi.fn();
  const opts = options({
    request: async () => {
      throw new DownloadError('URL_POLICY', 'caller revoked');
    },
  });
  await expect(retrying(opts, onRetry)).rejects.toMatchObject({ code: 'URL_POLICY' });
  expect(onRetry).not.toHaveBeenCalled();
  expect(fs.existsSync(`${opts.targetPath}.part`)).toBe(false);
});

it('rejects a forbidden redirect before requesting it, without retrying the original URL', async () => {
  const onRetry = vi.fn();
  const opts = options({ isUrlAllowed: (u) => u.startsWith('https://example.invalid/') });
  send.mockResolvedValue(
    new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } }),
  );
  await expect(retrying(opts, onRetry)).rejects.toMatchObject({ code: 'URL_POLICY' });
  expect(send).toHaveBeenCalledTimes(1);
  expect(onRetry).not.toHaveBeenCalled();
});

it('still retries a transient failure of the injected request', async () => {
  const onRetry = vi.fn();
  send.mockRejectedValueOnce(new Error('connection reset')).mockResolvedValueOnce(new Response(BODY));
  await expect(retrying(options(), onRetry)).resolves.toMatchObject({ size: BODY.length });
  expect(send).toHaveBeenCalledTimes(2);
  expect(onRetry).toHaveBeenCalledTimes(1);
});

it('cancellation while waiting for data releases the request and publishes nothing', async () => {
  const abort = new AbortController();
  const opts = options({ signal: abort.signal });
  send.mockImplementation(
    async (_url, init: RequestInit) =>
      new Response(
        new ReadableStream({
          start(c) {
            init.signal!.addEventListener('abort', () => c.error(new Error('aborted')), {
              once: true,
            });
          },
        }),
      ),
  );
  const work = execute(opts);
  const rejected = expect(work).rejects.toMatchObject({ code: 'ABORTED' });
  await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  abort.abort();
  await rejected;
  expect(release).toHaveBeenCalledOnce();
  expect(fs.existsSync(opts.targetPath)).toBe(false);
});

it('cancelling a resumed prefix hash releases the response before settling', async () => {
  const abort = new AbortController();
  const opts = options({ signal: abort.signal });
  partial(opts);
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => (entered = resolve));
  const stream = new PassThrough();
  vi.spyOn(fs, 'createReadStream').mockImplementation(((
    _path: unknown,
    config: { signal: AbortSignal },
  ) => {
    addAbortSignal(config.signal, stream);
    entered();
    return stream;
  }) as never);
  send.mockResolvedValue(resumed('def'));
  const rejected = expect(execute(opts)).rejects.toMatchObject({ code: 'ABORTED' });
  await ready;
  abort.abort();
  await rejected;
  expect(stream.destroyed).toBe(true);
  expect(release).toHaveBeenCalledOnce();
  expect(fs.existsSync(opts.targetPath)).toBe(false);
});

it.each([
  ['network', 'NETWORK'],
  ['cancel', 'ABORTED'],
  ['timeout', 'TIMEOUT'],
] as const)('keeps the written prefix after a mid-body %s and resumes from it', async (failure, code) => {
  const abort = new AbortController();
  const opts = options({ signal: abort.signal, timeout: { idleMs: 20 } });
  let pulls = 0;
  send.mockImplementationOnce(
    async (_url, init: RequestInit) =>
      new Response(
        new ReadableStream(
          {
            pull(c) {
              if (++pulls === 1) return c.enqueue(Buffer.from('abc'));
              if (failure === 'network') return c.error(new Error('connection reset'));
              init.signal!.addEventListener('abort', () => c.error(new Error('aborted')), {
                once: true,
              });
              if (failure === 'cancel') abort.abort();
            },
          },
          { highWaterMark: 0 },
        ),
        { headers: { etag: 'v1' } },
      ),
  );
  await expect(execute(opts)).rejects.toMatchObject({ code });
  expect(fs.readFileSync(`${opts.targetPath}.part`, 'utf8')).toBe('abc');
  expect(readMeta(opts.targetPath)?.downloadedBytes).toBe(3);
  send.mockResolvedValueOnce(resumed('def'));
  await expect(execute({ ...opts, signal: undefined })).resolves.toMatchObject({ size: 6 });
  expect(send.mock.calls[1][1].headers).toMatchObject({ Range: 'bytes=3-', 'If-Range': 'v1' });
  expect(fs.readFileSync(opts.targetPath, 'utf8')).toBe(BODY);
  expect(readMeta(opts.targetPath)).toBeNull();
});

it('discards both sidecars for short or oversized bodies, then downloads fresh', async () => {
  const opts = options();
  for (const body of ['abc', 'abcdefg']) {
    send.mockResolvedValueOnce(new Response(body));
    await expect(execute(opts)).rejects.toMatchObject({ code: 'SIZE' });
    for (const file of [opts.targetPath, `${opts.targetPath}.part`, `${opts.targetPath}.meta.json`])
      expect(fs.existsSync(file)).toBe(false);
  }
  send.mockResolvedValueOnce(new Response(BODY));
  await expect(execute(opts)).resolves.toMatchObject({ size: BODY.length });
  expect(send.mock.calls[2][1].headers).not.toHaveProperty('Range');
});

it('reports verification once, only after every byte arrived', async () => {
  const onVerifying = vi.fn();
  send.mockResolvedValueOnce(new Response('abc'));
  await expect(execute(options({ onVerifying }))).rejects.toMatchObject({ code: 'SIZE' });
  expect(onVerifying).not.toHaveBeenCalled();
  const opts = options();
  const written: number[] = [];
  onVerifying.mockImplementation(() => written.push(fs.statSync(`${opts.targetPath}.part`).size));
  send.mockResolvedValueOnce(new Response(BODY));
  await expect(execute({ ...opts, onVerifying })).resolves.toMatchObject({ size: 6 });
  expect(written).toEqual([BODY.length]);
});

it('does not pull another chunk while a disk write is pending', async () => {
  let pulls = 0;
  let unblock!: () => void;
  let started!: () => void;
  const writing = new Promise<void>((r) => (started = r));
  const gate = new Promise<void>((r) => (unblock = r));
  const open = fs.promises.open.bind(fs.promises);
  vi.spyOn(fs.promises, 'open').mockImplementation(async (...args: Parameters<typeof open>) => {
    const handle = await open(...args);
    const write = handle.writeFile.bind(handle);
    let first = true;
    vi.spyOn(handle, 'writeFile').mockImplementation(async (...data: Parameters<typeof write>) => {
      if (first) {
        first = false;
        started();
        await gate;
      }
      return write(...data);
    });
    return handle;
  });
  send.mockResolvedValue(
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
  const work = execute(options());
  await writing;
  try {
    expect(pulls).toBe(1);
  } finally {
    unblock();
  }
  await expect(work).resolves.toMatchObject({ size: BODY.length });
});

it('does not persist oversized resume validators from the server', async () => {
  const opts = options();
  let pulls = 0;
  send.mockResolvedValueOnce(
    new Response(
      new ReadableStream(
        {
          pull(c) {
            if (++pulls === 1) c.enqueue(Buffer.from('abc'));
            else c.error(new Error('connection reset'));
          },
        },
        { highWaterMark: 0 },
      ),
      { headers: { etag: `"${'x'.repeat(2000)}"`, 'last-modified': 'y'.repeat(300) } },
    ),
  );
  await expect(execute(opts)).rejects.toMatchObject({ code: 'NETWORK' });
  expect(readMeta(opts.targetPath)).toMatchObject({ downloadedBytes: 3, etag: null, lastModified: null });
});
