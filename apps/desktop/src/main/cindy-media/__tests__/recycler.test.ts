/**
 * recycler.test.ts — 媒体总仓回收器单测(第 5 步)。
 * 内存 SQLite(真实 migration 建表,与生产 schema 同源)+ os.tmpdir 字节仓
 * (规则 23),直测注入 db 的纯函数(规则 14)。
 * 覆盖:活引用取证(三个暂存区)、零引用候选(缓冲期/引用/活引用三重排除)、
 * 安全删除顺序(条件删账→复查→删字节,竞态各分支)、cache LRU 逐出(pin 粘性
 * 与 integration-cache 索引级联)、对账 diff(孤魂/坏账/在途豁免)、tmp 残留清理。
 */

import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
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
const recycler = await import('../recycler');

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

beforeAll(() => {
  tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-recycler-test-'));
});

afterAll(() => {
  fs.rmSync(tmpUserData, { recursive: true, force: true });
});

beforeEach(() => {
  db = freshDb();
  fs.rmSync(path.join(tmpUserData, 'cindy-media'), { recursive: true, force: true });
});

/** 写一个真实 blob(字节仓 + 账本行),返回指纹等。 */
async function seedBlob(
  content: string,
  opts?: { isCache?: boolean; ageMs?: number },
): Promise<{ hash: string; ext: string; bytes: number }> {
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
  if (opts?.ageMs) {
    // 把 createdAt / lastAccessAt 拨回过去(模拟超过缓冲期)。
    const past = Date.now() - opts.ageMs;
    await db
      .update(schema.mediaBlobs)
      .set({ createdAt: past, lastAccessAt: past })
      .run();
  }
  return { hash: written.hash, ext: written.ext, bytes: written.bytes };
}

function blobPath(hash: string, ext: string): string {
  return path.join(tmpUserData, 'cindy-media', 'blobs', hash.slice(0, 2), `${hash}${ext}`);
}

const OLD = 100 * 60 * 60 * 1000; // 100h,超过 72h 缓冲期

describe('extractBlobHashes / collectLiveHashes(活引用取证)', () => {
  it('从任意文本抽取 cindy-media 指纹,三个来源合并', async () => {
    const h1 = 'a'.repeat(64);
    const h2 = 'b'.repeat(64);
    const h3 = 'c'.repeat(64);
    const live = await recycler.collectLiveHashes({
      draftUrls: [`cindy-media://blobs/${h1}.png`, 'xdt-image://old/ignored.png'],
      inMemoryQueueTexts: () => [JSON.stringify({ text: `看图 cindy-media://blobs/${h2}.jpg` })],
      snapshotPayloads: async () => [`[{"images":[{"url":"cindy-media://blobs/${h3}.webp"}]}]`],
    });
    expect(live).toEqual(new Set([h1, h2, h3]));
  });

  it('来源缺省 / 空文本不炸', async () => {
    await expect(recycler.collectLiveHashes({})).resolves.toEqual(new Set());
  });
});

describe('scanZeroRef(零引用候选)', () => {
  it('零引用+过缓冲期才候选;有引用/太新/活引用的排除', async () => {
    const candidate = await seedBlob('candidate', { ageMs: OLD });
    const referenced = await seedBlob('referenced', { ageMs: OLD });
    await ledger.addRef(
      { hash: referenced.hash, refKind: 'session-attachment', refId: 'sess-1' },
      db,
    );
    const fresh = await seedBlob('fresh'); // 刚入库,缓冲期内
    const drafted = await seedBlob('drafted', { ageMs: OLD });

    // seedBlob 的 ageMs update 不带 where,会把先 seed 的 fresh 一起拨老——
    // 把 fresh 的时间刷回现在,保持"缓冲期内"语义。
    const now = Date.now();
    await db
      .update(schema.mediaBlobs)
      .set({ createdAt: now, lastAccessAt: now })
      .where(eq(schema.mediaBlobs.hash, fresh.hash))
      .run();

    const scan = await recycler.scanZeroRef({ live: new Set([drafted.hash]) }, db);
    expect(scan.hashes).toEqual([candidate.hash]);
    expect(scan.count).toBe(1);
    expect(scan.bytes).toBe(candidate.bytes);
    expect(scan.protectedCount).toBe(1); // drafted 被活引用保护
  });
});

