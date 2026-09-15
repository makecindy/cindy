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
 *   - --apply --archive-stale 必须绑 dry-run 审阅集 (--from-plan), 不重扫新 stale
 *   - --backup-dir 可选真备份; 归档/备份目标循环递增后缀, 绝不覆盖
 *   - 执行前检测宿主进程 (Cindy 桌面应用) — 持有 Store/SQLite 句柄时拒绝;
    检测失败 (缺 tasklist/ps、权限拒绝) 同样拒绝, 须显式 --force
  - --apply 在宿主检查后持有分片排他锁直到归档/rebuild 结束; 检测不是一次性快照
 *
 * 输出格式: 人类可读报告 + 末尾一行机器可读的 `RESULT <json>`。
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

// tsx 运行本脚本, 直接 import maker-core 源码 (同 migrate-maker-memory.mjs)。
import {
  acquireCleanupExclusiveLock,
  bindReviewedStaleCandidates,
  CleanupLockError,
  isCindyHostComm,
  normalizeProcessComm,
  parseCleanupCliArgs,
  parseReviewedStalePlan,
  planMemoryCleanup,
  releaseCleanupExclusiveLock,
  requireFromPlanForArchiveStale,
  resolveReviewedKeepDigests,
  runMemoryCleanup,
  staleSetFingerprint,
} from '../packages/maker-core/src/memory/cleanup.ts';

export { isCindyHostComm, normalizeProcessComm };

const HELP = `cleanup-maker-memory — 分片内清理 (P0.5, #2379)

用法:
  node --import tsx scripts/cleanup-maker-memory.mjs --shard <path> [选项]

必填:
  --shard <path>        memory 分片目录 (canonical 主仓分片, 非 maker-memory 根)

选项:
  --dry-run             只输出清理计划, 不修改任何文件 (默认)
  --apply               执行归档 (进 <shard>/.archive/, 可逆); 只归档确定性项
  --archive-stale       连同终态候选一并归档 — 终态是语义判断, 需你确认后显式开启
  --write-plan <path>   dry-run 把审阅集 (含 expectedHash) 写到该文件
  --from-plan <path>    apply 绑定 dry-run 审阅集; --apply --archive-stale 必填
  --stale-set-hash <hex>  apply 时 live 终态指纹须等于 dry-run RESULT.staleFingerprint
  --confirm-stale-diff  live 比审阅集多出新终态时仍只归档审阅集 (须显式确认)
  --keep-digests <n>    digest 保留数 (默认 2)
  --backup-dir <path>   归档前先复制到该目录 (可选真备份)
  --force               宿主 (Cindy 桌面应用) 正在运行时也继续执行
  --json                只输出 RESULT JSON (供 agent / 脚本消费)
  --help                显示本说明

安全:
  - 清理 = 归档 (rename 进 .archive/), 不是删除; 可逆, 用户可手工找回
  - 完全重复 / digest 精简自动执行; 终态候选 + 近似重复只报告
  - --apply --archive-stale 只归档 --from-plan 里审阅过的终态集, 新命中须重新 dry-run
  - 归档/备份目标循环递增后缀, 同名冲突绝不覆盖
  - SSH 分片 / 无 meta.json 目录不属于本工具范围 (那是 migrate-maker-memory 的活)
  - 执行前检测宿主进程; --apply 持有分片排他锁直到归档/rebuild 结束

示例:
  node --import tsx scripts/cleanup-maker-memory.mjs --shard "%APPDATA%/cindy/maker-memory/E--repo" --dry-run
  node --import tsx scripts/cleanup-maker-memory.mjs --shard "%APPDATA%/cindy/maker-memory/E--repo" --apply
  node --import tsx scripts/cleanup-maker-memory.mjs --shard "%APPDATA%/cindy/maker-memory/E--repo" --dry-run --archive-stale --write-plan plan.json
  node --import tsx scripts/cleanup-maker-memory.mjs --shard "%APPDATA%/cindy/maker-memory/E--repo" --apply --from-plan plan.json
  node --import tsx scripts/cleanup-maker-memory.mjs --shard "%APPDATA%/cindy/maker-memory/E--repo" --apply --keep-digests 1

  --apply --from-plan 使用审阅文件里的 keepDigests (dry-run --keep-digests N 写入),
  CLI 省略 --keep-digests 时不得回落到默认 2。
`;

