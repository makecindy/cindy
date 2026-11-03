import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildAttachmentOssRef, buildPeerAttachmentRef } from '@cindy/device-link';
import type { LedgerDb } from '../../cindy-media/ledger';

const state = vi.hoisted(() => ({
  root: '',
  owner: 'alice',
  generation: 1,
  db: undefined as LedgerDb | undefined,
}));
const peer = vi.hoisted(() => vi.fn());
const fetchMedia = vi.hoisted(() => vi.fn());
vi.mock('../filePeer', () => ({ tryPeerFile: peer }));
vi.mock('../mediaTransfer', () => ({ removeRemote: vi.fn() }));
vi.mock('electron', () => ({ app: { getPath: () => state.root }, net: { fetch: fetchMedia } }));
vi.mock('../../appSessionState', () => ({
  getActiveAppSession: () => ({ mode: 'cloud', dataOwnerId: state.owner }),
  activeOwnerScopeKey: () => `${state.owner}:${state.generation}`,
  ownerScopedUserDataPath: () => state.root,
}));
vi.mock('../../localDb/client/current', () => ({ getDbClient: () => ({ drizzle: state.db }) }));
vi.mock('../broadcast-tap', () => ({
  captureDataOwnerBroadcastScope: () => state.generation,
  isDataOwnerBroadcastScopeCurrent: (generation: number) => generation === state.generation,
}));

import * as schema from '../../localDb/schema';
import { listAllBlobRecords, listCacheBlobsByLru } from '../../cindy-media/ledger';
import { resolveHashRef } from '../../cindy-media/blobStore';
import * as blobStore from '../../cindy-media/blobStore';
import { evictCacheBlobs, scanCache } from '../../cindy-media/recycler';
import { createStorageIpcHandlers } from '../../cindy-media/storageIpc';
import {
  invalidateRemoteMediaPersistentWrites,
  createSentImageRetainer,
  remoteMediaPersistentCache,
} from '../remoteMediaPersistentCache';
import { remoteFileVersionCache } from '../remoteFileVersionCache';
import { readRemoteDeviceFile } from '../fileAccess';
import { createChatMedia } from '../../maker-ipc/chatServerMedia';
import type { ChatApi } from '../../maker-ipc/chatServerMigration';

const { default: migration0071 } =
  (await import('../../../../drizzle/scripts/0071_bright_ultron')) as {
    default: { run: (db: Database.Database) => void };
  };
let raw: Database.Database;
const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const url = `cindy-media://blobs/${createHash('sha256').update(png).digest('hex')}.png`;
const chatEndpoint = 'https://chat.example.test';
const chatMetadata = () => ({ name: 'image.png', type: 'image/png', size: png.length,
  url: 'https://download.example.test/signed' });
function reopen() {
  raw = new Database(path.join(state.root, 'ledger.db'));
  raw.pragma('foreign_keys = ON');
  state.db = drizzle(raw, { schema }) as unknown as LedgerDb;
}
beforeEach(async () => {
  peer.mockReset();
  fetchMedia.mockReset().mockImplementation(async () => new Response(new Uint8Array(png)));
  state.root = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-image-cache-'));
  state.owner = 'alice';
  state.generation = 1;
  reopen();
  const sql = await fs.readFile(
    path.resolve(__dirname, '../../../../drizzle/0070_woozy_harpoon.sql'),
    'utf8',
  );
  for (const statement of sql.split('--> statement-breakpoint'))
    if (statement.trim()) raw.exec(statement);
  migration0071.run(raw);
});

