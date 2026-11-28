/**
 * 本地 SQLite 数据库只读空间与页内碎片诊断 CLI。
 *
 * 以 `readonly: true` 打开目标库，直接输出 `page_count`、`freelist_count` 与 `dbstat` 实测未用空间；
 * 不写入任何业务数据，不挂载触发器，也不主动触发 WAL checkpoint。
 *
 * 用法：
 *   pnpm --filter desktop run db:inspect -- --db "<path/to/cindy-xxx.db>" [--top 10]
 */
import path from 'node:path';

import { inspectDatabaseFragmentation } from '../src/main/localDb/dbFragmentationDiagnostics.js';

interface ParsedArgs {
  dbFilePath: string;
  topLimit: number;
}

function formatMiB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

function printUsage(): void {
  process.stdout.write(
    [
      'Usage: pnpm --filter desktop run db:inspect -- --db <db-file> [--top <n>]',
      '',
      'Read-only diagnostics (writes no application data and triggers no WAL checkpoint):',
      '  --db <path>    Path to SQLite database file (required)',
      '  --top <n>      Number of largest tables/indexes to report from dbstat (default: 10)',
      '',
    ].join('\n'),
  );
}

function parseArgs(argv: string[]): ParsedArgs | null {
  let dbFilePath = '';
  let topLimit = 10;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') continue;
    if (arg === '--help' || arg === '-h') {
      printUsage();
      return null;
    }
    if (arg === '--db') {
      dbFilePath = argv[++i] ?? '';
    } else if (arg === '--top') {
      const parsed = Number(argv[++i]);
      if (!Number.isInteger(parsed) || parsed < 0 || parsed > 50) {
        throw new Error('--top must be an integer between 0 and 50');
      }
      topLimit = parsed;
    } else {
      throw new Error(`Unsupported argument: ${arg} (this tool is read-only)`);
    }
  }

  if (!dbFilePath) {
    printUsage();
    throw new Error('--db <path> is required');
  }

  return {
    dbFilePath: path.resolve(dbFilePath),
    topLimit,
  };
}

function main(): void {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed) return;

  const report = inspectDatabaseFragmentation(parsed.dbFilePath, {
    topLimit: parsed.topLimit,
  });

  process.stdout.write(
    `${JSON.stringify(
      {
        mode: 'readonly-inspect',
        dbName: path.basename(report.dbFilePath),
        mainSize: formatMiB(report.mainBytes),
        walSize: formatMiB(report.walBytes),
        totalSize: formatMiB(report.totalBytes),
        pageSize: report.pageSize,
        pageCount: report.pageCount,
        freelistPages: report.freelistCount,
        freelistSize: formatMiB(report.freelistBytes),
        autoVacuum: report.autoVacuum,
        dbstatUnused:
          report.dbstatUnusedBytes === null ? 'unavailable' : formatMiB(report.dbstatUnusedBytes),
        topObjects: report.topObjects.map((item) => ({
          name: item.name,
          pages: item.pages,
          size: formatMiB(item.totalBytes),
          unused: formatMiB(item.unusedBytes),
        })),
      },
      null,
      2,
    )}\n`,
  );
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