describe('deleteZeroRefBlobs(安全删除顺序)', () => {
  it('删账成功后删字节,统计释放量', async () => {
    const b = await seedBlob('doomed', { ageMs: OLD });
    expect(fs.existsSync(blobPath(b.hash, b.ext))).toBe(true);
    const result = await recycler.deleteZeroRefBlobs(
      { hashes: [b.hash], live: new Set() },
      db,
    );
    expect(result).toEqual({ deleted: 1, freedBytes: b.bytes, skipped: 0 });
    expect(fs.existsSync(blobPath(b.hash, b.ext))).toBe(false);
    expect(await ledger.getBlobInfo(b.hash, db)).toBeNull();
  });

  it('执行时才出现的引用让条件删账失败 → 跳过,文件保留', async () => {
    const b = await seedBlob('rescued', { ageMs: OLD });
    // 扫描后、执行前:消息落库挂了引用(模拟用户刚好发送了草稿)。
    await ledger.addRef({ hash: b.hash, refKind: 'session-attachment', refId: 'sess-1' }, db);
    const result = await recycler.deleteZeroRefBlobs(
      { hashes: [b.hash], live: new Set() },
      db,
    );
    expect(result).toEqual({ deleted: 0, freedBytes: 0, skipped: 1 });
    expect(fs.existsSync(blobPath(b.hash, b.ext))).toBe(true);
  });

  it('执行时在活引用集里 → 跳过(重新取证生效)', async () => {
    const b = await seedBlob('draft-live', { ageMs: OLD });
    const result = await recycler.deleteZeroRefBlobs(
      { hashes: [b.hash], live: new Set([b.hash]) },
      db,
    );
    expect(result.skipped).toBe(1);
    expect(fs.existsSync(blobPath(b.hash, b.ext))).toBe(true);
  });

  it('账里已无此指纹 → 跳过不炸', async () => {
    const result = await recycler.deleteZeroRefBlobs(
      { hashes: ['f'.repeat(64)], live: new Set() },
      db,
    );
    expect(result.skipped).toBe(1);
  });
});

