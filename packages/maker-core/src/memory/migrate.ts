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

import { constants, promises as fs } from 'node:fs';
import * as path from 'node:path';

import { MemoryStorage, SSH_SCOPE_KEY_PREFIX, memoryScopeDirName, parseFilename } from './storage.js';
import {
  looksLikeWindowsLocalPath,
  normalizeWindowsLocalScopeKey,
  resolveMemoryScopeKey,
} from './scope-resolver.js';

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
  /** 规划时 canonical 分片目录是否已存在 (apply 检测并发创建)。 */
  canonicalExistedAtPlan?: boolean;
  /** skipped / failed 原因 (relative-absPath / worktree-resolve-failure 等)。 */
  skipReason?: string;
}

/** 迁移计划。 */
export interface LegacyShardMigrationPlan {
  /** 全部扫描到的分片 (含非 legacy)。 */
  all: LegacyShardInfo[];
  /** 空 legacy 分片 (可直接删)。 */
  emptyToDelete: LegacyShardInfo[];
  /** 有内容需合并的 legacy 分片。 */
  mergeCandidates: LegacyShardInfo[];
  /** 无 meta.json / SSH / 相对 absPath / symlink 分片、分片文件或 canonical 目标等不处理的分片。 */
  skipped: LegacyShardInfo[];
  /** 活 worktree 解析失败等需 surface 的分片 (不 abort 整份计划)。 */
  failed: LegacyShardInfo[];
}

/** 单文件合并结果。 */
export interface MergeFileResult {
  filename: string;
  outcome: 'copied' | 'same-skipped' | 'conflict-skipped' | 'target-exists-merged';
}

/** 单个 legacy 分片的迁移结果。 */
export interface ShardMigrationResult {
  shard: LegacyShardInfo;
  action: 'removed-empty' | 'renamed' | 'merged' | 'skipped' | 'rename-incomplete';
  mergedFiles?: MergeFileResult[];
  error?: string;
}

export interface RunMigrationOptions {
  /** 备份根目录; 提供时删除/rename 前先复制一份。 */
  backupRoot?: string;
  /** 注入依赖 (测试用)。 */
  deps?: LegacyShardMigrationDeps;
  /** 测试注入: dropStaleFts 用的单文件 rm (Codex 3971991067)。 */
  rmFile?: (filePath: string) => Promise<void>;
  /** 测试注入: 替换 rename (Codex 3971991063)。 */
  rename?: (from: string, to: string) => Promise<void>;
}

export interface RunMigrationResult {
  results: ShardMigrationResult[];
  /** 冲突文件 (同名不同内容) — 调用方应展示给用户。 */
  conflicts: Array<{ dir: string; filename: string }>;
}

/** --apply CLI 汇总: 必须含 plan.failed, 否则 Git 探测失败仍 0 退出 (Codex 3971230679)。 */
export interface ApplyMigrationSummary {
  shards: Array<{
    dir: string;
    action: ShardMigrationResult['action'];
    records: number;
    mergedFiles?: MergeFileResult[];
    error?: string;
  }>;
  conflicts: Array<{ dir: string; filename: string }>;
  failed: Array<{ dir: string; reason: string | null }>;
  executionErrors: Array<{ dir: string; action: ShardMigrationResult['action']; error: string }>;
  /** 无解析失败、无执行期错误、无未解决冲突时为 true (Codex 3971991063)。 */
  ok: boolean;
}

/** 分片系统文件: 迁移不得跟随 symlink 改写根外 (Codex 3975030337)。 */
const SYSTEM_SHARD_FILES = ['MEMORY.md', 'meta.json', 'fts.db', 'fts.db-wal', 'fts.db-shm'] as const;

function isSystemShardFile(name: string): boolean {
  return (SYSTEM_SHARD_FILES as readonly string[]).includes(name);
}

async function isSymlinkPath(p: string): Promise<boolean> {
  try {
    return (await fs.lstat(p)).isSymbolicLink();
  } catch {
    return false;
  }
}

/** 规划/执行都不跟随 symlink 分片目录 (Codex #2519 3974113763)。 */
async function isSymlinkShardDir(dir: string): Promise<boolean> {
  return isSymlinkPath(dir);
}

/** ENOENT 当空目录; 其它 I/O 必须抛给调用方, 不得伪装成空 (Codex 3975030334)。 */
async function readShardDir(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch (e) {
    if (isEnoentError(e)) return [];
    throw e;
  }
}

/** 合法分片文件名是 symlink — 不跟随读/复制 (Codex #2519 3974674258)。 */
async function shardHasSymlinkShardFile(dir: string): Promise<boolean> {
  const files = await readShardDir(dir);
  for (const f of files) {
    if (!parseFilename(f)) continue;
    if (await isSymlinkPath(path.join(dir, f))) return true;
  }
  return false;
}

/** meta.json / MEMORY.md / fts.db(+sidecar) 是 symlink → 拒绝跟随 (Codex 3975030337)。 */
async function shardHasSymlinkSystemFile(dir: string): Promise<boolean> {
  for (const name of SYSTEM_SHARD_FILES) {
    if (await isSymlinkPath(path.join(dir, name))) return true;
  }
  return false;
}

function isExecutionFailure(r: ShardMigrationResult): boolean {
  if (r.action === 'skipped' || r.action === 'rename-incomplete') return true;
  // merged 但带 error = 源目录因冲突/未识别文件保留, 自动化不得当成功。
  return Boolean(r.error);
}

