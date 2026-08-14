#!/usr/bin/env node
/**
 * cleanup-maker-memory.mjs — 分片内清理 CLI (P0.5, #2379)。
 *
 * 对单个 memory 分片目录做整理 (归档而非删除, 全部进 `.archive/` 可逆):
 *   1. 完全重复去重 (title+description+body 一致) — 保留 updatedAt 最新一条 (自动)
 *   2. digest 精简 — 保留最新 N 份, 其余归档 (自动)
 *   3. 终态候选 (project/reference 命中终态信号词 / 时间过期) — 只报告,
 *      需 --archive-stale 显式确认才归档 (语义判断, 单靠子串不可靠)
 * 近似重复 (同 title 不同内容) 只报告, 交 memory_review/人工。
 *
 * 运行 (从仓库根):
 *   node --import tsx scripts/cleanup-maker-memory.mjs --shard <path> [--dry-run|--apply]
 *
 * 安全约定:
 *   - 默认 dry-run (只输出计划, 不修改任何文件)
 *   - --apply 只归档确定性项 (完全重复 + digest 冗余); 归档进 <shard>/.archive/
 *     不是删除, 可手工找回
 *   - 终态候选默认只报告; --archive-stale 才一并归档 (用户已确认)
 *   - --backup-dir 可选真备份; 归档/备份目标循环递增后缀, 绝不覆盖
 *   - 执行前检测宿主进程 (Cindy 桌面应用) — 持有 Store/SQLite 句柄时拒绝
 *
 * 输出格式: 人类可读报告 + 末尾一行机器可读的 `RESULT <json>`。
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import process from 'node:process';

// tsx 运行本脚本, 直接 import maker-core 源码 (同 migrate-maker-memory.mjs)。
import {
  planMemoryCleanup,
  runMemoryCleanup,
} from '../packages/maker-core/src/memory/cleanup.ts';

const HELP = `cleanup-maker-memory — 分片内清理 (P0.5, #2379)

用法:
  node --import tsx scripts/cleanup-maker-memory.mjs --shard <path> [选项]

必填:
  --shard <path>        memory 分片目录 (canonical 主仓分片, 非 maker-memory 根)

选项:
  --dry-run             只输出清理计划, 不修改任何文件 (默认)
  --apply               执行归档 (进 <shard>/.archive/, 可逆); 只归档确定性项
  --archive-stale       连同终态候选一并归档 — 终态是语义判断, 需你确认后显式开启
  --keep-digests <n>    digest 保留数 (默认 2)
  --backup-dir <path>   归档前先复制到该目录 (可选真备份)
  --force               宿主 (Cindy 桌面应用) 正在运行时也继续执行
  --json                只输出 RESULT JSON (供 agent / 脚本消费)
  --help                显示本说明

安全:
  - 清理 = 归档 (rename 进 .archive/), 不是删除; 可逆, 用户可手工找回
  - 完全重复 / digest 精简自动执行; 终态候选 + 近似重复只报告
  - 归档/备份目标循环递增后缀, 同名冲突绝不覆盖
  - SSH 分片 / 无 meta.json 目录不属于本工具范围 (那是 migrate-maker-memory 的活)
  - 执行前检测宿主进程

示例:
  node --import tsx scripts/cleanup-maker-memory.mjs --shard "%APPDATA%/cindy/maker-memory/E--repo" --dry-run
  node --import tsx scripts/cleanup-maker-memory.mjs --shard "%APPDATA%/cindy/maker-memory/E--repo" --apply
  node --import tsx scripts/cleanup-maker-memory.mjs --shard "%APPDATA%/cindy/maker-memory/E--repo" --apply --archive-stale
  node --import tsx scripts/cleanup-maker-memory.mjs --shard "%APPDATA%/cindy/maker-memory/E--repo" --apply --keep-digests 1
`;

function parseArgs(argv) {
  const out = {
    shard: null,
    dryRun: true,
    keepDigests: null,
    backupDir: null,
    archiveStale: false,
    force: false,
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') {
      process.stdout.write(HELP);
      process.exit(0);
    } else if (a === '--shard') {
      out.shard = requireOperand(argv, ++i, '--shard');
    } else if (a === '--apply') {
      out.dryRun = false;
    } else if (a === '--dry-run') {
      out.dryRun = true;
    } else if (a === '--archive-stale') {
      out.archiveStale = true;
    } else if (a === '--keep-digests') {
      const raw = argv[++i];
      const n = Number(raw);
      // 边界校验 (Greptile P1 on #2561): 0 / 负数 / 小数 / 非数字都要明确拒绝,
      // 不能靠 truthy 或 slice 语义静默误解释。0 合法 (全清 digest)。
      if (raw == null || raw === '' || !Number.isInteger(n) || n < 0) {
        process.stderr.write(`--keep-digests 必须是 >=0 的整数, 收到 "${raw}"\n`);
        process.exit(2);
      }
      out.keepDigests = n;
    } else if (a === '--backup-dir') {
      out.backupDir = requireOperand(argv, ++i, '--backup-dir');
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

/**
 * 取值型选项的操作数校验 — 拒绝缺失或「把下一个 flag 当值」的情况
 * (Codex P1 on #2561: `--apply --backup-dir --json` 会把 backupRoot 设成
 * `<repo>/--json`, 导致记忆被复制进 Git worktree)。操作数以 `-` 开头且不是
 * 负数即视为 flag, 报错退出。调用处先 `++i` 把索引推进到操作数再传入。
 */