// Regression: reopening a group/topic/direct chat downloaded every image again because
// createChatMedia only indexed server media IDs in memory. Existing tests covered device
// transfers, not Chat Server IDs. Minimum input: one image, then recreate the service and
// reopen its real SQLite ledger (unit tier with an isolated temporary DB, no real network).
it('reuses a Chat Server image across service and database restart without downloading its bytes again', async () => {
  const api = vi.fn(async () => ({ name: 'image.png', type: 'image/png', size: png.length,
    url: 'https://download.example.test/first-signature' })) as unknown as ChatApi;
  const first = await createChatMedia(api, () => true, 'https://chat.example.test').download('room', 'media');
  raw.close(); state.generation++; reopen();
  vi.mocked(api).mockResolvedValue({ name: 'image.png', type: 'image/png', size: png.length,
    url: 'https://download.example.test/new-signature' });
  const restored = await createChatMedia(api, () => true, 'https://chat.example.test').download('room', 'media');
  expect(restored).toEqual(first);
  expect(fetchMedia).toHaveBeenCalledTimes(1);
  expect(api).toHaveBeenCalledTimes(2); // Permission is still checked before local reuse.
  expect(await listCacheBlobsByLru(state.db, 'remote-media')).toHaveLength(1);
});

it('retains the actual Chat Server upload so reopening its sent image needs no download', async () => {
  const source = path.join(state.root, 'upload.png');
  await fs.writeFile(source, png);
  const api = vi.fn(async (route: string, method?: string) => method !== 'POST' ? chatMetadata()
    : route.endsWith('/complete') ? {} : { id: 'media', uploadUrl: 'https://upload.example.test/signed' }) as unknown as ChatApi;
  const service = createChatMedia(api, () => true, chatEndpoint);
  expect(await service.upload('room', 'operation', [{ id: 'file', name: 'image.png', mimeType: 'image/png',
    size: png.length, category: 'image', path: source, url: null }], 'actor'))
    .toEqual([{ type: 'media', mediaId: 'media', caption: 'image.png' }]);
  await fs.writeFile(source, Buffer.alloc(png.length));
  raw.close(); state.generation++; reopen();
  expect((await createChatMedia(api, () => true, chatEndpoint).download('room', 'media')).url).toBe(url);
  expect(fetchMedia).toHaveBeenCalledTimes(1); // PUT only, never GET.
  expect(fetchMedia.mock.calls[0][1].method).toBe('PUT');
});

it.each(['account', 'endpoint', 'room', 'media'] as const)('isolates Chat Server images by %s and still refuses revoked access', async (scope) => {
  const api = vi.fn(async () => chatMetadata()) as unknown as ChatApi;
  await createChatMedia(api, () => true, chatEndpoint).download('room', 'media');
  if (scope === 'account') { state.owner = 'bob'; state.generation++; }
  const service = createChatMedia(api, () => true, scope === 'endpoint' ? 'https://other.example.test' : chatEndpoint);
  const room = scope === 'room' ? 'other-room' : 'room';
  const mediaId = scope === 'media' ? 'other-media' : 'media';
  await service.download(room, mediaId);
  expect(fetchMedia).toHaveBeenCalledTimes(2);
  vi.mocked(api).mockRejectedValue(new Error('CONVERSATION_NOT_FOUND'));
  await expect(service.download(room, mediaId)).rejects.toThrow('CONVERSATION_NOT_FOUND');
  expect(fetchMedia).toHaveBeenCalledTimes(2);
});

it.each(['missing', 'corrupt'] as const)('repairs a %s Chat Server image without restarting the service', async (damage) => {
  const service = createChatMedia(vi.fn(async () => chatMetadata()) as unknown as ChatApi, () => true, chatEndpoint);
  await service.download('room', 'media');
  const [record] = await listAllBlobRecords(state.db);
  const file = resolveHashRef(record.hash, record.ext).absPath;
  if (damage === 'missing') await fs.rm(file);
  else await fs.writeFile(file, Buffer.alloc(png.length));
  expect((await service.download('room', 'media')).url).toBe(url);
  expect(fetchMedia).toHaveBeenCalledTimes(2);
  expect(await fs.readFile(file)).toEqual(png);
});

