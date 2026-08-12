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

import { MemoryStorage, SSH_SCOPE_KEY_PREFIX, memoryScopeDirName, parseFilename } from './storage.js';
import { resolveMemoryScopeKey } from './scope-resolver.js';

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

    let meta: ShardMeta | null = null;
    try {
      meta = JSON.parse(await fs.readFile(path.join(dir, 'meta.json'), 'utf8')) as ShardMeta;
    } catch {
      // 无 meta.json → 不猜不删, 跳过并报告 (目录名以 ssh- 开头时同样跳过)
      plan.skipped.push(await buildSkippedInfo(dir, entry));
      continue;
    }

    // SSH 分片不迁移 (#2379 约束 3)。判定依据是 scope key 形态 (meta.absPath
    // 以 `ssh:` 开头 — storage 层只对远端会话生成 ssh: 复合键), 而不是目录名
    // 前缀: sanitizeWorkdir 允许本地路径 (如 /ssh/proj) 恰好产出 ssh- 开头的
    // 目录名, 按前缀误判会把本地 legacy 分片跳过成孤儿 (Codex review on
    // #2519 第五轮)。
    const isRemote = (meta.absPath ?? '').startsWith(SSH_SCOPE_KEY_PREFIX);
    if (isRemote) {
      plan.skipped.push(await buildSkippedInfo(dir, entry));
      continue;
    }

    let canonicalScopeKey: string;
    try {
      canonicalScopeKey = await resolveScopeKey(meta.absPath || entry);
    } catch {
      canonicalScopeKey = meta.absPath || entry;
    }
    // 已归档/删除的 Cindy worktree (resolver live 探测失败回落原样) —
    // 用 `.cindy-worktrees/<name>` 路径形态做静态推导, 否则旧记录永远孤儿
    // (Codex review on #2519)。
    //
    // 仅当该路径**不是活 git 仓库**时才推导 (Codex review on #2519 第十二
    // 轮): 普通本地 checkout 恰好位于 `.cindy-worktrees`/`.xdt-worktrees`
    // 目录下时 (如 /home/me/.cindy-worktrees/proj), resolver 正确返回原样
    // 但无条件推导会把 canonical 错误改写 — dry-run 报假 legacy、apply 把
    // 记忆合并到错误 scope。isLiveGitRepo 探测 `.git` 标记: 活仓库跳过推导。
    if (canonicalScopeKey === (meta.absPath || entry)) {
      const raw = meta.absPath || entry;
      if (!(await isLiveGitRepo(raw))) {
        const derived = deriveCanonicalFromCindyWorktreePath(raw);
        if (derived) canonicalScopeKey = derived;
      }
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

    // 统计合法分片数 + 未识别遗留内容 (数据保全: 只有遗留文件 (含非
    // Markdown) 的目录不是「空」— 删掉会永久丢失用户内容; Greptile review
    // on #2519 第二轮 + Codex 第十轮: 只含 notes.txt/data.yaml 的分片同样
    // 不能按空删)。
    let files: string[];
    try {
      files = await fs.readdir(dir);
    } catch {
      files = [];
    }
    let hasUnrecognizedContent = false;
    for (const f of files) {
      if (parseFilename(f)) {
        info.recordCount += 1;
      } else if (f !== 'MEMORY.md' && f !== 'meta.json' && f !== 'fts.db') {
        hasUnrecognizedContent = true;
      }
    }

    plan.all.push(info);
    if (!isLegacy) continue;
    // recordCount === 0 但存在未识别遗留内容 → 不按空删 (内容可能就在里面),
    // 归入 mergeCandidates 走慢路径合并 (那边有未识别文件保留源目录的保护)
    if (info.recordCount === 0 && !hasUnrecognizedContent) {
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
 * 托管 worktree 路径 → 主仓路径的静态推导 (Codex review on #2519)。
 *
 * 场景: 旧 worktree 分片的 meta.absPath 指向 `.../<主仓>/<托管段>/<name>`。
 * 若该 worktree 已被归档/删除, resolver 的 live git 探测找不到 .git 标记,
 * 回落返回原路径 → canonicalDirName === 目录名 → 不迁移, 旧记录永远孤儿。
 *
 * 本函数只处理 **已知的托管 worktree 形态** (产品自己创建的):
 *   `.cindy-worktrees` — 现行形态
 *   `.xdt-worktrees`   — 品牌迁移前的旧形态 (Codex review on #2519 第二轮)
 * 取托管段之前的路径为主仓根, 段之后的子路径拼回。非该形态 (用户手工
 * worktree / 其他布局) 返回 null, 交回 live 探测结果, 不做危险猜测。
 *
 * 例:
 *   /repo/.cindy-worktrees/feat-x            → /repo
 *   /repo/.cindy-worktrees/feat-x/apps/a     → /repo/apps/a
 *   /repo/.xdt-worktrees/feat-x/apps/a       → /repo/apps/a
 *   /Users/me/other/wt (无托管段)            → null
 */
const MANAGED_WORKTREE_DIRS = ['.cindy-worktrees', '.xdt-worktrees'];

export function deriveCanonicalFromCindyWorktreePath(absPath: string): string | null {
  // Desktop 存储会把 Windows workingDir 归一化为正斜杠 (C:/repo/.cindy-...),
  // 而 path.sep 在 Windows 是反斜杠 — 只认一种分隔符会漏掉归一化后的路径
  // (Codex review on #2519 第四轮)。统一按段解析, 两种分隔符都接受。
  const segments = absPath.split(/[\\/]/);
  for (let i = 0; i < segments.length - 1; i += 1) {
    if (!MANAGED_WORKTREE_DIRS.includes(segments[i])) continue;
    // segments[i] = 托管段; segments[i+1] = worktree 名 (必须存在)
    const worktreeName = segments[i + 1];
    if (worktreeName.length === 0) continue;
    const mainRoot = segments.slice(0, i).join(path.sep);
    if (mainRoot.length === 0) continue;
    const subPath = segments.slice(i + 2).join(path.sep);
    return subPath ? path.join(mainRoot, subPath) : mainRoot;
  }
  return null;
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
      // 竞态防御 (Greptile on #2519): 计划基于扫描快照, 删除前重新校验目录
      // 仍无任何内容 — 若扫描后新增了分片文件或未识别 .md, 跳过删除并报告,
      // 绝不让过期快照删掉新写入的数据。rename-then-remove 把复查与删除之间
      // 的窗口压缩到 rename 原子操作之后: 目录一改名, 新写入只会落到原名
      // 目录 (已不存在) 或别的路径, 不会进到即将删除的临时名目录。
      const gained = await countShardFiles(shard.dir);
      const unrecognized = await findUnrecognizedMdFiles(shard.dir);
      if (gained > 0 || unrecognized.length > 0) {
        r.action = 'skipped';
        r.error = `dir gained content since scan (${gained} shard file(s), ${unrecognized.length} unrecognized md), kept`;
        result.results.push(r);
        continue;
      }
      if (backupRoot) await backupDir(shard.dir, backupRoot);
      // rename → 复查 → remove: 复查放在 rename 之后, 只看将被删的临时目录;
      // rename 后目录已不在原路径, 复查窗口内写入只能落到原名 (已不存在),
      // 无法进入待删目录 (与备份目录同层, 名字带后缀避免冲突)。
      const trashName = `${path.basename(shard.dir)}.trash-${now().replace(/[:.]/g, '-')}`;
      const trashDir = path.join(path.dirname(shard.dir), trashName);
      await fs.rename(shard.dir, trashDir);
      // 最终复查 (rename 后, 删前): 合法分片 + 未识别 .md 都要查 — 首次复查
      // 之后、rename 之前写入的 notes.md 等未识别文件同样不能被删 (Greptile
      // review on #2519 第三轮)。
      const afterRename = await countShardFiles(trashDir);
      const unrecognizedAfterRename = await findUnrecognizedMdFiles(trashDir);
      if (afterRename > 0 || unrecognizedAfterRename.length > 0) {
        // 极端: rename 前已写入的内容 — 恢复原目录名并报告
        await fs.rename(trashDir, shard.dir);
        r.action = 'skipped';
        r.error = `dir gained content before rename (${afterRename} shard file(s), ${unrecognizedAfterRename.length} unrecognized md), kept`;
        result.results.push(r);
        continue;
      }
      await fs.rm(trashDir, { recursive: true, force: true });
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
        // 重建 MEMORY.md — legacy 分片索引可能缺失/过期 (写入与重建之间崩溃
        // 或人工修复), 不重建的话 canonical 会话 getIndex() 读到 stale 索引,
        // 记忆进不了 prompt (Codex review on #2519 第十一轮, 与合并路径一致)
        await rebuildIndexFile(targetDir);
        r.action = 'renamed';
      } else {
        // 慢路径: 逐文件合并
        if (backupRoot) await backupDir(shard.dir, backupRoot);
        const merged = await mergeFilesInto(shard, targetDir, result.conflicts);
        r.mergedFiles = merged;
        // 合并后重建目标 MEMORY.md (从分片 frontmatter 派生)
        await rebuildIndexFile(targetDir);
        // 源目录此刻只剩 MEMORY.md / meta.json / fts.db → 整个删掉。
        // 保留源目录的情形 (数据保全, 人工处理前数据必须仍在磁盘上):
        //  1. 有冲突 — 同名不同内容绝不静默覆盖 (#2400)
        //  2. 有未识别文件 — 不参与合并的任何遗留内容 (含非 Markdown),
        //     删掉源目录会永久丢失 (Greptile review on #2519)
        //  3. 快照后合法分片集合变化 — 新增/缺失/同数替换 (删 A 建 B):
        //     数量复查检测不到同数替换, 文件名集合对比兜底 (Codex review
        //     on #2519 第六轮)
        //  4. 复制后已有分片被更新 — 存量会话在复制后、删源前改写了同名
        //     记忆, 数量复查检测不到, 内容对比兜底 (Greptile review on
        //     #2519 第五轮)
        const hasConflict = merged.some((m) => m.outcome === 'conflict-skipped');
        const snapshotNames = new Set(merged.map((m) => m.filename));
        const unrecognized = await findUnrecognizedMdFiles(shard.dir);
        // 当前合法文件名集合 vs 快照集合: added = 快照后新增, missing =
        // 快照后消失 (被替换删掉) — 任一存在都说明快照后源目录被写过
        const { added, missing } = await diffShardFilenames(shard.dir, snapshotNames);
        // 内容复查: 已合并的合法分片, 源与目标逐字节对比 — 源文件在复制后
        // 被存量会话更新过则源 ≠ 目标, 保留源目录 (目标保留的是旧数据)。
        const contentChanged = await findChangedAfterMerge(shard.dir, targetDir, merged);
        if (unrecognized.length > 0) {
          r.action = 'merged';
          r.error = `unrecognized files kept in source dir for manual review: ${unrecognized.join(', ')}`;
          result.results.push(r);
          continue;
        }
        if (added.length > 0 || missing.length > 0) {
          r.action = 'merged';
          r.error = `shard filename set changed after snapshot (added ${added.length}, missing ${missing.length}), source dir kept`;
          result.results.push(r);
          continue;
        }
        if (contentChanged.length > 0) {
          r.action = 'merged';
          r.error = `shard file(s) updated after copy, source dir kept: ${contentChanged.join(', ')}`;
          result.results.push(r);
          continue;
        }
        if (hasConflict) {
          r.action = 'merged';
          r.error = 'conflicts remain in source dir (kept for manual review)';
          result.results.push(r);
          continue;
        }
        // 全部复查通过 → rename-then-remove: rename 后源目录不在原路径,
        // 复查窗口内新写入只能落到原名 (已不存在), 无法进入待删目录;
        // rename 后对 trash 再做一次最终复查兜底 (Greptile review on #2519
        // 第六轮: 复查完成后 fs.rm 前的写入仍会被删)。
        const trashName = `${path.basename(shard.dir)}.trash-${now().replace(/[:.]/g, '-')}`;
        const trashDir = path.join(path.dirname(shard.dir), trashName);
        await fs.rename(shard.dir, trashDir);
        // 最终复查 (rename 后, 删前): 未识别 + 文件名集合 + **内容对比** —
        // 存量会话在 findChangedAfterMerge 之后、rename 之前更新同名记忆时,
        // trash 集合不变但内容新, 只查集合会删掉新版本 (Greptile/Codex
        // review on #2519 第七轮)。
        const trashUnrecognized = await findUnrecognizedMdFiles(trashDir);
        const trashDiff = await diffShardFilenames(trashDir, snapshotNames);
        const trashChanged = await findChangedAfterMerge(trashDir, targetDir, merged);
        if (
          trashUnrecognized.length > 0 ||
          trashDiff.added.length > 0 ||
          trashDiff.missing.length > 0 ||
          trashChanged.length > 0
        ) {
          await fs.rename(trashDir, shard.dir);
          r.action = 'merged';
          r.error = 'content appeared or changed before remove, source dir restored';
          result.results.push(r);
          continue;
        }
        await fs.rm(trashDir, { recursive: true, force: true });
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

/** 目录中合法分片文件 (<type>_<slug>.md) 的数量。目录不存在返 0。 */
async function countShardFiles(dir: string): Promise<number> {
  try {
    const files = await fs.readdir(dir);
    return files.filter((f) => parseFilename(f)).length;
  } catch {
    return 0;
  }
}

/**
 * 路径是否位于活 git 仓库内 — 从 `<p>` 向上遍历祖先目录找 `.git` 标记
 * (目录或 gitdir 指针文件)。静态推导前的护栏: 普通 checkout 恰好位于
 * .cindy-worktrees 下、会话 workdir 是子目录时 (如 /home/me/.cindy-worktrees/
 * proj/apps/a), `.git` 在祖先 proj/ 下 — 只查 `<p>/.git` 会误判非活仓库并
 * 推导成错误主仓根 (Codex review on #2519 第十二轮 + 第十四轮)。
 */
async function isLiveGitRepo(p: string): Promise<boolean> {
  let cur = path.resolve(p);
  for (;;) {
    try {
      const s = await fs.stat(path.join(cur, '.git'));
      if (s.isDirectory() || s.isFile()) return true;
    } catch {
      // 继续向上
    }
    const parent = path.dirname(cur);
    if (parent === cur) return false;
    cur = parent;
  }
}

/**
 * 对比目录当前合法分片文件名集合与快照集合 (Codex review on #2519 第六轮)。
 * added = 快照后新增的文件名; missing = 快照后消失的文件名 (被存量会话
 * 删掉/替换)。同数替换 (删 A 建 B) 时数量不变, 集合对比兜底。
 * 目录读失败 (并发删除) 返回空差异 — 调用方后续 rm 会失败兜底。
 */
async function diffShardFilenames(
  dir: string,
  snapshot: Set<string>,
): Promise<{ added: string[]; missing: string[] }> {
  try {
    const current = new Set((await fs.readdir(dir)).filter((f) => parseFilename(f)));
    const added = [...current].filter((f) => !snapshot.has(f));
    const missing = [...snapshot].filter((f) => !current.has(f));
    return { added, missing };
  } catch {
    return { added: [], missing: [] };
  }
}

/**
 * 找出「复制后被改写」的已合并分片 — 对 merged 中 outcome 为 copied /
 * same-skipped 的文件, 逐字节对比源目录与目标目录 (Greptile review on
 * #2519 第五轮: 存量会话在复制后、删源前更新已有记忆, 数量复查检测不到)。
 * 返回源 ≠ 目标的文件名列表; 源文件已消失 (并发删除) 视为未变化。
 */
async function findChangedAfterMerge(
  srcDir: string,
  targetDir: string,
  merged: MergeFileResult[],
): Promise<string[]> {
  const changed: string[] = [];
  for (const m of merged) {
    if (m.outcome !== 'copied' && m.outcome !== 'same-skipped') continue;
    const src = path.join(srcDir, m.filename);
    const dst = path.join(targetDir, m.filename);
    let srcBuf: Buffer;
    let dstBuf: Buffer;
    try {
      [srcBuf, dstBuf] = await Promise.all([fs.readFile(src), fs.readFile(dst)]);
    } catch {
      // 读取失败 (源被并发删/目标异常) → 无法证明源与目标一致, 保守记为
      // changed → 调用方保留源目录 (Greptile review on #2519 第十三轮:
      // 跳过会删掉未经验证的最新记忆)
      changed.push(m.filename);
      continue;
    }
    if (!srcBuf.equals(dstBuf)) changed.push(m.filename);
  }
  return changed;
}

/**
 * 找出目录中「不参与合并但仍保存内容的遗留文件」— 排除系统文件
 * (MEMORY.md / meta.json / fts.db) 与合法分片 (<type>_<slug>.md) 之外
 * 的**一切文件**, 含未识别的 .md (手写笔记) 与非 Markdown 遗留内容
 * (notes.txt / data.yaml 等)。存在即数据保全风险: 删掉源目录会永久丢失
 * (Greptile review on #2519)。
 */
async function findUnrecognizedMdFiles(dir: string): Promise<string[]> {
  try {
    const files = await fs.readdir(dir);
    return files.filter(
      (f) => f !== 'MEMORY.md' && f !== 'meta.json' && f !== 'fts.db' && !parseFilename(f),
    );
  } catch {
    return [];
  }
}
