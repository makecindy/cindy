import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const userDataDir = path.join(os.tmpdir(), `chat-attachment-cache-${randomUUID()}`);

vi.mock('electron', () => ({
  app: { getPath: () => userDataDir },
}));
vi.mock('../../logger.js', () => ({
  createLogger: () => ({
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const {
  getChatAttachmentCacheRoot,
  getRemoteFileCacheRoot,
  stageLocalFileToCache,
  sweepCacheOnStartup,
} = await import('../remote-file-cache');

afterEach(async () => {
  await fs.rm(userDataDir, { recursive: true, force: true });
});

describe('chat attachment staging cache', () => {
  it('stores persisted chat attachments outside the disposable remote-file LRU', async () => {
    const payload = Buffer.from('installer-bytes');
    const stagedPath = await stageLocalFileToCache({
      suggestedName: 'setup.exe',
      expectedSize: BigInt(payload.byteLength),
      copyTo: (targetPath) => fs.writeFile(targetPath, payload),
    });

    expect(path.dirname(stagedPath)).toBe(getChatAttachmentCacheRoot());
    expect(stagedPath.endsWith('.bin')).toBe(true);
    expect(stagedPath.startsWith(`${getRemoteFileCacheRoot()}${path.sep}`)).toBe(false);

    await fs.mkdir(getRemoteFileCacheRoot(), { recursive: true });
    const disposablePart = path.join(getRemoteFileCacheRoot(), 'orphan.part');
    await fs.writeFile(disposablePart, 'partial');
    await sweepCacheOnStartup();

    await expect(fs.stat(stagedPath)).resolves.toMatchObject({ size: payload.byteLength });
    await expect(fs.stat(disposablePart)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