it('keeps Chat Server images out of automatic file eviction and lets manual image cleanup remove them', async () => {
  const service = createChatMedia(vi.fn(async () => chatMetadata()) as unknown as ChatApi, () => true, chatEndpoint);
  await service.download('room', 'media');
  const [record] = await listAllBlobRecords(state.db);
  expect((await scanCache({ live: new Set(), limitBytes: 0, integration: 'remote-file' }, state.db)).evictable).toEqual([]);
  expect((await scanCache({ live: new Set(), limitBytes: 0 }, state.db)).evictable).toEqual([]);
  expect((await evictCacheBlobs({ hashes: [record.hash], live: new Set() }, state.db)).deleted).toBe(0);
  const generation = service.cacheGeneration;
  invalidateRemoteMediaPersistentWrites();
  expect((await evictCacheBlobs({ hashes: [record.hash], live: new Set(), integration: 'remote-media' }, state.db)).deleted).toBe(1);
  expect(service.cacheGeneration).not.toBe(generation);
  expect((await service.download('room', 'media')).url).toBe(url);
  expect(fetchMedia).toHaveBeenCalledTimes(2);
});

// PR #7442: a lookup started after cleanup's initial invalidation could publish a
// stale hit or recreate the cleared index. Unit timing regression through the real
// cleanup handler + downloader; existing cases only started reads before cleanup.
it.each(['success', 'failure'] as const)('rejects an image lookup started during cleanup after its %s', async outcome => {
  const api = vi.fn(async () => chatMetadata()) as unknown as ChatApi;
  const service = createChatMedia(api, () => true, chatEndpoint);
  await service.download('room', 'media');
  const [record] = await listAllBlobRecords(state.db);
  let releaseScan!: () => void;
  const scanBarrier = new Promise<void>(resolve => { releaseScan = resolve; });
  const handlers = createStorageIpcHandlers({ db: state.db, getQueueScanTexts: () => [],
    loadSnapshotPayloads: async () => {
      await scanBarrier;
      if (outcome === 'failure') throw new Error('scan failed');
      return [];
    } });
  const cleanup = handlers.cleanup({ scope: 'remote-media', draftUrls: [], zeroRefHashes: [],
    evictCacheHashes: [record.hash], deadDirNames: [], cleanTmpFiles: false })
    .then(() => null, error => error);
  let releaseMetadata!: (value: ReturnType<typeof chatMetadata>) => void;
  vi.mocked(api).mockReturnValueOnce(new Promise(resolve => { releaseMetadata = resolve; }));
  const pending = service.download('room', 'media');
  releaseScan();
  const cleanupError = await cleanup;
  if (outcome === 'failure') expect(cleanupError).toBeInstanceOf(Error);
  else expect(cleanupError).toBeNull();
  releaseMetadata(chatMetadata());
  await expect(pending).rejects.toThrow('REMOTE_MEDIA_CACHE_CLEARED');
  expect(fetchMedia).toHaveBeenCalledTimes(1);
  expect(await listAllBlobRecords(state.db)).toHaveLength(outcome === 'success' ? 0 : 1);
});

