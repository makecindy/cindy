/**
 * ledger.test.ts — cindy-media 账本单测。
 * 内存 SQLite + 真实 0070 migration SQL 建表 + 0071 配套脚本加列(与生产
 * schema 同源,不手写建表语句避免漂移),直测注入 db 的纯函数(规则 14)。
 * 覆盖:blob 幂等入账、引用增删、意识归属校验(出生/画廊/越权/未知)、FK 级联、
 * 画廊清单(排序/归属隔离/label 透传/limit)。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import type { LedgerDb } from '../ledger';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/never-used-here' },
}));

const schema = await import('../../localDb/schema');
const ledger = await import('../ledger');

const MIGRATION_0070 = path.resolve(__dirname, '../../../../drizzle/0070_woozy_harpoon.sql');
// 0071 的加列在配套脚本里(SQL 是占位),与生产同源经 CommonJS require 加载。
// eslint-disable-next-line @typescript-eslint/no-require-imports
const migration0071 = require('../../../../drizzle/scripts/0071_bright_ultron.ts') as {
  run: (db: Database.Database) => void;
};

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

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

beforeEach(() => {
  db = freshDb();
});

async function seedBlob(hash: string, isCache = false): Promise<void> {
  await ledger.recordBlob({ hash, ext: '.png', mimeType: 'image/png', bytes: 8, isCache }, db);
}

describe('recordBlob(幂等入账)', () => {
  it('首次入账写全量字段,重复入账不炸只刷 lastAccess', async () => {
    await seedBlob(HASH_A);
    await expect(seedBlob(HASH_A)).resolves.toBeUndefined();
    const rows = db.select().from(schema.mediaBlobs).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].hash).toBe(HASH_A);
    expect(rows[0].isCache).toBe(false);
  });
});

describe('addRef / removeRefs(引用增删)', () => {
  it('未入账的指纹加引用被 FK 拒绝(先记 blob 后记 ref 的顺序由类型层保证)', async () => {
    await expect(
      ledger.addRef({ hash: HASH_A, refKind: 'message', refId: 'msg-1', originSessionId: 'sess-1' }, db),
    ).rejects.toThrow();
  });

  it('removeRefs 只删指定引用方名下的行,返回删除数', async () => {
    await seedBlob(HASH_A);
    await ledger.addRef({ hash: HASH_A, refKind: 'message', refId: 'msg-1', originSessionId: 'sess-1' }, db);
    await ledger.addRef({ hash: HASH_A, refKind: 'ghost-gallery', refId: 'art' }, db);
    await expect(ledger.removeRefs({ refKind: 'message', refId: 'msg-1' }, db)).resolves.toBe(1);
    const left = db.select().from(schema.mediaRefs).all();
    expect(left).toHaveLength(1);
    expect(left[0].refKind).toBe('ghost-gallery');
  });

  it('message ref 漏传 originSessionId 被代码级断言拒绝(否则永远无人回收)', async () => {
    await seedBlob(HASH_A);
    await expect(
      ledger.addRef({ hash: HASH_A, refKind: 'message', refId: 'msg-1' }, db),
    ).rejects.toThrow(/originSessionId/);
  });

  it('删除 blob 行时引用级联清空(回收器删文件后账面自洽)', async () => {
    await seedBlob(HASH_A);
    await ledger.addRef({ hash: HASH_A, refKind: 'message', refId: 'msg-1', originSessionId: 'sess-1' }, db);
    db.delete(schema.mediaBlobs).run();
    expect(db.select().from(schema.mediaRefs).all()).toHaveLength(0);
  });

  it('hasRef 可按 originKind 区分人工授权与工具自动授权', async () => {
    await seedBlob(HASH_A);
    await ledger.addRef(
      { hash: HASH_A, refKind: 'ghost-grant', refId: 'art', originKind: 'tool' },
      db,
    );

    await expect(
      ledger.hasRef({ hash: HASH_A, refKind: 'ghost-grant', refId: 'art' }, db),
    ).resolves.toBe(true);
    await expect(
      ledger.hasRef({
        hash: HASH_A,
        refKind: 'ghost-grant',
        refId: 'art',
        originKind: 'user',
      }, db),
    ).resolves.toBe(false);
    await expect(
      ledger.hasRef({
        hash: HASH_A,
        refKind: 'ghost-grant',
        refId: 'art',
        originKind: 'tool',
      }, db),
    ).resolves.toBe(true);

    await ledger.addRef(
      { hash: HASH_A, refKind: 'ghost-grant', refId: 'art', originKind: 'user' },
      db,
    );
    await expect(
      ledger.hasRef({
        hash: HASH_A,
        refKind: 'ghost-grant',
        refId: 'art',
        originKind: 'user',
      }, db),
    ).resolves.toBe(true);
  });

  it('hasGhostToolGrant 兼容旧 ghost-grant/tool，但不把 user provenance 当工具交接', async () => {
    await seedBlob(HASH_A);
    await expect(
      ledger.hasGhostToolGrant({ hash: HASH_A, ghostId: 'art' }, db),
    ).resolves.toBe(false);

    await ledger.addRef(
      { hash: HASH_A, refKind: 'ghost-grant', refId: 'art', originKind: 'user' },
      db,
    );
    await expect(
      ledger.hasGhostToolGrant({ hash: HASH_A, ghostId: 'art' }, db),
    ).resolves.toBe(false);

    await ledger.addRef(
      { hash: HASH_A, refKind: 'ghost-grant', refId: 'art', originKind: 'tool' },
      db,
    );
    await expect(
      ledger.hasGhostToolGrant({ hash: HASH_A, ghostId: 'art' }, db),
    ).resolves.toBe(true);

    await seedBlob(HASH_B);
    await ledger.addRef(
      { hash: HASH_B, refKind: 'ghost-tool-grant', refId: 'art', originKind: 'tool' },
      db,
    );
    await expect(
      ledger.hasGhostToolGrant({ hash: HASH_B, ghostId: 'art' }, db),
    ).resolves.toBe(true);
  });

  it('新版工具交接可取件，但旧版 ghost-grant shortcut 看不到它(回退 fail closed)', async () => {
    await seedBlob(HASH_A);
    await ledger.addRef(
      { hash: HASH_A, refKind: 'ghost-tool-grant', refId: 'art', originKind: 'tool' },
      db,
    );

    // 新版运行时仍能把本次交接的指纹交给插件实际使用。
    await expect(ledger.ghostCanRead(HASH_A, 'art', db)).resolves.toBe(true);
    // 模拟旧客户端不带 provenance 的永久授权 shortcut：它只查
    // refKind='ghost-grant'，因此不会把新版自动交接误当成人工批准。
    await expect(
      ledger.hasRef({ hash: HASH_A, refKind: 'ghost-grant', refId: 'art' }, db),
    ).resolves.toBe(false);
    await expect(
      ledger.hasRef({ hash: HASH_A, refKind: 'ghost-tool-grant', refId: 'art' }, db),
    ).resolves.toBe(true);
  });
});

describe('removeRefsExceptHash(替换型引用清理:个人头像换图)', () => {
  it('只删同引用方名下、指纹不等于 keepHash 的行;别的引用方不受牵连', async () => {
    await seedBlob(HASH_A);
    await seedBlob(HASH_B);
    // user-1 换头像:旧图 HASH_A、新图 HASH_B 均已挂 profile-avatar 引用
    await ledger.addRef({ hash: HASH_A, refKind: 'profile-avatar', refId: 'user-1', originKind: 'user' }, db);
    await ledger.addRef({ hash: HASH_B, refKind: 'profile-avatar', refId: 'user-1', originKind: 'user' }, db);
    // 同指纹的其它业务引用与别的用户头像都必须幸存
    await ledger.addRef({ hash: HASH_A, refKind: 'ghost-gallery', refId: 'art' }, db);
    await ledger.addRef({ hash: HASH_A, refKind: 'profile-avatar', refId: 'user-2', originKind: 'user' }, db);

    await expect(
      ledger.removeRefsExceptHash({ refKind: 'profile-avatar', refId: 'user-1', keepHash: HASH_B }, db),
    ).resolves.toBe(1);

    const left = db.select().from(schema.mediaRefs).all();
    expect(left).toHaveLength(3);
    const mine = left.filter((r) => r.refKind === 'profile-avatar' && r.refId === 'user-1');
    expect(mine).toHaveLength(1);
    expect(mine[0].hash).toBe(HASH_B);
  });

  it('同指纹重复保存(去重命中)时不删 keepHash 的任何行', async () => {
    await seedBlob(HASH_A);
    await ledger.addRef({ hash: HASH_A, refKind: 'profile-avatar', refId: 'user-1', originKind: 'user' }, db);
    await ledger.addRef({ hash: HASH_A, refKind: 'profile-avatar', refId: 'user-1', originKind: 'user' }, db);
    await expect(
      ledger.removeRefsExceptHash({ refKind: 'profile-avatar', refId: 'user-1', keepHash: HASH_A }, db),
    ).resolves.toBe(0);
    expect(db.select().from(schema.mediaRefs).all()).toHaveLength(2);
  });
});

describe('removeSessionRefs(会话删除钩子)', () => {
  it('删附件/导入/本会话出生的消息引用;画廊与引渡引用不陪葬;别的会话不受牵连', async () => {
    await seedBlob(HASH_A);
    await seedBlob(HASH_B);
    // 会话 sess-1 名下:附件 ref + 导入 ref + 出生消息 ref
    await ledger.addRef({ hash: HASH_A, refKind: 'session-attachment', refId: 'sess-1' }, db);
    await ledger.addRef({ hash: HASH_A, refKind: 'import', refId: 'sess-1' }, db);
    await ledger.addRef(
      { hash: HASH_A, refKind: 'message', refId: 'msg-1', originSessionId: 'sess-1', originKind: 'tool' },
      db,
    );
    // 免死引用:同一指纹挂了画廊 + 引渡(跨会话持久,删会话不动)。
    // 特意带上 originSessionId=sess-1:钉死"按出生会话单键误删"的回归——
    // 出生在被删会话里,但 refKind 不是 message,照样必须幸存。
    await ledger.addRef(
      { hash: HASH_A, refKind: 'ghost-gallery', refId: 'art', originSessionId: 'sess-1' },
      db,
    );
    await ledger.addRef(
      { hash: HASH_A, refKind: 'ghost-grant', refId: 'art', originKind: 'user', originSessionId: 'sess-1' },
      db,
    );
    // 无关会话 sess-2 的引用
    await ledger.addRef({ hash: HASH_B, refKind: 'session-attachment', refId: 'sess-2' }, db);
    await ledger.addRef(
      { hash: HASH_B, refKind: 'message', refId: 'msg-9', originSessionId: 'sess-2' },
      db,
    );

    await expect(ledger.removeSessionRefs('sess-1', db)).resolves.toBe(3);

    const left = db.select().from(schema.mediaRefs).all();
    expect(left.map((r) => r.refKind).sort()).toEqual([
      'ghost-gallery',
      'ghost-grant',
      'message',
      'session-attachment',
    ]);
    // 幸存的 message/session-attachment 都是 sess-2 的
    expect(
      left.filter((r) => r.refKind === 'session-attachment').every((r) => r.refId === 'sess-2'),
    ).toBe(true);
  });

  it('无引用可删时返回 0,不炸', async () => {
    await expect(ledger.removeSessionRefs('nobody', db)).resolves.toBe(0);
  });
});

describe('ghostCanRead(供图归属校验)', () => {
  it('出生自本意识 → 放行', async () => {
    await seedBlob(HASH_A);
    await ledger.addRef(
      {
        hash: HASH_A,
        refKind: 'message',
        refId: 'msg-1',
        originSessionId: 'sess-1',
        originKind: 'ghost',
        originId: 'art',
      },
      db,
    );
    await expect(ledger.ghostCanRead(HASH_A, 'art', db)).resolves.toBe(true);
  });

  it('挂在本意识画廊 → 放行(即使出生自别处)', async () => {
    await seedBlob(HASH_A);
    await ledger.addRef({ hash: HASH_A, refKind: 'ghost-gallery', refId: 'art' }, db);
    await expect(ledger.ghostCanRead(HASH_A, 'art', db)).resolves.toBe(true);
  });

  it('用户显式引渡(ghost-grant)→ 放行本意识,别的意识仍拒', async () => {
    await seedBlob(HASH_A);
    await ledger.addRef(
      { hash: HASH_A, refKind: 'ghost-grant', refId: 'art', originKind: 'user' },
      db,
    );
    await expect(ledger.ghostCanRead(HASH_A, 'art', db)).resolves.toBe(true);
    await expect(ledger.ghostCanRead(HASH_A, 'other-ghost', db)).resolves.toBe(false);
  });

  it('Host 工具代办交接(ghost-tool-grant)→ 放行本意识,但不是人工授权', async () => {
    await seedBlob(HASH_A);
    await ledger.addRef(
      { hash: HASH_A, refKind: 'ghost-tool-grant', refId: 'art', originKind: 'tool' },
      db,
    );
    await expect(ledger.ghostCanRead(HASH_A, 'art', db)).resolves.toBe(true);
    await expect(ledger.ghostCanRead(HASH_A, 'other-ghost', db)).resolves.toBe(false);
    await expect(
      ledger.hasRef({
        hash: HASH_A,
        refKind: 'ghost-grant',
        refId: 'art',
        originKind: 'user',
      }, db),
    ).resolves.toBe(false);
  });

  it('本意识寄存(ghost-deposit)→ 放行本意识,别的意识仍拒(#784)', async () => {
    await seedBlob(HASH_A);
    await ledger.addRef(
      { hash: HASH_A, refKind: 'ghost-deposit', refId: 'art', originKind: 'user' },
      db,
    );
    // 这条正是 "画布上的图 = AI 能改的图":resolveOwnedMedia 走 ghostCanRead。
    await expect(ledger.ghostCanRead(HASH_A, 'art', db)).resolves.toBe(true);
    await expect(ledger.ghostCanRead(HASH_A, 'other-ghost', db)).resolves.toBe(false);
  });

  it('别的意识 / 未知指纹一律拒(不区分不存在与不属于你)', async () => {
    await seedBlob(HASH_A);
    await ledger.addRef(
      { hash: HASH_A, refKind: 'message', refId: 'msg-1', originSessionId: 'sess-1', originKind: 'ghost', originId: 'art' },
      db,
    );
    await expect(ledger.ghostCanRead(HASH_A, 'other-ghost', db)).resolves.toBe(false);
    await expect(ledger.ghostCanRead(HASH_B, 'art', db)).resolves.toBe(false);
  });

  it('用户/工具出生的媒体不因 originId 撞名意识 id 而放行', async () => {
    await seedBlob(HASH_A);
    // originKind 不是 ghost:即使 originId 恰好等于某意识 id 也不算它的出生。
    await ledger.addRef(
      { hash: HASH_A, refKind: 'message', refId: 'msg-1', originSessionId: 'sess-1', originKind: 'tool', originId: 'art' },
      db,
    );
    await expect(ledger.ghostCanRead(HASH_A, 'art', db)).resolves.toBe(false);
  });
});

describe('getBlobInfo(指纹 → 落盘元数据)', () => {
  it('已入账返回 ext/mime/bytes,未入账返回 null', async () => {
    await seedBlob(HASH_A);
    await expect(ledger.getBlobInfo(HASH_A, db)).resolves.toEqual({
      ext: '.png',
      mimeType: 'image/png',
      bytes: 8,
    });
    await expect(ledger.getBlobInfo(HASH_B, db)).resolves.toBeNull();
  });
});

describe('listGhostGallery(画廊清单:重启回放数据源)', () => {
  /** 以受控时间戳挂一张画廊图(addRef 的 createdAt 取 Date.now())。 */
  async function hangAt(hash: string, ghostId: string, at: number, label?: string): Promise<void> {
    vi.useFakeTimers();
    vi.setSystemTime(at);
    try {
      await ledger.addRef(
        { hash, refKind: 'ghost-gallery', refId: ghostId, ...(label ? { label } : {}) },
        db,
      );
    } finally {
      vi.useRealTimers();
    }
  }

  it('新在前排序,label 透传,无 label 为 null', async () => {
    await seedBlob(HASH_A);
    await seedBlob(HASH_B);
    await hangAt(HASH_A, 'art', 1_000, '第一张');
    await hangAt(HASH_B, 'art', 2_000);
    const items = await ledger.listGhostGallery('art', db);
    expect(items.map((i) => i.hash)).toEqual([HASH_B, HASH_A]);
    expect(items[0].label).toBeNull();
    expect(items[1].label).toBe('第一张');
    expect(items[1].ext).toBe('.png');
  });

  it('只含本意识的 gallery 引用:别的意识画廊、非 gallery 引用都不进清单', async () => {
    await seedBlob(HASH_A);
    await seedBlob(HASH_B);
    await ledger.addRef({ hash: HASH_A, refKind: 'ghost-gallery', refId: 'other-ghost' }, db);
    await ledger.addRef(
      { hash: HASH_B, refKind: 'message', refId: 'msg-1', originSessionId: 'sess-1', originKind: 'ghost', originId: 'art' },
      db,
    );
    await expect(ledger.listGhostGallery('art', db)).resolves.toEqual([]);
  });

  it('limit 截断且保留最新的一批', async () => {
    await seedBlob(HASH_A);
    await hangAt(HASH_A, 'art', 1_000, '旧');
    await hangAt(HASH_A, 'art', 2_000, '新');
    const items = await ledger.listGhostGallery('art', db, 1);
    expect(items).toHaveLength(1);
    expect(items[0].label).toBe('新');
  });
});

