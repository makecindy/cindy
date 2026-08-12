#!/usr/bin/env node
/**
 * migrate-maker-memory.mjs — 存量 worktree 分片迁移 CLI (P0 第二阶段, #2379)。
 *
 * 扫描 maker-memory 根目录下所有分片, 把 #2399 合入前产生的旧 worktree
 * 分片合并进 canonical (主仓) 分片, 空分片直接删除。
 *
 * 运行 (从仓库根):
 *   node --import tsx scripts/migrate-maker-memory.mjs --memory-root <path> [--dry-run|--apply] [--backup-dir <path>]
 *
 * 安全约定:
 *   - 默认 dry-run (只输出计划, 不修改任何文件)
 *   - --apply 才真正执行
 *   - 执行前建议 --backup-dir 备份; 同名不同内容的冲突文件绝不自动覆盖,
 *     冲突分片源目录保留 (见 migrate.ts 注释)
 *   - SSH 分片 (目录名 ssh- 前缀) / 无 meta.json 的目录一律不碰
 *
 * 输出格式: 人类可读报告 + 末尾一行机器可读的 `RESULT <json>`。
 */

import * as path from 'node:path';
import process from 'node:process';

// tsx 运行本脚本, 直接 import maker-core 源码 (同 browser-capability-benchmark)
import {
  planLegacyShardMigration,
  runLegacyShardMigration,
} from '../packages/maker-core/src/memory/migrate.ts';

const HELP = `migrate-maker-memory — 存量 worktree 分片迁移 (P0 第二阶段, #2379)

用法:
  node --import tsx scripts/migrate-maker-memory.mjs --memory-root <path> [选项]

必填:
  --memory-root <path>   maker-memory 根目录 (分片目录的直接父目录)

选项:
  --dry-run              只输出迁移计划, 不修改任何文件 (默认)
  --apply                真正执行迁移
  --backup-dir <path>    执行前把受影响分片备份到该目录 (建议提供)
  --json                 只输出 RESULT JSON (供 agent / 脚本消费)
  --help                 显示本说明

安全:
  - 空分片直接删除; 有内容分片合并进 canonical (主仓) 分片
  - 同名不同内容 = 冲突: 不自动覆盖, 源目录保留供人工处理
  - SSH 分片 / 无 meta.json 目录不碰

示例:
  node --import tsx scripts/migrate-maker-memory.mjs --memory-root "%APPDATA%/cindy/maker-memory" --dry-run
  node --import tsx scripts/migrate-maker-memory.mjs --memory-root "%APPDATA%/cindy/maker-memory" --apply --backup-dir "%APPDATA%/cindy/maker-memory-backup"
`;

function parseArgs(argv) {
  const out = { memoryRoot: null, dryRun: true, backupDir: null, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') {
      process.stdout.write(HELP);
      process.exit(0);
    } else if (a === '--memory-root') {
      out.memoryRoot = argv[++i] ?? null;
    } else if (a === '--apply') {
      out.dryRun = false;
    } else if (a === '--dry-run') {
      out.dryRun = true;
    } else if (a === '--backup-dir') {
      out.backupDir = argv[++i] ?? null;
    } else if (a === '--json') {
      out.json = true;
    } else {
      process.stderr.write(`未知参数: ${a}\n`);
      process.stderr.write(HELP);
      process.exit(2);
    }
  }
  return out;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.memoryRoot) {
    process.stderr.write('缺少 --memory-root <path>\n');
    process.stderr.write(HELP);
    process.exit(2);
  }
  const memoryRoot = path.resolve(opts.memoryRoot);

  const plan = await planLegacyShardMigration(memoryRoot);

  const summarize = (p) => ({
    memoryRoot,
    totalShards: p.all.length,
    legacy: p.emptyToDelete.length + p.mergeCandidates.length,
    emptyToDelete: p.emptyToDelete.map((s) => s.dir),
    mergeCandidates: p.mergeCandidates.map((s) => ({
      from: s.dir,
      to: path.join(memoryRoot, s.canonicalDirName),
      records: s.recordCount,
    })),
    skipped: p.skipped.map((s) => s.dir),
  });

  if (opts.dryRun) {
    const summary = summarize(plan);
    if (!opts.json) {
      process.stdout.write(`maker-memory 根: ${memoryRoot}\n`);
      process.stdout.write(`分片总数: ${summary.totalShards} (legacy ${summary.legacy})\n`);
      process.stdout.write(`\n空分片待删除 (${summary.emptyToDelete.length}):\n`);
      for (const d of summary.emptyToDelete) process.stdout.write(`  - ${d}\n`);
      process.stdout.write(`\n有内容待合并 (${summary.mergeCandidates.length}):\n`);
      for (const m of summary.mergeCandidates) {
        process.stdout.write(
          `  - ${m.from} (${m.records} 条)\n    → ${m.to}\n`,
        );
      }
      process.stdout.write(`\n跳过不处理 (${summary.skipped.length}):\n`);
      for (const d of summary.skipped) process.stdout.write(`  - ${d}\n`);
      process.stdout.write('\n(dry-run — 未修改任何文件; 执行请加 --apply)\n');
    }
    process.stdout.write(`RESULT ${JSON.stringify({ mode: 'dry-run', ...summary })}\n`);
    return;
  }

  // --apply
  const result = await runLegacyShardMigration(plan, {
    ...(opts.backupDir ? { backupRoot: path.resolve(opts.backupDir) } : {}),
  });

  const lines = result.results.map((r) => ({
    dir: r.shard.dir,
    action: r.action,
    records: r.shard.recordCount,
    mergedFiles: r.mergedFiles ?? undefined,
    error: r.error ?? undefined,
  }));
  const conflicts = result.conflicts.map((c) => ({ dir: c.dir, filename: c.filename }));

  if (!opts.json) {
    process.stdout.write(`迁移完成: ${lines.length} 个分片处理\n\n`);
    for (const l of lines) {
      process.stdout.write(`[${l.action}] ${l.dir}${l.error ? ` — ${l.error}` : ''}\n`);
      if (l.mergedFiles) {
        for (const m of l.mergedFiles) {
          process.stdout.write(`    ${m.outcome.padEnd(20)} ${m.filename}\n`);
        }
      }
    }
    if (conflicts.length > 0) {
      process.stdout.write(`\n⚠️ 冲突 (${conflicts.length}) — 源目录保留, 请人工处理:\n`);
      for (const c of conflicts) {
        process.stdout.write(`  - ${c.dir}/${c.filename}\n`);
      }
    }
  }
  process.stdout.write(
    `RESULT ${JSON.stringify({ mode: 'apply', backupDir: opts.backupDir ?? null, shards: lines, conflicts })}\n`,
  );
}

main().catch((e) => {
  process.stderr.write(`migrate-maker-memory failed: ${e?.stack ?? e}\n`);
  process.exit(1);
});
