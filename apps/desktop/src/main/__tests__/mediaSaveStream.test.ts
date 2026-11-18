import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';
import { saveMediaStream, type MediaSaveStreamPorts } from '../mediaSaveStream';

// Test value: #10128's production stream saver must publish complete bytes and
// preserve a user's old file on failure. Existing lightbox tests fake file writes.
// Minimal inputs are a chunked Response or an interrupted response and one target.
// Unit tier: bounded small temporary files, no network/process/real waits.
const directories: string[] = [];
async function target() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-save-test-'));
  directories.push(directory);
  return { directory, destination: path.join(directory, 'clip.mp4') };
}
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(directories.splice(0).map((p) => fs.rm(p, { recursive: true, force: true })));
});
const source = { kind: 'http', url: 'https://example.test/clip.mp4' } as const;
function ports(response: Response): MediaSaveStreamPorts {
  return { fetchHttp: vi.fn(async () => response), fetchRemote: vi.fn(async () => response) };
}

describe('saveMediaStream', () => {
  it.each(['http', 'remote-media'] as const)('publishes matching chunked %s bytes and removes staging', async (kind) => {
    const { directory, destination } = await target();
    await fs.writeFile(destination, 'previous');
    const chunk = Buffer.alloc(16 * 1024, 37);
    const expected = createHash('sha256');
    let count = 0;
    const response = new Response(new ReadableStream({
      pull(c) {
        if (count++ < 64) { expected.update(chunk); c.enqueue(chunk); } else c.close();
      },
    }), { headers: { 'Content-Length': String(64 * chunk.length) } });
    await saveMediaStream({ ...source, kind }, destination, ports(response));
    const actual = createHash('sha256');
    for await (const bytes of createReadStream(destination)) actual.update(bytes);
    expect(actual.digest('hex')).toBe(expected.digest('hex'));
    expect((await fs.stat(destination)).size).toBe(1024 * 1024);
    expect(await fs.readdir(directory)).toEqual(['clip.mp4']);
  });

  it.each(['stream-error', 'truncated', 'partial-status', 'http-error'])(
    'preserves the existing destination and cleans its partial file on %s', async (failure) => {
      const { directory, destination } = await target();
      await fs.writeFile(destination, 'keep me');
      let reads = 0;
      const cancel = vi.fn();
      const response = new Response(new ReadableStream({
        pull(c) {
          if (reads++ === 0) c.enqueue(new Uint8Array([1, 2, 3]));
          else if (failure === 'stream-error') c.error(new Error('broken stream'));
          else c.close();
        }, cancel,
      }), { status: failure === 'http-error' ? 503 : failure === 'partial-status' ? 206 : 200,
        headers: { 'Content-Length': '4' } });
      await expect(saveMediaStream(source, destination, ports(response))).rejects.toThrow();
      expect(await fs.readFile(destination, 'utf8')).toBe('keep me');
      expect(await fs.readdir(directory)).toEqual(['clip.mp4']);
      if (failure.endsWith('status') || failure === 'http-error') expect(cancel).toHaveBeenCalledOnce();
    },
  );

  it('does not fetch when the chosen directory cannot be opened', async () => {
    const { directory } = await target();
    const p = ports(new Response('bytes'));
    await expect(saveMediaStream(source, path.join(directory, 'missing', 'clip.mp4'), p)).rejects.toThrow();
    expect(p.fetchHttp).not.toHaveBeenCalled();
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it('cancels a stalled fetch at the inactivity limit and removes staging', async () => {
    const { directory, destination } = await target();
    vi.useFakeTimers();
    const started = Promise.withResolvers<void>();
    const p: MediaSaveStreamPorts = {
      fetchHttp: (_url, signal) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        started.resolve();
      }), fetchRemote: vi.fn(),
    };
    const saving = saveMediaStream(source, destination, p);
    const rejected = expect(saving).rejects.toThrow('aborted');
    await started.promise;
    await vi.advanceTimersByTimeAsync(30_000);
    await rejected;
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it('allows remote cache materialization before starting body inactivity timing', async () => {
    const { directory, destination } = await target();
    vi.useFakeTimers();
    const started = Promise.withResolvers<void>();
    const ready = Promise.withResolvers<void>();
    const p: MediaSaveStreamPorts = {
      fetchHttp: vi.fn(),
      fetchRemote: async (_url, signal) => {
        started.resolve();
        // SSH materializes an uncached video before returning its response.
        // Its existing chunk/RPC timeouts govern this phase, not a total save budget.
        await ready.promise;
        expect(signal.aborted).toBe(false);
        return new Response('remote video');
      },
    };
    const saving = saveMediaStream({ ...source, kind: 'remote-media' }, destination, p);
    const completed = expect(saving).resolves.toBeUndefined();
    await started.promise;
    await vi.advanceTimersByTimeAsync(45_000);
    ready.resolve();
    await completed;
    expect(await fs.readFile(destination, 'utf8')).toBe('remote video');
    expect(await fs.readdir(directory)).toEqual(['clip.mp4']);
  });

  it('cancels a stalled response reader and preserves the prior file', async () => {
    const { directory, destination } = await target();
    await fs.writeFile(destination, 'previous');
    vi.useFakeTimers();
    const stalled = Promise.withResolvers<void>();
    const cancel = vi.fn();
    let pulls = 0;
    const response = new Response(new ReadableStream({
      pull(c) {
        if (pulls++ === 0) c.enqueue(new Uint8Array([1]));
        else stalled.resolve();
      }, cancel,
    }));
    const saving = saveMediaStream(source, destination, ports(response));
    const rejected = expect(saving).rejects.toThrow();
    await stalled.promise;
    await vi.advanceTimersByTimeAsync(30_000);
    await rejected;
    expect(cancel).toHaveBeenCalledOnce();
    expect(await fs.readFile(destination, 'utf8')).toBe('previous');
    expect(await fs.readdir(directory)).toEqual(['clip.mp4']);
  });

  it('publishes over a selected symbolic link without changing its referent', async (context) => {
    const { directory, destination } = await target();
    const original = path.join(directory, 'original.mp4');
    await fs.writeFile(original, 'keep');
    try { await fs.symlink(original, destination); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') { context.skip(); return; }
      throw error;
    }
    await saveMediaStream(source, destination, ports(new Response('new video')));
    expect(await fs.readFile(original, 'utf8')).toBe('keep');
    expect(await fs.readFile(destination, 'utf8')).toBe('new video');
    expect((await fs.lstat(destination)).isSymbolicLink()).toBe(false);
    expect((await fs.readdir(directory)).sort()).toEqual(['clip.mp4', 'original.mp4']);
  });

  it('leaves a target directory intact if publishing fails', async () => {
    const { directory, destination } = await target();
    await fs.mkdir(destination);
    await fs.writeFile(path.join(destination, 'original'), 'keep');
    await expect(saveMediaStream(source, destination, ports(new Response('bytes')))).rejects.toThrow();
    expect(await fs.readFile(path.join(destination, 'original'), 'utf8')).toBe('keep');
    expect(await fs.readdir(directory)).toEqual(['clip.mp4']);
  });
});
