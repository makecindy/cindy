import fs from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { fetchVideoTaskContent } from '../videoTaskContent.js';

const fetch = vi.hoisted(() => vi.fn());
vi.mock('../../maker-host/outbound-fetch.js', () => ({ outboundFetch: fetch }));

const reserve = 256n * 1024n * 1024n;
const connection = { baseUrl: 'https://relay.example/v1', headers: { authorization: 'Bearer test-key' }, revision: 'original', assertCurrent: vi.fn() };

describe('private video task download disk budget', () => {
  let directories: MockInstance<typeof fs.mkdtemp>;
  beforeEach(() => {
    fetch.mockReset();
    directories = vi.spyOn(fs, 'mkdtemp');
    vi.spyOn(fs, 'statfs').mockResolvedValue({ bavail: reserve + 16n, bsize: 1n } as never);
  });
  afterEach(async () => {
    for (const result of directories.mock.results) {
      if (result.type === 'return') await fs.rm(await result.value, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  it.each([undefined, '1'])('counts actual streamed bytes with content-length=%s and cancels, cleans up, and does not retry overflow', async contentLength => {
    const cancel = vi.fn();
    const chunks = [new Uint8Array(4), new Uint8Array(5)];
    fetch.mockResolvedValue(new Response(new ReadableStream({
      pull(controller) {
        if (chunks.length) controller.enqueue(chunks.shift()!);
        else controller.close();
      },
      cancel,
    }, { highWaterMark: 0 }), { headers: contentLength ? { 'content-length': contentLength } : {} }));
    await expect(fetchVideoTaskContent(connection, 'paid-task')).rejects.toMatchObject({ code: 'MEDIA_DOWNLOAD_UNAVAILABLE' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(chunks).toHaveLength(0);
    await expect(fs.stat(await directories.mock.results[0]!.value)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rechecks available disk space before writing when another writer consumes the reserve', async () => {
    vi.mocked(fs.statfs).mockResolvedValueOnce({ bavail: reserve + 16n, bsize: 1n } as never)
      .mockResolvedValue({ bavail: reserve + 1n, bsize: 1n } as never);
    fetch.mockResolvedValue(new Response(new Uint8Array(2)));
    await expect(fetchVideoTaskContent(connection, 'paid-task')).rejects.toMatchObject({ code: 'MEDIA_DOWNLOAD_UNAVAILABLE' });
    expect(fetch).toHaveBeenCalledTimes(1);
    await expect(fs.stat(await directories.mock.results[0]!.value)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails without retry when disk capacity cannot be determined', async () => {
    vi.mocked(fs.statfs).mockRejectedValue(new Error('statfs unavailable'));
    fetch.mockResolvedValue(new Response(new Uint8Array(2)));
    await expect(fetchVideoTaskContent(connection, 'paid-task')).rejects.toMatchObject({ code: 'MEDIA_DOWNLOAD_UNAVAILABLE' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('allows a complete stream within the budget and disposes the private file', async () => {
    const content = new Uint8Array(8).fill(7);
    fetch.mockResolvedValue(new Response(content, { headers: { 'content-type': 'video/mp4' } }));
    const result = await fetchVideoTaskContent(connection, 'paid-task');
    expect(await fs.readFile(result.filePath)).toEqual(Buffer.from(content));
    expect(result.headerMime).toBe('video/mp4');
    await result.dispose();
    await expect(fs.stat(result.filePath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
