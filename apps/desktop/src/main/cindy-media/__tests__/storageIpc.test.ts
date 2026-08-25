/**
 * storageIpc.test.ts — 存储空间卡片 IPC 业务体单测(第 5 步,规则 14)。
 * 依赖注入的内存 harness 直接调 handler body:内存 SQLite 账本 + os.tmpdir
 * 字节仓 + 假的队列/快照取证。覆盖:stats 统计、scan 的草稿保护贯通、cleanup
 * 全类别执行与执行时重新取证、reconcile 只报不删、查询型失败 fallback。
 */

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { LedgerDb } from '../ledger';

let tmpUserData = '';

vi.mock('electron', () => ({
  app: { getPath: () => tmpUserData },
}));

const schema = await import('../../localDb/schema');
const ledger = await import('../ledger');
const blobStore = await import('../blobStore');
const { createStorageIpcHandlers } = await import('../storageIpc');

const MIGRATION_0070 = path.resolve(__dirname, '../../../../drizzle/0070_woozy_harpoon.sql');
const { default: migration0071 } = (await import('../../../../drizzle/scripts/0071_bright_ultron')) as {
  default: { run: (db: Database.Database) => void };
};

function freshDb(): LedgerDb {
  const raw = new Database(':memory:');
  raw.pragma('foreign_keys = ON');
  const sqlText = fs.readFileSync(MIGRATION_0070, 'utf8');
  for (const stmt of sqlText.split('--> statement-breakpoint')) {
    const trimmed = stmt.trim();
    if (trimmed) raw.exec(trimmed);
  }
  migration0071.run(raw);
  return drizzle(raw, { schema }) as unknown as LedgerDb;
}

let db: LedgerDb;
let legacyRoot = '';

beforeAll(() => {
  tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-storage-ipc-test-'));
});

afterAll(() => {
  fs.rmSync(tmpUserData, { recursive: true, force: true });
});

beforeEach(() => {
  db = freshDb();
  fs.rmSync(path.join(tmpUserData, 'cindy-media'), { recursive: true, force: true });
  legacyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-storage-legacy-'));
});

afterEach(() => {
  fs.rmSync(legacyRoot, { recursive: true, force: true });
});

const OLD_MS = 100 * 60 * 60 * 1000;

async function seedBlob(
  content: string,
  opts?: { isCache?: boolean; aged?: boolean },
): Promise<{ hash: string; ext: string; bytes: number; url: string }> {
  const written = await blobStore.writeBlob({
    buffer: Buffer.from(content),
    mimeType: 'image/png',
  });
  await ledger.recordBlob(
    {
      hash: written.hash,
      ext: written.ext,
      mimeType: written.mimeType,
      bytes: written.bytes,
      isCache: opts?.isCache ?? false,
    },
    db,
  );
  if (opts?.aged) {
    const past = Date.now() - OLD_MS;
    const { eq } = await import('drizzle-orm');
    await db
      .update(schema.mediaBlobs)
      .set({ createdAt: past, lastAccessAt: past })
      .where(eq(schema.mediaBlobs.hash, written.hash))
      .run();
  }
  return written;
}

function makeHandlers(overrides?: {
  queueTexts?: string[];
  snapshotPayloads?: string[];
  registeredDraftUrls?: string[];
  openLegacyImagesDir?: () => Promise<boolean>;
}) {
  return createStorageIpcHandlers({
    getQueueScanTexts: () => overrides?.queueTexts ?? [],
    loadSnapshotPayloads: async () => overrides?.snapshotPayloads ?? [],
    getRegisteredDraftUrls: () => overrides?.registeredDraftUrls ?? [],
    db,
    legacyRootDir: legacyRoot,
    openLegacyImagesDir: overrides?.openLegacyImagesDir ?? (async () => false),
  });
}

describe('stats(占用总览)', () => {
  it('账面统计 + 历史兼容层占用 + 死目录状态', async () => {
    const a = await seedBlob('stats-a');
    const c = await seedBlob('stats-cache', { isCache: true });
    fs.mkdirSync(path.join(legacyRoot, 'feishu-media'), { recursive: true });
    fs.writeFileSync(path.join(legacyRoot, 'feishu-media', 'x.png'), 'legacy');

    const res = await makeHandlers().stats();
    expect(res.success).toBe(true);
    expect(res.blobs.totalCount).toBe(2);
    expect(res.blobs.totalBytes).toBe(a.bytes + c.bytes);
    expect(res.blobs.cacheBytes).toBe(c.bytes);
    expect(res.legacy.bytes).toBe(0); // Settings mount never walks the legacy image root.
    expect(res.deadDirs).toHaveLength(3);
  });
});