describe('scanCache / evictCacheBlobs(cache 瘦身)', () => {
  it('超限时按 LRU 头部凑够超限量;未超限不出候选', async () => {
    const a = await seedBlob('cache-a', { isCache: true });
    const b = await seedBlob('cache-b', { isCache: true });
    // a 最久未用。
    await db.update(schema.mediaBlobs).set({ lastAccessAt: 1000 }).where(eq(schema.mediaBlobs.hash, a.hash)).run();
    await db.update(schema.mediaBlobs).set({ lastAccessAt: 2000 }).where(eq(schema.mediaBlobs.hash, b.hash)).run();

    const total = a.bytes + b.bytes;
    const notOver = await recycler.scanCache({ live: new Set(), limitBytes: total + 1 }, db);
    expect(notOver.excessBytes).toBeLessThanOrEqual(0);
    expect(notOver.evictable).toEqual([]);

    const over = await recycler.scanCache({ live: new Set(), limitBytes: total - 1 }, db);
    expect(over.excessBytes).toBe(1);
    expect(over.evictable.map((e) => e.hash)).toEqual([a.hash]); // LRU 头部一个就够
  });

  it('逐出删账删文件;integration-cache 索引行随 FK 级联消失', async () => {
    const b = await seedBlob('cache-evict', { isCache: true });
    await ledger.addRef(
      { hash: b.hash, refKind: 'integration-cache', refId: 'feishu:tok-1', originKind: 'integration' },
      db,
    );
    const result = await recycler.evictCacheBlobs({ hashes: [b.hash], live: new Set() }, db);
    expect(result.deleted).toBe(1);
    expect(fs.existsSync(blobPath(b.hash, b.ext))).toBe(false);
    // 索引行级联清掉:同 token 下次查询按 miss 重下(自愈复位)。
    expect(await ledger.getIntegrationCacheHash('feishu:tok-1', db)).toBeNull();
  });

  it('被非 cache 业务引用(pin 语义)的 blob 拒绝逐出——双保险', async () => {
    const b = await seedBlob('cache-pinned', { isCache: true });
    // 模拟 pin 链路漏了 isCache 降级、但消息引用已挂上的最坏情况。
    await ledger.addRef(
      { hash: b.hash, refKind: 'message', refId: 'msg-1', originSessionId: 'sess-1' },
      db,
    );
    const result = await recycler.evictCacheBlobs({ hashes: [b.hash], live: new Set() }, db);
    expect(result).toEqual({ deleted: 0, freedBytes: 0, skipped: 1 });
    expect(fs.existsSync(blobPath(b.hash, b.ext))).toBe(true);
  });

  it('pinBlob 降级后(isCache=false)不再出现在 cache 候选里', async () => {
    const b = await seedBlob('cache-downgraded', { isCache: true });
    await ledger.pinBlob(b.hash, db);
    const scan = await recycler.scanCache({ live: new Set(), limitBytes: 0 }, db);
    expect(scan.evictable.find((e) => e.hash === b.hash)).toBeUndefined();
  });
});

describe('reconcile(对账:只报不删)', () => {
  it('孤魂文件(盘有账无,超 1h)与坏账(账有盘无)都能报出;在途新文件豁免', async () => {
    // 孤魂:直接写字节仓不记账,并把 mtime 拨老。
    const orphan = await blobStore.writeBlob({ buffer: Buffer.from('orphan'), mimeType: 'image/png' });
    const orphanAbs = blobPath(orphan.hash, orphan.ext);
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    fs.utimesSync(orphanAbs, old, old);

    // 在途:写字节不记账但 mtime 是现在 → 豁免。
    const inflight = await blobStore.writeBlob({ buffer: Buffer.from('inflight'), mimeType: 'image/png' });

    // 坏账:记账后手动删文件。
    const missing = await seedBlob('missing');
    fs.rmSync(blobPath(missing.hash, missing.ext));

    const report = await recycler.reconcile(db);
    expect(report.orphanFiles.map((o) => o.absPath)).toEqual([orphanAbs]);
    expect(report.missingFiles.map((m) => m.hash)).toEqual([missing.hash]);
    expect(report.orphanFiles.find((o) => o.absPath.includes(inflight.hash))).toBeUndefined();
    // 数据一个都没动:孤魂文件仍在。
    expect(fs.existsSync(orphanAbs)).toBe(true);
  });
});

describe('cleanupTmpFiles(.tmp 残留)', () => {
  it('只删超龄的 .tmp-*,新的留给在途写入', async () => {
    const seeded = await seedBlob('tmp-host');
    const dir = path.dirname(blobPath(seeded.hash, seeded.ext));
    const oldTmp = path.join(dir, '.tmp-old');
    const newTmp = path.join(dir, '.tmp-new');
    fs.writeFileSync(oldTmp, 'x');
    fs.writeFileSync(newTmp, 'y');
    const past = new Date(Date.now() - 48 * 60 * 60 * 1000);
    fs.utimesSync(oldTmp, past, past);

    const removed = await blobStore.cleanupTmpFiles(recycler.TMP_FILE_MAX_AGE_MS);
    expect(removed).toBe(1);
    expect(fs.existsSync(oldTmp)).toBe(false);
    expect(fs.existsSync(newTmp)).toBe(true);
  });
});
