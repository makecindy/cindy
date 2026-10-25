/**
 * 已发布 migration 的已知等价 hash 兼容层。
 *
 * 这里只收敛经过人工确认、最终 schema 完全相同的精确 hash 迁移；未知 hash 仍保留为
 * drift，让正式版继续告警。更新只改 migration_history 的校验元数据，不执行 DDL，
 * 也不触碰用户业务数据。
 */

import type Database from 'better-sqlite3';

import type { DriftEntry, DriftReport } from './schemaDriftCore';

/** 一次已确认等价的历史 migration hash 变更。from/to 必须都是完整 sha256。 */
interface KnownEquivalentMigrationHash {
  seq: number;
  fileName: string;
  from: string;
  to: string;
}

/**
 * 0067 发布后只把 CREATE TABLE 改成了 CREATE TABLE IF NOT EXISTS；目标表结构没有变化。
 * 旧正式版用户记录的是 from，新正式版随包文件是 to。
 */
const KNOWN_EQUIVALENT_MIGRATION_HASHES: readonly KnownEquivalentMigrationHash[] = [
  {
    seq: 67,
    fileName: '0067_freezing_molecule_man.sql',
    from: '5f7a4e6b5fa4ac55299acab47e9d085eeabfc488e642a9c0af7e4c20c9b9e02f',
    to: '71a1a1f0c17cb33012d1f6f30c471708772bbe77418aa9bf2ef096e74953a06e',
  },
];

/** 一条已经从历史 hash 收敛到当前 canonical hash 的记录。 */
export interface ReconciledMigrationHash {
  seq: number;
  fileName: string;
  from: string;
  to: string;
}

/** 一条未能收敛、必须继续按 drift 告警的记录及失败原因。 */
export interface MigrationHashReconcileFailure {
  entry: DriftEntry;
  error: unknown;
}

/** 兼容收敛后的 drift 报告、已修复记录和失败记录。 */
export interface MigrationHashReconcileResult {
  report: DriftReport;
  reconciled: ReconciledMigrationHash[];
  failures: MigrationHashReconcileFailure[];
}

/**
 * 用 compare-and-swap 方式收敛已知等价 hash。
 *
 * WHERE 同时约束 seq/file/hash，避免并发变化或未知 drift 被误覆盖。写入失败时保留原
 * drift entry 交给上层告警，绝不把失败伪装成 clean。
 */
export function reconcileKnownEquivalentMigrationHashes(
  db: Database.Database,
  report: DriftReport,
): MigrationHashReconcileResult {
  if (report.status !== 'drifted') {
    return { report, reconciled: [], failures: [] };
  }

  const remaining: DriftEntry[] = [];
  const reconciled: ReconciledMigrationHash[] = [];
  const failures: MigrationHashReconcileFailure[] = [];
  let update: Database.Statement;
  try {
    update = db.prepare(
      `UPDATE migration_history
       SET content_hash = ?
       WHERE seq = ? AND file_name = ? AND content_hash = ?`,
    );
  } catch (error) {
    return {
      report,
      reconciled,
      failures: report.entries.map((entry) => ({ entry, error })),
    };
  }

  for (const entry of report.entries) {
    const known = KNOWN_EQUIVALENT_MIGRATION_HASHES.find(
      (candidate) =>
        candidate.seq === entry.seq &&
        candidate.fileName === entry.fileName &&
        candidate.from === entry.recordedHash &&
        candidate.to === entry.currentHash,
    );
    if (!known) {
      remaining.push(entry);
      continue;
    }

    try {
      const result = update.run(known.to, known.seq, known.fileName, known.from);
      if (result.changes !== 1) {
        remaining.push(entry);
        failures.push({
          entry,
          error: new Error('migration_history changed before compatibility update'),
        });
        continue;
      }
      reconciled.push({
        seq: known.seq,
        fileName: known.fileName,
        from: known.from,
        to: known.to,
      });
    } catch (error) {
      remaining.push(entry);
      failures.push({ entry, error });
    }
  }

  return {
    report:
      remaining.length > 0
        ? { status: 'drifted', entries: remaining }
        : { status: 'clean', entries: [] },
    reconciled,
    failures,
  };
}
