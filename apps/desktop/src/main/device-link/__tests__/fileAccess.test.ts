import { beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { sharedTaskHostPeer } from '@cindy/device-link';
const peer = vi.hoisted(() => vi.fn());
const rangePeer = vi.hoisted(() => vi.fn());
const remove = vi.hoisted(() => vi.fn());
const owner = vi.hoisted(() => ({ current: true }));
const cache = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), invalidate: vi.fn() }));
vi.mock('../remoteFileVersionCache', () => ({ remoteFileVersionCache: () => cache }));
vi.mock('../filePeer', () => ({ tryPeerFile: peer, tryPeerFileRange: rangePeer }));
vi.mock('../mediaTransfer.desktop', () => ({ removeRemote: remove }));
vi.mock('../broadcast-tap', () => ({
  captureDataOwnerBroadcastScope: () => ({}),
  isDataOwnerBroadcastScopeCurrent: () => owner.current,
}));
import { readRemoteDeviceFile } from '../fileAccess';
import { invalidateFilePeerScopes } from '../filePeerScope';
beforeEach(() => {
  vi.clearAllMocks();
  owner.current = true;
  peer.mockResolvedValue(null);
});
describe('desktop shared file access', () => {
  // #8332, unit: exercise readRemoteDeviceFile with the workdir export fallback
  // supplied by file previews. Existing guest coverage only reads three inline
  // bytes; 65,537 bytes previously entered the forbidden same-account export.
  // Standalone file: 2.34s Vitest / 3.87s command wall time on Windows.
  it.each([
    { size: 65_536, fileRead: true },
    { size: 65_537, fileRead: true },
    { size: 65_537, fileRead: undefined },
  ])('reads a $size-byte shared workdir file without owner export (fileRead=$fileRead)', async ({ size, fileRead }) => {
    const url = `xdt-file://open?path=/work/changed.txt&baseDir=/work&maxBytes=${size}`;
    const metadata = { ossKey: '', size, mimeType: 'text/plain', version: 'd'.repeat(64) };
    const inline = { ...metadata, inlineBase64: Buffer.alloc(size, 7).toString('base64') };
    const uploaded = { ...metadata, ossKey: 'shared/changed.txt' };
    const invoke = vi.fn(async (_device, channel, [request]) => {
      if (channel === 'file-browser:remote-op' && request.op === 'caps') return { ok: true, result: { fileRead } };
      if (channel === 'file-browser:remote-op' && request.op === 'fileUrl') return { ok: true, result: { ok: true, url } };
      if (channel !== 'device-link:media:fetch') throw new Error('PERMISSION_DENIED');
      expect(Object.fromEntries(new URL(request.url).searchParams))
        .toEqual(Object.fromEntries(new URL(url).searchParams));
      expect(request).not.toHaveProperty('metadataOnly');
      return { ok: true, result: request.prepareOnly
        ? size <= 65_536 ? inline : { ...metadata, transferRequired: true }
        : uploaded };
    });
    const fallback = vi.fn(async (): Promise<never> => { throw new Error('PERMISSION_DENIED: exportFileStart'); });
    const result = await readRemoteDeviceFile(sharedTaskHostPeer('shared', 'host'), url, invoke, {
      workdir: '/work', relPath: 'changed.txt', maxBytes: size, fallback,
    });
    expect(result).toEqual(size <= 65_536 ? inline : uploaded);
    expect(peer).not.toHaveBeenCalled();
    expect(fallback).not.toHaveBeenCalled();
  });

  it.each(['prepare', 'upload', 'cancel'] as const)('stops shared file reads on %s rejection without owner fallback', async (failure) => {
    const abort = new AbortController();
    const invoke = vi.fn(async (_device, channel, [request]) => {
      if (channel === 'file-browser:remote-op' && request.op === 'caps') return { ok: true, result: { fileRead: true } };
      if (channel === 'file-browser:remote-op' && request.op === 'fileUrl') return { ok: true, result: { ok: true, url: 'xdt-file://open?path=/work/a' } };
      if (failure === 'prepare' || !request.prepareOnly) return { ok: false, error: { code: 'PERMISSION_DENIED' } };
      if (failure === 'cancel') abort.abort();
      return { ok: true, result: { ossKey: '', size: 65_537, mimeType: 'text/plain', transferRequired: true } };
    });
    const fallback = vi.fn(async (): Promise<never> => { throw new Error('owner export must not run'); });
    await expect(readRemoteDeviceFile(sharedTaskHostPeer('shared', 'host'), 'unused', invoke, {
      workdir: '/work', relPath: 'a', fallback, signal: abort.signal,
    })).rejects.toThrow(failure === 'cancel' ? 'FILE_PEER_CANCELLED' : 'PERMISSION_DENIED');
    expect(peer).not.toHaveBeenCalled();
    expect(fallback).not.toHaveBeenCalled();
    expect(invoke.mock.calls.filter(([, channel]) => channel === 'device-link:media:fetch'))
      .toHaveLength(failure === 'upload' ? 2 : 1);
  });

  it('reads through an older shared host without sending unknown metadata-only fields', async () => {
    const result = { ossKey: '', size: 3, mimeType: 'text/plain', inlineBase64: 'YWJj' };
    const invoke = vi.fn(async (_device, _channel, [request]) => {
      if ('metadataOnly' in request) throw new Error('PERMISSION_DENIED');
      return { ok: true, result };
    });
    const device = sharedTaskHostPeer('shared', 'host');
    expect(await readRemoteDeviceFile(device, 'xdt-file://open?path=/a.txt', invoke)).toEqual(result);
    expect(await readRemoteDeviceFile(device, 'xdt-file://open?path=/a.txt', invoke)).toEqual(result);
    expect(invoke).toHaveBeenCalledTimes(2);
  });
  it('waits for the current same-size version when filling an outer version cache', async () => {
    const old = { ossKey: '', size: 3, mimeType: 'text/html', version: '1'.repeat(64), inlineBase64: 'b2xk' };
    const fresh = { ...old, version: '2'.repeat(64), inlineBase64: 'bmV3' };
    const invoke = vi.fn().mockResolvedValue({ ok: true, result: old });
    const url = 'xdt-file://open?path=/versioned.html';
    await readRemoteDeviceFile('versioned', url, invoke);
    cache.get.mockResolvedValue('/cache/old');
    const read = vi.spyOn(fs, 'readFile').mockResolvedValue(Buffer.from('old'));
    let reply!: (value: unknown) => void;
    invoke.mockImplementationOnce(() => new Promise(resolve => { reply = resolve; }));
    let settled = false;
    const pending = readRemoteDeviceFile('versioned', url, invoke, { cacheFirst: false })
      .then(result => { settled = true; return result; });
    try {
      await vi.waitFor(() => expect(reply).toBeTypeOf('function'));
      expect(settled).toBe(false);
      expect(read).not.toHaveBeenCalled();
      reply({ ok: true, result: fresh });
      expect(await pending).toEqual(fresh);
      expect(cache.invalidate).not.toHaveBeenCalled();
    } finally { read.mockRestore(); }
  });
  it('returns cached HTML before a blocked host version check completes', async () => {
    const result = { ossKey: '', size: 3, mimeType: 'text/html', version: 'c'.repeat(64), inlineBase64: 'YWJj' };
    cache.get.mockResolvedValueOnce(null).mockResolvedValueOnce('/cache/instant');
    const read = vi.spyOn(fs, 'readFile').mockResolvedValueOnce(Buffer.from('abc'));
    const invoke = vi.fn(async (_device, _channel, [args]) => ({ ok: true, result: args.metadataOnly
      ? { ...result, inlineBase64: undefined, transferRequired: true } : result }));
    let reply!: (value: any) => void;
    try {
      await readRemoteDeviceFile('instant', 'xdt-file://open?path=/cached.html', invoke);
      invoke.mockImplementationOnce(() => new Promise(resolve => { reply = resolve; }));
      expect(await readRemoteDeviceFile('instant', 'xdt-file://open?path=/cached.html', invoke)).toEqual(result);
      expect(invoke).toHaveBeenCalledTimes(3);
      reply({ ok: true, result });
    } finally { read.mockRestore(); }
  });
  it('checks metadata then reads the same durable cache used by large files', async () => {
    const result = { ossKey: '', size: 3, mimeType: 'text/html', version: 'a'.repeat(64), inlineBase64: 'YWJj' };
    cache.get.mockResolvedValueOnce(null).mockResolvedValueOnce('/cache/html');
    const read = vi.spyOn(fs, 'readFile').mockResolvedValueOnce(Buffer.from('abc'));
    const invoke = vi.fn(async (_device, _channel, [args]) => ({ ok: true, result: args.metadataOnly
      ? { ...result, inlineBase64: undefined, transferRequired: true } : result }));
    try {
      expect(await readRemoteDeviceFile('d', 'xdt-file://open?path=/a.html', invoke)).toEqual(result);
      expect(cache.put).toHaveBeenCalledWith(Buffer.from('abc'));
      expect(await readRemoteDeviceFile('d', 'xdt-file://open?path=/a.html', invoke)).toEqual(result);
      expect(invoke).toHaveBeenCalledTimes(3);
      expect(peer).not.toHaveBeenCalled();
    } finally { read.mockRestore(); }
  });
  it.each(['abort', 'stop', 'owner'] as const)('keeps business requests cancelled while permitting owner-safe close (%s)', async reason => {
    const abort = new AbortController();
    const invoke = vi.fn(async () => ({ ok: true, result: { ossKey: '', size: 5, mimeType: 'text/plain', transferRequired: true } }));
    peer.mockImplementationOnce(async (device, _url, guarded) => {
      if (reason === 'abort') abort.abort();
      if (reason === 'stop') invalidateFilePeerScopes(device);
      if (reason === 'owner') owner.current = false;
      for (const action of ['caps', 'offer', 'open'])
        await expect(guarded(device, 'device-link:file-peer', [{ action }])).rejects.toThrow('FILE_PEER_CANCELLED');
      await expect(guarded(device, 'device-link:media:fetch', [{ action: 'close' }])).rejects.toThrow('FILE_PEER_CANCELLED');
      const close = guarded(device, 'device-link:file-peer', [{ action: 'close', connection: 'old-connection' }]);
      if (reason === 'owner') await expect(close).rejects.toThrow('FILE_PEER_CANCELLED');
      else await expect(close).resolves.toMatchObject({ ok: true });
      return null;
    });
    await expect(readRemoteDeviceFile('guarded-peer', 'url', invoke, { signal: abort.signal })).rejects.toThrow('FILE_PEER_CANCELLED');
    expect(invoke).toHaveBeenCalledTimes(reason === 'owner' ? 1 : 2);
  });

  it('cancels a late file preparation after unlink without starting peer or OSS', async () => {
    let answer!: (value: unknown) => void;
    const invoke = vi.fn(() => new Promise<any>(resolve => { answer = resolve; }));
    const fallback = vi.fn();
    const read = readRemoteDeviceFile('d', 'xdt-file://test', invoke, { fallback });
    const cancelled = expect(read).rejects.toThrow('FILE_PEER_CANCELLED');
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledOnce());
    invalidateFilePeerScopes('d');
    answer({ ok: true, result: { ossKey: '', size: 100, mimeType: 'text/plain', transferRequired: true } });
    await cancelled;
    expect(peer).not.toHaveBeenCalled();
    expect(fallback).not.toHaveBeenCalled();
  });
  it.each([false, true])(
    'forwards direct progress for workdir and media reads (workdir=%s)',
    async (workdir) => {
      const metadata = {
        ossKey: '',
        size: 100,
        mimeType: 'application/octet-stream',
        transferRequired: true,
      };
      const invoke = vi.fn(async (_device, _channel, [args]) => ({
        ok: true,
        result:
          args.op === 'caps'
            ? { fileRead: true }
            : args.op === 'fileUrl'
              ? { ok: true, url: 'xdt-file://local/?path=/w/file' }
              : metadata,
      }));
      const progress = vi.fn();
      const local = {
        path: '/tmp/received',
        size: 100,
        mimeType: metadata.mimeType,
        dispose: vi.fn(),
      };
      peer.mockImplementationOnce(async (_device, _url, _invoke, _signal, onProgress) => {
        onProgress(0, 100);
        onProgress(45, 100);
        onProgress(100, 100);
        return local;
      });
      const fallback = vi.fn();
      const result = await readRemoteDeviceFile('d', 'xdt-file://test', invoke, {
        onProgress: progress,
        ...(workdir ? { workdir: '/w', relPath: 'file', fallback } : {}),
      });
      expect(result).toMatchObject({ path: local.path });
      expect(progress.mock.calls).toEqual([
        [0, 100],
        [45, 100],
        [100, 100],
      ]);
      expect(fallback).not.toHaveBeenCalled();
    },
  );

  it('resets discarded partial bytes before falling back to OSS', async () => {
    const progress = vi.fn();
    peer.mockImplementationOnce(async (_device, _url, _invoke, _signal, onProgress) => {
      onProgress(40, 100);
      return null;
    });
    const invoke = vi.fn(async () => ({
      ok: true,
      result: { ossKey: '', size: 100, mimeType: 'text/plain', transferRequired: true },
    }));
    const fallback = vi.fn(async () => {
      expect(progress).toHaveBeenLastCalledWith(0, 100);
      return { ossKey: 'fallback', size: 100, mimeType: 'text/plain' };
    });
    expect(
      await readRemoteDeviceFile('d', 'xdt-file://test', invoke, {
        onProgress: progress,
        fallback,
      }),
    ).toMatchObject({ ossKey: 'fallback' });
    expect(progress.mock.calls).toEqual([
      [40, 100],
      [0, 100],
    ]);
  });

  it('keeps old hosts on two-stage export without synchronous media upload', async () => {
    const invoke = vi.fn(async () => ({ ok: true, result: { ok: true, gzip: true } }));
    const fallback = vi.fn(async () => ({
      ossKey: 'large',
      size: 200_000_000,
      mimeType: 'application/octet-stream',
    }));
    expect(
      (
        await readRemoteDeviceFile('d', 'unused', invoke, {
          workdir: '/p',
          relPath: 'large',
          fallback,
        })
      ).ossKey,
    ).toBe('large');
    expect(invoke).toHaveBeenCalledExactlyOnceWith('d', 'file-browser:remote-op', [
      { op: 'caps', workdir: '/p' },
    ]);
    expect(peer).not.toHaveBeenCalled();
  });
  it('uses an authorized reference and skips peer for inline files', async () => {
    const inline = { ossKey: '', size: 0, mimeType: 'text/plain', inlineBase64: '' };
    const invoke = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, result: { fileRead: true } })
      .mockResolvedValueOnce({
        ok: true,
        result: { ok: true, url: 'xdt-file://open?path=%2Fp%2Fa' },
      })
      .mockResolvedValueOnce({ ok: true, result: inline });
    const fallback = vi.fn();
    expect(
      await readRemoteDeviceFile('d', 'unused', invoke, {
        workdir: '/p',
        relPath: 'a',
        maxBytes: 10,
        fallback,
      }),
    ).toEqual(inline);
    expect(peer).not.toHaveBeenCalled();
    expect(fallback).not.toHaveBeenCalled();
    expect(new URL(invoke.mock.calls[2][2][0].url).searchParams.get('maxBytes')).toBe('10');
  });
  it('does not download a video by peer only to discard it for streaming', async () => {
    const invoke = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        result: { ossKey: '', size: 1_000_000, mimeType: 'video/mp4', transferRequired: true },
      })
      .mockResolvedValueOnce({
        ok: true,
        result: { ossKey: 'video', size: 1_000_000, mimeType: 'video/mp4' },
      });
    expect(
      (await readRemoteDeviceFile('d', 'xdt-video://v', invoke, { stream: true })).ossKey,
    ).toBe('video');
    expect(peer).not.toHaveBeenCalled();
  });
});

