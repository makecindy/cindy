/**
 * ingest.test.ts — cindy-media 统一入库助手单测。
 * 覆盖:主路径(落盘+入账+挂引用)、全局去重(同内容多引用)、多 ref、
 * "先字节后记账"崩溃语义(记账失败字节仍在)、白名单外 mime 零副作用拒绝。
 * 文件落 os.tmpdir() 临时目录并收尾清理(规则 23);账本用内存 SQLite +
 * 真实 migration 建表(与 ledger.test.ts 同源做法,不手写建表语句)。
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { LedgerDb } from '../ledger';
import type { MediaRefCompensationScope } from '../refCompensationJournal';

let tmpUserData = '';
const OWNER_ID = 'owner-a';
const OWNER_KEY = 'a'.repeat(20);
const OWNER_SCOPE_KEY = 'cloud:owner-a:1';

vi.mock('electron', () => ({
  app: { getPath: () => tmpUserData },
}));

vi.mock('../../appSessionState', () => ({
  activeOwnerScopeKey: () => OWNER_SCOPE_KEY,
  dataOwnerStorageKey: () => OWNER_KEY,
  getActiveAppSession: () => ({ mode: 'cloud', dataOwnerId: OWNER_ID, generation: 1 }),
  isAppSessionBoundaryPending: () => false,
}));

const schema = await import('../../localDb/schema');
const ledger = await import('../ledger');
const ingest = await import('../ingest');
const refCompensation = await import('../refCompensationJournal');

const MIGRATION_0070 = path.resolve(__dirname, '../../../../drizzle/0070_woozy_harpoon.sql');
const { default: migration0071 } = (await import('../../../../drizzle/scripts/0071_bright_ultron')) as {
  default: { run: (db: Database.Database) => void };
};

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7]);
const PNG_HASH = createHash('sha256').update(PNG_BYTES).digest('hex');

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
  tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-media-ingest-test-'));
});

afterAll(() => {
  fs.rmSync(tmpUserData, { recursive: true, force: true });
});

beforeEach(() => {
  db = freshDb();
  fs.rmSync(path.join(tmpUserData, 'owners', OWNER_KEY, 'cindy-media', 'ref-compensation-v1'), {
    recursive: true,
    force: true,
  });
});

function compensationScope(): MediaRefCompensationScope {
  return refCompensation.captureMediaRefCompensationScope(OWNER_SCOPE_KEY);
}

function postCommitExpiringScope(
  journalDir: string,
  expiration: 'after-commit' | 'after-collection' = 'after-commit',
): MediaRefCompensationScope {
  let sawPendingMarker = false;
  let sawCommittedMarker = false;
  const scope: MediaRefCompensationScope = {
    journalDir,
    ownerStorageKey: OWNER_KEY,
    assertStillValid: () => {
      const markers = fs.existsSync(scope.journalDir)
        ? fs.readdirSync(scope.journalDir).filter((name) => name.endsWith('.json'))
        : [];
      if (markers.some((name) => name.endsWith('.pending.json'))) sawPendingMarker = true;
      if (sawPendingMarker && markers.some((name) => name.endsWith('.committed.json'))) {
        sawCommittedMarker = true;
        if (expiration === 'after-commit') throw new Error('owner changed after journal commit');
      }
      if (expiration === 'after-collection' && sawCommittedMarker && markers.length === 0) {
        throw new Error('owner changed after journal commit');
      }
    },
  };
  return scope;
}

function blobPathOf(hash: string, ext: string): string {
  return path.join(tmpUserData, 'cindy-media', 'blobs', hash.slice(0, 2), `${hash}${ext}`);
}

describe('ingestMedia(主路径)', () => {
  it('落盘 + blob 入账 + 挂引用,一次到位', async () => {
    const result = await ingest.ingestMedia(
      {
        buffer: PNG_BYTES,
        mimeType: 'image/png',
        refs: [
          {
            refKind: 'session-attachment',
            refId: 'session-1',
            originSessionId: 'session-1',
            originKind: 'user',
          },
        ],
      },
      db,
    );
    expect(result.hash).toBe(PNG_HASH);
    expect(result.url).toBe(`cindy-media://blobs/${PNG_HASH}.png`);
    expect(result.deduplicated).toBe(false);
    expect(result.refIds).toHaveLength(1);
    expect(fs.existsSync(blobPathOf(PNG_HASH, '.png'))).toBe(true);

    const blobs = db.select().from(schema.mediaBlobs).all();
    expect(blobs).toHaveLength(1);
    expect(blobs[0].hash).toBe(PNG_HASH);
    expect(blobs[0].isCache).toBe(false);

    const refs = db.select().from(schema.mediaRefs).all();
    expect(refs).toHaveLength(1);
    expect(refs[0].refKind).toBe('session-attachment');
    expect(refs[0].refId).toBe('session-1');
    expect(refs[0].originSessionId).toBe('session-1');
  });

  it('isCache 透传到账本(集成缓存吃 cache 上限的依据)', async () => {
    await ingest.ingestMedia(
      { buffer: PNG_BYTES, mimeType: 'image/png', isCache: true, refs: [] },
      db,
    );
    const blobs = db.select().from(schema.mediaBlobs).all();
    expect(blobs[0].isCache).toBe(true);
  });

  it('多条引用一次挂上,refIds 一一对应', async () => {
    const result = await ingest.ingestMedia(
      {
        buffer: PNG_BYTES,
        mimeType: 'image/png',
        refs: [
          { refKind: 'session-attachment', refId: 's-1' },
          { refKind: 'message', refId: 'm-1', originSessionId: 's-1' },
        ],
      },
      db,
    );
    expect(result.refIds).toHaveLength(2);
    expect(db.select().from(schema.mediaRefs).all()).toHaveLength(2);
  });
});

describe('ingestMedia(全局去重)', () => {
  it('cache 先入、非 cache 后到:去重命中时 isCache 降为 false(只降不升)', async () => {
    await ingest.ingestMedia(
      { buffer: PNG_BYTES, mimeType: 'image/png', isCache: true, refs: [] },
      db,
    );
    expect(db.select().from(schema.mediaBlobs).all()[0].isCache).toBe(true);
    // 同字节被聊天附件(非 cache)引用 → 必须降级,否则 cache 回收器会清掉用户附件
    await ingest.ingestMedia(
      {
        buffer: PNG_BYTES,
        mimeType: 'image/png',
        refs: [{ refKind: 'session-attachment', refId: 's-1' }],
      },
      db,
    );
    expect(db.select().from(schema.mediaBlobs).all()[0].isCache).toBe(false);
    // 反向不升:后续再有 cache 写入,非 cache 粘性保持
    await ingest.ingestMedia(
      { buffer: PNG_BYTES, mimeType: 'image/png', isCache: true, refs: [] },
      db,
    );
    expect(db.select().from(schema.mediaBlobs).all()[0].isCache).toBe(false);
  });

  it('同内容第二次入库:一个文件、一行 blob、引用行累加', async () => {
    await ingest.ingestMedia(
      {
        buffer: PNG_BYTES,
        mimeType: 'image/png',
        refs: [{ refKind: 'session-attachment', refId: 's-1' }],
      },
      db,
    );
    const again = await ingest.ingestMedia(
      {
        buffer: PNG_BYTES,
        mimeType: 'image/png',
        refs: [{ refKind: 'session-attachment', refId: 's-2' }],
      },
      db,
    );
    expect(again.deduplicated).toBe(true);
    expect(again.hash).toBe(PNG_HASH);

    const shard = path.join(tmpUserData, 'cindy-media', 'blobs', PNG_HASH.slice(0, 2));
    expect(fs.readdirSync(shard)).toHaveLength(1);
    expect(db.select().from(schema.mediaBlobs).all()).toHaveLength(1);
    expect(db.select().from(schema.mediaRefs).all()).toHaveLength(2);
  });
});

describe('ingestMedia(崩溃语义:先字节后记账)', () => {
  it('记账失败照样抛错,但字节已落盘(无账 blob 交对账兜底,不产生坏账)', async () => {
    const bytes = Buffer.from('ledger-will-fail-on-this-one');
    const hash = createHash('sha256').update(bytes).digest('hex');
    const brokenDb = drizzle(new Database(':memory:'), { schema }) as unknown as LedgerDb; // 未建表 → recordBlob 必炸
    await expect(
      ingest.ingestMedia({ buffer: bytes, mimeType: 'image/png', refs: [] }, brokenDb),
    ).rejects.toThrow();
    expect(fs.existsSync(blobPathOf(hash, '.png'))).toBe(true);
  });

  it('作用域断言在记账后失效时停止挂引用', async () => {
    let checks = 0;
    await expect(
      ingest.ingestMedia(
        {
          buffer: PNG_BYTES,
          mimeType: 'image/png',
          refs: [{ refKind: 'ghost-gallery', refId: 'art' }],
          assertStillValid: () => {
            checks += 1;
            if (checks === 3) throw new Error('owner scope changed');
          },
          refCompensationScope: compensationScope(),
        },
        db,
      ),
    ).rejects.toThrow('owner scope changed');

    expect(db.select().from(schema.mediaBlobs).all()).toHaveLength(1);
    expect(db.select().from(schema.mediaRefs).all()).toHaveLength(0);
  });

  it('作用域在 addRef 返回后失效时精确回滚本次引用', async () => {
    let checks = 0;
    await expect(
      ingest.ingestMedia(
        {
          buffer: PNG_BYTES,
          mimeType: 'image/png',
          refs: [{ refKind: 'session-attachment', refId: 'deleted-session' }],
          assertStillValid: () => {
            checks += 1;
            if (checks === 4) throw new Error('session was deleted');
          },
          refCompensationScope: compensationScope(),
        },
        db,
      ),
    ).rejects.toThrow('session was deleted');

    expect(db.select().from(schema.mediaBlobs).all()).toHaveLength(1);
    expect(db.select().from(schema.mediaRefs).all()).toHaveLength(0);
  });

  it('补偿日志提交后 owner 失效时仍精确回滚本次引用', async () => {
    const scope = postCommitExpiringScope(
      path.join(tmpUserData, 'post-commit-owner-change-journal'),
    );

    await expect(
      ingest.ingestMedia(
        {
          buffer: PNG_BYTES,
          mimeType: 'image/png',
          refs: [{ refKind: 'ghost-gallery', refId: 'stale-owner-art' }],
          assertStillValid: () => undefined,
          refCompensationScope: scope,
        },
        db,
      ),
    ).rejects.toThrow('owner changed after journal commit');

    expect(db.select().from(schema.mediaRefs).all()).toHaveLength(0);
    expect(fs.readdirSync(scope.journalDir).filter((name) => name.endsWith('.json'))).toHaveLength(
      0,
    );
  });

  it('补偿日志提交后 owner 失效且即时回滚失败时保留可恢复标记', async () => {
    const scope = postCommitExpiringScope(compensationScope().journalDir, 'after-collection');
    const removeRefById = vi
      .spyOn(ledger, 'removeRefById')
      .mockRejectedValueOnce(new Error('worker disposed'));
    try {
      await expect(
        ingest.ingestMedia(
          {
            buffer: PNG_BYTES,
            mimeType: 'image/png',
            refs: [{ refKind: 'ghost-gallery', refId: 'recover-stale-owner-art' }],
            assertStillValid: () => undefined,
            refCompensationScope: scope,
          },
          db,
        ),
      ).rejects.toThrow('owner changed after journal commit');

      expect(db.select().from(schema.mediaRefs).all()).toHaveLength(1);
      const markerNames = fs
        .readdirSync(scope.journalDir)
        .filter((name) => name.endsWith('.committed.json'));
      expect(markerNames).toHaveLength(1);
      expect(
        JSON.parse(fs.readFileSync(path.join(scope.journalDir, markerNames[0]), 'utf8')),
      ).toMatchObject({ rollbackRequired: true });

      removeRefById.mockRestore();
      await expect(
        refCompensation.reconcileMediaRefCompensationsForOwner({
          ownerId: OWNER_ID,
          db,
          isOwnerCurrent: () => true,
        }),
      ).resolves.toMatchObject({ recoveredPending: 1 });
      expect(db.select().from(schema.mediaRefs).all()).toHaveLength(0);
    } finally {
      removeRefById.mockRestore();
    }
  });

  it('addRef 已提交但回执丢失时仍用预留 id 精确回滚引用', async () => {
    const realAddRef = ledger.addRef;
    const addRef = vi.spyOn(ledger, 'addRef').mockImplementationOnce(async (params, targetDb) => {
      await realAddRef(params, targetDb);
      throw new Error('worker acknowledgement lost');
    });
    try {
      await expect(
        ingest.ingestMedia(
          {
            buffer: PNG_BYTES,
            mimeType: 'image/png',
            refs: [{ refKind: 'session-attachment', refId: 'deleted-session' }],
            refCompensationScope: compensationScope(),
          },
          db,
        ),
      ).rejects.toThrow('worker acknowledgement lost');

      expect(addRef).toHaveBeenCalledWith(
        expect.objectContaining({ id: expect.any(String), refId: 'deleted-session' }),
        db,
      );
      expect(db.select().from(schema.mediaBlobs).all()).toHaveLength(1);
      expect(db.select().from(schema.mediaRefs).all()).toHaveLength(0);
    } finally {
      addRef.mockRestore();
    }
  });

  it('worker 在 INSERT 后丢失 ACK 且即时回滚不可用时由同 owner 下次就绪补偿', async () => {
    const realAddRef = ledger.addRef;
    const addRef = vi.spyOn(ledger, 'addRef').mockImplementationOnce(async (params, targetDb) => {
      await realAddRef(params, targetDb);
      throw new Error('worker acknowledgement lost');
    });
    const removeRefById = vi
      .spyOn(ledger, 'removeRefById')
      .mockRejectedValueOnce(new Error('worker disposed'));
    try {
      await expect(
        ingest.ingestMedia(
          {
            buffer: PNG_BYTES,
            mimeType: 'image/png',
            refs: [{ refKind: 'session-attachment', refId: 'deleted-session' }],
            refCompensationScope: compensationScope(),
          },
          db,
        ),
      ).rejects.toThrow('worker acknowledgement lost');

      expect(db.select().from(schema.mediaRefs).all()).toHaveLength(1);
      const journalDir = compensationScope().journalDir;
      expect(
        fs.readdirSync(journalDir).filter((name) => name.endsWith('.pending.json')),
      ).toHaveLength(1);

      addRef.mockRestore();
      removeRefById.mockRestore();
      await expect(
        refCompensation.reconcileMediaRefCompensationsForOwner({
          ownerId: OWNER_ID,
          db,
          isOwnerCurrent: () => true,
        }),
      ).resolves.toMatchObject({ recoveredPending: 1 });
      expect(db.select().from(schema.mediaRefs).all()).toHaveLength(0);
      expect(fs.readdirSync(journalDir).filter((name) => name.endsWith('.json'))).toHaveLength(0);
    } finally {
      addRef.mockRestore();
      removeRefById.mockRestore();
    }
  });

  it('补偿日志无法可靠落盘时不执行任何 addRef', async () => {
    const blockedJournalPath = path.join(tmpUserData, 'blocked-ref-journal');
    fs.writeFileSync(blockedJournalPath, 'not a directory');
    const addRef = vi.spyOn(ledger, 'addRef');
    try {
      await expect(
        ingest.ingestMedia(
          {
            buffer: PNG_BYTES,
            mimeType: 'image/png',
            refs: [{ refKind: 'session-attachment', refId: 'session-a' }],
            refCompensationScope: {
              journalDir: blockedJournalPath,
              ownerStorageKey: OWNER_KEY,
              assertStillValid: () => undefined,
            },
          },
          db,
        ),
      ).rejects.toThrow();
      expect(addRef).not.toHaveBeenCalled();
      expect(db.select().from(schema.mediaRefs).all()).toHaveLength(0);
    } finally {
      addRef.mockRestore();
      fs.rmSync(blockedJournalPath, { force: true });
    }
  });

  it('startup 只回收 committed marker，不删除已经提交的引用', async () => {
    const operationId = '11111111-1111-4111-8111-111111111111';
    const refId = '22222222-2222-4222-8222-222222222222';
    await ledger.recordBlob(
      { hash: PNG_HASH, ext: '.png', mimeType: 'image/png', bytes: PNG_BYTES.length },
      db,
    );
    await ledger.addRef(
      {
        id: refId,
        hash: PNG_HASH,
        refKind: 'session-attachment',
        refId: 'session-a',
      },
      db,
    );
    const journalDir = compensationScope().journalDir;
    fs.mkdirSync(journalDir, { recursive: true });
    fs.writeFileSync(
      path.join(journalDir, `${operationId}.committed.json`),
      JSON.stringify({
        version: 1,
        operationId,
        ownerStorageKey: OWNER_KEY,
        createdAt: Date.now(),
        refIds: [refId],
      }),
    );

    await expect(
      refCompensation.reconcileMediaRefCompensationsForOwner({
        ownerId: OWNER_ID,
        db,
        isOwnerCurrent: () => true,
      }),
    ).resolves.toMatchObject({ removedCommitted: 1, recoveredPending: 0 });
    expect(db.select().from(schema.mediaRefs).all()).toEqual([
      expect.objectContaining({ id: refId }),
    ]);
    expect(fs.readdirSync(journalDir).filter((name) => name.endsWith('.json'))).toHaveLength(0);
  });

  it('startup 补偿目录提交不确定且即时回滚失败的 committed 引用', async () => {
    const operationId = '33333333-3333-4333-8333-333333333333';
    const refId = '44444444-4444-4444-8444-444444444444';
    await ledger.recordBlob(
      { hash: PNG_HASH, ext: '.png', mimeType: 'image/png', bytes: PNG_BYTES.length },
      db,
    );
    await ledger.addRef(
      {
        id: refId,
        hash: PNG_HASH,
        refKind: 'session-attachment',
        refId: 'session-a',
      },
      db,
    );
    const journalDir = compensationScope().journalDir;
    fs.mkdirSync(journalDir, { recursive: true });
    fs.writeFileSync(
      path.join(journalDir, `${operationId}.committed.json`),
      JSON.stringify({
        version: 1,
        operationId,
        ownerStorageKey: OWNER_KEY,
        createdAt: Date.now(),
        refIds: [refId],
        rollbackRequired: true,
      }),
    );

    await expect(
      refCompensation.reconcileMediaRefCompensationsForOwner({
        ownerId: OWNER_ID,
        db,
        isOwnerCurrent: () => true,
      }),
    ).resolves.toMatchObject({ recoveredPending: 1, removedCommitted: 0 });
    expect(db.select().from(schema.mediaRefs).all()).toHaveLength(0);
    expect(fs.readdirSync(journalDir).filter((name) => name.endsWith('.json'))).toHaveLength(0);
  });

  it('启用作用域断言时必须显式捕获数据库句柄', async () => {
    await expect(
      ingest.ingestMedia({
        buffer: PNG_BYTES,
        mimeType: 'image/png',
        refs: [],
        assertStillValid: () => undefined,
      }),
    ).rejects.toThrow('requires an explicit database');
  });

  it('会挂引用的 guarded ingest 必须显式捕获 owner 补偿日志', async () => {
    await expect(
      ingest.ingestMedia(
        {
          buffer: PNG_BYTES,
          mimeType: 'image/png',
          refs: [{ refKind: 'session-attachment', refId: 'session-a' }],
          assertStillValid: () => undefined,
        },
        db,
      ),
    ).rejects.toThrow('requires a reference compensation scope');
    expect(db.select().from(schema.mediaRefs).all()).toHaveLength(0);
  });
});

describe('ingestMedia(白名单外拒绝)', () => {
  it('不支持的 mime 整体拒,磁盘与账本零副作用', async () => {
    const bytes = Buffer.from('not-a-media-file');
    await expect(
      ingest.ingestMedia({ buffer: bytes, mimeType: 'application/zip', refs: [] }, db),
    ).rejects.toThrow(/unsupported mime/);
    expect(db.select().from(schema.mediaBlobs).all()).toHaveLength(0);
  });

  it('supportedMime 供调用方前置分流(规则 25 边界:非媒体走直读通道)', () => {
    expect(ingest.supportedMime('image/png')).toBe(true);
    expect(ingest.supportedMime('application/zip')).toBe(false);
  });
});
