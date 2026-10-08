import { describe, expect, it, vi } from 'vitest';
import { createMobileMakerTransport, type RemoteInvoke } from '@/device-link/mobileMakerTransport';
import { exportRemoteFileToUrl } from '@/session/fileBrowserExport';
import { clearPeerMedia, installPeerFileDownload, recordPeerMedia } from '@/device-link/peerFileRegistry';

vi.mock('@react-native-async-storage/async-storage', () => ({ default: {} }));

describe('file browser playback and download', () => {
  it.each(['audio/mpeg', 'video/mp4', 'image/png', 'application/pdf', 'application/octet-stream'])('keeps %s previews off cached peer downloads in either order', async (mimeType) => {
    for (const first of [false, true]) {
      const direct = { ossKey: '', size: 70_000, mimeType };
      const local = 'file:///preview-staging';
      recordPeerMedia(direct, local, () => {});
      const peer = vi.fn(async () => direct);
      const uninstall = installPeerFileDownload(peer);
      const invoke = vi.fn(async (_device, _channel, args) => {
        if (args[0].op === 'caps') return { fileRead: true };
        if (args[0].op === 'fileUrl') return { ok: true, url: 'xdt-file://open?path=/media' };
        if (args[0].op === 'exportFileStart') return { ok: true, transferId: 'export', size: direct.size };
        if (args[0].op === 'exportFileStatus') return { ok: true, state: 'done', key: 'stream/key' };
        return { ...direct, transferRequired: true };
      });
      const deps = {
        deviceId: `stream-${mimeType}-${first}`,
        maker: createMobileMakerTransport({ deviceId: `stream-${mimeType}-${first}`, invoke: invoke as RemoteInvoke }),
        openLink: vi.fn(async () => {}),
        presignGet: vi.fn(async () => ({ getUrl: 'https://example.test/stream', expiresAt: new Date(Date.now() + 3_600_000).toISOString() })),
      };
      try {
        for (const stream of [first, !first, first, !first]) {
          expect(await exportRemoteFileToUrl({ ...deps, stream }, '/p', 'media', 1))
            .toBe(stream ? 'https://example.test/stream' : local);
        }
        expect(peer).toHaveBeenCalledOnce();
        expect(deps.presignGet).toHaveBeenCalledOnce();
      } finally { uninstall(); clearPeerMedia(); }
    }
  });

  it('reports host upload progress while a video is staged for streaming', async () => {
    const statuses = [
      { ok: true, state: 'uploading', uploaded: 0 },
      { ok: true, state: 'uploading', uploaded: 400 },
      { ok: true, state: 'uploading', uploaded: 5000 },
      { ok: true, state: 'done', key: 'stream/key', uploaded: 1000 },
    ];
    const invoke = vi.fn(async (_device, _channel, args) => {
      if (args[0].op === 'caps') return { fileRead: true };
      if (args[0].op === 'fileUrl') return { ok: true, url: 'xdt-file://open?path=/movie' };
      if (args[0].op === 'exportFileStart') return { ok: true, transferId: 'export', size: 1000 };
      if (args[0].op === 'exportFileStatus') return statuses.shift();
      return { ossKey: '', size: 1000, mimeType: 'video/mp4', transferRequired: true };
    });
    const onProgress = vi.fn();
    vi.useFakeTimers();
    try {
      const pending = exportRemoteFileToUrl({
        deviceId: 'progress-device',
        maker: createMobileMakerTransport({ deviceId: 'progress-device', invoke: invoke as RemoteInvoke }),
        openLink: vi.fn(async () => {}),
        presignGet: vi.fn(async () => ({ getUrl: 'https://example.test/movie', expiresAt: new Date(Date.now() + 3_600_000).toISOString() })),
        stream: true,
        onProgress,
      }, '/p', 'movie.mp4', 1);
      await vi.runAllTimersAsync();
      expect(await pending).toBe('https://example.test/movie');
    } finally { vi.useRealTimers(); }
    // Old hosts without `uploaded` stay silent; values are clamped to the file size.
    expect(onProgress.mock.calls).toEqual([[0, 1000], [400, 1000], [1000, 1000]]);
  });
});