// PR #7442: end-generation invalidation misses writes committed during a multi-blob
// clear. Unit regression: pause real cleanup after deleting its first file, complete
// another cleanup, then try both the Chat Server read and the persistent put entry.
it('fences reads and writes until every overlapping cleanup finishes', async () => {
  const service = createChatMedia(vi.fn(async () => chatMetadata()) as unknown as ChatApi, () => true, chatEndpoint);
  await service.download('room', 'media');
  const [first] = await listAllBlobRecords(state.db);
  const secondBytes = Buffer.concat([png, Buffer.from([1])]);
  const secondHash = createHash('sha256').update(secondBytes).digest('hex');
  const secondUrl = `cindy-media://blobs/${secondHash}.png`;
  await remoteMediaPersistentCache('computer', secondUrl)!.put(secondBytes, 'image/png');
  let deletedFirst!: () => void;
  const firstDeleted = new Promise<void>(resolve => { deletedFirst = resolve; });
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const deleteFile = blobStore.deleteBlobFile;
  const deleting = vi.spyOn(blobStore, 'deleteBlobFile').mockImplementation(async (...args) => {
    await deleteFile(...args);
    if (args[0] === first.hash) { deletedFirst(); await barrier; }
  });
  const handlers = createStorageIpcHandlers({ db: state.db, getQueueScanTexts: () => [], loadSnapshotPayloads: async () => [] });
  const params = { scope: 'remote-media' as const, draftUrls: [], zeroRefHashes: [],
    evictCacheHashes: [first.hash, secondHash], deadDirNames: [], cleanTmpFiles: false };
  const cleanup = handlers.cleanup(params);
  try {
    await firstDeleted;
    await handlers.cleanup({ ...params, evictCacheHashes: [] });
    await expect(service.download('room', 'media')).rejects.toThrow('REMOTE_MEDIA_CACHE_CLEARED');
    await expect(remoteMediaPersistentCache('computer', url)!.put(png, 'image/png'))
      .rejects.toThrow('REMOTE_MEDIA_CACHE_CLEARED');
    expect(fetchMedia).toHaveBeenCalledTimes(1);
  } finally {
    release();
    await cleanup.finally(() => deleting.mockRestore());
  }
  expect(await listAllBlobRecords(state.db)).toEqual([]);
  expect((await service.download('room', 'media')).url).toBe(url);
  expect(fetchMedia).toHaveBeenCalledTimes(2);
});

// PR #7442 review: ordinary attachments have no persistent image index. Two reads of
// one PDF must retain the original service-local reuse, including across image cleanup.
// This unit fixture exercises the real downloader/filesystem; previous cases only used PNG.
it('reuses ordinary Chat Server files across reads and image cleanup while rechecking access', async () => {
  const pdf = Buffer.from('%PDF-1.4 test');
  fetchMedia.mockImplementation(async () => new Response(new Uint8Array(pdf)));
  const api = vi.fn(async () => ({ ...chatMetadata(), name: 'report.pdf', type: 'application/pdf', size: pdf.length })) as unknown as ChatApi;
  const service = createChatMedia(api, () => true, chatEndpoint);
  const first = await service.download('room', 'file');
  expect(await service.download('room', 'file')).toEqual(first);
  expect(fetchMedia).toHaveBeenCalledTimes(1);
  invalidateRemoteMediaPersistentWrites();
  expect(await service.download('room', 'file')).toEqual(first);
  expect(await fs.readFile(first.path!)).toEqual(pdf);
  expect(fetchMedia).toHaveBeenCalledTimes(1);
  vi.mocked(api).mockRejectedValueOnce(new Error('CONVERSATION_NOT_FOUND'));
  await expect(service.download('room', 'file')).rejects.toThrow('CONVERSATION_NOT_FOUND');
  expect(api).toHaveBeenCalledTimes(4);
});

it('does not cancel an ordinary file transfer when the image cache is cleared', async () => {
  const pdf = Buffer.from('%PDF-1.4 test');
  fetchMedia.mockImplementationOnce(async () => {
    invalidateRemoteMediaPersistentWrites();
    return new Response(new Uint8Array(pdf));
  });
  const api = vi.fn(async () => ({ ...chatMetadata(), name: 'report.pdf', type: 'application/pdf', size: pdf.length })) as unknown as ChatApi;
  const service = createChatMedia(api, () => true, chatEndpoint);
  const file = await service.download('room', 'file');
  expect(await fs.readFile(file.path!)).toEqual(pdf);
  expect(await service.download('room', 'file')).toEqual(file);
  expect(fetchMedia).toHaveBeenCalledTimes(1);
});

it.each(['account', 'clear'] as const)('rejects a Chat Server image arriving after %s changes', async (change) => {
  const changeScope = () => {
    if (change === 'account') { state.owner = 'bob'; state.generation++; }
    else invalidateRemoteMediaPersistentWrites();
  };
  fetchMedia.mockImplementationOnce(async () => { changeScope(); return new Response(new Uint8Array(png)); });
  const service = createChatMedia(vi.fn(async () => chatMetadata()) as unknown as ChatApi, () => state.owner === 'alice', chatEndpoint);
  await expect(service.download('room', 'media')).rejects.toThrow();
  expect(await listAllBlobRecords(state.db)).toEqual([]);
});

