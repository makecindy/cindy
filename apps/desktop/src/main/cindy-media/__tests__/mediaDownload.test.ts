import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { SsrFBlockedError } from '@cindy/browser-control-runtime/ssrf-runtime';
import { downloadMediaResult, type MediaDownloadContext } from '../mediaDownload.js';

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), release: vi.fn(async () => {}) }));
vi.mock('../../maker-host/outbound-fetch.js', () => ({ guardedOutboundFetch: mocks.fetch }));

const bytes = Buffer.from('generated-media-fixture');
function response(body: BodyInit | null = bytes, init?: ResponseInit) {
  return { response: new Response(body, init), release: mocks.release };
}
function context(): MediaDownloadContext & { confirm: ReturnType<typeof vi.fn> } {
  return { assertActive: vi.fn(), approvals: new Set(), confirm: vi.fn(async () => true) };
}
const downloads: Awaited<ReturnType<typeof downloadMediaResult>>[] = [];
async function download(ctx?: MediaDownloadContext, raw = 'https://new.example.com/video?signature=secret') {
  const result = await downloadMediaResult({ raw, allowedHosts: ['known.example.com'], context: ctx, assertActive: vi.fn() });
  downloads.push(result);
  return result;
}
async function downloadedBytes(result: Awaited<ReturnType<typeof download>>) {
  return fs.readFile(result.filePath);
}

