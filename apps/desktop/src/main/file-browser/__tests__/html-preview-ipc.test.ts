import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const mocks = vi.hoisted(() => ({
  handle: vi.fn(),
  trusted: vi.fn(),
  ingest: vi.fn(),
  current: true,
  db: {},
  compensation: { assertStillValid: vi.fn() },
}));
vi.mock('electron', () => ({ ipcMain: { handle: mocks.handle } }));
vi.mock('../../security/trustedAppRenderer.js', () => ({
  assertTrustedAppRendererEvent: mocks.trusted,
}));
vi.mock('../../logger.js', () => ({ createLogger: () => ({ warn: vi.fn() }) }));
vi.mock('../../cindy-media/ingest.js', () => ({ ingestMedia: mocks.ingest }));
vi.mock('../../cindy-media/refCompensationJournal.js', () => ({
  captureMediaRefCompensationScope: () => mocks.compensation,
}));
vi.mock('../../device-link/broadcast-tap.js', () => ({
  captureDataOwnerBroadcastScope: () => ({ ownerScopeKey: 'owner-a:1' }),
  isDataOwnerBroadcastScopeCurrent: () => mocks.current,
}));
vi.mock('../../localDb/client/current.js', () => ({ getDbClient: () => ({ drizzle: mocks.db }) }));
import { disposeHtmlPreviews, registerHtmlPreviewIpc } from '../html-preview-ipc';
const args = {
  origin: { kind: 'device', deviceId: 'remote' },
  workdir: '/remote',
  absPath: '/remote/preview/index.html',
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.current = true;
});
afterAll(disposeHtmlPreviews);
it('rejects an untrusted guest before any filesystem or remote operation', async () => {
  mocks.trusted.mockImplementationOnce(() => {
    throw new Error('PERMISSION_DENIED');
  });
  const list = vi.fn();
  registerHtmlPreviewIpc({ list, read: vi.fn() });
  await expect(mocks.handle.mock.calls[0][1]({}, args)).rejects.toThrow('PERMISSION_DENIED');
  expect(list).not.toHaveBeenCalled();
});
it('returns an actionable typed error for an old remote without directory snapshots', async () => {
  const list = vi.fn().mockRejectedValue(new Error('COMPLETE_DIRECTORY_LISTING_UNSUPPORTED'));
  registerHtmlPreviewIpc({ list, read: vi.fn() });
  await expect(mocks.handle.mock.calls[0][1]({}, args)).rejects.toMatchObject({
    code: 'HTML_PREVIEW_UNSUPPORTED',
  });
  expect(list).toHaveBeenCalledWith(args, '/remote/preview', '');
});
it('checks the full manifest budget before starting downloads', async () => {
  const read = vi.fn();
  registerHtmlPreviewIpc({
    list: async () => [
      {
        name: 'index.html',
        relPath: 'index.html',
        type: 'file',
        size: 101 * 1024 * 1024,
        mtimeMs: 0,
      },
    ],
    read,
  });
  await expect(mocks.handle.mock.calls[0][1]({}, args)).rejects.toMatchObject({
    code: 'HTML_PREVIEW_TOO_LARGE',
  });
  expect(read).not.toHaveBeenCalled();
});
it('passes the captured owner guard and compensation scope through media ingestion', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-preview-owner-test-'));
  try {
    await fs.writeFile(path.join(dir, 'index.html'), '');
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    await fs.writeFile(path.join(dir, 'image.png'), png);
    mocks.ingest.mockImplementationOnce(async (params, db) => {
      expect(db).toBe(mocks.db);
      expect(params.refCompensationScope).toBe(mocks.compensation);
      params.assertStillValid();
      expect(mocks.compensation.assertStillValid).toHaveBeenCalled();
      // The real ingest helper calls this guard after each asynchronous write/ref operation.
      await Promise.resolve();
      mocks.current = false;
      params.assertStillValid();
    });
    registerHtmlPreviewIpc({
      list: async () =>
        ['index.html', 'image.png'].map((name) => ({
          name,
          relPath: name,
          type: 'file' as const,
          size: name === 'image.png' ? png.length : 0,
          mtimeMs: 0,
        })),
      read: async (_args, _root, entry) => path.join(dir, entry.relPath),
    });
    await expect(mocks.handle.mock.calls[0][1]({}, args)).rejects.toMatchObject({
      code: 'BROWSER_FILE_OPEN_FAILED',
    });
    expect(mocks.ingest).toHaveBeenCalledTimes(1);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
