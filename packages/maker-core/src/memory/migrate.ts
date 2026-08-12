/**
 * migrate.ts — 存量 worktree 分片迁移 (P0 第二阶段, #2379)。
 *
 * 背景: #2399 合入前, `buildMemoryScopeKey()` 对本地会话原样透传 workdir
 * 绝对路径, git linked worktree 会话因此落到独立分片目录
 * `<basePath>/maker-memory/<sanitizeWorkdir(worktree路径)>/`。归一化生效后,
 * 新会话读写 `<sanitizeWorkdir(主仓根+相对子路径)>/` 的 canonical 分片,
 * 旧 worktree 分片不再被访问 — 数据保留在磁盘, 需要一次性迁移 (#2379 正文
 * 修复方向 2; #2400 维护者分析「后续迁移至少应满足…」的落地)。
 *
 * 本模块只做文件层迁移, 不碰 SQLite:
 *  - 文件是 source of truth, FTS5 是派生索引 (fts.ts 设计原则)
 *  - 目标分片下次被打开时, store.init() 的 sanityCheck 会因 count 不一致
 *    自动全量 rebuild FTS — 迁移后无需手工重建索引
 *  - maker-core 不依赖 better-sqlite3 (type-only import, zero-electron-deps 边界)
 *
 * 迁移规则 (遵循 #2379 / #2400 约束):
 *  - 只处理「meta.json.absPath 经 resolveMemoryScopeKey 归一化后, canonical
 *    目录名 ≠ 当前目录名」的分片 — 即真正的旧 worktree 分片
 *  - 空分片 (无合法 <type>_<slug>.md) → 直接删 (零内容零风险, #2379 正文)
 *  - 有内容分片 → 合并进 canonical 分片:
 *      canonical 不存在 → rename 整个目录 (快路径, fts.db 相对名不变仍有效)
 *      canonical 已存在 → 逐文件复制: 同名同内容跳过 / 同名不同内容 = 冲突
 *        (不静默覆盖, #2400 硬约束) 跳过并报告 / 不同名复制
 *    复制后重建目标 MEMORY.md (从 frontmatter 派生, storage.rebuildIndex 语义)
 *  - SSH 分片 (目录名以 ssh- 开头) 一律不碰 (#2379: 不要动 SSH 分支)
 *  - 无 meta.json 的残留目录 → 跳过并报告, 不猜不删
 *  - 迁移前可选备份 (--backup-dir); 空分片删除前若指定备份同样先复制
 *
 * 流程: planLegacyShardMigration() 纯扫描出计划 (dry-run 可预览);
 * runLegacyShardMigration() 执行计划 (幂等, 可重复跑)。
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { MemoryStorage, memoryScopeDirName, parseFilename } from './storage.js';
import { resolveMemoryScopeKey } from './scope-resolver.js';

/** 目标分片目录名前缀 — SSH 分片不迁移 (#2379 约束 3)。 */
const SSH_DIR_PREFIX = 'ssh-';

/** meta.json 内容 (storage.ts MemoryStorageMeta 同形)。 */
interface ShardMeta {
  absPath: string;
  createdAt: string;
  lastUsedAt: string;
}

/** 迁移工具依赖注入 (默认走真实 fs / resolver, 测试可替换)。 */
export interface LegacyShardMigrationDeps {
  /** canonical scope key 解析; 默认 resolveMemoryScopeKey (带 worktree 归一化)。 */
  resolveScopeKey?: (workingDir: string) => Promise<string>;
  /** 时钟 (meta 更新)。 */
  now?: () => string;
}

/** 单个分片目录的扫描结果。 */
export interface LegacyShardInfo {
  /** 分片目录绝对路径。 */
  dir: string;
  /** meta.json.absPath (记录旧 workdir, 迁移前是未归一化路径)。 */
  legacyWorkdir: string;
  /** 归一化后的 canonical scope key。 */
  canonicalScopeKey: string;
  /** canonical 分片目录名 (memoryScopeDirName(canonicalScopeKey))。 */
  canonicalDirName: string;
  /** 是否为需要迁移的 legacy 分片 (canonicalDirName ≠ 当前目录名)。 */
  isLegacy: boolean;
  /** 合法 .md 分片数 (排除 MEMORY.md / meta.json / fts.db)。 */
  recordCount: number;
}

/** 迁移计划。 */
export interface LegacyShardMigrationPlan {
  /** 全部扫描到的分片 (含非 legacy)。 */
  all: LegacyShardInfo[];
  /** 空 legacy 分片 (可直接删)。 */
  emptyToDelete: LegacyShardInfo[];
  /** 有内容需合并的 legacy 分片。 */
  mergeCandidates: LegacyShardInfo[];
  /** 无 meta.json / SSH 等不处理的分片。 */
  skipped: LegacyShardInfo[];
}