describe('media download approval and network recovery', () => {
  beforeEach(() => {
    mocks.fetch.mockReset().mockImplementation(async (_url, _init, gate) => {
      await gate();
      return response();
    });
    mocks.release.mockClear();
  });
  afterEach(async () => {
    await Promise.all(downloads.splice(0).map((result) => result.dispose()));
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('automatically downloads known sources without asking', async () => {
    const ctx = context();
    expect(await downloadedBytes(await download(ctx, 'https://known.example.com/video'))).toEqual(bytes);
    expect(ctx.confirm).not.toHaveBeenCalled();
  });

  it('does not dispatch before approval; does not disclose the signed URL', async () => {
    const ctx = context();
    let approve!: (allow: boolean) => void;
    const shown = new Promise<void>((resolve) => {
      ctx.confirm.mockImplementation(() => new Promise<boolean>((finish) => { approve = finish; resolve(); }));
    });
    const pending = download(ctx);
    await shown;
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(ctx.confirm).toHaveBeenCalledWith({ source: 'https://new.example.com', reasons: ['source'] });
    approve(true);
    expect(await downloadedBytes(await pending)).toEqual(bytes);
    expect(mocks.fetch.mock.calls[0][1].headers).toBeUndefined();
  });

  it('a refusal ends the download without retrying or asking again', async () => {
    const ctx = context();
    ctx.confirm.mockResolvedValue(false);
    await expect(download(ctx)).rejects.toMatchObject({ code: 'MEDIA_DOWNLOAD_DENIED' });
    expect(ctx.confirm).toHaveBeenCalledOnce();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('network errors are retried by the client using the same approval', async () => {
    const ctx = context();
    mocks.fetch.mockRejectedValueOnce(new TypeError('connection reset'))
      .mockResolvedValueOnce(response(null, { status: 503 }));
    const result = await download(ctx);
    expect(await downloadedBytes(result)).toEqual(bytes);
    expect(mocks.fetch).toHaveBeenCalledTimes(3);
    expect(ctx.confirm).toHaveBeenCalledOnce();
    expect(mocks.release).toHaveBeenCalledTimes(2);
  });

  it('exhausted network retries return an error, not another permission card', async () => {
    const ctx = context();
    mocks.fetch.mockRejectedValue(new TypeError('offline'));
    await expect(download(ctx)).rejects.toMatchObject({ code: 'MEDIA_DOWNLOAD_FAILED' });
    expect(mocks.fetch).toHaveBeenCalledTimes(3);
    expect(ctx.confirm).toHaveBeenCalledOnce();
  });

  it('permission changes require an explicit exception, which survives network retry', async () => {
    const ctx = context();
    mocks.fetch.mockRejectedValueOnce(new SsrFBlockedError('private address'))
      .mockRejectedValueOnce(new TypeError('connection reset'));
    expect(await downloadedBytes(await download(ctx))).toEqual(bytes);
    expect(ctx.confirm.mock.calls.map(([request]) => request.reasons)).toEqual([['source'], ['network']]);
    expect(mocks.fetch.mock.calls[0][3].allowPrivateNetwork).toBe(false);
    expect(mocks.fetch.mock.calls.slice(1).every((call) => call[3].allowPrivateNetwork === true)).toBe(true);
    expect(mocks.fetch.mock.calls[1][3].targetUrl).toBe(mocks.fetch.mock.calls[1][0]);
  });

  it('redirecting to a different origin requires new approval; same origin does not', async () => {
    const ctx = context();
    mocks.fetch.mockResolvedValueOnce(response(null, { status: 302, headers: { location: '/next' } }))
      .mockResolvedValueOnce(response(null, { status: 302, headers: { location: 'https://other.example.com/video' } }));
    await download(ctx);
    expect(ctx.confirm.mock.calls.map(([request]) => request.source)).toEqual(['https://new.example.com', 'https://other.example.com']);
    expect(mocks.release).toHaveBeenCalledTimes(3);
  });

  it('does not transfer a private-network exception to the next origin', async () => {
    const ctx = context();
    mocks.fetch.mockRejectedValueOnce(new SsrFBlockedError('private'))
      .mockResolvedValueOnce(response(null, { status: 302, headers: { location: 'https://other.example.com/video' } }))
      .mockRejectedValueOnce(new SsrFBlockedError('another private target'));
    await download(ctx);
    expect(ctx.confirm.mock.calls.map(([request]) => [request.source, request.reasons])).toEqual([
      ['https://new.example.com', ['source']], ['https://new.example.com/video?signature=%5BREDACTED%5D', ['network']],
      ['https://other.example.com', ['source']], ['https://other.example.com/video', ['network']],
    ]);
    expect(mocks.fetch.mock.calls[2][3].allowPrivateNetwork).toBe(false);
  });

  it('HTTP and a custom port require approval before dispatch', async () => {
    const ctx = context();
    await download(ctx, 'http://known.example.com:8080/video');
    expect(ctx.confirm).toHaveBeenCalledWith({ source: 'http://known.example.com:8080', reasons: ['http', 'port'] });
    expect(mocks.fetch.mock.calls[0][3]).toMatchObject({ allowHttp: true, targetUrl: 'http://known.example.com:8080/video' });
  });

  it.each(['/internal/admin', '/video?operation=admin'])(
    'requires a fresh private-network decision for the same-origin target %s', async (location) => {
      const ctx = context();
      ctx.confirm.mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
      mocks.fetch.mockRejectedValueOnce(new SsrFBlockedError('private'))
        .mockResolvedValueOnce(response(null, { status: 302, headers: { location } }))
        .mockRejectedValueOnce(new SsrFBlockedError('unapproved private target'));
      await expect(download(ctx)).rejects.toMatchObject({ code: 'MEDIA_DOWNLOAD_DENIED' });
      expect(ctx.confirm.mock.calls.map(([request]) => request.reasons)).toEqual([
        ['source'], ['network'], ['network'],
      ]);
      expect(mocks.fetch.mock.calls.map((call) => call[3].allowPrivateNetwork)).toEqual([false, true, false]);
      expect(mocks.fetch.mock.calls[2][0]).toBe(new URL(location, 'https://new.example.com').href);
      expect(ctx.confirm.mock.calls[1][0].source).toBe('https://new.example.com/video?signature=%5BREDACTED%5D');
      expect(ctx.confirm.mock.calls[2][0].source).toBe(new URL(location, 'https://new.example.com').href);
      expect(mocks.release).toHaveBeenCalledOnce();
    },
  );

  it('does not forward URL credentials on a redirect', async () => {
    const ctx = context();
    mocks.fetch.mockResolvedValueOnce(response(null, { status: 302, headers: { location: '/next' } }));
    await download(ctx, 'https://user:secret@known.example.com/video');
    expect(JSON.stringify(ctx.confirm.mock.calls)).not.toContain('secret');
    expect(mocks.fetch.mock.calls[0][0]).toBe('https://known.example.com/video');
    expect(mocks.fetch.mock.calls[0][1].headers).toEqual({ Authorization: 'Basic dXNlcjpzZWNyZXQ=' });
    expect(mocks.fetch.mock.calls[1][1].headers).toBeUndefined();
  });

  it('shows the private endpoint and ordinary parameters without login or signature values', async () => {
    const ctx = context();
    mocks.fetch.mockRejectedValueOnce(new SsrFBlockedError('private'));
    await download(ctx, 'https://test-user:test-password@known.example.com/media/view?operation=read&signature=test-signature&sig=test-sig&OSSAccessKeyId=test-key-id#hidden-fragment');
    const request = ctx.confirm.mock.calls.at(-1)![0];
    expect(request.reasons).toEqual(['network']);
    const shown = new URL(request.source);
    expect(shown.pathname).toBe('/media/view');
    expect(shown.searchParams.get('operation')).toBe('read');
    for (const key of ['signature', 'sig', 'OSSAccessKeyId']) {
      expect(shown.searchParams.get(key)).toBe('[REDACTED]');
    }
    expect(shown.hash).toBe('');
    expect(JSON.stringify(ctx.confirm.mock.calls)).not.toMatch(/test-user|test-password|test-signature|test-sig|test-key-id|hidden-fragment/);
  });

  it('a refreshed signed URL on the same origin reuses the operation approval', async () => {
    const ctx = context();
    mocks.fetch.mockResolvedValueOnce(response(null, { status: 403 }));
    await expect(download(ctx)).rejects.toMatchObject({ code: 'MEDIA_DOWNLOAD_URL_EXPIRED' });
    await download(ctx, 'https://new.example.com/video?signature=fresh');
    expect(ctx.confirm).toHaveBeenCalledOnce();
  });

  it.each([true, false])('streams to disk without buffering or size approval (length header: %s)', async (declared) => {
    const ctx = context();
    const chunk = new Uint8Array(64 * 1024).fill(7);
    const chunks = 40;
    let emitted = 0;
    mocks.fetch.mockResolvedValueOnce(response(new ReadableStream({
      pull(controller) {
        if (emitted++ < chunks) controller.enqueue(chunk);
        else controller.close();
      },
    }), declared ? { headers: { 'content-length': String(chunks * chunk.length) } } : undefined));
    const concat = vi.spyOn(Buffer, 'concat');
    const readFile = vi.spyOn(fs, 'readFile');
    const result = await download(ctx);
    expect((await fs.stat(result.filePath)).size).toBe(chunks * chunk.length);
    expect(concat).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
    expect(ctx.confirm).toHaveBeenCalledOnce();
    await result.dispose();
    await expect(fs.stat(path.dirname(result.filePath))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('removes partial files on failed reads before retrying the same approved source', async () => {
    const ctx = context();
    const mkdtemp = vi.spyOn(fs, 'mkdtemp');
    mocks.fetch.mockResolvedValueOnce(response(new ReadableStream({
      start(controller) { controller.enqueue(bytes); },
      pull(controller) { controller.error(new Error('connection lost')); },
    })));
    const result = await download(ctx);
    expect(await downloadedBytes(result)).toEqual(bytes);
    const failedDir = await mkdtemp.mock.results[0].value;
    await expect(fs.stat(failedDir)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(ctx.confirm).toHaveBeenCalledOnce();
    expect(mocks.release).toHaveBeenCalledTimes(2);
  });

  it('cleans up a partial file when the task is cancelled', async () => {
    const ctx = context();
    const controller = new AbortController();
    ctx.signal = controller.signal;
    ctx.assertActive = () => controller.signal.throwIfAborted();
    const mkdtemp = vi.spyOn(fs, 'mkdtemp');
    mocks.fetch.mockResolvedValueOnce(response(new ReadableStream({
      pull(stream) { controller.abort(); stream.enqueue(bytes); },
    }, { highWaterMark: 0 })));
    await expect(download(ctx)).rejects.toBeDefined();
    const dir = await mkdtemp.mock.results[0].value;
    await expect(fs.stat(dir)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(mocks.fetch).toHaveBeenCalledOnce();
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  // 2026-10-30 线上回归：X 任务的 Seedance 成片连续四次在正好 120 秒失败，字节当时还在以 40 KB/s 到达。
  // 入口 downloadMediaResult，unit；相邻用例的响应体都瞬时结束，没有覆盖慢速传输。
  // 最小失败输入：每 20 秒一个分块，持续 5 分钟。
  describe('slow transfers', () => {
    let chunks = 0;
    let end: 'close' | 'stall' = 'close';
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      mocks.fetch.mockImplementation(async (_url, init: RequestInit, gate) => {
        await gate();
        let sent = 0;
        return response(new ReadableStream<Uint8Array>({
          start(stream) { init.signal?.addEventListener('abort', () => stream.error(new Error('aborted'))); },
          async pull(stream) {
            await new Promise((resolve) => setTimeout(resolve, 20_000));
            if (sent++ < chunks) stream.enqueue(Buffer.from('x'));
            else if (end === 'close') stream.close();
            else await new Promise(() => {});
          },
        }));
      });
    });
    function drip(count: number, completion: 'close' | 'stall' = 'close') {
      chunks = count;
      end = completion;
    }
    /** 文件操作全换成内存实现，时序只由假时钟决定；真实磁盘 I/O 跟不上时钟推进，负载高时会拉偏耗时。 */
    async function settle(ctx: MediaDownloadContext) {
      const written: Uint8Array[] = [];
      vi.spyOn(fs, 'mkdtemp').mockResolvedValue('/nonexistent/cindy-media-download');
      vi.spyOn(fs, 'rm').mockResolvedValue();
      vi.spyOn(fs, 'open').mockResolvedValue({
        writeFile: async (chunk: Uint8Array) => { written.push(chunk); }, close: async () => {},
      } as never);
      const startedAt = Date.now();
      let settled = false;
      const outcome = download(ctx).then(
        (result) => ({ result, error: undefined }), (error: unknown) => ({ result: undefined, error }),
      ).finally(() => { settled = true; });
      while (!settled && Date.now() - startedAt < 600_000) await vi.advanceTimersByTimeAsync(1_000);
      expect(settled).toBe(true);
      return { ...(await outcome), written, elapsedMs: Date.now() - startedAt };
    }

    it('finishes while bytes keep arriving past the response budget', async () => {
      drip(15);
      const { error, written } = await settle(context());
      expect(error).toBeUndefined();
      expect(written).toHaveLength(15);
      expect(mocks.fetch).toHaveBeenCalledOnce();
    });

    it.each([
      ['a stall after the response budget', 8, 190_000],
      ['the total transfer cap', Infinity, 540_000],
    ])('stops at %s without restarting the transfer', async (_name, chunks, expectedMs) => {
      drip(chunks, 'stall');
      const { error, elapsedMs } = await settle(context());
      expect(error).toMatchObject({ code: 'MEDIA_DOWNLOAD_FAILED' });
      expect(elapsedMs).toBeGreaterThanOrEqual(expectedMs);
      expect(elapsedMs).toBeLessThanOrEqual(expectedMs + 2_000);
      expect(mocks.fetch).toHaveBeenCalledOnce();
    });
  });

  it('cancelled approval cannot dispatch, even if a late response allows it', async () => {
    const ctx = context();
    const controller = new AbortController();
    ctx.signal = controller.signal;
    ctx.assertActive = () => controller.signal.throwIfAborted();
    ctx.confirm.mockImplementation(async () => { controller.abort(); return true; });
    await expect(download(ctx)).rejects.toBeDefined();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});
