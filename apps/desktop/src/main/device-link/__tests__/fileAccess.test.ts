import { beforeEach, describe, expect, it, vi } from 'vitest';
const peer = vi.hoisted(() => vi.fn());
const remove = vi.hoisted(() => vi.fn());
vi.mock('../filePeer', () => ({ tryPeerFile: peer }));
vi.mock('../mediaTransfer', () => ({ removeRemote: remove }));
vi.mock('../broadcast-tap', () => ({
  captureDataOwnerBroadcastScope: () => ({}),
  isDataOwnerBroadcastScopeCurrent: () => true,
}));
import { readRemoteDeviceFile } from '../fileAccess';
beforeEach(() => {
  vi.clearAllMocks();
  peer.mockResolvedValue(null);
});
describe('desktop shared file access', () => {
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
