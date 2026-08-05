/**
 * integrationCache.test.ts — 集成缓存媒体总仓存取口单测。
 * 覆盖:put→get 往返(token 命中免重下)、isCache 记账、同 key 幂等、
 * token 复用换内容取最新、坏账(有账无文件)按 miss 自愈、未登记 miss。
 * 文件落 os.tmpdir() 收尾清理(规则 23);账本内存 SQLite + 真实 migration。
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { LedgerDb } from '../ledger';

let tmpUserData = '';

vi.mock('electron', () => ({
  app: { getPath: () => tmpUserData },
}));

const schema = await import('../../localDb/schema');
const integrationCache = await import('../integrationCache');

const MIGRATION_0070 = path.resolve(__dirname, '../../../../drizzle/0070_woozy_harpoon.sql');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const migration0071 = require('../../../../drizzle/scripts/0071_bright_ultron.ts') as {
  run: (db: Database.Database) => void;
};

const BYTES_A = Buffer.from('feishu-image-bytes-a');
const HASH_A = createHash('sha256').update(BYTES_A).digest('hex');
const BYTES_B = Buffer.from('feishu-image-bytes-b');
const HASH_B = createHash('sha256').update(BYTES_B).digest('hex');

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
  tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'integration-cache-test-'));
});

afterAll(() => {
  fs.rmSync(tmpUserData, { recursive: true, force: true });
});

beforeEach(() => {
  db = freshDb();
});

const KEY = integrationCache.integrationCacheKey('Feishu', 'img_v3_token_abc');

describe('integrationCacheKey', () => {
  it('集成名归一小写,token 原样', () => {
    expect(KEY).toBe('feishu:img_v3_token_abc');
  });
});

describe('put → get 往返(token 命中免重下)', () => {
  it('put 后 get 命中同一文件;blob 记 isCache=true;索引行 originKind=integration', async () => {
    const put = await integrationCache.integrationCachePut(
      { cacheKey: KEY, integration: 'feishu', buffer: BYTES_A, mimeType: 'image/png' },
      db,
    );
    expect(put.url).toBe(`cindy-media://blobs/${HASH_A}.png`);

    const hit = await integrationCache.integrationCacheGet(KEY, db);
    expect(hit).not.toBeNull();
    expect(hit?.hash).toBe(HASH_A);
    expect(hit?.absPath).toBe(put.absPath);
    expect(fs.existsSync(hit!.absPath)).toBe(true);

    const blobs = db.select().from(schema.mediaBlobs).all();
    expect(blobs[0].isCache).toBe(true);
    const refs = db.select().from(schema.mediaRefs).all();
    expect(refs).toHaveLength(1);
    expect(refs[0].refKind).toBe('integration-cache');
    expect(refs[0].refId).toBe(KEY);
    expect(refs[0].originKind).toBe('integration');
    expect(refs[0].originId).toBe('feishu');
  });

  it('同 key 同内容重复 put:索引行幂等不累积', async () => {
    await integrationCache.integrationCachePut(
      { cacheKey: KEY, integration: 'feishu', buffer: BYTES_A, mimeType: 'image/png' },
      db,
    );
    await integrationCache.integrationCachePut(
      { cacheKey: KEY, integration: 'feishu', buffer: BYTES_A, mimeType: 'image/png' },
      db,
    );
    expect(db.select().from(schema.mediaRefs).all()).toHaveLength(1);
  });

  it('token 复用换内容:追加索引行,get 取最新指纹', async () => {
    await integrationCache.integrationCachePut(
      { cacheKey: KEY, integration: 'feishu', buffer: BYTES_A, mimeType: 'image/png' },
      db,
    );
    // 人为拉开 createdAt(同毫秒下 orderBy 不稳定)
    await new Promise((r) => setTimeout(r, 5));
    await integrationCache.integrationCachePut(
      { cacheKey: KEY, integration: 'feishu', buffer: BYTES_B, mimeType: 'image/png' },
      db,
    );
    const hit = await integrationCache.integrationCacheGet(KEY, db);
    expect(hit?.hash).toBe(HASH_B);
    expect(db.select().from(schema.mediaRefs).all()).toHaveLength(2);
  });
});

describe('isCache 与 mime 归一化', () => {
  it('isCache:false(IM 用户附件语义)透传到账本;默认 true', async () => {
    await integrationCache.integrationCachePut(
      { cacheKey: 'discord:att-1', integration: 'discord', buffer: BYTES_A, mimeType: 'image/png', isCache: false },
      db,
    );
    expect(db.select().from(schema.mediaBlobs).all()[0].isCache).toBe(false);
  });

  it('normalizeIntegrationMime:剥参数 + 小写 + image/jpg 别名', () => {
    expect(integrationCache.normalizeIntegrationMime('IMAGE/PNG; charset=binary')).toBe('image/png');
    expect(integrationCache.normalizeIntegrationMime('image/jpg')).toBe('image/jpeg');
    expect(integrationCache.normalizeIntegrationMime('image/jpeg')).toBe('image/jpeg');
  });

  it('put 内部做归一化:image/jpg 字节照样入仓为 .jpg blob', async () => {
    const hit = await integrationCache.integrationCachePut(
      { cacheKey: 'jira:att-x', integration: 'jira', buffer: BYTES_B, mimeType: 'image/jpg' },
      db,
    );
    expect(hit.url).toMatch(/\.jpg$/);
  });
});

describe('miss 路径', () => {
  it('未登记的 key → null(调用方去真下载)', async () => {
    await expect(integrationCache.integrationCacheGet('jira:nope', db)).resolves.toBeNull();
  });

  it('坏账(有账无文件)→ 按 miss 自愈,不抛不删账', async () => {
    const put = await integrationCache.integrationCachePut(
      { cacheKey: KEY, integration: 'feishu', buffer: BYTES_A, mimeType: 'image/png' },
      db,
    );
    fs.rmSync(put.absPath, { force: true });
    await expect(integrationCache.integrationCacheGet(KEY, db)).resolves.toBeNull();
    // 账还在(只报不删);重下同内容后自动复位
    expect(db.select().from(schema.mediaRefs).all()).toHaveLength(1);
    await integrationCache.integrationCachePut(
      { cacheKey: KEY, integration: 'feishu', buffer: BYTES_A, mimeType: 'image/png' },
      db,
    );
    await expect(integrationCache.integrationCacheGet(KEY, db)).resolves.not.toBeNull();
  });
});