// Unit: protocol requests independently call fileAccess for each seek. Previously
// each call transferred the first MiB again. Metadata must still be revalidated.
it('reuses a versioned playback reader for seeks but replaces changed or revoked sources', async () => {
  invalidateFilePeerScopes();
  let version = 'a'.repeat(64);
  const metadata = () => ({ ossKey: '', size: 2 * 1024 * 1024 + 9, mimeType: 'video/mp4', version, transferRequired: true });
  const invoke = vi.fn(async () => ({ ok: true as const, result: metadata() }));
  const dispose = vi.fn(async () => {});
  rangePeer.mockImplementation(async (_device, _url, _invoke, range) => ({ path: range, dispose }));
  const read = vi.spyOn(fs, 'readFile').mockImplementation(async (range: any) => Buffer.alloc(range.end - range.start + 1) as any);
  const open = () => readRemoteDeviceFile('seek-review-device', 'xdt-video://session/seek.mp4', invoke, { stream: true, playback: true });
  try {
    const first = await open();
    expect('kind' in first && first.kind).toBe('peer-stream');
    const second = await open();
    expect(second).toBe(first);
    expect(invoke).toHaveBeenCalledTimes(2); // freshness/auth metadata remains checked
    expect(rangePeer).toHaveBeenCalledTimes(1);
    if (!('serve' in second)) throw new Error('expected peer stream');
    const response = await second.serve('bytes=-9');
    expect((await response.arrayBuffer()).byteLength).toBe(9);
    expect(rangePeer).toHaveBeenCalledTimes(2);
    expect(rangePeer.mock.calls[1][3].start).toBe(metadata().size - 9);
    version = 'b'.repeat(64);
    expect(await open()).not.toBe(first);
    expect(rangePeer).toHaveBeenCalledTimes(3);
    invalidateFilePeerScopes('seek-review-device');
    expect(await open()).not.toBe(second);
    expect(rangePeer).toHaveBeenCalledTimes(4);
    owner.current = false;
    await expect(second.serve(null)).rejects.toThrow('FILE_PEER_CANCELLED');
  } finally { read.mockRestore(); invalidateFilePeerScopes(); }
});

