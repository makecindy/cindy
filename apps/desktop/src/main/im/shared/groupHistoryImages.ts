import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import type { TelegramHistoryImageRef } from '@cindy/im';
import { resolveSafe } from '../../cindy-media/blobStore.desktop';
import { getBlobInfo } from '../../cindy-media/ledger';
import { integrationCacheGet, integrationCachePut } from '../../cindy-media/integrationCache';
import { getCurrentDbClientSnapshot } from '../../localDb/client/current';
import { readOfficialGroupImage } from '../../hook-control/groupImageBridge';
import { verifiedInboundMediaMime } from './inboundMediaVerify';
import type { GroupHistorySearchLane } from './groupHistorySearch';
import type { GroupHistoryAccessScope } from './groupHistoryAccess';

export interface GroupHistoryImageReadArgs {
  lane: GroupHistorySearchLane;
  messageId: string;
  ref: TelegramHistoryImageRef;
  scope: GroupHistoryAccessScope;
  isCurrent: () => boolean;
}

const MAX_HISTORY_IMAGE_BYTES = 20 * 1024 * 1024;

async function loadGroupHistoryImage(
  args: GroupHistoryImageReadArgs,
  needBytes: boolean,
): Promise<{ absPath: string; mimeType: string; bytes?: Buffer } | null> {
  const snapshot = getCurrentDbClientSnapshot();
  if (!snapshot) return null;
  const assertCurrent = () => {
    if (!args.isCurrent() || getCurrentDbClientSnapshot() !== snapshot)
      throw new Error('HISTORY_SCOPE_EXPIRED');
  };
  assertCurrent();
  if (args.ref.fileId.startsWith('cindy-media://')) {
    const resolved = resolveSafe(args.ref.fileId);
    // Physical blobs are shared; only the captured account's ledger authorizes access.
    const info = await getBlobInfo(resolved.hash, snapshot.client.drizzle);
    assertCurrent();
    if (!info || !/^image\/(png|jpeg|gif|webp)$/.test(resolved.mimeType)) return null;
    try {
      const fileSize = (await stat(resolved.absPath)).size;
      if (fileSize <= 0 || fileSize > MAX_HISTORY_IMAGE_BYTES) return null;
      const bytes = await readFile(resolved.absPath);
      assertCurrent();
      if (!bytes.length || bytes.length > MAX_HISTORY_IMAGE_BYTES) return null;
      return {
        absPath: resolved.absPath,
        mimeType: verifiedInboundMediaMime(bytes, resolved.mimeType, 'image'),
        ...(needBytes ? { bytes } : {}),
      };
    } catch (error) {
      assertCurrent();
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }
  // Cache lookup uses the captured account DB; key includes bot, topic and message identity.
  const cacheKey =
    'telegram-history:' +
    createHash('sha256')
      .update(
        JSON.stringify([args.lane, args.messageId, args.ref.fileId, args.ref.downloadToken ?? '']),
      )
      .digest('hex');
  const cached = await integrationCacheGet(cacheKey, snapshot.client.drizzle);
  assertCurrent();
  if (cached) {
    try {
      const fileSize = (await stat(cached.absPath)).size;
      if (fileSize <= 0 || fileSize > MAX_HISTORY_IMAGE_BYTES) return null;
      if (!needBytes) {
        return { absPath: cached.absPath, mimeType: cached.mimeType };
      }
      const bytes = await readFile(cached.absPath);
      assertCurrent();
      if (bytes.length > 0 && bytes.length <= MAX_HISTORY_IMAGE_BYTES)
        return { absPath: cached.absPath, mimeType: cached.mimeType, bytes };
      return null;
    } catch (error) {
      assertCurrent();
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      // Reclamation can delete the blob after the cache existence check.
    }
  }
  const bytes =
    args.lane.provider.startsWith('telegram:') && args.ref.downloadToken
      ? await readOfficialGroupImage(args.lane, args.ref.downloadToken)
      : args.lane.provider === args.scope.provider && args.scope.readImage
        ? await args.scope.readImage(args.ref.fileId)
        : null;
  assertCurrent();
  if (!bytes || bytes.length === 0 || bytes.length > MAX_HISTORY_IMAGE_BYTES) return null;
  const mimeType = verifiedInboundMediaMime(bytes, args.ref.mimeType, 'image');
  const stored = await integrationCachePut(
    {
      cacheKey,
      integration: 'telegram-history',
      buffer: bytes,
      mimeType,
      isCache: true,
      assertStillValid: assertCurrent,
    },
    snapshot.client.drizzle,
  );
  if (!args.isCurrent() || getCurrentDbClientSnapshot() !== snapshot) {
    await stored.rollbackRef();
    return null;
  }
  return { absPath: stored.absPath, mimeType, ...(needBytes ? { bytes } : {}) };
}

/** Resolve an authorized group history image to a cached local cindy-media blob file path. */
export async function resolveGroupHistoryImageFile(
  args: GroupHistoryImageReadArgs,
): Promise<{ absPath: string; mimeType: string } | null> {
  const loaded = await loadGroupHistoryImage(args, false);
  return loaded ? { absPath: loaded.absPath, mimeType: loaded.mimeType } : null;
}

export async function readGroupHistoryImage(
  args: GroupHistoryImageReadArgs,
): Promise<{ data: string; mimeType: string } | null> {
  const loaded = await loadGroupHistoryImage(args, true);
  return loaded?.bytes ? { data: loaded.bytes.toString('base64'), mimeType: loaded.mimeType } : null;
}
