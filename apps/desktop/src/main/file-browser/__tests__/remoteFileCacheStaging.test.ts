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
  cleanupOwnedUnpersistedStagedChatAttachments,
  getChatAttachmentCacheRoot,
  getChatAttachmentOwnerCacheRoot,
  getRemoteFileCacheRoot,
  stageLocalFileToCache,
  sweepCacheOnStartup,
  sweepStagedChatAttachmentsOnStartup,
} = await import('../remote-file-cache');

afterEach(async () => {
  await fs.rm(userDataDir, { recursive: true, force: true });
});

describe('chat attachment staging cache', () => {
  it('stores persisted chat attachments outside the disposable remote-file LRU', async () => {
    const payload = Buffer.from('installer-bytes');
    const stagedPath = await stageLocalFileToCache({
      ownerId: 'owner-a',
      suggestedName: 'setup.exe',
      expectedSize: BigInt(payload.byteLength),
      copyTo: (targetPath) => fs.writeFile(targetPath, payload),
    });

    expect(path.dirname(stagedPath)).toBe(getChatAttachmentOwnerCacheRoot('owner-a'));
    expect(path.dirname(stagedPath)).not.toBe(getChatAttachmentCacheRoot());
    expect(stagedPath.endsWith('.bin')).toBe(true);
    expect(stagedPath.startsWith(`${getRemoteFileCacheRoot()}${path.sep}`)).toBe(false);

    await fs.mkdir(getRemoteFileCacheRoot(), { recursive: true });
    const disposablePart = path.join(getRemoteFileCacheRoot(), 'orphan.part');
    await fs.writeFile(disposablePart, 'partial');
    await sweepCacheOnStartup();

    await expect(fs.stat(stagedPath)).resolves.toMatchObject({ size: payload.byteLength });
    await expect(fs.stat(disposablePart)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('supports the reserved owner used by account-free local mode', async () => {
    const payload = Buffer.from('local-installer');
    const stagedPath = await stageLocalFileToCache({
      ownerId: 'local-v1',
      suggestedName: 'setup.exe',
      expectedSize: BigInt(payload.byteLength),
      copyTo: (targetPath) => fs.writeFile(targetPath, payload),
    });

    expect(path.dirname(stagedPath)).toBe(getChatAttachmentOwnerCacheRoot('local-v1'));
    await expect(fs.readFile(stagedPath)).resolves.toEqual(payload);
  });

  it('sweeps only old, unreferenced files for the current owner', async () => {
    const ownerId = 'owner-a';
    const otherOwnerId = 'owner-b';
    const ownerRoot = getChatAttachmentOwnerCacheRoot(ownerId);
    const otherOwnerRoot = getChatAttachmentOwnerCacheRoot(otherOwnerId);
    await fs.mkdir(ownerRoot, { recursive: true });
    await fs.mkdir(otherOwnerRoot, { recursive: true });

    const orphanPath = path.join(ownerRoot, 'orphan.bin');
    const protectedPath = path.join(ownerRoot, 'protected.bin');
    const partialPath = path.join(ownerRoot, 'partial.bin.part');
    const freshPath = path.join(ownerRoot, 'fresh.bin');
    const otherOwnerPath = path.join(otherOwnerRoot, 'other.bin');
    await Promise.all([
      fs.writeFile(orphanPath, 'orphan'),
      fs.writeFile(protectedPath, 'protected'),
      fs.writeFile(partialPath, 'partial'),
      fs.writeFile(freshPath, 'fresh'),
      fs.writeFile(otherOwnerPath, 'other'),
    ]);
    const sweepCutoffMs = Date.now() - 1_000;
    const oldTime = new Date(sweepCutoffMs - 60_000);
    const freshTime = new Date(sweepCutoffMs + 60_000);
    await Promise.all([
      fs.utimes(orphanPath, oldTime, oldTime),
      fs.utimes(protectedPath, oldTime, oldTime),
      fs.utimes(partialPath, oldTime, oldTime),
      fs.utimes(freshPath, freshTime, freshTime),
      fs.utimes(otherOwnerPath, oldTime, oldTime),
    ]);

    await expect(
      sweepStagedChatAttachmentsOnStartup({
        ownerId,
        protectedPaths: [protectedPath],
        createdBeforeMs: sweepCutoffMs,
      }),
    ).resolves.toMatchObject({ inspected: 4, removed: 2, protected: 1 });

    await expect(fs.stat(orphanPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(partialPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(protectedPath)).resolves.toBeDefined();
    await expect(fs.stat(freshPath)).resolves.toBeDefined();
    await expect(fs.stat(otherOwnerPath)).resolves.toBeDefined();
  });

  it('renderer cleanup removes only current-owner files not retained by messages', async () => {
    const ownerId = 'owner-a';
    const ownerRoot = getChatAttachmentOwnerCacheRoot(ownerId);
    const otherOwnerRoot = getChatAttachmentOwnerCacheRoot('owner-b');
    await fs.mkdir(ownerRoot, { recursive: true });
    await fs.mkdir(otherOwnerRoot, { recursive: true });
    const draftPath = path.join(ownerRoot, 'draft.bin');
    const persistedPath = path.join(ownerRoot, 'persisted.bin');
    const otherOwnerPath = path.join(otherOwnerRoot, 'other.bin');
    const nestedPath = path.join(ownerRoot, 'nested', 'nested.bin');
    await fs.mkdir(path.dirname(nestedPath), { recursive: true });
    await Promise.all([
      fs.writeFile(draftPath, 'draft'),
      fs.writeFile(persistedPath, 'persisted'),
      fs.writeFile(otherOwnerPath, 'other'),
      fs.writeFile(nestedPath, 'nested'),
    ]);

    await cleanupOwnedUnpersistedStagedChatAttachments({
      ownerId,
      filePaths: [draftPath, persistedPath, otherOwnerPath, nestedPath],
      protectedPaths: [persistedPath],
    });

    await expect(fs.stat(draftPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(persistedPath)).resolves.toBeDefined();
    await expect(fs.stat(otherOwnerPath)).resolves.toBeDefined();
    await expect(fs.stat(nestedPath)).resolves.toBeDefined();
  });

  it('renderer cleanup rechecks the active owner before unlinking', async () => {
    const ownerId = 'owner-a';
    const ownerRoot = getChatAttachmentOwnerCacheRoot(ownerId);
    const draftPath = path.join(ownerRoot, 'draft.bin');
    await fs.mkdir(ownerRoot, { recursive: true });
    await fs.writeFile(draftPath, 'draft');

    await cleanupOwnedUnpersistedStagedChatAttachments({
      ownerId,
      filePaths: [draftPath],
      protectedPaths: [],
      canRemove: () => false,
    });

    await expect(fs.stat(draftPath)).resolves.toBeDefined();
  });
});