// Unit: a cached reader used to survive a failed later range and permanently
// bypass the still-working OSS fallback. Exercise reopen via the production entry.
it('reprobes and falls back after a cached playback range fails', async () => {
  invalidateFilePeerScopes();
  const metadata = { ossKey: '', size: 2 * 1024 * 1024, mimeType: 'video/mp4', version: 'c'.repeat(64), transferRequired: true };
  const uploaded = { ...metadata, ossKey: 'fallback/video.mp4' };
  const invoke = vi.fn(async (_device, _channel, [request]) => ({ ok: true as const,
    result: request.prepareOnly ? metadata : uploaded }));
  rangePeer.mockResolvedValue(null).mockResolvedValueOnce({ path: '/first-block', dispose: async () => {} });
  const read = vi.spyOn(fs, 'readFile').mockResolvedValue(Buffer.alloc(1024 * 1024));
  const open = () => readRemoteDeviceFile('failed-range-device', 'xdt-video://session/failure.mp4', invoke, { stream: true, playback: true });
  try {
    const first = await open();
    if (!('serve' in first)) throw new Error('expected peer stream');
    const response = await first.serve('bytes=1048576-1048580');
    await expect(response.arrayBuffer()).rejects.toThrow('FILE_PEER_UNAVAILABLE');
    expect(first.isAvailable()).toBe(false);
    expect(await open()).toEqual(uploaded);
    expect(rangePeer).toHaveBeenCalledTimes(3); // probe, failed range, reopen probe
    expect(invoke.mock.calls.filter(([, , [request]]) => !request.prepareOnly)).toHaveLength(1);
  } finally { read.mockRestore(); invalidateFilePeerScopes(); }
});
