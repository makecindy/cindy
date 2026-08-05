/**
 * Contacts SQLite schema — 建表 DDL + PRAGMA user_version 顺序迁移。
 *
 * 为什么不走 desktop 的 drizzle localDb:
 *  - contacts 是 maker-core 的独立能力(零 electron 依赖, 未来可拆独立产品),
 *    自带单文件 SQLite 库(<basePath>/maker-contacts/contacts.db), 与 Maker Memory 的
 *    fts.db 同一注入模式(host 传 sqliteFactory), 不与 desktop localDb 耦合。
 *  - 迁移用 PRAGMA user_version 顺序执行 MIGRATIONS 数组, append-only:
 *    改 schema 就往数组尾部加一条, 绝不改历史条目(与仓库 migration 纪律一致)。
 *
 * FTS 说明:
 *  contacts_fts 是派生索引(standalone fts5, 每 contact 一行), 由 store 在写路径同步,
 *  count 不一致时全量 rebuild — 主表才是 source of truth。
 */

import type Database from 'better-sqlite3';

import { ContactsError } from './types.js';

/** append-only 迁移数组: index+1 即目标 user_version */
const MIGRATIONS: string[] = [
  // v1: 初始 schema
  `
  CREATE TABLE contacts (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('person', 'org')),
    display_name TEXT NOT NULL,
    aliases TEXT NOT NULL DEFAULT '[]',
    summary TEXT NOT NULL DEFAULT '',
    narrative TEXT NOT NULL DEFAULT '',
    agent_notes TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'pending')),
    source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'agent', 'import')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE contact_identities (
    id TEXT PRIMARY KEY,
    contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    platform TEXT NOT NULL,
    value TEXT NOT NULL,
    normalized_value TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    UNIQUE (platform, normalized_value)
  );
  CREATE INDEX idx_contact_identities_contact ON contact_identities(contact_id);

  CREATE TABLE contact_events (
    id TEXT PRIMARY KEY,
    contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    text TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_contact_events_contact ON contact_events(contact_id, date DESC);

  CREATE TABLE contact_groups (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );

  CREATE TABLE contact_group_members (
    group_id TEXT NOT NULL REFERENCES contact_groups(id) ON DELETE CASCADE,
    contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    PRIMARY KEY (group_id, contact_id)
  );
  CREATE INDEX idx_contact_group_members_contact ON contact_group_members(contact_id);

  CREATE VIRTUAL TABLE contacts_fts USING fts5(
    contact_id UNINDEXED,
    kind UNINDEXED,
    status UNINDEXED,
    name,
    aliases,
    identities,
    summary,
    narrative,
    events,
    tokenize='porter unicode61'
  );
  `,
  // v2: 关系边(人↔组织任职 / 人↔人) + FTS 加 relations 列(重建虚表, 下次
  // sanityCheck 发现 count=0 ≠ 主表自动全量回填, 不需要迁移内回填)
  `
  CREATE TABLE contact_relations (
    id TEXT PRIMARY KEY,
    from_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    to_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    relation TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    UNIQUE (from_id, to_id, relation)
  );
  CREATE INDEX idx_contact_relations_from ON contact_relations(from_id);
  CREATE INDEX idx_contact_relations_to ON contact_relations(to_id);

  DROP TABLE IF EXISTS contacts_fts;
  CREATE VIRTUAL TABLE contacts_fts USING fts5(
    contact_id UNINDEXED,
    kind UNINDEXED,
    status UNINDEXED,
    name,
    aliases,
    identities,
    summary,
    narrative,
    events,
    relations,
    tokenize='porter unicode61'
  );
  `,
];

/**
 * 初始化/迁移数据库到最新 schema。幂等; 每条迁移单事务, 失败即抛(不写坏 user_version)。
 * 注意 foreign_keys 是 per-connection PRAGMA, 每次 open 都要设 — 放这里统一处理。
 */
export function initContactsSchema(db: Database.Database): void {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  const current = db.pragma('user_version', { simple: true }) as number;
  if (current > MIGRATIONS.length) {
    // 数据库来自更新版本的 app(降级场景) — 拒绝打开, 避免旧代码写坏新 schema
    throw new ContactsError(
      'io-error',
      `contacts.db schema version ${current} is newer than supported ${MIGRATIONS.length}`,
    );
  }
  for (let v = current; v < MIGRATIONS.length; v++) {
    const sql = MIGRATIONS[v]!;
    const tx = db.transaction(() => {
      db.exec(sql);
      db.pragma(`user_version = ${v + 1}`);
    });
    tx();
  }
}

export const CONTACTS_SCHEMA_VERSION = MIGRATIONS.length;