it('does not turn a sealed Chat Server upload into a failed send when image storage is cleared', async () => {
  fetchMedia.mockImplementationOnce(async () => { invalidateRemoteMediaPersistentWrites(); return new Response(''); });
  const api = vi.fn(async () => ({ id: 'media', uploadUrl: 'https://upload.example.test/signed' })) as unknown as ChatApi;
  await expect(createChatMedia(api, () => true, chatEndpoint).upload('room', 'operation', [{ id: 'file', name: 'image.png',
    mimeType: 'image/png', size: png.length, category: 'image', path: null, url: null, readBytes: async () => png }], 'actor'))
    .resolves.toEqual([{ type: 'media', mediaId: 'media', caption: 'image.png' }]);
  expect(await listAllBlobRecords(state.db)).toEqual([]);
});

it.each(['prepare', 'peer-queue'])('does not recreate the disk index after clearing during %s', async (phase) => {
  const metadata = { ossKey: '', transferRequired: true, version: 'b'.repeat(64), size: png.length, mimeType: 'image/png' };
  const invoke = vi.fn(async () => {
    if (phase === 'prepare') invalidateRemoteMediaPersistentWrites();
    return { ok: true, result: metadata };
  });
  peer.mockImplementationOnce(async (device, source, _invoke, _signal, _progress, captured) => {
    if (phase === 'peer-queue') invalidateRemoteMediaPersistentWrites();
    // The cache adapter is created only after the delayed host reply / queue slot.
    const cache = remoteFileVersionCache(device, source, captured)!;
    await expect(cache.put(png)).rejects.toThrow('REMOTE_MEDIA_CACHE_CLEARED');
    return { ...metadata, path: '/consumer-copy', dispose: async () => {} };
  });
  await readRemoteDeviceFile('computer', url, invoke);
  expect(peer).toHaveBeenCalledOnce();
  expect(await listCacheBlobsByLru(state.db, 'remote-media')).toEqual([]);
});
afterEach(async () => {
  raw.close();
  await fs.rm(state.root, { recursive: true, force: true });
});

it('reuses image bytes after closing and reopening the database, across login generations', async () => {
  await remoteMediaPersistentCache('computer', url)!.put(png, 'image/png');
  raw.close();
  state.generation++;
  reopen();
  const cached = await remoteMediaPersistentCache('computer', url)!.get(1024);
  expect(cached?.bytes).toEqual(png);
  expect((await listCacheBlobsByLru(state.db, 'remote-media')).length).toBe(1);
});

