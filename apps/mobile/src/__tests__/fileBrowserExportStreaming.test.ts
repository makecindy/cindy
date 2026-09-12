import { describe, expect, it, vi } from 'vitest';
import { createMobileMakerTransport, type RemoteInvoke } from '@/device-link/mobileMakerTransport';
import { exportRemoteFileToUrl } from '@/session/fileBrowserExport';
import { clearPeerMedia, installPeerFileDownload, recordPeerMedia } from '@/device-link/peerFileRegistry';

vi.mock('@react-native-async-storage/async-storage', () => ({ default: {} }));

describe('file browser playback and download', () => {
  it.each(['audio/mpeg', 'video/mp4'])('keeps %s playback off cached peer downloads in either order', async (mimeType) => {
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
});