function parseArgs(argv) {
  const parsed = parseCleanupCliArgs(argv);
  if (parsed.help) {
    process.stdout.write(HELP);
    process.exit(0);
  }
  return parsed.options;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.shard) {
    process.stderr.write('缺少 --shard <path>\n');
    process.stderr.write(HELP);
    process.exit(2);
  }
  const shard = path.resolve(opts.shard);

  // shard 身份校验 (Codex P1 on #2561 第十九/二十轮: validate the shard
  // before applying cleanup): --apply/--dry-run 指向已存在但非 maker-memory
  // shard 的目录 (如 repo 根 / maker-memory 根) 时, runMemoryCleanup 的
  // rebuildIndex 会写 <shard>/MEMORY.md — 即使 plan 为空也可能创建/覆盖 Git
  // 跟踪或无关的 MEMORY.md。帮助文本声明「无 meta.json 目录不属于本工具
  // 范围」, 这里强制: 目录必须存在且含**形态正确**的 meta.json (canonical
  // 分片身份), 否则拒绝。
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
    // 只检查可访问不够 — 任意项目/根目录若恰好含有自己的 meta.json 也会
    // 通过 (Codex P1 on #2561 第二十轮: require real shard metadata)。
    // 验证 MemoryStorageMeta 结构 (absPath/createdAt/lastUsedAt 三字段)。
    const metaRaw = await fs.readFile(path.join(shard, 'meta.json'), 'utf8');
    const meta = JSON.parse(metaRaw);
    if (
      typeof meta !== 'object' ||
      meta === null ||
      typeof meta.absPath !== 'string' ||
      typeof meta.createdAt !== 'string' ||
      typeof meta.lastUsedAt !== 'string'
    ) {
      throw new Error('meta.json shape mismatch');
    }
  } catch {
    process.stderr.write(
      `不是 maker-memory 分片 (meta.json 缺失或格式不符): ${shard}\n` +
        '  分片 meta.json 需为 MakerMemoryStorageMeta (absPath/createdAt/lastUsedAt); ' +
        'SSH 分片 / 手工目录属 migrate-maker-memory 范围。\n',
    );
    process.exit(2);
  }

  // --from-plan 必须在 planMemoryCleanup 之前读入: dry-run 写入的 keepDigests
  // 是审阅过的保留窗口, apply 省略 CLI flag 时不得回落到默认 2
  // (Codex P1 on #2561: Honor the reviewed digest retention setting)。
  /** @type {import('../packages/maker-core/src/memory/cleanup.ts').ReviewedStalePlanFile | null} */
  let reviewedPlan = null;
  if (opts.fromPlan) {
    if (opts.dryRun) {
      process.stderr.write('--from-plan 仅用于 --apply, dry-run 请用 --write-plan。\n');
      process.exit(2);
    }
    try {
      const raw = JSON.parse(await fs.readFile(path.resolve(opts.fromPlan), 'utf8'));
      reviewedPlan = parseReviewedStalePlan(raw);
    } catch (e) {
      process.stderr.write(`--from-plan 无效: ${e?.message ?? e}\n`);
      process.exit(2);
    }
    if (reviewedPlan.shardDir && path.resolve(reviewedPlan.shardDir) !== shard) {
      process.stderr.write(
        `--from-plan 的 shardDir 与 --shard 不一致:\n  plan: ${reviewedPlan.shardDir}\n  shard: ${shard}\n`,
      );
      process.exit(2);
    }
  }

  let keepDigests;
  try {
    keepDigests = resolveReviewedKeepDigests(
      opts.keepDigests,
      reviewedPlan && typeof reviewedPlan.keepDigests === 'number'
        ? reviewedPlan.keepDigests
        : undefined,
    );
  } catch (e) {
    process.stderr.write(`${e?.message ?? e}\n`);
    process.exit(2);
  }

  const plan = await planMemoryCleanup(shard, {
    // 注意: keepDigests 为 0 是合法值 (全清 digest), 用 !== null 而非 truthy。
    ...(keepDigests !== null ? { keepDigests } : {}),
  });

  // --archive-stale 时 apply 会把全部 staleCandidates 加入归档 — dry-run
  // 必须如实反映实际归档量 (Codex P1 on #2561 第二十二轮: reflect stale
  // archiving in dry-run output), 否则用户/自动化会批准一个比实际更小的清理。
  // 同一文件可既是完全重复又命中 stale — apply 第一次归档后第二次 ENOENT
  // 跳过, dry-run 应按 filename 去重后再计数 (Codex P2 on #2561)。
  const uniqueArchiveFilenames = (p, archiveStale = false) => {
    const names = new Set(p.archiveItems.map((i) => i.filename));
    if (archiveStale) {
      for (const c of p.staleCandidates) names.add(c.filename);
    }
    return names;
  };

  const serializeStale = (s) => ({
    filename: s.filename,
    reason: s.reason,
    matchedSignal: s.matchedSignal ?? undefined,
    updatedAt: s.updatedAt,
    expectedHash: s.expectedHash,
  });

  const summarize = (p, archiveStale = false) => ({
    shardDir: shard,
    totalRecords: p.records.length,
    duplicates: p.duplicates.map((d) => ({ keep: d.keep, archive: d.archive })),
    nearDuplicates: p.nearDuplicates,
    staleCandidates: p.staleCandidates.map(serializeStale),
    staleFingerprint: staleSetFingerprint(p.staleCandidates),
    digests: p.digests,
    archiveCount: uniqueArchiveFilenames(p, archiveStale).size,
  });

  if (opts.dryRun) {
    const summary = summarize(plan, opts.archiveStale);
    if (opts.writePlan) {
      const planPath = path.resolve(opts.writePlan);
      await fs.writeFile(
        planPath,
        JSON.stringify(
          {
            version: 1,
            shardDir: shard,
            keepDigests: keepDigests ?? 2,
            archiveStale: opts.archiveStale,
            staleFingerprint: summary.staleFingerprint,
            staleCandidates: summary.staleCandidates,
          },
          null,
          2,
        ) + '\n',
        'utf8',
      );
      if (!opts.json) {
        process.stdout.write(`已写入审阅计划: ${planPath}\n`);
      }
    }
    if (!opts.json) {
      const staleSignal = summary.staleCandidates.filter((s) => s.reason === 'signal');
      const staleWeak = summary.staleCandidates.filter((s) => s.reason === 'weak-signal');
      const staleAge = summary.staleCandidates.filter((s) => s.reason === 'age');
      const staleLabel = opts.archiveStale ? '将归档 (--archive-stale)' : '仅报告; 确认后加 --archive-stale';
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
      process.stdout.write(`\n终态候选 (信号词, ${staleSignal.length} 条, ${staleLabel}):\n`);
      for (const s of staleSignal) {
        process.stdout.write(`  - ${s.filename} (命中 "${s.matchedSignal}")\n`);
      }
      process.stdout.write(
        `\n终态候选 (英文 broad 词, ${staleWeak.length} 条, ${staleLabel}):\n`,
      );
      for (const s of staleWeak) {
        process.stdout.write(`  - ${s.filename} (命中 "${s.matchedSignal}")\n`);
      }
      process.stdout.write(`\n终态候选 (仅时间过期, ${staleAge.length} 条, ${staleLabel}):\n`);
      for (const s of staleAge) {
        process.stdout.write(`  - ${s.filename} (updatedAt ${s.updatedAt})\n`);
      }
      process.stdout.write(
        `\ndigest 精简: 保留 ${summary.digests.keep.length}, 归档 ${summary.digests.archive.length}\n`,
      );
      process.stdout.write(`\n预计归档总数: ${summary.archiveCount} 条\n`);
      process.stdout.write(`\n(dry-run — 未修改任何文件; 执行请加 --apply)\n`);
    }
    process.stdout.write(`RESULT ${JSON.stringify({ mode: 'dry-run', ...summary })}\n`);
    return;
  }

  // --apply: 宿主检查后持有排他锁直到归档/rebuild 结束
  // (Codex P1 on #2561: hold exclusive lock after host check through apply)。
  const banner = (msg) => (opts.json ? process.stderr : process.stdout).write(`${msg}\n`);
  if (opts.backupDir) {
    banner(`备份目录: ${path.resolve(opts.backupDir)}`);
  }
  let exclusiveLock = null;
  const abortApply = async (code) => {
    await releaseCleanupExclusiveLock(exclusiveLock);
    exclusiveLock = null;
    process.exit(code);
  };
  try {
    try {
      exclusiveLock = await acquireCleanupExclusiveLock(shard);
    } catch (e) {
      if (e instanceof CleanupLockError) {
        process.stderr.write(`❌ ${e.message}\n`);
        process.exit(3);
      }
      throw e;
    }
    if (!opts.force) {
      const host = await detectHost();
      if (host.status === 'unknown') {
        process.stderr.write(
          '❌ 无法确认宿主 (Cindy 桌面应用) 是否在运行: ' +
            `${host.error}\n` +
            '缺少 tasklist/ps、权限拒绝或进程查询失败时不得当作「未运行」继续 ' +
            '(fail-open 会绕过排他检查并移动记忆文件)。\n' +
            '请修复检测环境后重跑, 或确认无活动会话后显式加 --force。\n',
        );
        await abortApply(3);
      }
      if (host.running) {
        process.stderr.write(
          '❌ 检测到宿主 (Cindy 桌面应用) 正在运行 — 归档会移动用户记忆文件, ' +
            '宿主持有的 Store/SQLite 句柄会与归档冲突。\n' +
            '请先退出 Cindy 再运行; 确认无活动会话时可用 --force 继续。\n',
        );
        await abortApply(3);
      }
      const hostAgain = await detectHost();
      if (hostAgain.status === 'unknown' || hostAgain.running) {
        process.stderr.write(
          '❌ 持锁后复查仍检测到宿主或无法确认宿主状态; 拒绝 apply, 避免并发写。\n',
        );
        await abortApply(3);
      }
    }

    // --apply --archive-stale 必须绑 dry-run 审阅集, 不得 live 重扫后把新 stale
    // 一并归档 (Codex P1 on #2561: apply must bind to the reviewed dry-run set)。
    let extraLive = [];
    let archiveStale = opts.archiveStale;
    let boundFingerprint = null;
    if (reviewedPlan) {
      extraLive = bindReviewedStaleCandidates(plan, reviewedPlan.staleCandidates).extraLive;
      boundFingerprint = reviewedPlan.staleFingerprint;
      // 审阅文件带 archiveStale, 或 CLI 显式 --archive-stale, 才归档该审阅集。
      archiveStale = opts.archiveStale || reviewedPlan.archiveStale;
    } else if (archiveStale) {
      try {
        requireFromPlanForArchiveStale(opts);
      } catch (e) {
        process.stderr.write(
          `${e?.message ?? e}\n` +
            '  apply 不得重新扫描终态候选; 新命中须重新 dry-run 审阅后再 apply。\n',
        );
        await abortApply(2);
      }
    }

    if (opts.staleSetHash) {
      const expected = boundFingerprint ?? staleSetFingerprint(plan.staleCandidates);
      if (opts.staleSetHash !== expected) {
        process.stderr.write(
          `--stale-set-hash 与审阅终态集不一致:\n  expected: ${opts.staleSetHash}\n  bound: ${expected}\n` +
            '  请重新 --dry-run 审阅, 或传入 RESULT.staleFingerprint。\n',
        );
        await abortApply(2);
      }
    }
    if (archiveStale && extraLive.length > 0 && !opts.confirmStaleDiff) {
      process.stderr.write(
        `live 扫描比审阅集多出 ${extraLive.length} 条终态候选, 拒绝归档以免删未审阅分片:\n`,
      );
      for (const c of extraLive) {
        process.stderr.write(`  - ${c.filename} (${c.reason}${c.matchedSignal ? ` "${c.matchedSignal}"` : ''})\n`);
      }
      process.stderr.write(
        '请重新 --dry-run 审阅, 或显式 --confirm-stale-diff 只归档审阅集、跳过上述新命中。\n',
      );
      await abortApply(6);
    }

    const result = await runMemoryCleanup(plan, {
      ...(opts.backupDir ? { backupRoot: path.resolve(opts.backupDir) } : {}),
      archiveStale,
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
        archiveStale,
        staleFingerprint: boundFingerprint,
        skippedUnreviewedStale: extraLive.map((c) => c.filename),
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
      await abortApply(5);
    }

    // MEMORY.md 重建失败必须暴露 (Codex P2 on #2561): 静默会让旧索引把已归档
    // 文件继续注入后续会话, 且 store.init() 只修 FTS 不重建索引。
    if (result.indexRebuildError) {
      const warn = (msg) => (opts.json ? process.stderr : process.stdout).write(`${msg}\n`);
      warn('⚠️ MEMORY.md 重建失败: ' + result.indexRebuildError);
      warn('  归档已落盘, 但旧索引可能仍引用已归档文件; 请修复索引文件权限/磁盘后重跑。');
      await abortApply(4);
    }
  } finally {
    await releaseCleanupExclusiveLock(exclusiveLock);
  }
}

export async function detectHost() {
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);
    if (process.platform === 'win32') {
      const r = await run('tasklist', ['/FO', 'CSV', '/NH']);
      const names = new Set(r.stdout.toLowerCase().match(/"?[a-z0-9_.\- ]+\.exe"?/g) ?? []);
      const running = ['cindy.exe', 'cindydev.exe', 'desktop.exe', 'electron.exe'].some((p) =>
        names.has(`"${p}"`),
      );
      return { status: 'ok', running };
    }
    const r = await run('ps', ['-eo', 'comm']);
    const running = r.stdout.split(/\r?\n/).some((line) => isCindyHostComm(line));
    return { status: 'ok', running };
  } catch (e) {
    const err = /** @type {NodeJS.ErrnoException} */ (e);
    const detail = err?.code ? `${err.code}: ${err.message}` : String(err?.message ?? e);
    return { status: 'unknown', error: detail };
  }
}

function isCliEntry() {
  const argvPath = process.argv[1];
  if (!argvPath) return false;
  try {
    return pathToFileURL(path.resolve(argvPath)).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isCliEntry()) {
  main().catch((e) => {
    process.stderr.write(`cleanup-maker-memory failed: ${e?.stack ?? e}\n`);
    process.exit(1);
  });
}

