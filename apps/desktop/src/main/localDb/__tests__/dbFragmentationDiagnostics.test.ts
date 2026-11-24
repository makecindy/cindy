import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { inspectDatabaseFragmentation } from '../dbFragmentationDiagnostics';

// 测试价值（engineering-conventions.md §3.2）：
// 1. 依据：toolResults.compactSession 原地把大体积 tool_result 缩成 ~97B 后，auto_vacuum=0 的主库
//    freelist_count 仍可能为 0，真实膨胀隐藏在 B-tree 页内 unused 空间中；只读诊断不得写入业务数据或触发 checkpoint。
// 2. 覆盖缺口：既有测试未覆盖 dbstat 实测页内碎片统计，以及第二连接持有未提交 WAL 写事务时的并发只读诊断。
// 3. 最小失败输入：freelist=0 但原地 UPDATE 留下半空页的合成库，以及并发 BEGIN IMMEDIATE 写事务下的巡检调用。
// 4. tier：unit（仅使用临时目录合成库，单文件耗时 < 1s）。
describe('inspectDatabaseFragmentation', () => {
  let tmpDir: string;
  let dbFilePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-db-frag-'));
    dbFilePath = path.join(tmpDir, 'synthetic.db');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reports direct dbstat in-page unused bytes even when freelist_count is zero', () => {
    const db = new Database(dbFilePath);
    try {
      db.pragma('journal_mode = WAL');
      db.exec(`
        CREATE TABLE messages (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          content TEXT NOT NULL
        );
      `);
      const insert = db.prepare('INSERT INTO messages (id, session_id, content) VALUES (?, ?, ?)');
      const seed = db.transaction(() => {
        for (let i = 0; i < 200; i += 1) {
          insert.run(`m-${i}`, 's-1', 'x'.repeat(1500));
        }
      });
      seed();
      db.prepare(
        `UPDATE messages SET content = '{"type":"tool_result_compacted","version":1}'`,
      ).run();
      db.pragma('wal_checkpoint(TRUNCATE)');
    } finally {
      db.close();
    }

    const report = inspectDatabaseFragmentation(dbFilePath, { topLimit: 5 });
    expect(report.mainBytes).toBeGreaterThan(200 * 1024);
    expect(report.walBytes).toBe(0);
    if (report.dbstatUnusedBytes !== null) {
      expect(report.dbstatUnusedBytes).toBeGreaterThan(150 * 1024);
      expect(report.topObjects[0]?.name).toBe('messages');
      expect(report.topObjects[0]?.unusedBytes).toBeGreaterThan(150 * 1024);
    }
  });

  it('reads safely alongside an active WAL writer without writing application data or triggering a checkpoint', () => {
    const writer = new Database(dbFilePath);
    try {
      writer.pragma('journal_mode = WAL');
      writer.exec('CREATE TABLE messages (id TEXT PRIMARY KEY, content TEXT NOT NULL)');
      writer.prepare('INSERT INTO messages VALUES (?, ?)').run('m-1', 'committed-in-wal');
      const walBefore = fs.statSync(`${dbFilePath}-wal`).size;
      expect(walBefore).toBeGreaterThan(0);

      writer.exec('BEGIN IMMEDIATE');
      writer.prepare('INSERT INTO messages VALUES (?, ?)').run('m-2', 'in-flight-write');

      const report = inspectDatabaseFragmentation(dbFilePath, { topLimit: 3 });
      expect(report.walBytes).toBeGreaterThanOrEqual(walBefore);

      writer.exec('COMMIT');
      expect(writer.prepare('SELECT COUNT(*) AS count FROM messages').get()).toEqual({ count: 2 });
    } finally {
      writer.close();
    }
  });

  it('throws when the target database file does not exist instead of creating an empty file', () => {
    const missingPath = path.join(tmpDir, 'does-not-exist.db');
    expect(() => inspectDatabaseFragmentation(missingPath)).toThrow();
    expect(fs.existsSync(missingPath)).toBe(false);
  });
});