// Existing DB-tier coverage only persisted downloaded images. Sent bytes must populate
// that same index before any read from the host, and survive process/database restart.
it.each(['oss', 'peer'] as const)('retains a sent %s image by the final content address across restart', async (transport) => {
  const metadata = { sha256: createHash('sha256').update(png).digest('hex'), size: png.length, mimeType: 'image/png' };
  const ref = transport === 'oss' ? buildAttachmentOssRef({ ...metadata, ossKey: 'uploads/image' })
    : buildPeerAttachmentRef({ ...metadata, ticket: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' });
  const source = path.join(state.root, 'sent.png');
  await fs.writeFile(source, png);
  await createSentImageRetainer('computer')(transport === 'oss' ? png : source, ref);
  await fs.rm(source);
  raw.close();
  state.generation++;
  reopen();
  expect((await remoteMediaPersistentCache('computer', url)!.get(1024))?.bytes).toEqual(png);
  expect(await remoteMediaPersistentCache('another-computer', url)!.get(1024)).toBeNull();
});

it.each(['switch-account', 'clear-cache', 'changed-source'] as const)('does not retain stale sent pixels after %s', async (change) => {
  const retain = createSentImageRetainer('computer');
  const ref = buildAttachmentOssRef({ ossKey: 'uploads/image', size: png.length,
    sha256: createHash('sha256').update(png).digest('hex'), mimeType: 'image/png' });
  if (change === 'switch-account') { state.owner = 'bob'; state.generation++; }
  if (change === 'clear-cache') invalidateRemoteMediaPersistentWrites();
  const pending = retain(change === 'changed-source' ? Buffer.alloc(png.length) : png, ref);
  if (change === 'changed-source') await pending;
  else await expect(pending).rejects.toThrow();
  expect(await listCacheBlobsByLru(state.db, 'remote-media')).toEqual([]);
});

it('direct transfers and preview downloads share one persistent index and cleanup category', async () => {
  const direct = remoteFileVersionCache('computer', url, {
    version: 'b'.repeat(64),
    size: png.length,
    mimeType: 'image/png',
  })!;
  await direct.put(png);
  expect((await remoteMediaPersistentCache('computer', url)!.get(1024))?.bytes).toEqual(png);
  await remoteMediaPersistentCache('computer', url)!.put(png, 'image/png');
  expect(await listCacheBlobsByLru(state.db, 'remote-file')).toEqual([]);
  expect(await listCacheBlobsByLru(state.db, 'remote-media')).toHaveLength(1);
  expect(await direct.get()).not.toBeNull();
});

it('isolates device, account and original URL even when their bytes are identical', async () => {
  await remoteMediaPersistentCache('computer', url)!.put(png, 'image/png');
  expect(await remoteMediaPersistentCache('other-computer', url)!.get(1024)).toBeNull();
  expect(
    await remoteMediaPersistentCache('computer', 'xdt-image://history/image.png')!.get(1024),
  ).toBeNull();
  state.owner = 'bob';
  state.generation++;
  expect(await remoteMediaPersistentCache('computer', url)!.get(1024)).toBeNull();
});

it('detects a corrupt local file and refuses oversized cache reads', async () => {
  const cache = remoteMediaPersistentCache('computer', url)!;
  await cache.put(png, 'image/png');
  expect(await cache.get(1)).toBeNull();
  const [record] = await listAllBlobRecords(state.db);
  const file = resolveHashRef(record.hash, record.ext).absPath;
  await fs.writeFile(file, Buffer.alloc(png.length));
  expect(await cache.get(1024)).toBeNull();
  const direct = remoteFileVersionCache('computer', url, {
    version: 'b'.repeat(64), size: png.length, mimeType: 'image/png',
  })!;
  expect(await direct.get()).toBeNull();
  await direct.put(png);
  expect(await direct.get()).toBe(file);
  expect((await cache.get(1024))?.bytes).toEqual(png);
  await fs.rm(file);
  expect(await cache.get(1024)).toBeNull();
});

it('does not persist arbitrary paths, false image MIME, or mismatched content addresses', async () => {
  expect(remoteMediaPersistentCache('computer', 'xdt-file://local/?path=/image.png')).toBeNull();
  await remoteMediaPersistentCache('computer', url)!.put(Buffer.from('not an image'), 'image/png');
  await remoteMediaPersistentCache('computer', `cindy-media://blobs/${'a'.repeat(64)}.png`)!.put(
    png,
    'image/png',
  );
  expect(await listAllBlobRecords(state.db)).toEqual([]);
});

it('drops a late write after account switching without adding a cache index', async () => {
  const pending = remoteMediaPersistentCache('computer', url)!.put(png, 'image/png');
  state.owner = 'bob';
  state.generation++;
  await expect(pending).rejects.toThrow('FILE_PEER_CANCELLED');
  expect(await listCacheBlobsByLru(state.db, 'remote-media')).toEqual([]);
});

it('does not refill a cache that was cleared during its background write', async () => {
  const pending = remoteMediaPersistentCache('computer', url)!.put(png, 'image/png');
  invalidateRemoteMediaPersistentWrites();
  await expect(pending).rejects.toThrow('REMOTE_MEDIA_CACHE_CLEARED');
  expect(await listCacheBlobsByLru(state.db, 'remote-media')).toEqual([]);
});