function requireOperand(argv, idx, flag) {
  const v = argv[idx];
  if (v == null || (v.startsWith('-') && Number.isNaN(Number(v)))) {
    process.stderr.write(`${flag} 缺少参数 (收到 "${v ?? ''}")\n`);
    process.exit(2);
  }
  return v;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.shard) {
    process.stderr.write('缺少 --shard <path>\n');
    process.stderr.write(HELP);
    process.exit(2);
  }
  const shard = path.resolve(opts.shard);

  // shard 身份校验 (Codex P1 on #2561 第十九轮: validate the shard before
  // applying cleanup): --apply/--dry-run 指向已存在但非 maker-memory shard 的
  // 目录 (如 repo 根 / maker-memory 根) 时, runMemoryCleanup 的 rebuildIndex
  // 会写 <shard>/MEMORY.md — 即使 plan 为空也可能创建/覆盖 Git 跟踪或无关的
  // MEMORY.md。帮助文本声明「无 meta.json 目录不属于本工具范围」, 这里强制:
  // 目录必须存在且含 meta.json (canonical 分片身份), 否则拒绝。
  const shardStat = await fs.stat(shard).catch(() => null);
  if (shardStat === null) {
    process.stderr.write(`分片目录不存在: ${shard}\n`);
    process.exit(2);
  }
  if (!shardStat.isDirectory()) {
    process.stderr.write(`--shard 必须是目录: ${shard}\n`);
    process.exit(2);
  }
  try {
    await fs.access(path.join(shard, 'meta.json'));
  } catch {
    process.stderr.write(
      `不是 maker-memory 分片 (缺少 meta.json): ${shard}\n` +
        '  本工具只处理带 meta.json 的 canonical 分片; SSH 分片 / 手工目录属 migrate-maker-memory 范围。\n',
    );
    process.exit(2);
  }

  const plan = await planMemoryCleanup(shard, {
    // 注意: keepDigests 为 0 是合法值 (全清 digest), 用 !== null 而非 truthy。
    ...(opts.keepDigests !== null ? { keepDigests: opts.keepDigests } : {}),
  });

  const summarize = (p) => ({
    shardDir: shard,
    totalRecords: p.records.length,
    duplicates: p.duplicates.map((d) => ({ keep: d.keep, archive: d.archive })),
    nearDuplicates: p.nearDuplicates,
    staleCandidates: p.staleCandidates.map((s) => ({
      filename: s.filename,
      reason: s.reason,
      matchedSignal: s.matchedSignal ?? undefined,
      updatedAt: s.updatedAt,
    })),
    digests: p.digests,
    archiveCount: p.archiveItems.length,
  });

  if (opts.dryRun) {
    const summary = summarize(plan);
    if (!opts.json) {
      const staleSignal = summary.staleCandidates.filter((s) => s.reason === 'signal');
      const staleWeak = summary.staleCandidates.filter((s) => s.reason === 'weak-signal');
      const staleAge = summary.staleCandidates.filter((s) => s.reason === 'age');
      process.stdout.write(`分片目录: ${shard}\n`);
      process.stdout.write(`合法分片总数: ${summary.totalRecords}\n\n`);
      process.stdout.write(`完全重复 (${summary.duplicates.length} 组, 自动归档):\n`);
      for (const d of summary.duplicates) {
        process.stdout.write(`  - 保留 ${d.keep}, 归档 [${d.archive.join(', ')}]\n`);
      }
      process.stdout.write(`\n近似重复 (同 title, ${summary.nearDuplicates.length} 组, 仅报告):\n`);
      for (const n of summary.nearDuplicates) {
        process.stdout.write(`  - "${n.title}": ${n.filenames.join(', ')}\n`);
      }
      process.stdout.write(
        `\n终态候选 (信号词, ${staleSignal.length} 条, 仅报告; 确认后加 --archive-stale):\n`,
      );
      for (const s of staleSignal) {
        process.stdout.write(`  - ${s.filename} (命中 "${s.matchedSignal}")\n`);
      }
      process.stdout.write(
        `\n终态候选 (英文 broad 词, ${staleWeak.length} 条, 仅报告):\n`,
      );
      for (const s of staleWeak) {
        process.stdout.write(`  - ${s.filename} (命中 "${s.matchedSignal}")\n`);
      }
      process.stdout.write(`\n终态候选 (仅时间过期, ${staleAge.length} 条, 仅报告):\n`);
      for (const s of staleAge) {
        process.stdout.write(`  - ${s.filename} (updatedAt ${s.updatedAt})\n`);
      }
      process.stdout.write(
        `\ndigest 精简: 保留 ${summary.digests.keep.length}, 归档 ${summary.digests.archive.length}\n`,
      );
      process.stdout.write(`\n(dry-run — 未修改任何文件; 执行请加 --apply)\n`);
    }
    process.stdout.write(`RESULT ${JSON.stringify({ mode: 'dry-run', ...summary })}\n`);
    return;
  }

  // --apply: 宿主排他检测 (归档会移动用户记忆文件, 见 #2529 行动项 2)。
  const banner = (msg) => (opts.json ? process.stderr : process.stdout).write(`${msg}\n`);
  if (opts.backupDir) {
    banner(`备份目录: ${path.resolve(opts.backupDir)}`);
  }
  if (!opts.force && (await isHostRunning())) {
    process.stderr.write(
      '❌ 检测到宿主 (Cindy 桌面应用) 正在运行 — 归档会移动用户记忆文件, ' +
        '宿主持有的 Store/SQLite 句柄会与归档冲突。\n' +
        '请先退出 Cindy 再运行; 确认无活动会话时可用 --force 继续。\n',
    );
    process.exit(3);
  }

  const result = await runMemoryCleanup(plan, {
    ...(opts.backupDir ? { backupRoot: path.resolve(opts.backupDir) } : {}),
    archiveStale: opts.archiveStale,
  });

  if (!opts.json) {
    process.stdout.write(`清理完成: 归档 ${result.archived.length} 条 → ${shard}/.archive/\n`);
    for (const a of result.archived) {
      process.stdout.write(`  [${a.reason}] ${a.filename} — ${a.detail}\n`);
    }
    for (const f of result.failed) {
      process.stdout.write(`  [failed] ${f.filename} — ${f.error}\n`);
    }
  }
  process.stdout.write(
    `RESULT ${JSON.stringify({
      mode: 'apply',
      archiveStale: opts.archiveStale,
      archived: result.archived,
      failed: result.failed,
      indexRebuildError: result.indexRebuildError ?? null,
    })}\n`,
  );

  // 归档失败必须非零退出 (Codex P1 on #2561): 自动化会误把「源保留未清理」
  // 当成成功, 导致清理被静默跳过。exit 5 区分于缺参(2)/宿主(3)/索引失败(4)。
  if (result.failed.length > 0) {
    const warn = (msg) => (opts.json ? process.stderr : process.stdout).write(`${msg}\n`);
    warn(`⚠️ ${result.failed.length} 个文件归档失败, 源已保留在分片目录, 请修复后重跑。`);
    process.exit(5);
  }

  // MEMORY.md 重建失败必须暴露 (Codex P2 on #2561): 静默会让旧索引把已归档
  // 文件继续注入后续会话, 且 store.init() 只修 FTS 不重建索引。
  if (result.indexRebuildError) {
    const warn = (msg) => (opts.json ? process.stderr : process.stdout).write(`${msg}\n`);
    warn('⚠️ MEMORY.md 重建失败: ' + result.indexRebuildError);
    warn('  归档已落盘, 但旧索引可能仍引用已归档文件; 请修复索引文件权限/磁盘后重跑。');
    process.exit(4);
  }
}

/**
 * 宿主 (Cindy 桌面应用) 运行检测 — 与 migrate-maker-memory.mjs 同款逻辑
 * (#2529 行动项 2 排他契约)。归档会移动用户记忆文件, 宿主进程持有
 * MakerMemoryStore 与 SQLite 句柄时不应并发。检测工具缺失保守返回 false。
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
      const names = new Set(out.toLowerCase().match(/"?[a-z0-9_.\- ]+\.exe"?/g) ?? []);
      return ['cindy.exe', 'cindydev.exe', 'desktop.exe', 'electron.exe'].some((p) =>
        names.has(`"${p}"`),
      );
    }
    const r = await run('ps', ['-eo', 'comm']);
    out = r.stdout;
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
    return false;
  }
}

main().catch((e) => {
  process.stderr.write(`cleanup-maker-memory failed: ${e?.stack ?? e}\n`);
  process.exit(1);
});