export function summarizeApplyMigration(
  plan: LegacyShardMigrationPlan,
  result: RunMigrationResult,
): ApplyMigrationSummary {
  const executionErrors = result.results
    .filter(isExecutionFailure)
    .map((r) => ({
      dir: r.shard.dir,
      action: r.action,
      error: r.error ?? r.action,
    }));
  return {
    shards: result.results.map((r) => ({
      dir: r.shard.dir,
      action: r.action,
      records: r.shard.recordCount,
      mergedFiles: r.mergedFiles ?? undefined,
      error: r.error ?? undefined,
    })),
    conflicts: result.conflicts.map((c) => ({ dir: c.dir, filename: c.filename })),
    failed: plan.failed.map((s) => ({
      dir: s.dir,
      reason: s.skipReason ?? null,
    })),
    executionErrors,
    ok:
      plan.failed.length === 0 &&
      executionErrors.length === 0 &&
      result.conflicts.length === 0,
  };
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
    failed: [],
  };

  let entries: string[];
  try {
    entries = await fs.readdir(memoryRoot);
  } catch (e) {
    // ENOENT = 尚无数据, 空计划合法; EACCES/EIO/ENOTDIR 等不得伪装成
    // 0 分片成功 (Codex 3972389951 / 第五轮 Us6gzzAz 漏修: 原先 catch
    // 一律 return plan, dry-run 报 0、--apply ok:true/exit 0)。
    if (isEnoentError(e)) return plan;
    const code = errnoCode(e);
    plan.failed.push(
      await buildSkippedInfo(
        memoryRoot,
        path.basename(memoryRoot),
        `memory-root-unreadable:${code}`,
      ),
    );
    return plan;
  }

  for (const entry of entries) {
    const dir = path.join(memoryRoot, entry);
    let lstat;
    try {
      lstat = await fs.lstat(dir);
    } catch (e) {
      // ENOENT: 扫描窗口内条目消失, 忽略. 其它 I/O (EACCES/EIO) 必须进
      // plan.failed, 不得静默丢弃 — 否则 --apply 在未检查任何分片时仍
      // ok:true / exit 0 (Codex #2519 3974018433)。
      if (isEnoentError(e)) continue;
      plan.failed.push(
        await buildSkippedInfo(dir, entry, `stat-failure:${errnoCode(e)}`),
      );
      continue;
    }
    // 不跟随 symlink 分片目录: rename/updateMeta/dropStaleFts 会改到根外
    // (Codex #2519 3974113763)。与 copyLegacyMemoryShardsSync 的 lstatSync
    // 同款。junction 在 win32 也是 isSymbolicLink。
    if (lstat.isSymbolicLink()) {
      plan.skipped.push(await buildSkippedInfo(dir, entry, 'symlink-shard'));
      continue;
    }
    if (!lstat.isDirectory()) continue;

    // 在读 meta.json 之前拒绝系统文件 symlink, 避免规划期跟随读到根外
    // (Codex #2519 3975030337)。
    if (await shardHasSymlinkSystemFile(dir)) {
      plan.skipped.push(await buildSkippedInfo(dir, entry, 'symlink-system-file'));
      continue;
    }

    let metaRaw: string;
    try {
      metaRaw = await fs.readFile(path.join(dir, 'meta.json'), 'utf8');
    } catch (e) {
      // ENOENT = 无 meta, 不猜不删. EACCES/EIO 等不得当 no-meta —
      // summarizeApplyMigration 忽略 plan.skipped, --apply 会 ok:true
      // 并把该分片的 legacy 记忆当孤儿 (Codex #2519 3976576804)。
      if (isEnoentError(e)) {
        plan.skipped.push(await buildSkippedInfo(dir, entry, 'no-meta'));
        continue;
      }
      plan.failed.push(
        await buildSkippedInfo(dir, entry, `meta-read-failure:${errnoCode(e)}`),
      );
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(metaRaw);
    } catch {
      // 非 JSON → 不猜不删, 跳过并报告
      plan.skipped.push(await buildSkippedInfo(dir, entry, 'invalid-meta'));
      continue;
    }
    // JSON.parse("null") / 数组 / 非对象通过 try, 但 meta.absPath 会抛掉整份计划
    // (Codex review on #2519 第十七轮)。{}、缺 absPath 也当无效 meta。
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed) ||
      typeof (parsed as ShardMeta).absPath !== 'string' ||
      (parsed as ShardMeta).absPath.trim() === ''
    ) {
      plan.skipped.push(await buildSkippedInfo(dir, entry, 'invalid-meta'));
      continue;
    }
    const meta = parsed as ShardMeta;

    // SSH 分片不迁移 (#2379 约束 3)。判定依据是 scope key 形态 (meta.absPath
    // 以 `ssh:` 开头 — storage 层只对远端会话生成 ssh: 复合键), 而不是目录名
    // 前缀: sanitizeWorkdir 允许本地路径 (如 /ssh/proj) 恰好产出 ssh- 开头的
    // 目录名, 按前缀误判会把本地 legacy 分片跳过成孤儿 (Codex review on
    // #2519 第五轮)。
    const rawAbs = canonicalizeMetaAbsPath(meta.absPath);
    const isRemote = rawAbs.startsWith(SSH_SCOPE_KEY_PREFIX);
    if (isRemote) {
      plan.skipped.push(await buildSkippedInfo(dir, entry, 'ssh', rawAbs));
      continue;
    }
    // MemoryStorageMeta.absPath 约定绝对路径; 相对路径 (如 "..") 规划阶段
    // 拒绝, 否则 apply 会把目标解析到 memoryRoot 的父目录并删源
    // (Codex review on #2519 第十八轮)。
    if (!isAbsoluteLocalPath(rawAbs)) {
      plan.skipped.push(await buildSkippedInfo(dir, entry, 'relative-absPath', rawAbs));
      continue;
    }
    // `/..` 仍是绝对路径, 但 memoryScopeDirName('/..') === '..',
    // path.join(memoryRoot, '..') 会写到根外 (Codex #2519 3974301309)。
    if (hasParentDirTraversal(rawAbs)) {
      plan.skipped.push(await buildSkippedInfo(dir, entry, 'parent-dir-traversal', rawAbs));
      continue;
    }
    // 目录名必须由原始 absPath 派生: 手工复制/损坏 meta 若带着另一分片的
    // 合法绝对路径, 不得被当成该路径的 legacy 并进目标 (Codex #2519 3974018438)。
    {
      const expectedDirName = memoryScopeDirName(rawAbs);
      if (!sameMigrationDirName(expectedDirName, entry, windowsFsIdentity(rawAbs))) {
        plan.failed.push(
          await buildSkippedInfo(dir, entry, 'dir-name-mismatch', rawAbs),
        );
        continue;
      }
    }

    let canonicalScopeKey: string;
    try {
      canonicalScopeKey = await resolveScopeKey(rawAbs);
    } catch {
      canonicalScopeKey = rawAbs;
    }
    // 已归档/删除的 Cindy worktree (resolver live 探测失败回落原样) —
    // 用 `.cindy-worktrees/<name>` 路径形态做静态推导, 否则旧记录永远孤儿
    // (Codex review on #2519)。
    //
    // 仅当该路径**不是活 git 仓库**、且能证明是 Cindy 托管 worktree 时才
    // 推导 (Codex review on #2519 第十二/十六/七/二十一轮): 普通仓内恰好有
    // 同名 `.cindy-worktrees/<name>` 目录时, resolver 正确返回原样, 不推导。
    // 路径形态像托管但既无 `.git`/主仓登记、目录也已删 — 不能从
    // 路径形态猜测 (Codex 3972854282): 普通 checkout 曾位于同名路径后
    // 卸载时会被误并入祖先 scope。记 failed `ambiguous-managed-worktree`, 不自动迁移。
    //
    // 活托管 worktree 上 resolver 超时/失败也回落原路径, 且 isLiveGitRepo
    // 为真会压掉静态推导 → 静默 non-legacy、记忆孤儿。记 failed 并 surface
    // (Codex review on #2519 第十八轮), 不 abort 整份计划。
    if (canonicalScopeKey === rawAbs) {
      const live = await isLiveGitRepo(rawAbs);
      // 活 Cindy worktree 仍有 `.git/worktrees/<name>` 登记, 但 resolver 回落
      // 原路径 (超时/git 失败) → 不能当 non-legacy 静默吞掉。碰巧同名的
      // 独立仓库没有登记, 回落原路径是正确结果, 不进 failed。
      if (
        live &&
        ((await hasGitWorktreeRegistration(rawAbs)) || (await hasFileFormGitdir(rawAbs)))
      ) {
        // 托管登记 或 祖先 linked-worktree 文件形态 `.git` (gitdir 含 worktrees/):
        // resolver 回落原路径不得当 non-legacy 静默吞掉 (Codex 3974674280)。
        // 主仓 submodule 的 gitdir 指向 modules/, 回落原路径是正确结果。
        plan.failed.push(
          await buildSkippedInfo(dir, entry, 'worktree-resolve-failure', rawAbs),
        );
        continue;
      }
      if (!live) {
        if (await shouldDeriveArchivedManagedWorktree(rawAbs)) {
          const derived = deriveCanonicalFromCindyWorktreePath(rawAbs);
          if (derived) canonicalScopeKey = derived;
        } else {
          const managed = managedWorktreeRoot(rawAbs);
          if (managed && !(await dirExists(managed))) {
            plan.failed.push(
              await buildSkippedInfo(dir, entry, 'ambiguous-managed-worktree', rawAbs),
            );
            continue;
          }
        }
      }
    }
    const canonicalDirName = memoryScopeDirName(canonicalScopeKey);
    if (
      hasParentDirTraversal(canonicalScopeKey) ||
      isUnsafeMigrationTargetDirName(canonicalDirName)
    ) {
      plan.skipped.push(
        await buildSkippedInfo(dir, entry, 'parent-dir-traversal', canonicalScopeKey),
      );
      continue;
    }
    // Windows 文件系统大小写不敏感: Desktop `C:/Repo` 与 git `C:/repo`
    // sanitize 后仅大小写不同, 仍是同一分片。大小写比较不改存储形态
    // (Codex #2519 3974544919)。
    const windowsFs =
      windowsFsIdentity(rawAbs) || windowsFsIdentity(canonicalScopeKey);
    const isLegacy = !sameMigrationDirName(canonicalDirName, entry, windowsFs);
    const canonicalAbs = path.join(memoryRoot, canonicalDirName);
    if (isLegacy && (await isSymlinkShardDir(canonicalAbs))) {
      // 规划已把同名 symlink 条目跳过, 但 canonical 目标仍可能是链接;
      // 跟随写入会打到 memoryRoot 外 (Codex #2519 3974544925)。
      plan.skipped.push(
        await buildSkippedInfo(dir, entry, 'symlink-canonical', canonicalScopeKey),
      );
      continue;
    }
    if (isLegacy && (await shardHasSymlinkSystemFile(canonicalAbs))) {
      // 既有 canonical 的 MEMORY.md / meta.json / fts.db 若是 symlink,
      // rebuildIndex / updateMeta 会跟随覆盖根外 (Codex #2519 3975030337)。
      plan.skipped.push(
        await buildSkippedInfo(dir, entry, 'symlink-system-file', canonicalScopeKey),
      );
      continue;
    }
    if (isLegacy && (await shardHasSymlinkShardFile(canonicalAbs))) {
      // 既有 canonical 的合法记录若是 symlink, rebuildIndex 会把根外
      // frontmatter/正文编进 MEMORY.md 与 FTS (Codex #2519 3975187669)。
      plan.skipped.push(
        await buildSkippedInfo(dir, entry, 'symlink-canonical-record', canonicalScopeKey),
      );
      continue;
    }

    const info: LegacyShardInfo = {
      dir,
      legacyWorkdir: meta.absPath || entry,
      canonicalScopeKey,
      canonicalDirName,
      isLegacy,
      recordCount: 0,
      canonicalExistedAtPlan: await dirExists(path.join(memoryRoot, canonicalDirName)),
    };

    // 统计合法分片数 + 未识别遗留内容 (数据保全: 只有遗留文件 (含非
    // Markdown) 的目录不是「空」— 删掉会永久丢失用户内容; Greptile review
    // on #2519 第二轮 + Codex 第十轮: 只含 notes.txt/data.yaml 的分片同样
    // 不能按空删)。
    let files: string[];
    try {
      files = await fs.readdir(dir);
    } catch (e) {
      // ENOENT: 规划窗口内目录消失, 当空列表。EACCES/EIO 不得当空 — 否则
      // 含记录的 legacy 会进 emptyToDelete, --no-backup 下 trash 掉原作用域
      // (Codex #2519 3975030334 / Us6gqun4)。
      if (isEnoentError(e)) {
        files = [];
      } else {
        plan.failed.push(
          await buildSkippedInfo(
            dir,
            entry,
            `dir-read-failure:${errnoCode(e)}`,
            canonicalScopeKey,
          ),
        );
        continue;
      }
    }
    let hasUnrecognizedContent = false;
    let hasSymlinkShardFile = false;
    for (const f of files) {
      if (parseFilename(f)) {
        if (await isSymlinkPath(path.join(dir, f))) {
          hasSymlinkShardFile = true;
          continue;
        }
        info.recordCount += 1;
      } else if (!isSystemShardFile(f)) {
        hasUnrecognizedContent = true;
      }
    }
    if (hasSymlinkShardFile) {
      // 合法分片文件名若是 symlink, readFile/copyFile/rebuildIndex 会跟随到根外
      // (Codex #2519 3974674258)。与 copyLegacyMemoryShardsSync 的 lstatSync 同款。
      plan.skipped.push(await buildSkippedInfo(dir, entry, 'symlink-shard-file', canonicalScopeKey));
      continue;
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

function canonicalizeMetaAbsPath(absPath: string): string {
  // 不 trim: POSIX / Windows 都允许目录名尾空格; trim 会把 `/home/project `
  // 改成 `/home/project`, 两者 sanitize 目录不同, 非 legacy 分片被误迁
  // (Codex 3972854308)。全空串已在读 meta 时按 invalid-meta 拒绝, 不在这里改写身份。
  if (process.platform === 'win32' || looksLikeWindowsLocalPath(absPath)) {
    return normalizeWindowsLocalScopeKey(absPath);
  }
  if (absPath.length > 1) return absPath.replace(/\/+$/, '');
  return absPath;
}

function isAbsoluteLocalPath(p: string): boolean {
  if (path.isAbsolute(p)) return true;
  // 跨平台规划: Linux CI 上 Windows 盘符/UNC 仍视为绝对; 相对盘符 C:foo 与裸 C: 不算 (Codex 3972854297)。
  if (/^[A-Za-z]:\//.test(p)) return true;
  if (p.startsWith('//') && p.length > 2) return true;
  return false;
}

/** 反复 decodeURIComponent, 挡住 `%2e%2e` / `%252e%252e` 绕过。 */
function decodePathForTraversalCheck(p: string): string {
  let cur = p;
  for (let i = 0; i < 3; i += 1) {
    try {
      const next = decodeURIComponent(cur.replace(/\+/g, ' '));
      if (next === cur) break;
      cur = next;
    } catch {
      break;
    }
  }
  return cur;
}

function pathHasParentDirSegment(p: string): boolean {
  const segs = p.replace(/\\/g, '/').split('/');
  return segs.some((s) => s === '..');
}

/** 元数据/canonical 路径含父目录段 (含编码绕过)。 */
function hasParentDirTraversal(p: string): boolean {
  return pathHasParentDirSegment(p) || pathHasParentDirSegment(decodePathForTraversalCheck(p));
}

/** path.join(memoryRoot, name) 不得逃出根: `.` / `..` / 空 / 含分隔符。 */
function isUnsafeMigrationTargetDirName(name: string): boolean {
  if (!name || name === '.' || name === '..') return true;
  if (name.includes('/') || name.includes('\\')) return true;
  return pathHasParentDirSegment(name);
}

function windowsFsIdentity(p: string): boolean {
  return process.platform === 'win32' || looksLikeWindowsLocalPath(p);
}

/** Windows 分片目录名按文件系统身份比较, 不改 sanitize 存储形态。 */
function sameMigrationDirName(a: string, b: string, windowsFs: boolean): boolean {
  if (windowsFs) return a.toLowerCase() === b.toLowerCase();
  return a === b;
}

function errnoCode(e: unknown): string {
  const code = typeof e === 'object' && e !== null ? (e as { code?: unknown }).code : undefined;
  return typeof code === 'string' && code.length > 0 ? code : 'UNKNOWN';
}

function isEnoentError(e: unknown): boolean {
  return errnoCode(e) === 'ENOENT';
}

async function buildSkippedInfo(
  dir: string,
  entry: string,
  reason?: string,
  legacyWorkdir?: string,
): Promise<LegacyShardInfo> {
  return {
    dir,
    legacyWorkdir: legacyWorkdir ?? entry,
    canonicalScopeKey: entry,
    canonicalDirName: entry,
    isLegacy: false,
    recordCount: -1,
    skipReason: reason,
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
const WINDOWS_DRIVE_RE = /^[A-Za-z]:$/;

/**
 * 把托管段之前的路径段还原成主仓根。根盘 / POSIX 根不能用 join 丢分隔符:
 * `C:\\.cindy-worktrees\\name` 的前缀是 `C:`, 必须还原成 `C:/` 而不是 `C:`
 * (`C:` → sanitize `C-`, `C:/` → `C--`; Codex review on #2519 第十七轮);
 * POSIX `/.cindy-worktrees/name` 前缀为空, 必须还原成 `/` 而不是拒绝。
 */
function prefixSegmentsToMainRoot(prefixSegs: string[], original: string): string | null {
  const meaningful = prefixSegs.filter((s) => s.length > 0);
  if (meaningful.length === 0) {
    if (original.startsWith('//') || original.startsWith('\\')) return '//';
    return '/';
  }
  if (meaningful.length === 1 && WINDOWS_DRIVE_RE.test(meaningful[0])) {
    return `${meaningful[0]}/`;
  }
  // UNC: ['', '', 'server', 'share'] 或 ['', 'server', 'share'] 经 split 后
  const uncHost = prefixSegs[0] === '' && prefixSegs[1] === '' ? prefixSegs.slice(2) : null;
  if (uncHost && uncHost.length >= 1) {
    return '//' + uncHost.filter((s) => s.length > 0).join('/');
  }
  const joined = prefixSegs.filter((s) => s.length > 0).join('/');
  if (joined.length === 0) return null;
  return original.startsWith('/') ? `/${joined}` : joined;
}

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
    const mainRoot = prefixSegmentsToMainRoot(segments.slice(0, i), absPath);
    if (mainRoot === null) continue;
    const subPath = segments.slice(i + 2).filter((s) => s.length > 0).join('/');
    const joined = subPath ? `${mainRoot.replace(/\/+$/, '')}/${subPath}` : mainRoot;
    if (looksLikeWindowsLocalPath(absPath) || process.platform === 'win32') {
      return normalizeWindowsLocalScopeKey(joined);
    }
    return joined;
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
  const renameFn = opts.rename ?? ((from: string, to: string) => fs.rename(from, to));
  const dropFtsFn = (dir: string) => dropStaleFts(dir, opts.rmFile);
  const result: RunMigrationResult = { results: [], conflicts: [] };
  // 本轮 rename 创建的 canonical, 后续同目标候选走合并而非 concurrent-create
  // (Codex #2519 3975187667)。大小写不敏感 FS 用小写键对齐目录身份。
  const createdThisRun = new Set<string>();
  const canonicalBackupDone = new Set<string>();
  const targetIdentityKey = (dir: string, windowsFs: boolean) =>
    windowsFs ? dir.toLowerCase() : dir;
  const backupCanonicalOnce = async (targetDir: string, windowsFs: boolean) => {
    if (!backupRoot) return;
    const key = targetIdentityKey(targetDir, windowsFs);
    if (canonicalBackupDone.has(key)) return;
    await backupDir(targetDir, backupRoot);
    canonicalBackupDone.add(key);
  };

  // ── 1. 空分片删除 ───────────────────────────────────────────────
  for (const shard of plan.emptyToDelete) {
    const r: ShardMigrationResult = { shard, action: 'removed-empty' };
    try {
      if (await isSymlinkShardDir(shard.dir)) {
        r.action = 'skipped';
        r.error = 'symlink-shard';
        result.results.push(r);
        continue;
      }
      if (await shardHasSymlinkShardFile(shard.dir)) {
        r.action = 'skipped';
        r.error = 'symlink-shard-file';
        result.results.push(r);
        continue;
      }
      if (await shardHasSymlinkSystemFile(shard.dir)) {
        r.action = 'skipped';
        r.error = 'symlink-system-file';
        result.results.push(r);
        continue;
      }
      if (
        sameMigrationDirName(
          path.basename(shard.dir),
          shard.canonicalDirName,
          windowsFsIdentity(shard.canonicalScopeKey),
        )
      ) {
        r.action = 'skipped';
        r.error = 'case-only-alias';
        result.results.push(r);
        continue;
      }
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
      await renameFn(shard.dir, trashDir);
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
      if (await isSymlinkShardDir(shard.dir)) {
        r.action = 'skipped';
        r.error = 'symlink-shard';
        result.results.push(r);
        continue;
      }
      if (await shardHasSymlinkShardFile(shard.dir)) {
        r.action = 'skipped';
        r.error = 'symlink-shard-file';
        result.results.push(r);
        continue;
      }
      if (await shardHasSymlinkSystemFile(shard.dir)) {
        r.action = 'skipped';
        r.error = 'symlink-system-file';
        result.results.push(r);
        continue;
      }
      if (
        hasParentDirTraversal(shard.canonicalScopeKey) ||
        isUnsafeMigrationTargetDirName(shard.canonicalDirName)
      ) {
        r.action = 'skipped';
        r.error = 'parent-dir-traversal';
        result.results.push(r);
        continue;
      }
      if (
        sameMigrationDirName(
          path.basename(shard.dir),
          shard.canonicalDirName,
          windowsFsIdentity(shard.canonicalScopeKey),
        )
      ) {
        r.action = 'skipped';
        r.error = 'case-only-alias';
        result.results.push(r);
        continue;
      }
      const targetDir = path.join(path.dirname(shard.dir), shard.canonicalDirName);
      if (await isSymlinkShardDir(targetDir)) {
        r.action = 'skipped';
        r.error = 'symlink-canonical';
        result.results.push(r);
        continue;
      }
      if (await shardHasSymlinkSystemFile(targetDir)) {
        r.action = 'skipped';
        r.error = 'symlink-system-file';
        result.results.push(r);
        continue;
      }
      if (await shardHasSymlinkShardFile(targetDir)) {
        r.action = 'skipped';
        r.error = 'symlink-canonical-record';
        result.results.push(r);
        continue;
      }
      const windowsFs =
        windowsFsIdentity(shard.canonicalScopeKey) || windowsFsIdentity(shard.dir);
      const createdKey = targetIdentityKey(targetDir, windowsFs);
      const targetExists = await dirExists(targetDir);
      const createdByThisRun = createdThisRun.has(createdKey);
      if (
        !shard.canonicalExistedAtPlan &&
        !createdByThisRun &&
        (targetExists || (await pathExists(targetDir)))
      ) {
        // 计划时不存在、apply 前被外部并发创建 → 不得 rename/merge 覆盖新分片
        // (Codex #2519 3974808630)。本轮先前候选刚创建的目标除外
        // (Codex #2519 3975187667)。
        r.action = 'skipped';
        r.error = 'concurrent-create';
        result.results.push(r);
        continue;
      }

      if (!targetExists) {
        // 快路径: canonical 分片不存在 → rename 整个目录
        if (backupRoot) await backupDir(shard.dir, backupRoot);
        // 先快照源 meta / 索引, rename 后 finalize 失败时一并还原,
        // 避免滚回路径后 meta.absPath 已是 canonical → dir-name-mismatch
        // 或看起来不再是 legacy (Codex #2519 3975785141)。
        const originalMeta = await fs
          .readFile(path.join(shard.dir, 'meta.json'))
          .catch(() => null);
        const originalIndex = await fs
          .readFile(path.join(shard.dir, 'MEMORY.md'))
          .catch(() => null);
        try {
          await renameFn(shard.dir, targetDir);
        } catch (e) {
          const code = errnoCode(e);
          if (code === 'EEXIST' || code === 'ENOTEMPTY') {
            r.action = 'skipped';
            r.error = 'concurrent-create';
            result.results.push(r);
            continue;
          }
          throw e;
        }
        const rollbackFastPathRename = async (): Promise<string | null> => {
          try {
            if (originalMeta) {
              await fs.writeFile(path.join(targetDir, 'meta.json'), originalMeta);
            }
            if (originalIndex) {
              await fs.writeFile(path.join(targetDir, 'MEMORY.md'), originalIndex);
            }
            await fs.rename(targetDir, shard.dir);
            return null;
          } catch (rb) {
            return String(rb);
          }
        };
        try {
          // meta.absPath 更新为 canonical scope key (原值 = 旧 worktree 路径)
          await updateMetaAbsPath(targetDir, shard.canonicalScopeKey, now());
          // 重建 MEMORY.md — legacy 分片索引可能缺失/过期 (写入与重建之间崩溃
          // 或人工修复), 不重建的话 canonical 会话 getIndex() 读到 stale 索引,
          // 记忆进不了 prompt (Codex review on #2519 第十一轮, 与合并路径一致)
          await rebuildIndexFile(targetDir);
          // 丢弃 legacy 的 fts.db 与 sidecar — FTS 曾有更新失败时文件新但行数
          // 碰巧匹配, sanityCheck() 只对比行数 → memory_search 一直返回 stale
          // 行。删除后下次打开由 sanity check 以文件为 source of truth 重建
          // (Codex review on #2519 第十六轮)。rm 失败不得报 renamed
          // (Codex #2519 3971991067): 旧 fts.db 残留会让新 store 撞 stale FTS。
          await dropFtsFn(targetDir);
        } catch (e) {
          const rollbackError = await rollbackFastPathRename();
          if (rollbackError) {
            r.action = 'rename-incomplete';
            r.error = `post-rename failed (${String(e)}); rollback failed: ${rollbackError}`;
            result.results.push(r);
            continue;
          }
          r.action = 'skipped';
          r.error = `post-rename failed, rolled back: ${String(e)}`;
          result.results.push(r);
          continue;
        }
        createdThisRun.add(createdKey);
        r.action = 'renamed';
      } else {
        // 慢路径: 逐文件合并
        if (backupRoot) {
          // 首次改写已有 canonical 前备份目标, 否则默认备份只有 legacy 源,
          // 无法把目标恢复到迁移前 (Codex #2519 3968440926)。
          await backupCanonicalOnce(targetDir, windowsFs);
          await backupDir(shard.dir, backupRoot);
        }
        const merged = await mergeFilesInto(shard, targetDir, result.conflicts);
        r.mergedFiles = merged;
        // 合并后重建目标 MEMORY.md (从分片 frontmatter 派生)
        await rebuildIndexFile(targetDir);
        // 慢路径不 rename 整个目录, canonical 上可能残留 stale fts.db;
        // sanityCheck 只比行数, 合并后文件数碰巧相等会漏掉新记录
        // (Codex #2519 3975030344)。rm 失败不得当成功 merged。
        try {
          await dropFtsFn(targetDir);
        } catch (e) {
          r.action = 'merged';
          r.error = `stale fts.db remove failed: ${String(e)}`;
          result.results.push(r);
          continue;
        }
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
        await renameFn(shard.dir, trashDir);
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
    if (await isSymlinkPath(src)) continue;
    const srcBuf = await fs.readFile(src);
    const dstExists = await pathExists(dst);

    if (!dstExists) {
      try {
        await fs.copyFile(src, dst, constants.COPYFILE_EXCL);
        out.push({ filename, outcome: 'copied' });
        continue;
      } catch (e) {
        if (errnoCode(e) !== 'EEXIST') throw e;
        // pathExists 后、copy 前被并发创建: 不得覆盖 (Codex #2519 3974808630)
      }
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

/**
 * 丢弃分片目录中的 FTS 文件 (fts.db + SQLite sidecar)。rename 快路径把
 * legacy fts.db 原样带入 canonical — FTS 曾有更新失败时文件内容新但行数
 * 碰巧匹配, sanityCheck() 只对比行数, memory_search 持续返回 stale 行。
 * 删除后下次打开由 sanity check 以文件为 source of truth 重建 (Codex
 * review on #2519 第十六轮)。文件不存在时静默。
 */
async function dropStaleFts(
  dir: string,
  rmFile?: (filePath: string) => Promise<void>,
): Promise<void> {
  const rm = rmFile ?? ((p: string) => fs.rm(p, { force: true }));
  const errors: string[] = [];
  for (const name of ['fts.db', 'fts.db-wal', 'fts.db-shm']) {
    try {
      await rm(path.join(dir, name));
    } catch (e) {
      // ENOENT 由 force:true 覆盖; 其它错误 (Windows 锁 / ACL) 必须 surface
      // (Codex #2519 3971991067), 不能假定下次 sanityCheck 会重建。
      errors.push(`${name}: ${String(e)}`);
    }
  }
  if (errors.length > 0) {
    throw new Error(errors.join('; '));
  }
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

/** 目录中合法分片文件 (<type>_<slug>.md) 的数量。目录不存在返 0; 其它 I/O 抛出。 */
async function countShardFiles(dir: string): Promise<number> {
  const files = await readShardDir(dir);
  return files.filter((f) => parseFilename(f)).length;
}

/**
 * 路径是否位于活 git 仓库内 — 从 `<p>` 向上遍历祖先目录找 `.git` 标记
 * (目录或 gitdir 指针文件)。静态推导前的护栏: 普通 checkout 恰好位于
 * .cindy-worktrees 下、会话 workdir 是子目录时 (如 /home/me/.cindy-worktrees/
 * proj/apps/a), `.git` 在祖先 proj/ 下 — 只查 `<p>/.git` 会误判非活仓库并
 * 推导成错误主仓根 (Codex review on #2519 第十二轮 + 第十四轮)。
 *
 * 但遍历祖先对**已归档的托管 worktree** 误伤: /repo/.cindy-worktrees/<name>/
 * 的 <name> 已删除后 worktree 无 .git, 而主仓 /repo/.git 仍存在 — 遍历命中
 * 主仓标记会判活仓库、跳过静态推导, 记忆永远孤儿 (Codex review on #2519
 * 第十五轮)。因此仅在「有托管证据」或「托管根已不在磁盘」(git worktree
 * remove 清掉目录+登记) 时遍历才止步于托管 worktree 根。普通仓内同名目录
 * 仍然存在且无登记, 不把该段当托管根, 继续向上找真正的仓库标记。
 * 非托管形态保持遍历到根的行为。
 */
async function isLiveGitRepo(p: string): Promise<boolean> {
  // 托管根从原始 absPath 重建 (保留 POSIX 前导 /), 不要 path.resolve 后再
  // 比 stop: Windows 会把 `/repo/.cindy-worktrees/wt` 绑到当前盘, 且错误
  // 重建的相对 stop 永远对不上绝对祖先, 命中主仓 `.git` 误判存活
  // (Codex review on #2519 3971230671)。
  const managed = managedWorktreeRoot(p);
  let stop: string | null = null;
  if (managed) {
    const evidence = await hasManagedWorktreeEvidence(p);
    const rootStillThere = await dirExists(managed);
    // 登记还在, 或 worktree remove 后目录已消失 → 止步托管根, 不把主仓 .git
    // 当活仓库。目录还在且无登记 → 普通仓同名路径, 继续向上。
    if (evidence || !rootStillThere) stop = managed;
  }
  let cur = p;
  for (;;) {
    try {
      const s = await fs.stat(path.join(cur, '.git'));
      if (s.isDirectory() || s.isFile()) return true;
    } catch {
      // 继续向上
    }
    if (stop !== null && sameLocalPath(cur, stop)) return false; // 托管根未命中 → 非活仓库
    const parent = path.dirname(cur);
    if (parent === cur) return false;
    cur = parent;
  }
}

function sameLocalPath(a: string, b: string): boolean {
  const norm = (s: string): string => {
    const n = s.replace(/\\/g, '/').replace(/\/+$/, '');
    return n === '' ? '/' : n;
  };
  const na = norm(a);
  const nb = norm(b);
  if (process.platform === 'win32' || looksLikeWindowsLocalPath(a) || looksLikeWindowsLocalPath(b)) {
    return na.toLowerCase() === nb.toLowerCase();
  }
  return na === nb;
}

/**
 * 路径是否有 Cindy 托管 worktree 证据, 而非仅目录名碰巧叫
 * `.cindy-worktrees/<name>`。证据任一即可:
 *   1. 托管根 (含 worktree 名) 自身有 `.git` 标记 (活 worktree / 未清 gitdir)
 *   2. 主仓登记 `<mainRoot>/.git/worktrees/<name>` (归档后磁盘目录已删,
 *      但 git 仍保留 worktree 元数据, 直至 prune)
 * 都没有则禁止静态推导: 目录还在 = 普通仓同名路径 (第十六轮);
 * 目录已删 = 歧义, 由调用方标 `ambiguous-managed-worktree` 而非自动并入
 * (Codex 3972854282)。
 */
async function hasManagedWorktreeEvidence(absPath: string): Promise<boolean> {
  const root = managedWorktreeRoot(absPath);
  if (!root) return false;
  try {
    const s = await fs.stat(path.join(root, '.git'));
    if (s.isDirectory() || s.isFile()) return true;
  } catch {
    // 归档 worktree 通常已无 .git, 继续看主仓登记
  }
  return hasGitWorktreeRegistration(absPath);
}

/**
 * 祖先是否是「普通 linked worktree」: 文件形态 `.git` 且 gitdir 指向
 * `<main>/.git/worktrees/<name>`。主仓 / 独立仓的 `.git` 是目录;
 * 主仓内 submodule 的 gitdir 指向 `.git/modules/` — 解析回落原路径是正确结果,
 * 不得记 `worktree-resolve-failure` (Codex 3974808633 / 修 2 过宽回归)。
 */
async function hasFileFormGitdir(absPath: string): Promise<boolean> {
  let cur = absPath;
  for (;;) {
    try {
      const gitPath = path.join(cur, '.git');
      const s = await fs.lstat(gitPath);
      if (s.isFile()) {
        const body = await fs.readFile(gitPath, 'utf8').catch(() => '');
        if (/[\\/]worktrees[\\/]/.test(body)) return true;
        // submodule 或未知 gitdir 指针: 继续向上, 不在这一层判定 linked worktree
      } else if (s.isDirectory()) {
        return false;
      }
    } catch {
      // 继续向上
    }
    const parent = path.dirname(cur);
    if (parent === cur) return false;
    cur = parent;
  }
}

/** 主仓是否仍登记该托管 worktree (`.git/worktrees/<name>`)。 */
async function hasGitWorktreeRegistration(absPath: string): Promise<boolean> {
  const root = managedWorktreeRoot(absPath);
  if (!root) return false;
  const worktreeName = path.basename(root);
  const mainRoot = path.dirname(path.dirname(root));
  if (!worktreeName || !mainRoot) return false;
  try {
    const s = await fs.stat(path.join(mainRoot, '.git', 'worktrees', worktreeName));
    return s.isDirectory() || s.isFile();
  } catch {
    return false;
  }
}

/**
 * 是否应对已归档托管路径做静态推导。
 * - 仍有 worktree `.git` 或 `.git/worktrees/<name>` 登记 → 是托管, 推导
 * - 无证据且目录已删 → 不推导 (调用方标歧义; Codex 3972854282)
 * - 普通仓内同名目录还在磁盘上、且无登记 → 不推导 (第十六轮护栏)
 */
async function shouldDeriveArchivedManagedWorktree(absPath: string): Promise<boolean> {
  const root = managedWorktreeRoot(absPath);
  if (!root) return false;
  return hasManagedWorktreeEvidence(absPath);
}

/**
 * 托管 worktree 根 (含 worktree 名) — 解析 absPath 中 `.cindy-worktrees/<name>`
 * 或 `.xdt-worktrees/<name>` 段 (两种分隔符), 返回该段整体路径; 无托管段
 * 返回 null。
 */
export function managedWorktreeRoot(absPath: string): string | null {
  const segments = absPath.split(/[\\/]/);
  for (let i = 0; i < segments.length - 1; i += 1) {
    if (!MANAGED_WORKTREE_DIRS.includes(segments[i])) continue;
    const worktreeName = segments[i + 1];
    if (worktreeName.length === 0) continue;
    // 保留 path.parse(absPath).root: 不要 segments.join(path.sep) /
    // path.join('') — POSIX `/repo/.cindy-worktrees/wt` 的空首段会被丢掉,
    // 变成相对 `repo/...`, dirExists / isLiveGitRepo stop 对不上, 已删
    // worktree 误判存活 (Codex review on #2519 3971230671)。
    const reconstructed = prefixSegmentsToMainRoot(segments.slice(0, i + 2), absPath);
    if (reconstructed === null) continue;
    if (looksLikeWindowsLocalPath(absPath) || process.platform === 'win32') {
      return normalizeWindowsLocalScopeKey(reconstructed);
    }
    return reconstructed;
  }
  return null;
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
  const current = new Set((await readShardDir(dir)).filter((f) => parseFilename(f)));
  const added = [...current].filter((f) => !snapshot.has(f));
  const missing = [...snapshot].filter((f) => !current.has(f));
  return { added, missing };
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
  const files = await readShardDir(dir);
  return files.filter((f) => !isSystemShardFile(f) && !parseFilename(f));
}
