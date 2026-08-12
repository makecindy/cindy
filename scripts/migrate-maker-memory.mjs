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
  --apply                真正执行迁移 (默认自动备份; --no-backup 显式放弃)
  --backup-dir <path>    指定备份目录 (默认 <memory-root> 的父目录下自动生成)
  --no-backup            显式放弃备份 — 冲突/未识别文件仍保留源目录, 但
                         无冲突分片删除后将不可回滚 (慎用)
  --force                宿主 (Cindy 桌面应用) 正在运行时也继续执行 —
                         默认检测到宿主进程即拒绝 (迁移会移动/删除用户
                         记忆文件, 宿主持有 Store/SQLite 句柄会冲突)
  --json                 只输出 RESULT JSON (供 agent / 脚本消费)
  --help                 显示本说明

安全:
  - 空分片直接删除; 有内容分片合并进 canonical (主仓) 分片
  - 同名不同内容 = 冲突: 不自动覆盖, 源目录保留供人工处理
  - SSH 分片 / 无 meta.json 目录不碰
  - 执行前检测宿主进程; 迁移是可恢复的数据操作, 默认必带备份

示例:
  node --import tsx scripts/migrate-maker-memory.mjs --memory-root "%APPDATA%/cindy/maker-memory" --dry-run
  node --import tsx scripts/migrate-maker-memory.mjs --memory-root "%APPDATA%/cindy/maker-memory" --apply
  node --import tsx scripts/migrate-maker-memory.mjs --memory-root "%APPDATA%/cindy/maker-memory" --apply --no-backup
`;

function parseArgs(argv) {
  const out = {
    memoryRoot: null,
    dryRun: true,
    backupDir: null,
    noBackup: false,
    force: false,
    json: false,
  };
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
    } else if (a === '--no-backup') {
      out.noBackup = true;
    } else if (a === '--force') {
      out.force = true;
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

  // --apply: 先做安全前置检查 (排他 + 备份契约, 见 #2529 行动项 2/3)
  if (!opts.noBackup && !opts.backupDir) {
    // 默认备份: <memory-root> 同级自动生成备份目录
    opts.backupDir = path.join(
      path.dirname(memoryRoot),
      `maker-memory-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`,
    );
  }
  if (!opts.noBackup && opts.backupDir) {
    process.stdout.write(`备份目录: ${path.resolve(opts.backupDir)}\n`);
  } else {
    process.stdout.write('⚠️ --no-backup: 无冲突分片删除后不可回滚\n');
  }
  if (!opts.force && (await isHostRunning())) {
    process.stderr.write(
      '❌ 检测到宿主 (Cindy 桌面应用) 正在运行 — 迁移会移动/删除用户记忆文件, ' +
        '宿主持有的 Store/SQLite 句柄会与迁移冲突 (#2529)。\n' +
        '请先退出 Cindy 再运行; 确认无活动会话时可用 --force 继续。\n',
    );
    process.exit(3);
  }

  const result = await runLegacyShardMigration(plan, {
    ...(opts.noBackup ? {} : { backupRoot: path.resolve(opts.backupDir) }),
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

/**
 * 宿主 (Cindy 桌面应用) 运行检测 (#2529 行动项 2: 排他契约)。
 * 迁移会移动/删除用户记忆文件, 宿主进程持有 MakerMemoryStore 与 SQLite
 * 句柄 — 迁移期间活动会话向旧目录写入会 ENOENT, Windows 上打开的文件还
 * 可能让 rename 本身失败。检测到宿主在跑 → 默认拒绝 apply。
 *
 * 进程名匹配 (跨平台): 检测失败 (无 tasklist/ps 等) 保守返回 false —
 * 不因检测工具缺失而阻塞正常使用, 文档/--force 兜底。
 */
async function isHostRunning() {
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);
    let out = '';
    if (process.platform === 'win32') {
      const r = await run('tasklist', ['/FO', 'CSV', '/NH']);
      out = r.stdout;
      // Windows: CSV 行 → 精确匹配 "cindy.exe" / "desktop.exe" / "electron.exe"
      // (image name 字段), 避免子串误命中无关进程
      const names = new Set(out.toLowerCase().match(/"?[a-z0-9_.\- ]+\.exe"?/g) ?? []);
      return ['cindy.exe', 'desktop.exe', 'electron.exe'].some((p) => names.has(`"${p}"`));
    }
    const r = await run('ps', ['-eo', 'comm']);
    out = r.stdout;
    // POSIX: ps -eo comm 输出每行一个命令名。精确 basename 匹配 (行级),
    // 不匹配含 desktop 的无关进程 (xdg-desktop-portal 等, Codex review on
    // #2519 第十一轮)。Electron 主进程 comm 通常是 electron; Cindy 产物
    // 可能以 cindy / CindyDev / desktop 为进程名。
    const commNames = new Set(
      out
        .toLowerCase()
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean),
    );
    return (
      commNames.has('cindy') ||
      commNames.has('cindydev') ||
      commNames.has('desktop') ||
      commNames.has('electron')
    );
  } catch {
    return false; // 检测工具缺失 → 不阻塞
  }
}

main().catch((e) => {
  process.stderr.write(`migrate-maker-memory failed: ${e?.stack ?? e}\n`);
  process.exit(1);
});
