import { beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { sharedTaskHostPeer } from '@cindy/device-link';
const peer = vi.hoisted(() => vi.fn());
const remove = vi.hoisted(() => vi.fn());
const owner = vi.hoisted(() => ({ current: true }));
const cache = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), invalidate: vi.fn() }));
vi.mock('../remoteFileVersionCache', () => ({ remoteFileVersionCache: () => cache }));
vi.mock('../filePeer', () => ({ tryPeerFile: peer }));
vi.mock('../mediaTransfer', () => ({ removeRemote: remove }));
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
