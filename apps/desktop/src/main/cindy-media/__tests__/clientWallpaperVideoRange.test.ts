import fs from 'node:fs';
import fsp, { type FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ dir: '', handle: vi.fn(), touch: vi.fn() }));
vi.mock('electron', () => ({ app: { getPath: () => h.dir }, protocol: { handle: h.handle } }));
vi.mock('../ledger', () => ({ touchBlob: h.touch }));
import { registerCindyMediaProtocolHandler } from '../cindyMediaProtocol';
import { openClientWallpaperVideo } from '../blobStore';

const hash = 'a'.repeat(64);
const url = `cindy-media://client-wallpaper/${hash}.mp4`;
let filePath: string;
let handler: (request: Request) => Promise<Response>;
let files: FileHandle[];
let streams: fs.ReadStream[];

beforeEach(() => {
  h.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wallpaper-range-'));
  filePath = path.join(h.dir, 'cindy-media', 'client-wallpaper', 'aa', `${hash}.mp4`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, '0123456789');
  vi.clearAllMocks();
  files = [];
  streams = [];
  const open = fsp.open.bind(fsp);
  vi.spyOn(fsp, 'open').mockImplementation(async (...args) => {
    const file = await open(...args);
    files.push(file);
    const create = file.createReadStream.bind(file);
    vi.spyOn(file, 'createReadStream').mockImplementation((options) => {
      const stream = create(options);
      streams.push(stream);
      return stream;
    });
    return file;
  });
  registerCindyMediaProtocolHandler();
  handler = h.handle.mock.calls[0][1];
});

afterEach(async () => {
  for (const stream of streams) stream.destroy();
  for (const file of files) await file.close();
  vi.restoreAllMocks();
  fs.rmSync(h.dir, { recursive: true, force: true });
});

describe('client wallpaper video protocol streaming', () => {
  it.each([
    [null, 200, '0123456789', null],
    ['bytes=2-5', 206, '2345', 'bytes 2-5/10'],
    ['bytes=8-', 206, '89', 'bytes 8-9/10'],
    ['bytes=-3', 206, '789', 'bytes 7-9/10'],
    ['bytes=99-', 416, '', 'bytes */10'],
    ['bytes=abc', 200, '0123456789', null],
    ['bytes=0-1,4-5', 200, '0123456789', null],
  ])('preserves response semantics for %s', async (range, status, body, contentRange) => {
    const response = await handler(new Request(url, { headers: range ? { Range: range } : {} }));
    expect(response.status).toBe(status);
    expect(response.headers.get('Content-Type')).toBe('video/mp4');
    expect(response.headers.get('Accept-Ranges')).toBe('bytes');
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
    expect(response.headers.get('Content-Range')).toBe(contentRange);
    if (status !== 416) expect(response.headers.get('Content-Length')).toBe(String(body.length));
    expect(await response.text()).toBe(body);
    await vi.waitFor(() => expect(files.every((file) => file.fd === -1)).toBe(true));
    expect(h.touch).not.toHaveBeenCalled();
    if (status === 416) expect(streams).toHaveLength(0);
  });

  it('reads only requested bytes for concurrent ranges of a 100 MiB video', async () => {
    fs.truncateSync(filePath, 100 * 1024 * 1024);
    const readFile = vi.spyOn(fsp, 'readFile');
    const starts = [0, 50 * 1024 * 1024, 100 * 1024 * 1024 - 1024];
    await Promise.all(
      starts.map(async (start) => {
        const response = await handler(
          new Request(url, { headers: { Range: `bytes=${start}-${start + 1023}` } }),
        );
        expect(response.status).toBe(206);
        const bytes = Buffer.from(await response.arrayBuffer());
        expect(bytes.byteLength).toBe(1024);
        expect(bytes.subarray(0, 10)).toEqual(
          start === 0 ? Buffer.from('0123456789') : Buffer.alloc(10),
        );
      }),
    );
    expect(readFile).not.toHaveBeenCalled();
    expect(streams.map((stream) => stream.bytesRead)).toEqual([1024, 1024, 1024]);
    await vi.waitFor(() => expect(files.every((file) => file.fd === -1)).toBe(true));
  });

  it.each([null, 'bytes=0-'])(
    'bounds prefetch and closes a cancelled %s response',
    async (range) => {
      fs.truncateSync(filePath, 100 * 1024 * 1024);
      const response = await handler(new Request(url, { headers: range ? { Range: range } : {} }));
      // Let the queues fill without consuming: an open range must not preload 100 MiB.
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(streams[0].bytesRead).toBeLessThanOrEqual(3 * 64 * 1024);
      await response.body!.cancel();
      await vi.waitFor(() => expect(files[0].fd).toBe(-1));
    },
  );

  it.each([false, true])('closes an aborted request (already aborted=%s)', async (already) => {
    fs.truncateSync(filePath, 100 * 1024 * 1024);
    const controller = new AbortController();
    if (already) controller.abort();
    const response = await handler(new Request(url, { signal: controller.signal }));
    if (!already) controller.abort();
    await expect(response.arrayBuffer()).rejects.toThrow();
    await vi.waitFor(() => expect(files[0].fd).toBe(-1));
  });

  it('propagates stream errors and closes the descriptor', async () => {
    const response = await handler(new Request(url));
    streams[0].destroy(new Error('read failed'));
    await expect(response.arrayBuffer()).rejects.toThrow('read failed');
    await vi.waitFor(() => expect(files[0].fd).toBe(-1));
  });

  it('closes an empty file and handles missing or invalid URLs', async () => {
    fs.truncateSync(filePath, 0);
    const empty = await handler(new Request(url));
    expect(empty.status).toBe(200);
    expect(empty.headers.get('Content-Length')).toBe('0');
    expect(await empty.text()).toBe('');
    expect(files[0].fd).toBe(-1);
    expect(streams).toHaveLength(0);
    fs.unlinkSync(filePath);
    expect((await handler(new Request(url))).status).toBe(404);
    expect(await handler(new Request(url + '?x=1'))).toHaveProperty('status', 403);
    await expect(openClientWallpaperVideo(url.replace('.mp4', '.webp'))).rejects.toThrow('invalid');
  });

  it('rejects a symlinked bucket and a non-file without streaming bytes', async () => {
    fs.unlinkSync(filePath);
    fs.rmdirSync(path.dirname(filePath));
    const outside = path.join(h.dir, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, `${hash}.mp4`), 'private');
    fs.symlinkSync(
      outside,
      path.dirname(filePath),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    expect((await handler(new Request(url))).status).toBe(403);
    fs.unlinkSync(path.dirname(filePath));
    fs.mkdirSync(filePath, { recursive: true });
    expect((await handler(new Request(url))).status).toBe(403);
    expect(streams).toHaveLength(0);
  });

  it('rejects replacement during open and closes the unserved handle', async () => {
    const open = vi.mocked(fsp.open).getMockImplementation()!;
    vi.mocked(fsp.open).mockImplementationOnce(async (...args) => {
      const file = await open(...args);
      fs.renameSync(filePath, filePath + '.old');
      fs.writeFileSync(filePath, 'replacement');
      return file;
    });
    expect((await handler(new Request(url))).status).toBe(403);
    expect(files[0].fd).toBe(-1);
    expect(streams).toHaveLength(0);
  });
});
