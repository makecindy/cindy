import { afterAll, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ handle: vi.fn(), trusted: vi.fn() }));
vi.mock('electron', () => ({ ipcMain: { handle: mocks.handle } }));
vi.mock('../../security/trustedAppRenderer.js', () => ({ assertTrustedAppRendererEvent: mocks.trusted }));
vi.mock('../../logger.js', () => ({ createLogger: () => ({ warn: vi.fn() }) }));
vi.mock('../../cindy-media/ingest.js', () => ({ ingestMedia: vi.fn() }));
vi.mock('../../device-link/broadcast-tap.js', () => ({ captureDataOwnerBroadcastScope: () => ({}), isDataOwnerBroadcastScopeCurrent: () => true }));
vi.mock('../../localDb/client/current.js', () => ({ getDbClient: () => ({ drizzle: {} }) }));
import { disposeHtmlPreviews, registerHtmlPreviewIpc } from '../html-preview-ipc';
const args = { origin: { kind: 'device', deviceId: 'remote' }, workdir: '/remote', absPath: '/remote/preview/index.html' };
beforeEach(() => vi.clearAllMocks());
afterAll(disposeHtmlPreviews);
it('rejects an untrusted guest before any filesystem or remote operation', async () => {
  mocks.trusted.mockImplementationOnce(() => { throw new Error('PERMISSION_DENIED'); });
  const list = vi.fn();
  registerHtmlPreviewIpc({ list, read: vi.fn() });
  await expect(mocks.handle.mock.calls[0][1]({}, args)).rejects.toThrow('PERMISSION_DENIED');
  expect(list).not.toHaveBeenCalled();
});
it('returns an actionable typed error for an old remote without directory snapshots', async () => {
  const list = vi.fn().mockRejectedValue(new Error('COMPLETE_DIRECTORY_LISTING_UNSUPPORTED'));
  registerHtmlPreviewIpc({ list, read: vi.fn() });
  await expect(mocks.handle.mock.calls[0][1]({}, args)).rejects.toMatchObject({ code: 'HTML_PREVIEW_UNSUPPORTED' });
  expect(list).toHaveBeenCalledWith(args, '/remote/preview', '');
});
it('checks the full manifest budget before starting downloads', async () => {
  const read = vi.fn();
  registerHtmlPreviewIpc({ list: async () => [{ name: 'index.html', relPath: 'index.html', type: 'file', size: 101 * 1024 * 1024, mtimeMs: 0 }], read });
  await expect(mocks.handle.mock.calls[0][1]({}, args)).rejects.toMatchObject({ code: 'HTML_PREVIEW_TOO_LARGE' });
  expect(read).not.toHaveBeenCalled();
});
