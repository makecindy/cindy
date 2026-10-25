/**
 * Schema drift（迁移漂移）的纯检测核心。
 *
 * 调用方负责解析 drizzle 目录与记录 warning；这里只按给定目录读
 * migration_history，并把不可读状态降级为 unknown，避免检测逻辑阻断启动。
 */

import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';

import { hashMigrationFile } from './migrationRunner.js';

export interface DriftEntry {
  seq: number;
  fileName: string;
  recordedHash: string;
  /** 当前磁盘 hash；null = 文件不存在。 */
  currentHash: string | null;
  kind: 'drifted' | 'missing';
}

export type DriftStatus = 'clean' | 'drifted' | 'unknown';

export interface DriftReport {
  /** unknown 表示检测失败或检测不完整，调用方可 fail-open 但不能当作 clean。 */
  status: DriftStatus;
  /** 出问题的 migration 列表（只在 status='drifted' 时非空）。 */
  entries: DriftEntry[];
}

export type SchemaDriftWarning =
  | { kind: 'queryFailed'; error: unknown }
  | { kind: 'hashFailed'; fileName: string; error: unknown };

interface HistoryRow {
  seq: number;
  file_name: string;
  content_hash: string;
}

export function detectSchemaDriftInDir(
  db: Database.Database,
  drizzleDir: string,
  onWarning?: (warning: SchemaDriftWarning) => void,
): DriftReport {
  if (!tableExists(db, 'migration_history')) {
    return { status: 'unknown', entries: [] };
  }

  let rows: HistoryRow[];
  try {
    rows = db
      .prepare(`SELECT seq, file_name, content_hash FROM migration_history`)
      .all() as HistoryRow[];
  } catch (err) {
    onWarning?.({ kind: 'queryFailed', error: err });
    return { status: 'unknown', entries: [] };
  }

  const entries: DriftEntry[] = [];
  let incomplete = false;
  for (const row of rows) {
    const filePath = path.join(drizzleDir, row.file_name);
    if (!fs.existsSync(filePath)) {
      entries.push({
        seq: row.seq,
        fileName: row.file_name,
        recordedHash: row.content_hash,
        currentHash: null,
        kind: 'missing',
      });
      continue;
    }
    let currentHash: string;
    try {
      currentHash = hashMigrationFile(filePath);
    } catch (err) {
      onWarning?.({ kind: 'hashFailed', fileName: row.file_name, error: err });
      incomplete = true;
      continue;
    }
    if (currentHash !== row.content_hash) {
      entries.push({
        seq: row.seq,
        fileName: row.file_name,
        recordedHash: row.content_hash,
        currentHash,
        kind: 'drifted',
      });
    }
  }

  return {
    status: entries.length > 0 ? 'drifted' : incomplete ? 'unknown' : 'clean',
    entries,
  };
}

function tableExists(db: Database.Database, name: string): boolean {
  return !!db
    .prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`)
    .get(name);
}
