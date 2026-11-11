/**
 * chatAttachments.test.ts — 聊天附件媒体总仓写入口单测。
 * 覆盖:草稿入仓(blob+账本行,零引用)、拖拽路径入仓(扩展名判 mime、白名单外拒)、
 * URL 收集(嵌套 JSON 穿透)、发送提交(挂 session-attachment 引用、幂等去重、
 * 非法 URL 跳过)。文件落 os.tmpdir() 并收尾清理(规则 23);账本内存 SQLite +
 * 真实 migration 建表(与 ledger.test.ts 同源)。
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
const chatAttachments = await import('../chatAttachments');

const MIGRATION_0070 = path.resolve(__dirname, '../../../../drizzle/0070_woozy_harpoon.sql');
const { default: migration0071 } = (await import('../../../../drizzle/scripts/0071_bright_ultron')) as {
  default: { run: (db: Database.Database) => void };
};

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 42]);
const PNG_HASH = createHash('sha256').update(PNG_BYTES).digest('hex');
const PNG_URL = `cindy-media://blobs/${PNG_HASH}.png`;

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
  tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-attachments-test-'));
});

afterAll(() => {
  fs.rmSync(tmpUserData, { recursive: true, force: true });
});

beforeEach(() => {
  db = freshDb();
});

describe('ingestChatImageBuffer(粘贴草稿入仓)', () => {
  it('写 blob + 账本行,不挂任何引用(无引用 = 回收候选 = 草稿语义)', async () => {
    const result = await chatAttachments.ingestChatImageBuffer(
      { buffer: PNG_BYTES, mimeType: 'image/png' },
      db,
    );
    expect(result.url).toBe(PNG_URL);
    expect(result.filename).toBe(`${PNG_HASH}.png`);
    expect(db.select().from(schema.mediaBlobs).all()).toHaveLength(1);
    expect(db.select().from(schema.mediaBlobs).all()[0].isCache).toBe(false);
    expect(db.select().from(schema.mediaRefs).all()).toHaveLength(0);
  });
});

describe('ingestChatImageFromPath(拖拽文件入仓)', () => {
  it('按原始文件名扩展名判 mime,读盘入仓', async () => {
    const src = path.join(tmpUserData, 'dragged.PNG'); // 大写扩展名也要认
    fs.writeFileSync(src, PNG_BYTES);
    const result = await chatAttachments.ingestChatImageFromPath(
      { sourcePath: src, originalName: 'dragged.PNG' },
      db,
    );
    expect(result.url).toBe(PNG_URL);
  });

  it('图片白名单外扩展名整体拒(非媒体不进字节仓,规则 25 边界)', async () => {
    const src = path.join(tmpUserData, 'doc.pdf');
    fs.writeFileSync(src, Buffer.from('%PDF-fake'));
    await expect(
      chatAttachments.ingestChatImageFromPath({ sourcePath: src, originalName: 'doc.pdf' }, db),
    ).rejects.toThrow(/unsupported image extension/);
    expect(db.select().from(schema.mediaBlobs).all()).toHaveLength(0);
  });
});

describe('collectCindyMediaUrls(消息结构收集)', () => {
  it('穿透嵌套结构与二次 JSON 编码(persistedContent 场景),去重', () => {
    const msg = {
      type: 'user',
      content: [
        { type: 'text', text: `看图 ${PNG_URL}` },
        { type: 'image', path: PNG_URL, mimeType: 'image/png' },
      ],
      persistedContent: JSON.stringify({ images: [{ url: PNG_URL }] }),
    };
    expect(chatAttachments.collectCindyMediaUrls(msg)).toEqual([PNG_URL]);
  });

  it('无 blob 地址 / 不可序列化输入返回空数组', () => {
    expect(chatAttachments.collectCindyMediaUrls({ text: 'xdt-image://s/f.png' })).toEqual([]);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(chatAttachments.collectCindyMediaUrls(cyclic)).toEqual([]);
  });
});

describe('commitChatImageUrls(发送时挂引用)', () => {
  it('挂 session-attachment 引用(含出生信息);重复提交幂等跳过', async () => {
    await chatAttachments.ingestChatImageBuffer({ buffer: PNG_BYTES, mimeType: 'image/png' }, db);
    const first = await chatAttachments.commitChatImageUrls(
      { sessionId: 'sess-1', urls: [PNG_URL] },
      db,
    );
    expect(first).toEqual({ committed: 1, skipped: 0, failed: 0 });
    const refs = db.select().from(schema.mediaRefs).all();
    expect(refs).toHaveLength(1);
    expect(refs[0].refKind).toBe('session-attachment');
    expect(refs[0].refId).toBe('sess-1');
    expect(refs[0].originSessionId).toBe('sess-1');

    // 重发同消息 / 插话再次 commit → 不刷重复行
    const again = await chatAttachments.commitChatImageUrls(
      { sessionId: 'sess-1', urls: [PNG_URL] },
      db,
    );
    expect(again).toEqual({ committed: 0, skipped: 1, failed: 0 });
    expect(db.select().from(schema.mediaRefs).all()).toHaveLength(1);

    // 同图发到另一个任务 → 各挂各的引用
    const other = await chatAttachments.commitChatImageUrls(
      { sessionId: 'sess-2', urls: [PNG_URL] },
      db,
    );
    expect(other.committed).toBe(1);
    expect(db.select().from(schema.mediaRefs).all()).toHaveLength(2);
  });

  it('形状不合法的 URL 跳过不炸', async () => {
    const result = await chatAttachments.commitChatImageUrls(
      { sessionId: 'sess-1', urls: ['cindy-media://blobs/not-a-hash.png', 'xdt-image://s/f.png'] },
      db,
    );
    expect(result).toEqual({ committed: 0, skipped: 2, failed: 0 });
  });

  it('commitMessageMediaRefs:role 映射 originKind(user→user,其余→tool);无 URL 零 DB 访问', async () => {
    await chatAttachments.ingestChatImageBuffer({ buffer: PNG_BYTES, mimeType: 'image/png' }, db);
    // assistant/tool 消息(生成产物)→ originKind=tool
    const toolResult = await chatAttachments.commitMessageMediaRefs(
      { sessionId: 'sess-1', role: 'assistant', content: `{"xdt_image_url":"${PNG_URL}"}` },
      db,
    );
    expect(toolResult).toEqual({ committed: 1, skipped: 0, failed: 0 });
    expect(db.select().from(schema.mediaRefs).all()[0].originKind).toBe('tool');
    // 同图后到的 user 消息:hasRef 幂等跳过,不覆盖 origin
    const userResult = await chatAttachments.commitMessageMediaRefs(
      { sessionId: 'sess-1', role: 'user', content: `text ${PNG_URL}` },
      db,
    );
    expect(userResult).toEqual({ committed: 0, skipped: 1, failed: 0 });
    // user 消息在新会话 → originKind=user
    await chatAttachments.commitMessageMediaRefs(
      { sessionId: 'sess-2', role: 'user', content: `text ${PNG_URL}` },
      db,
    );
    const sess2 = db.select().from(schema.mediaRefs).all().filter((r) => r.refId === 'sess-2');
    expect(sess2[0].originKind).toBe('user');
    // 无 blob 地址:返回 null(零 DB 访问的快速路径)
    await expect(
      chatAttachments.commitMessageMediaRefs({ sessionId: 'sess-1', role: 'user', content: 'plain' }, db),
    ).resolves.toBeNull();
  });

  it('非 cache 粘性降级:cache 入仓的 blob 被消息引用后 isCache 归 false(review P1)', async () => {
    // 模拟集成下载先入仓(isCache=true,吃缓存回收策略)
    const { integrationCachePut } = await import('../integrationCache');
    await integrationCachePut(
      { cacheKey: 'jira:att-1', integration: 'jira', buffer: PNG_BYTES, mimeType: 'image/png' },
      db,
    );
    expect(db.select().from(schema.mediaBlobs).all()[0].isCache).toBe(true);

    // 同 blob 的地址进了聊天消息 → commit 挂引用并降级(聊天端无重下通道)
    const result = await chatAttachments.commitChatImageUrls(
      { sessionId: 'sess-1', urls: [PNG_URL], originKind: 'tool' },
      db,
    );
    expect(result.committed).toBe(1);
    expect(db.select().from(schema.mediaBlobs).all()[0].isCache).toBe(false);

    // hasRef 幂等跳过路径同样触发降级(首次降级失败的自愈口):手工把 blob
    // 翻回 cache 再重放同消息,skip 也要降回来
    db.update(schema.mediaBlobs).set({ isCache: true }).run();
    const again = await chatAttachments.commitChatImageUrls(
      { sessionId: 'sess-1', urls: [PNG_URL], originKind: 'tool' },
      db,
    );
    expect(again).toEqual({ committed: 0, skipped: 1, failed: 0 });
    expect(db.select().from(schema.mediaBlobs).all()[0].isCache).toBe(false);
  });

  it('per-URL 故障隔离:本机无账的外来 blob 地址不连坐同消息真实附件(review P1)', async () => {
    await chatAttachments.ingestChatImageBuffer({ buffer: PNG_BYTES, mimeType: 'image/png' }, db);
    // 形状合法但本机无 blob 行的外来地址(FK 拒):排在真实附件前面
    const foreignUrl = `cindy-media://blobs/${'f'.repeat(64)}.png`;
    const result = await chatAttachments.commitChatImageUrls(
      { sessionId: 'sess-1', urls: [foreignUrl, PNG_URL] },
      db,
    );
    expect(result).toEqual({ committed: 1, skipped: 0, failed: 1 });
    const refs = db.select().from(schema.mediaRefs).all();
    expect(refs).toHaveLength(1);
    expect(refs[0].hash).toBe(PNG_HASH);
  });
});