describe('scan(清理预检:三个暂存区保护贯通)', () => {
  it('草稿 URL / 内存队列 / 快照 payload 里的指纹全部被保护', async () => {
    const doomed = await seedBlob('scan-doomed', { aged: true });
    const inDraft = await seedBlob('scan-draft', { aged: true });
    const inQueue = await seedBlob('scan-queue', { aged: true });
    const inSnapshot = await seedBlob('scan-snapshot', { aged: true });

    const res = await makeHandlers({
      queueTexts: [JSON.stringify({ images: [{ url: inQueue.url }] })],
      snapshotPayloads: [JSON.stringify([{ chatMessage: { images: [{ url: inSnapshot.url }] } }])],
    }).scan({ draftUrls: [inDraft.url] });

    expect(res.success).toBe(true);
    expect(res.zeroRef.hashes).toEqual([doomed.hash]);
    expect(res.zeroRef.protectedCount).toBe(3);
  });

  it('全窗口草稿登记表里的指纹同样被保护(多窗口:发起窗口带不上别的窗口的草稿)', async () => {
    const doomed = await seedBlob('scan-doomed-2', { aged: true });
    const otherWindow = await seedBlob('scan-other-window', { aged: true });
    const res = await makeHandlers({
      registeredDraftUrls: [otherWindow.url],
    }).scan({ draftUrls: [] });
    expect(res.zeroRef.hashes).toEqual([doomed.hash]);
    expect(res.zeroRef.protectedCount).toBe(1);
  });
});

describe('cleanup(执行:全类别 + 执行时重新取证)', () => {
  it('零引用/缓存逐出/死目录/tmp 一次执行,汇总释放量', async () => {
    const doomed = await seedBlob('clean-doomed', { aged: true });
    const cacheBlob = await seedBlob('clean-cache', { isCache: true });
    const deadDir = path.join(legacyRoot, '@cindy/image-media');
    fs.mkdirSync(deadDir, { recursive: true });
    const deadFile = path.join(deadDir, 'a.png');
    fs.writeFileSync(deadFile, 'dead');
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    fs.utimesSync(deadFile, old, old);

    const result = await makeHandlers().cleanup({
      draftUrls: [],
      zeroRefHashes: [doomed.hash],
      evictCacheHashes: [cacheBlob.hash],
      deadDirNames: ['@cindy/image-media'],
      cleanTmpFiles: false,
    });

    expect(result.zeroRef.deleted).toBe(1);
    expect(result.cacheEvicted.deleted).toBe(1);
    expect(result.deadDirs.removed).toEqual(['@cindy/image-media']);
    expect(result.freedBytes).toBe(doomed.bytes + cacheBlob.bytes + 4);
    expect(fs.existsSync(deadDir)).toBe(false);
  });

  it('执行时草稿里新增的指纹被重新取证保护(不吃 scan 时的旧活引用集)', async () => {
    const b = await seedBlob('clean-late-draft', { aged: true });
    const result = await makeHandlers().cleanup({
      draftUrls: [b.url], // 确认弹出后用户又把这张图粘进了草稿
      zeroRefHashes: [b.hash],
      evictCacheHashes: [],
      deadDirNames: [],
      cleanTmpFiles: false,
    });
    expect(result.zeroRef).toEqual({ deleted: 0, freedBytes: 0, skipped: 1 });
    expect(await ledger.getBlobInfo(b.hash, db)).not.toBeNull();
  });

  it('params 缺失抛 INVALID_PARAMS(规则 13)', async () => {
    await expect(
      makeHandlers().cleanup(undefined as never),
    ).rejects.toThrow(/\[INVALID_PARAMS\]/);
  });
});

describe('reconcile(体检只报不删)', () => {
  it('坏账计数与样例返回,数据不动', async () => {
    const missing = await seedBlob('recon-missing');
    fs.rmSync(
      path.join(
        tmpUserData,
        'cindy-media',
        'blobs',
        missing.hash.slice(0, 2),
        `${missing.hash}${missing.ext}`,
      ),
    );
    const res = await makeHandlers().reconcile();
    expect(res.success).toBe(true);
    expect(res.missingCount).toBe(1);
    expect(res.missingSamples).toEqual([`${missing.hash}${missing.ext}`]);
    // 账本行仍在(只报不删)。
    expect(await ledger.getBlobInfo(missing.hash, db)).not.toBeNull();
  });
});

describe('legacy images directory', () => {
  it('opens only through the fixed-purpose main dependency', async () => {
    const openLegacyImagesDir = vi.fn(async () => true);
    const result = await makeHandlers({ openLegacyImagesDir }).openLegacyImagesDir();

    expect(result).toEqual({ opened: true });
    expect(openLegacyImagesDir).toHaveBeenCalledWith();
  });
});
