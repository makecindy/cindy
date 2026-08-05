/**
 * MakerContactsManager 单测 — lazy open / 实例复用 / dispose / 落盘路径与持久化。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import DatabaseCtor from 'better-sqlite3';

import { MakerContactsManager } from '../manager.js';
import type { Logger } from '../../interfaces/logger.js';

function noopLogger(): Logger {
  const noop = () => {};
  const l: Logger = {
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
    child: () => l,
  };
  return l;
}

describe('MakerContactsManager', () => {
  let tmpDir: string;

  beforeEach(() => {
    // 凭证不入仓红线: 测试路径一律走 os.tmpdir()
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maker-contacts-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const makeManager = () =>
    new MakerContactsManager({
      basePath: tmpDir,
      sqliteFactory: (p) => new DatabaseCtor(p),
      logger: noopLogger(),
    });

  it('lazy open: 建目录 + 落库文件, 同实例复用', () => {
    const mgr = makeManager();
    expect(mgr.hasStore()).toBe(false);
    const store = mgr.getStore();
    expect(mgr.hasStore()).toBe(true);
    expect(fs.existsSync(mgr.getDbPath())).toBe(true);
    expect(mgr.getDbPath()).toBe(path.join(tmpDir, 'maker-contacts', 'contacts.db'));
    expect(mgr.getStore()).toBe(store);
    mgr.dispose();
  });

  it('数据跨 manager 实例持久(重开库能读回)', () => {
    const mgr = makeManager();
    const created = mgr.getStore().createContact({
      kind: 'person',
      displayName: '张三',
      identities: [{ platform: 'email', value: 'zhang@example.com' }],
    });
    mgr.dispose();

    const mgr2 = makeManager();
    const hits = mgr2.getStore().resolve('zhang@example.com');
    expect(hits[0]!.profile.id).toBe(created.id);
    mgr2.dispose();
  });

  it('dispose 幂等, dispose 后可重新 getStore', () => {
    const mgr = makeManager();
    mgr.getStore();
    mgr.dispose();
    mgr.dispose();
    expect(mgr.hasStore()).toBe(false);
    expect(() => mgr.getStore().stats()).not.toThrow();
    mgr.dispose();
  });

  it('v1 库升级到 v2: 老数据保留 + relations 可用 + FTS 重建', () => {
    // 用 v1 时刻的 SQL 手工造一个旧库(相当于线上已有数据的用户升级)
    const dbPath = path.join(tmpDir, 'maker-contacts', 'contacts.db');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const raw = new DatabaseCtor(dbPath);
    raw.exec(`
      CREATE TABLE contacts (id TEXT PRIMARY KEY, kind TEXT NOT NULL, display_name TEXT NOT NULL,
        aliases TEXT NOT NULL DEFAULT '[]', summary TEXT NOT NULL DEFAULT '', narrative TEXT NOT NULL DEFAULT '',
        agent_notes TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'confirmed',
        source TEXT NOT NULL DEFAULT 'manual', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE contact_identities (id TEXT PRIMARY KEY, contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
        platform TEXT NOT NULL, value TEXT NOT NULL, normalized_value TEXT NOT NULL, label TEXT NOT NULL DEFAULT '',
        note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, UNIQUE (platform, normalized_value));
      CREATE TABLE contact_events (id TEXT PRIMARY KEY, contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
        date TEXT NOT NULL, text TEXT NOT NULL, source TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
      CREATE TABLE contact_groups (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
      CREATE TABLE contact_group_members (group_id TEXT NOT NULL, contact_id TEXT NOT NULL, PRIMARY KEY (group_id, contact_id));
      CREATE VIRTUAL TABLE contacts_fts USING fts5(contact_id UNINDEXED, kind UNINDEXED, status UNINDEXED,
        name, aliases, identities, summary, narrative, events, tokenize='porter unicode61');
      INSERT INTO contacts VALUES ('old-1','person','旧用户','[]','v1 时代的数据','','','confirmed','manual','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z');
      PRAGMA user_version = 1;
    `);
    raw.close();

    const mgr = makeManager();
    const store = mgr.getStore(); // init → v2 迁移 + FTS 重建
    const old = store.getContact('old-1');
    expect(old.displayName).toBe('旧用户');
    expect(old.relations).toEqual([]);
    expect(store.search('v1 时代').map((h) => h.contactId)).toContain('old-1');
    // 新表可用
    const org = store.createContact({ kind: 'org', displayName: 'O' });
    expect(store.addRelation('old-1', { toId: org.id, relation: '任职' }).relation).toBe('任职');
    mgr.dispose();
  });

  it('resetAll 透传', () => {
    const mgr = makeManager();
    mgr.getStore().createContact({ kind: 'person', displayName: 'x' });
    expect(mgr.resetAll().removedCount).toBe(1);
    mgr.dispose();
  });
});
