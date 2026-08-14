/**
 * attachmentGrantGate.test.ts — ghost 附件过户账本出生闸单测。
 * 内存 SQLite + 真实 migration 建表(与 ledger.test.ts 同 harness),直测注入
 * db 的 chatAttachmentOrigin(规则 14)。锁的语义:
 *   - 无任何引用 / 只有画廊引用(别的意识的产物,从未进过聊天)→ null = 拒;
 *   - session-attachment originKind 'user' → 'user';'tool' → 'tool';
 *   - 同图多行 'user' 优先;历史行 originKind 为空按 'user'。
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
const { chatAttachmentOrigin } = await import('../attachmentGrantGate');

const MIGRATION_0070 = path.resolve(__dirname, '../../../../drizzle/0070_woozy_harpoon.sql');
const { default: migration0071 } = (await import('../../../../drizzle/scripts/0071_bright_ultron')) as {
  default: { run: (db: Database.Database) => void };
};

const HASH = 'a'.repeat(64);

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

beforeEach(async () => {
  db = freshDb();
  await ledger.recordBlob({ hash: HASH, ext: '.jpg', mimeType: 'image/jpeg', bytes: 8 }, db);
});

describe('chatAttachmentOrigin', () => {
  it('无任何引用 → null(孤儿文件不可过户)', async () => {
    await expect(chatAttachmentOrigin(HASH, db)).resolves.toBeNull();
  });

  it('只有画廊引用(别的意识的产物,从未进过聊天)→ null = 拒', async () => {
    await ledger.addRef(
      { hash: HASH, refKind: 'ghost-gallery', refId: 'other-ghost', originKind: 'ghost' },
      db,
    );
    await expect(chatAttachmentOrigin(HASH, db)).resolves.toBeNull();
  });

  it('用户聊天附件 → user;会话内生成图 → tool', async () => {
    await ledger.addRef(
      { hash: HASH, refKind: 'session-attachment', refId: 's1', originSessionId: 's1', originKind: 'tool' },
      db,
    );
    await expect(chatAttachmentOrigin(HASH, db)).resolves.toBe('tool');
    await ledger.addRef(
      { hash: HASH, refKind: 'session-attachment', refId: 's2', originSessionId: 's2', originKind: 'user' },
      db,
    );
    // 同图多行 'user' 优先(被用户亲手发过 = 更高授权语义)。
    await expect(chatAttachmentOrigin(HASH, db)).resolves.toBe('user');
  });

  it('历史行 originKind 为空按 user(与 commitChatImageUrls 缺省语义一致)', async () => {
    await ledger.addRef(
      { hash: HASH, refKind: 'session-attachment', refId: 's3', originSessionId: 's3' },
      db,
    );
    await expect(chatAttachmentOrigin(HASH, db)).resolves.toBe('user');
  });
});
