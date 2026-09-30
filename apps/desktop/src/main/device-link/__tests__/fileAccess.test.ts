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
      await readRemoteDeviceFile('d', 'unused', invoke, { workdir: '/p', relPath: 'a', maxBytes: 10, fallback }),
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