describe('寄存计量与释放(ghostDepositUsageBytes / removeGhostDepositRef,#784)', () => {
  async function deposit(hash: string, ghostId: string, bytes: number): Promise<void> {
    await ledger.recordBlob({ hash, ext: '.png', mimeType: 'image/png', bytes }, db);
    await ledger.addRef({ hash, refKind: 'ghost-deposit', refId: ghostId, originKind: 'user' }, db);
  }

  it('按意识累加寄存字节,别的意识与别的 refKind 都不计入', async () => {
    await deposit(HASH_A, 'art', 100);
    await deposit(HASH_B, 'art', 250);
    const HASH_C = 'c'.repeat(64);
    await deposit(HASH_C, 'other-ghost', 999);
    // 画廊(生成产物)不占寄存配额 —— 否则"出图多"会挤掉"存参考图"。
    const HASH_D = 'd'.repeat(64);
    await ledger.recordBlob({ hash: HASH_D, ext: '.png', mimeType: 'image/png', bytes: 500 }, db);
    await ledger.addRef({ hash: HASH_D, refKind: 'ghost-gallery', refId: 'art' }, db);

    await expect(ledger.ghostDepositUsageBytes('art', db)).resolves.toBe(350);
    await expect(ledger.ghostDepositUsageBytes('other-ghost', db)).resolves.toBe(999);
    await expect(ledger.ghostDepositUsageBytes('nobody', db)).resolves.toBe(0);
  });

  it('同指纹重复入账只算一份(内容寻址下磁盘也只占一份)', async () => {
    await deposit(HASH_A, 'art', 100);
    // 历史数据里可能出现重复 ref 行,计量口径必须与真实磁盘占用一致。
    await ledger.addRef({ hash: HASH_A, refKind: 'ghost-deposit', refId: 'art' }, db);
    await expect(ledger.ghostDepositUsageBytes('art', db)).resolves.toBe(100);
  });

  it('撤回只删本意识的寄存引用:画廊/消息/别人的引用一概不动', async () => {
    await deposit(HASH_A, 'art', 100);
    await ledger.addRef({ hash: HASH_A, refKind: 'ghost-gallery', refId: 'art' }, db);
    await ledger.addRef({ hash: HASH_A, refKind: 'ghost-deposit', refId: 'other-ghost' }, db);
    await ledger.addRef(
      { hash: HASH_A, refKind: 'message', refId: 'msg-1', originSessionId: 'sess-1' },
      db,
    );

    await expect(ledger.removeGhostDepositRef({ hash: HASH_A, ghostId: 'art' }, db)).resolves.toBe(true);
    await expect(ledger.ghostDepositUsageBytes('art', db)).resolves.toBe(0);
    // 别人的寄存、自己的画廊、聊天消息都还在(字节不会被连带清掉)。
    await expect(ledger.ghostDepositUsageBytes('other-ghost', db)).resolves.toBe(100);
    const kinds = db.select().from(schema.mediaRefs).all().map((r) => `${r.refKind}:${r.refId}`);
    expect(kinds.sort()).toEqual([
      'ghost-deposit:other-ghost',
      'ghost-gallery:art',
      'message:msg-1',
    ]);
    // 撤回后字节仍在账(recycler 按引用归零判生死,不由本函数删)。
    await expect(ledger.getBlobInfo(HASH_A, db)).resolves.toMatchObject({ bytes: 100 });
  });

  it('撤回不存在的寄存引用 → false(幂等,不报错)', async () => {
    await seedBlob(HASH_A);
    await expect(ledger.removeGhostDepositRef({ hash: HASH_A, ghostId: 'art' }, db)).resolves.toBe(false);
  });

  it('卸载意识时按 refKind 清空自己的寄存物(removeRefs 口)', async () => {
    await deposit(HASH_A, 'art', 100);
    await deposit(HASH_B, 'art', 250);
    await ledger.addRef({ hash: HASH_A, refKind: 'ghost-gallery', refId: 'art' }, db);
    const removed = await ledger.removeRefs({ refKind: 'ghost-deposit', refId: 'art' }, db);
    expect(removed).toBe(2);
    await expect(ledger.ghostDepositUsageBytes('art', db)).resolves.toBe(0);
    // 画廊留存语义不在本改动范围内改动。
    await expect(ledger.listGhostGallery('art', db)).resolves.toHaveLength(1);
  });

  it('删会话不碰寄存物(画布上的图不因删会话变得不能改)', async () => {
    await deposit(HASH_A, 'art', 100);
    await ledger.addRef(
      { hash: HASH_A, refKind: 'message', refId: 'msg-1', originSessionId: 'sess-1' },
      db,
    );
    await ledger.removeSessionRefs('sess-1', db);
    await expect(ledger.ghostDepositUsageBytes('art', db)).resolves.toBe(100);
    await expect(ledger.ghostCanRead(HASH_A, 'art', db)).resolves.toBe(true);
  });
});

describe('touchBlob(惰性刷新,读路径永不被拖垮)', () => {
  it('正常刷新 lastAccessAt', async () => {
    await seedBlob(HASH_A);
    const before = db.select().from(schema.mediaBlobs).all()[0].lastAccessAt;
    vi.useFakeTimers();
    vi.setSystemTime(before + 60_000);
    await ledger.touchBlob(HASH_A, db);
    vi.useRealTimers();
    const after = db.select().from(schema.mediaBlobs).all()[0].lastAccessAt;
    expect(after).toBe(before + 60_000);
  });

  it('账本抛错时静默(不影响媒体读取)', async () => {
    const broken = { update: () => { throw new Error('db down'); } } as unknown as LedgerDb;
    await expect(ledger.touchBlob(HASH_A, broken)).resolves.toBeUndefined();
  });
});
