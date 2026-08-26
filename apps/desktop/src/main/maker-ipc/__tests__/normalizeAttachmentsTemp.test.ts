import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const tempRoot = vi.hoisted(() => ({ value: '' }));

vi.mock('electron', () => ({
  app: { getPath: () => tempRoot.value },
}));
vi.mock('../../imageCacheStore.js', () => ({
  resolveSafe: vi.fn(),
}));
vi.mock('../../cindy-media/blobStore.js', () => ({
  resolveSafe: vi.fn(),
  supportedMime: vi.fn(),
  mimeForExt: vi.fn(),
}));
vi.mock('../../cindy-media/ledger.js', () => ({
  removeRefById: vi.fn(),
  deleteZeroRefBlobRecord: vi.fn(),
}));
vi.mock('../../cindy-media/ingest.js', () => ({ ingestMedia: vi.fn() }));
vi.mock('../../device-link/mediaTransfer.js', () => ({
  downloadToFile: vi.fn(),
  removeRemote: vi.fn(),
}));
vi.mock('../../logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import {
  cleanupOrphanedTempAttachments,
  cleanupSessionTempAttachments,
  configureTempAttachmentOwner,
  materializeDirectSendOssAttachments,
  materializeQueuedOssAttachmentsDeferred,
  normalizeUserMessage,
} from '../normalizeAttachments.js';
import * as imageCacheStore from '../../imageCacheStore.js';
import * as cindyMediaBlobStore from '../../cindy-media/blobStore.js';
import { ingestMedia } from '../../cindy-media/ingest.js';
import { downloadToFile, removeRemote } from '../../device-link/mediaTransfer.js';
import { buildAttachmentOssRef } from '../../../shared/attachmentOssRef.js';

const tempDirs: string[] = [];