/** 单文件合并结果。 */
export interface MergeFileResult {
  filename: string;
  outcome: 'copied' | 'same-skipped' | 'conflict-skipped' | 'target-exists-merged';
}

/** 单个 legacy 分片的迁移结果。 */
export interface ShardMigrationResult {
  shard: LegacyShardInfo;
  action: 'removed-empty' | 'renamed' | 'merged' | 'skipped';
  mergedFiles?: MergeFileResult[];
  error?: string;
}

export interface RunMigrationOptions {
  /** 备份根目录; 提供时删除/rename 前先复制一份。 */
  backupRoot?: string;
  /** 注入依赖 (测试用)。 */
  deps?: LegacyShardMigrationDeps;
}

export interface RunMigrationResult {
  results: ShardMigrationResult[];
  /** 冲突文件 (同名不同内容) — 调用方应展示给用户。 */
  conflicts: Array<{ dir: string; filename: string }>;
}

/**
 * 扫描 maker-memory 根目录下所有分片, 生成迁移计划。
 * 纯只读, 不修改任何文件 (dry-run 安全)。
 */
export async function planLegacyShardMigration(
  memoryRoot: string,
  deps?: LegacyShardMigrationDeps,
): Promise<LegacyShardMigrationPlan> {
  const resolveScopeKey = deps?.resolveScopeKey ?? resolveMemoryScopeKey;
  const plan: LegacyShardMigrationPlan = {
    all: [],
    emptyToDelete: [],
    mergeCandidates: [],
    skipped: [],
  };

  let entries: string[];
  try {
    entries = await fs.readdir(memoryRoot);
  } catch {
    return plan;
  }

  for (const entry of entries) {
    const dir = path.join(memoryRoot, entry);
    let stat;
    try {
      stat = await fs.stat(dir);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;

    // SSH 分片不迁移 (#2379 约束 3)。
    if (entry.startsWith(SSH_DIR_PREFIX)) {
      plan.skipped.push(await buildSkippedInfo(dir, entry));
      continue;
    }

    let meta: ShardMeta | null = null;
    try {
      meta = JSON.parse(await fs.readFile(path.join(dir, 'meta.json'), 'utf8')) as ShardMeta;
    } catch {
      // 无 meta.json → 不猜不删, 跳过并报告
      plan.skipped.push(await buildSkippedInfo(dir, entry));
      continue;
    }

    let canonicalScopeKey: string;
    try {
      canonicalScopeKey = await resolveScopeKey(meta.absPath || entry);
    } catch {
      canonicalScopeKey = meta.absPath || entry;
    }
    const canonicalDirName = memoryScopeDirName(canonicalScopeKey);
    const isLegacy = canonicalDirName !== entry;

    const info: LegacyShardInfo = {
      dir,
      legacyWorkdir: meta.absPath || entry,
      canonicalScopeKey,
      canonicalDirName,
      isLegacy,
      recordCount: 0,
    };

    // 统计合法分片数
    let files: string[];
    try {
      files = await fs.readdir(dir);
    } catch {
      files = [];
    }
    for (const f of files) {
      if (parseFilename(f)) info.recordCount += 1;
    }

    plan.all.push(info);
    if (!isLegacy) continue;
    if (info.recordCount === 0) {
      plan.emptyToDelete.push(info);
    } else {
      plan.mergeCandidates.push(info);
    }
  }
  return plan;
}

async function buildSkippedInfo(dir: string, entry: string): Promise<LegacyShardInfo> {
  return {
    dir,
    legacyWorkdir: entry,
    canonicalScopeKey: entry,
    canonicalDirName: entry,
    isLegacy: false,
    recordCount: -1,
  };
}

/**
 * 执行迁移计划 (幂等: 已合并/已删除的分片第二次跑时 canonicalDirName === 目录名
 * 或目录已不存在, 自然跳过)。
 *
 * 步骤: 可选备份 → 空分片删除 / 有内容合并 → 重建目标 MEMORY.md。
 * 失败不中断: 单个分片出错记录 error 继续下一个 (迁移是可恢复的数据操作,
 * 残留问题由下次运行修复; 冲突文件绝不自动覆盖)。
 */
export async function runLegacyShardMigration(
  plan: LegacyShardMigrationPlan,
  opts: RunMigrationOptions = {},
): Promise<RunMigrationResult> {
  const { backupRoot, deps } = opts;
  const now = deps?.now ?? (() => new Date().toISOString());
  const result: RunMigrationResult = { results: [], conflicts: [] };

  // ── 1. 空分片删除 ───────────────────────────────────────────────
  for (const shard of plan.emptyToDelete) {
    const r: ShardMigrationResult = { shard, action: 'removed-empty' };
    try {
      if (backupRoot) await backupDir(shard.dir, backupRoot);
      await fs.rm(shard.dir, { recursive: true, force: true });
    } catch (e) {
      r.action = 'skipped';
      r.error = String(e);
    }
    result.results.push(r);
  }

  // ── 2. 有内容分片合并 ───────────────────────────────────────────
  for (const shard of plan.mergeCandidates) {
    const r: ShardMigrationResult = { shard, action: 'merged', mergedFiles: [] };
    try {
      const targetDir = path.join(path.dirname(shard.dir), shard.canonicalDirName);
      const targetExists = await dirExists(targetDir);

      if (!targetExists) {
        // 快路径: canonical 分片不存在 → rename 整个目录
        if (backupRoot) await backupDir(shard.dir, backupRoot);
        await fs.rename(shard.dir, targetDir);
        // meta.absPath 更新为 canonical scope key (原值 = 旧 worktree 路径)
        await updateMetaAbsPath(targetDir, shard.canonicalScopeKey, now());
        r.action = 'renamed';
      } else {
        // 慢路径: 逐文件合并
        if (backupRoot) await backupDir(shard.dir, backupRoot);
        const merged = await mergeFilesInto(shard, targetDir, result.conflicts);
        r.mergedFiles = merged;
        // 合并后重建目标 MEMORY.md (从分片 frontmatter 派生)
        await rebuildIndexFile(targetDir);
        // 源目录此刻只剩 MEMORY.md / meta.json / fts.db → 整个删掉。
        // 有冲突时保留源目录 — 冲突文件(同名不同内容)绝不静默覆盖,
        // 人工处理前数据必须仍在磁盘上 (#2400: 不静默覆盖现有记录)。
        const hasConflict = merged.some((m) => m.outcome === 'conflict-skipped');
        if (!hasConflict) {
          await fs.rm(shard.dir, { recursive: true, force: true });
        } else {
          r.action = 'merged';
          r.error = 'conflicts remain in source dir (kept for manual review)';
        }
      }
    } catch (e) {
      r.action = 'skipped';
      r.error = String(e);
    }
    result.results.push(r);
  }

  return result;
}

/** 合并源分片的所有 .md 文件进目标目录。返回逐文件结果; 冲突写入 conflicts 并跳过。 */
async function mergeFilesInto(
  shard: LegacyShardInfo,
  targetDir: string,
  conflicts: RunMigrationResult['conflicts'],
): Promise<MergeFileResult[]> {
  const files = (await fs.readdir(shard.dir)).filter((f) => parseFilename(f));
  const out: MergeFileResult[] = [];
  for (const filename of files) {
    const src = path.join(shard.dir, filename);
    const dst = path.join(targetDir, filename);
    const srcBuf = await fs.readFile(src);
    const dstExists = await pathExists(dst);

    if (!dstExists) {
      await fs.copyFile(src, dst);
      out.push({ filename, outcome: 'copied' });
      continue;
    }
    const dstBuf = await fs.readFile(dst);
    if (srcBuf.equals(dstBuf)) {
      out.push({ filename, outcome: 'same-skipped' });
      continue;
    }
    // 同名不同内容 = 冲突: 不静默覆盖 (#2400), 保留两份, 报告人工处理
    conflicts.push({ dir: shard.dir, filename });
    out.push({ filename, outcome: 'conflict-skipped' });
  }
  return out;
}

/** 目标目录 MEMORY.md 重建 — 复用 storage.rebuildIndex (与运行时行为完全一致)。 */
async function rebuildIndexFile(targetDir: string): Promise<void> {
  const storage = new MemoryStorage(targetDir);
  await storage.rebuildIndex();
}

/** 更新目标分片 meta.json 的 absPath 为 canonical scope key。 */
async function updateMetaAbsPath(dir: string, absPath: string, nowIso: string): Promise<void> {
  const metaPath = path.join(dir, 'meta.json');
  let meta: ShardMeta;
  try {
    meta = JSON.parse(await fs.readFile(metaPath, 'utf8')) as ShardMeta;
  } catch {
    meta = { absPath, createdAt: nowIso, lastUsedAt: nowIso };
  }
  meta.absPath = absPath;
  meta.lastUsedAt = nowIso;
  await fs.writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf8');
}

/** 迁移前备份单个分片目录到 backupRoot/<目录名>-<时间戳>。 */
async function backupDir(dir: string, backupRoot: string): Promise<void> {
  const name = path.basename(dir);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  await fs.mkdir(backupRoot, { recursive: true });
  await fs.cp(dir, path.join(backupRoot, `${name}-${stamp}`), { recursive: true });
}

async function dirExists(p: string): Promise<boolean> {
  try {
    const s = await fs.stat(p);
    return s.isDirectory();
  } catch {
    return false;
  }
}

/** 文件/目录存在性 (stat 成功即 true)。 */
async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}