beforeEach(async () => {
  vi.clearAllMocks();
  tempRoot.value = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-review-inline-test-'));
  tempDirs.push(tempRoot.value);
  configureTempAttachmentOwner({
    instanceId: 'normalize-attachments-test-owner',
    processId: process.pid,
  });
});

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('inline attachment temporary files', () => {
  it('keeps a resolved xdt-image URL as the Host-managed image identity', async () => {
    const imageUrl = 'xdt-image://managed-reference/source.png';
    const absPath = path.join(tempRoot.value, 'source.png');
    vi.mocked(imageCacheStore.resolveSafe).mockReturnValue({
      absPath,
      mimeType: 'image/png',
    });

    const normalized = await normalizeUserMessage('managed-reference', {
      type: 'user',
      content: [{
        type: 'image',
        path: imageUrl,
        managedUrl: 'https://renderer.example/forged.png',
      }],
    });

    expect(normalized).toEqual({
      type: 'user',
      content: [{
        type: 'image',
        path: absPath,
        managedUrl: imageUrl,
        mimeType: 'image/png',
        pathOrigin: 'desktop-host',
      }],
    });
  });

  it('keeps a resolved cindy-media URL as the Host-managed image identity', async () => {
    const hash = '9'.repeat(64);
    const mediaUrl = `cindy-media://blobs/${hash}.png`;
    const absPath = path.join(tempRoot.value, 'blob.png');
    vi.mocked(cindyMediaBlobStore.resolveSafe).mockReturnValue({
      absPath,
      mimeType: 'image/png',
      hash,
    });

    const normalized = await normalizeUserMessage('managed-media-reference', {
      type: 'user',
      content: [{ type: 'image', path: mediaUrl }],
    });

    expect(normalized).toEqual({
      type: 'user',
      content: [{
        type: 'image',
        path: absPath,
        managedUrl: mediaUrl,
        mimeType: 'image/png',
        pathOrigin: 'desktop-host',
      }],
    });
  });

  it('drops a renderer-supplied managed identity from an ordinary image path', async () => {
    const imagePath = path.join(tempRoot.value, 'ordinary.png');

    const normalized = await normalizeUserMessage('untrusted-managed-reference', {
      type: 'user',
      content: [{
        type: 'image',
        path: imagePath,
        managedUrl: `cindy-media://blobs/${'f'.repeat(64)}.png`,
      }],
    });

    expect(normalized).toEqual({
      type: 'user',
      content: [{ type: 'image', path: imagePath }],
    });
  });

  it('marks directly materialized OSS images as desktop-host attachments', async () => {
    const hash = 'a'.repeat(64);
    const mediaUrl = `cindy-media://blobs/${hash}.png`;
    const absPath = path.join(tempRoot.value, 'materialized.png');
    vi.mocked(downloadToFile).mockImplementationOnce(async (_ossKey, destination) => {
      await fs.writeFile(destination, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    });
    vi.mocked(cindyMediaBlobStore.supportedMime).mockReturnValue(true);
    vi.mocked(cindyMediaBlobStore.resolveSafe).mockReturnValue({
      absPath,
      mimeType: 'image/png',
      hash,
    });
    vi.mocked(ingestMedia).mockResolvedValueOnce({
      hash,
      ext: '.png',
      mimeType: 'image/png',
      bytes: 4,
      url: mediaUrl,
      deduplicated: false,
      refIds: ['ref-1'],
    });
    const ossRef = buildAttachmentOssRef({
      ossKey: 'cindy/device-link/user/image.png',
      mimeType: 'image/png',
      originalName: 'image.png',
    });

    const materialized = await materializeDirectSendOssAttachments(
      'direct-oss-image',
      {
        type: 'user',
        content: [{ type: 'image', path: ossRef, mimeType: 'image/png' }],
      },
      undefined,
    );

    expect(materialized.message).toEqual({
      type: 'user',
      content: [{
        type: 'image',
        path: mediaUrl,
        mimeType: 'image/png',
        pathOrigin: 'desktop-host',
        base64: undefined,
      }],
    });
    materialized.cleanupAfterAcceptance?.();
    expect(removeRemote).toHaveBeenCalledWith('cindy/device-link/user/image.png');
  });

  it('marks queued OSS images as desktop-host attachments after materialization', async () => {
    const hash = 'b'.repeat(64);
    const mediaUrl = `cindy-media://blobs/${hash}.png`;
    const absPath = path.join(tempRoot.value, 'queued-materialized.png');
    vi.mocked(downloadToFile).mockImplementationOnce(async (_ossKey, destination) => {
      await fs.writeFile(destination, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    });
    vi.mocked(cindyMediaBlobStore.supportedMime).mockReturnValue(true);
    vi.mocked(cindyMediaBlobStore.resolveSafe).mockReturnValue({
      absPath,
      mimeType: 'image/png',
      hash,
    });
    vi.mocked(ingestMedia).mockResolvedValueOnce({
      hash,
      ext: '.png',
      mimeType: 'image/png',
      bytes: 4,
      url: mediaUrl,
      deduplicated: false,
      refIds: ['ref-2'],
    });
    const ossRef = buildAttachmentOssRef({
      ossKey: 'cindy/device-link/user/queued-image.png',
      mimeType: 'image/png',
      originalName: 'queued-image.png',
    });

    const materialized = await materializeQueuedOssAttachmentsDeferred(
      'queued-oss-image',
      {
        clientId: 'queued-image-1',
        files: [{
          category: 'image',
          ext: '.png',
          path: ossRef,
          mimeType: 'image/png',
        }],
      },
    );

    expect(materialized.item).toEqual({
      clientId: 'queued-image-1',
      files: [{
        category: 'image',
        ext: '.png',
        path: absPath,
        url: mediaUrl,
        mimeType: 'image/png',
        pathOrigin: 'desktop-host',
        base64: undefined,
      }],
      persistedContent: undefined,
    });
    materialized.cleanupAfterAcceptance?.();
    expect(removeRemote).toHaveBeenCalledWith('cindy/device-link/user/queued-image.png');
  });

  it('marks queued local images as desktop-host attachments after materialization', async () => {
    const sourcePath = path.join(tempRoot.value, 'device-link-local.png');
    await fs.writeFile(sourcePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const hash = 'c'.repeat(64);
    const mediaUrl = `cindy-media://blobs/${hash}.png`;
    const absPath = path.join(tempRoot.value, 'queued-local-materialized.png');
    vi.mocked(cindyMediaBlobStore.mimeForExt).mockReturnValue('image/png');
    vi.mocked(cindyMediaBlobStore.resolveSafe).mockReturnValue({
      absPath,
      mimeType: 'image/png',
      hash,
    });
    vi.mocked(ingestMedia).mockResolvedValueOnce({
      hash,
      ext: '.png',
      mimeType: 'image/png',
      bytes: 4,
      url: mediaUrl,
      deduplicated: false,
      refIds: ['ref-3'],
    });

    const materialized = await materializeQueuedOssAttachmentsDeferred(
      'queued-local-image',
      {
        clientId: 'queued-image-2',
        files: [{
          category: 'image',
          ext: '.png',
          path: sourcePath,
          mimeType: 'image/png',
        }],
      },
    );

    expect(materialized.item).toEqual({
      clientId: 'queued-image-2',
      files: [{
        category: 'image',
        ext: '.png',
        path: absPath,
        url: mediaUrl,
        mimeType: 'image/png',
        pathOrigin: 'desktop-host',
        base64: undefined,
      }],
      persistedContent: undefined,
    });
    expect(downloadToFile).not.toHaveBeenCalled();
  });

  it('keeps queued images on managed URLs instead of rematerializing their source paths', async () => {
    const burnedUrl = 'xdt-image://queued-annotated/annotated.png';
    const selectedUrl = 'xdt-image://queued-selected/selected.png';
    const mediaUrl = `cindy-media://blobs/${'d'.repeat(64)}.png`;
    const originalPath = path.join(tempRoot.value, 'original.png');
    await fs.writeFile(originalPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const item = {
      clientId: 'queued-annotated-image',
      files: [
        {
          category: 'image',
          ext: '.png',
          path: originalPath,
          url: selectedUrl,
          mimeType: 'image/png',
        },
        {
          category: 'image',
          ext: '.png',
          path: originalPath,
          url: mediaUrl,
          mimeType: 'image/png',
        },
        {
          category: 'image',
          ext: '.png',
          path: originalPath,
          url: burnedUrl,
          mimeType: 'image/png',
          annotated: true,
        },
      ],
    };

    const materialized = await materializeQueuedOssAttachmentsDeferred(
      'queued-annotated-image',
      item,
    );

    expect(materialized.item).toBe(item);
    expect(ingestMedia).not.toHaveBeenCalled();
    expect(downloadToFile).not.toHaveBeenCalled();
  });

  it('writes private bytes and removes them even before Maker owns the session', async () => {
    const sessionId = 'reviewer-session';
    const normalized = await normalizeUserMessage(sessionId, {
      type: 'user',
      content: [
        { type: 'text', text: 'Review this image' },
        {
          type: 'image',
          base64: Buffer.from('private image bytes').toString('base64'),
          mimeType: 'image/png',
        },
      ],
    });
    if (typeof normalized === 'string' || typeof normalized.content === 'string') {
      throw new Error('expected block message');
    }
    const imageBlock = normalized.content.find((block) => block.type === 'image');
    const imagePath = imageBlock?.path;
    if (!imageBlock || typeof imagePath !== 'string') {
      throw new Error('expected materialized image path');
    }
    expect(imageBlock.pathOrigin).toBe('desktop-host');
    const sessionTempDir = path.dirname(imagePath);
    const ownerRoot = path.dirname(sessionTempDir);
    const ownerRecord = JSON.parse(
      await fs.readFile(path.join(ownerRoot, '.cindy-owner.json'), 'utf8'),
    ) as Record<string, unknown>;

    await expect(fs.readFile(imagePath, 'utf8')).resolves.toBe('private image bytes');
    expect(ownerRecord).toMatchObject({
      version: 1,
      owner: {
        instanceId: 'normalize-attachments-test-owner',
        processId: process.pid,
      },
    });
    expect(ownerRecord.expiresAt).toEqual(expect.any(Number));
    if (process.platform !== 'win32') {
      expect((await fs.stat(sessionTempDir)).mode & 0o777).toBe(0o700);
      expect((await fs.stat(imagePath)).mode & 0o777).toBe(0o600);
    }

    await cleanupSessionTempAttachments(sessionId);

    await expect(fs.lstat(sessionTempDir)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.lstat(ownerRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    await cleanupSessionTempAttachments(sessionId);
  });

  it('reclaims a persisted owner root after its Main process terminates', async () => {
    const normalized = await normalizeUserMessage('reviewer-crashed', {
      type: 'user',
      content: [{
        type: 'image',
        base64: Buffer.from('private image bytes').toString('base64'),
        mimeType: 'image/png',
      }],
    });
    if (typeof normalized === 'string' || typeof normalized.content === 'string') {
      throw new Error('expected block message');
    }
    const imagePath = normalized.content[0]?.path;
    if (typeof imagePath !== 'string') throw new Error('expected materialized image path');
    const ownerRoot = path.dirname(path.dirname(imagePath));

    await cleanupOrphanedTempAttachments({
      currentOwner: { instanceId: 'restarted-main', processId: process.pid },
      root: path.join(tempRoot.value, 'cindy-attachments'),
    });

    await expect(fs.lstat(ownerRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('coalesces concurrent owner-root creation without dropping either attachment', async () => {
    const makeMessage = (text: string) => ({
      type: 'user' as const,
      content: [{
        type: 'file',
        base64: Buffer.from(text).toString('base64'),
        mimeType: 'text/plain',
      }],
    });
    const [first, second] = await Promise.all([
      normalizeUserMessage('concurrent-a', makeMessage('first')),
      normalizeUserMessage('concurrent-b', makeMessage('second')),
    ]);
    if (
      typeof first === 'string' ||
      typeof first.content === 'string' ||
      typeof second === 'string' ||
      typeof second.content === 'string'
    ) {
      throw new Error('expected block messages');
    }
    const firstPath = first.content[0]?.path;
    const secondPath = second.content[0]?.path;
    expect(typeof firstPath).toBe('string');
    expect(typeof secondPath).toBe('string');
    expect(path.dirname(path.dirname(firstPath as string))).toBe(
      path.dirname(path.dirname(secondPath as string)),
    );

    await Promise.all([
      cleanupSessionTempAttachments('concurrent-a'),
      cleanupSessionTempAttachments('concurrent-b'),
    ]);
  });

  it('keeps an ambiguous live owner until its persisted deadline, then reclaims it', async () => {
    const normalized = await normalizeUserMessage('reviewer-ambiguous', {
      type: 'user',
      content: [{
        type: 'file',
        base64: Buffer.from('private document bytes').toString('base64'),
        mimeType: 'application/pdf',
      }],
    });
    if (typeof normalized === 'string' || typeof normalized.content === 'string') {
      throw new Error('expected block message');
    }
    const filePath = normalized.content[0]?.path;
    if (typeof filePath !== 'string') throw new Error('expected materialized file path');
    const ownerRoot = path.dirname(path.dirname(filePath));
    const record = JSON.parse(
      await fs.readFile(path.join(ownerRoot, '.cindy-owner.json'), 'utf8'),
    ) as { expiresAt: number };
    const sharedRoot = path.join(tempRoot.value, 'cindy-attachments');
    const currentOwner = { instanceId: 'other-live-main', processId: process.pid + 100_000 };

    await cleanupOrphanedTempAttachments({
      currentOwner,
      root: sharedRoot,
      processIsAlive: () => true,
      now: () => record.expiresAt - 1,
    });
    await expect(fs.lstat(ownerRoot)).resolves.toMatchObject({});

    await cleanupOrphanedTempAttachments({
      currentOwner,
      root: sharedRoot,
      processIsAlive: () => true,
      now: () => record.expiresAt,
    });
    await expect(fs.lstat(ownerRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['shared root', 'session directory'] as const)(
    'refuses a symlinked temporary attachment %s',
    async (target) => {
      if (process.platform === 'win32') return;
      const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-review-inline-outside-'));
      tempDirs.push(outside);
      const sharedRoot = path.join(tempRoot.value, 'cindy-attachments');
      if (target === 'shared root') {
        await fs.symlink(outside, sharedRoot);
      } else {
        await fs.mkdir(sharedRoot);
        await normalizeUserMessage('seed-session', {
          type: 'user',
          content: [{
            type: 'file',
            base64: Buffer.from('seed').toString('base64'),
            mimeType: 'text/plain',
          }],
        });
        const [ownerRootName] = await fs.readdir(sharedRoot);
        await fs.symlink(outside, path.join(sharedRoot, ownerRootName, 'reviewer-session'));
      }

      const normalized = await normalizeUserMessage('reviewer-session', {
        type: 'user',
        content: [
          { type: 'text', text: 'Review this image' },
          {
            type: 'image',
            base64: Buffer.from('private image bytes').toString('base64'),
            mimeType: 'image/png',
          },
        ],
      });

      if (typeof normalized === 'string' || typeof normalized.content === 'string') {
        throw new Error('expected block message');
      }
      expect(normalized.content).toEqual([{ type: 'text', text: 'Review this image' }]);
      await expect(fs.readdir(outside)).resolves.toEqual([]);
      if (target === 'session directory') {
        await cleanupSessionTempAttachments('seed-session');
      }
    },
  );
});
