/**
 * cleanup.ts — 分片内清理 (P0.5, #2379)。
 *
 * 背景: #2379 正文问题二实测主仓 canonical 分片 80 条记忆存在三类劣化:
 *   - 重复: 同一条规则被写成 6 个独立条目, 正文合计 5.7 KB;
 *   - 过期未清: 4 条已终态的项目归档仍占索引;
 *   - digest 冗余: 10 个 compaction digest 占 80 KB, 内容高度重叠。
 * 这些是「写进了读得到的地方」但「随用随劣化」的问题 — 与 P0 的跨分片
 * 迁移 (migrate.ts) 不同, 本模块做的是**单个分片内部**的内容整理。
 *
 * 与 #2379 / #2529 评论收敛的一致方向 (「归档而非删除」冷存储):
 *  - 所有清理动作都是**归档** (rename 进 `<shard>/.archive/`), 不是删除;
 *    归档文件退出 storage.list()/MEMORY.md/FTS 正常路径, 但仍完整留在
 *    磁盘上, 用户可随时手工找回 — 对记忆数据不可逆删除是禁区。
 *
 * 自动执行 vs 仅报告的分界:
 *  - **自动归档** (确定性, 无信息损失): 完全重复 (title+description+body 一致)
 *    保留 updatedAt 最新一条; digest 保留最新 N 份, 其余归档。
 *  - **仅报告** (语义判断, 不自动动): 终态信号候选 — 「是否已关闭」「替换
 *    deprecated 接口」等否定/疑问/引用上下文单靠子串无法可靠区分, 纯启发式
 *    会被反复挑出反例 (Greptile/Codex on #2561)。因此终态候选只进
 *    `staleCandidates` 报告, **不自动归档**; 需用户确认后显式 `--archive-stale`
 *    才归档 (Codex P2 on #2561: bare terms should be report-only)。近似重复
 *    (同 title 不同内容) 同理只报告, 交 memory_review (LLM) 或人工 — 那是 P1 的活。
 *
 * 本模块只做文件层整理, 不碰 SQLite (与 migrate.ts 同一原则): 文件是
 * source of truth, 目标分片下次打开时 store.init() 的 sanityCheck 会因
 * 行数不一致自动重建 FTS。
 *
 * 流程: planMemoryCleanup() 纯扫描出计划 (dry-run 可预览);
 * runMemoryCleanup() 执行归档 (幂等, 可重复跑)。
 */

import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import matter from 'gray-matter';

import {
  CLEANUP_EXCLUSIVE_LOCK_DIR,
  MemoryStorage,
  parseFilename,
} from './storage.js';
import type { MemoryRecord } from './types.js';

export { CLEANUP_EXCLUSIVE_LOCK_DIR };

export class CleanupLockError extends Error {
  override name = 'CleanupLockError';
  code = 'CLEANUP_LOCK_HELD';
}

export interface CleanupExclusiveLock {
  lockDir: string;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: 进程存在但无权发信号, 仍视为持有者活着。
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function stealStaleCleanupLock(lockDir: string): Promise<boolean> {
  try {
    const raw = await fs.readFile(path.join(lockDir, 'owner.json'), 'utf8');
    const pid = (JSON.parse(raw) as { pid?: unknown }).pid;
    if (typeof pid === 'number' && pidAlive(pid)) return false;
  } catch {
    // 缺 owner.json / 损坏 → 视为 stale
  }
  await fs.rm(lockDir, { recursive: true, force: true });
  return true;
}

/**
 * apply 从宿主检查到 rebuild 完成期间持有的排他锁。mkdir 原子占有;
 * 活着的 holder 不得被抢 (Codex P1 on #2561: hold exclusive lock after
 * host check through apply/rebuild)。
 */
export async function acquireCleanupExclusiveLock(
  shardDir: string,
): Promise<CleanupExclusiveLock> {
  const lockDir = path.join(shardDir, CLEANUP_EXCLUSIVE_LOCK_DIR);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await fs.mkdir(lockDir);
      await fs.writeFile(
        path.join(lockDir, 'owner.json'),
        `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`,
        'utf8',
      );
      return { lockDir };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      if (!(await stealStaleCleanupLock(lockDir))) {
        throw new CleanupLockError(
          'another process holds the maker-memory cleanup exclusive lock; wait for it to finish',
        );
      }
    }
  }
  throw new CleanupLockError('unable to acquire maker-memory cleanup exclusive lock');
}

export async function releaseCleanupExclusiveLock(
  handle: CleanupExclusiveLock | null | undefined,
): Promise<void> {
  if (!handle?.lockDir) return;
  await fs.rm(handle.lockDir, { recursive: true, force: true });
}

/** 归档子目录名 — 退出 storage.list()/MEMORY.md/FTS 正常路径的可逆软删除区。 */
export const ARCHIVE_DIR_NAME = '.archive';

/** Unix `ps -eo comm` / Windows exe basename 中认为 Cindy 宿主的进程名。 */
const HOST_COMM_BASENAMES = new Set(['cindy', 'cindydev', 'desktop', 'electron']);

/**
 * 把 `ps -eo comm` / 路径型 comm 收成 basename。
 * macOS 上 comm 常是 `/Applications/Cindy.app/Contents/MacOS/Cindy`, 不是 `cindy`
 * (Codex P1 on #2561: Normalize macOS ps command paths before matching)。
 */
export function normalizeProcessComm(comm: string | null | undefined): string {
  const raw = String(comm ?? '')
    .trim()
    .replace(/^["']+|['"]+$/g, '')
    .replace(/\0/g, '');
  if (!raw) return '';
  const segs = raw.split(/[/\\]/).filter(Boolean);
  const base = segs[segs.length - 1] ?? raw;
  return base.toLowerCase().replace(/\.exe$/i, '');
}

export function isCindyHostComm(comm: string | null | undefined): boolean {
  return HOST_COMM_BASENAMES.has(normalizeProcessComm(comm));
}

/**
 * 强终态信号 — 中文的明确状态短语, 命中 body/description 且 type 为
 * project/reference 时列入**高置信**终态候选 (#2379 正文「4 条已终态项目归档」
 * 的判定依据; 其中一条描述自己写着「当前状态需重新查询 GitHub」)。
 * 注意: 只进 staleCandidates 报告, 不自动归档 (见文件头「仅报告」说明)。
 */
export const STALE_STRONG_SIGNALS: ReadonlyArray<string> = [
  '已归档',
  '已结束',
  '已终态',
  '不再维护',
  '已废弃',
  '已下线',
  '已关闭',
  '已完结',
  '需重新查询',
  '已过期',
  '已取消',
  '已移除',
  '不再活跃',
];

/**
 * 弱终态信号 — 英文 broad 形容词, 常作引用/修饰语出现
 * ("read the archived logs" / "use X instead of deprecated Y"), 列入**低置信**
 * 终态候选 (reason='weak-signal')。只报告不归档。
 */
export const STALE_WEAK_SIGNALS: ReadonlyArray<string> = [
  'deprecated',
  'archived',
  'obsolete',
  'no longer maintained',
  'no longer active',
  'no longer in use',
];

/** age 归档默认阈值 (天): updatedAt 早于该时间的 project 条目列入低置信候选。 */
export const DEFAULT_STALE_AGE_DAYS = 90;

/** digest 保留数默认值 (#2379 正文「digest 只留最近 1–2 份」)。 */
export const DEFAULT_KEEP_DIGESTS = 2;

/**
 * CLI `--keep-digests` 与审阅 plan 共用: 必须是 >=0 的整数。
 * 0 合法 (全清 digest); 负数会让 slice(0, -N) 把全部 digest 标成归档
 * (Codex P2 on #2561: Validate keepDigests loaded from the reviewed plan)。
 */
export function parseKeepDigests(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`keepDigests must be a >=0 integer, got ${String(value)}`);
  }
  return value;
}

/** CLI `--help` 以外的解析失败 (exit 2)。 */
export class CleanupCliUsageError extends Error {
  readonly exitCode = 2;
  constructor(message: string) {
    super(message);
    this.name = 'CleanupCliUsageError';
  }
}

export interface CleanupCliOptions {
  shard: string | null;
  dryRun: boolean;
  keepDigests: number | null;
  backupDir: string | null;
  archiveStale: boolean;
  force: boolean;
  json: boolean;
  writePlan: string | null;
  fromPlan: string | null;
  staleSetHash: string | null;
  confirmStaleDiff: boolean;
}

export type CleanupCliParseResult =
  | { help: true }
  | { help?: false; options: CleanupCliOptions };

function requireCliOperand(argv: string[], idx: number, flag: string): string {
  const v = argv[idx];
  if (v == null || (v.startsWith('-') && Number.isNaN(Number(v)))) {
    throw new CleanupCliUsageError(`${flag} 缺少参数 (收到 "${v ?? ''}")`);
  }
  return v;
}

/**
 * 解析 cleanup-maker-memory CLI 参数。`--help` 返回 `{ help: true }`,
 * 非法参数抛 CleanupCliUsageError (exit 2)。供脚本与默认单测 in-process
 * 共用, 避免每个用例再起 Node+tsx (Codex P1 on #2561: Keep only one CLI
 * subprocess smoke in the default unit tier)。
 */
export function parseCleanupCliArgs(argv: string[]): CleanupCliParseResult {
  const out: CleanupCliOptions = {
    shard: null,
    dryRun: true,
    keepDigests: null,
    backupDir: null,
    archiveStale: false,
    force: false,
    json: false,
    writePlan: null,
    fromPlan: null,
    staleSetHash: null,
    confirmStaleDiff: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') {
      return { help: true };
    }
    if (a === '--shard') {
      out.shard = requireCliOperand(argv, ++i, '--shard');
    } else if (a === '--apply') {
      out.dryRun = false;
    } else if (a === '--dry-run') {
      out.dryRun = true;
    } else if (a === '--archive-stale') {
      out.archiveStale = true;
    } else if (a === '--write-plan') {
      out.writePlan = requireCliOperand(argv, ++i, '--write-plan');
    } else if (a === '--from-plan') {
      out.fromPlan = requireCliOperand(argv, ++i, '--from-plan');
    } else if (a === '--stale-set-hash') {
      out.staleSetHash = requireCliOperand(argv, ++i, '--stale-set-hash');
    } else if (a === '--confirm-stale-diff') {
      out.confirmStaleDiff = true;
    } else if (a === '--keep-digests') {
      const raw = argv[++i];
      try {
        if (raw == null || raw === '') throw new Error('missing');
        out.keepDigests = parseKeepDigests(Number(raw));
      } catch {
        throw new CleanupCliUsageError(`--keep-digests 必须是 >=0 的整数, 收到 "${raw}"`);
      }
    } else if (a === '--backup-dir') {
      out.backupDir = requireCliOperand(argv, ++i, '--backup-dir');
    } else if (a === '--force') {
      out.force = true;
    } else if (a === '--json') {
      out.json = true;
    } else {
      throw new CleanupCliUsageError(`未知参数: ${a}`);
    }
  }
  return { options: out };
}

/** --apply --archive-stale 必须绑 dry-run 审阅集。 */
export function requireFromPlanForArchiveStale(opts: {
  dryRun: boolean;
  archiveStale: boolean;
  fromPlan: string | null;
}): void {
  if (!opts.dryRun && opts.archiveStale && !opts.fromPlan) {
    throw new CleanupCliUsageError(
      '--apply --archive-stale 必须提供 --from-plan <dry-run --write-plan 文件>。',
    );
  }
}

/** CLI --keep-digests 与审阅 plan 必须一致; 省略 CLI 时用审阅值。 */
export function resolveReviewedKeepDigests(
  cliKeep: number | null,
  reviewedKeep: number | undefined,
): number | null {
  if (cliKeep !== null && typeof reviewedKeep === 'number' && cliKeep !== reviewedKeep) {
    throw new CleanupCliUsageError(
      `--keep-digests ${cliKeep} 与 --from-plan 审阅值 ${reviewedKeep} 不一致, 拒绝 apply。`,
    );
  }
  if (cliKeep !== null) return cliKeep;
  if (typeof reviewedKeep === 'number') return reviewedKeep;
  return null;
}

/** 清理工具依赖注入 (测试可替换)。 */
export interface MemoryCleanupDeps {
  now?: () => string;
}

/** 一条待归档动作。 */
export interface ArchiveItem {
  filename: string;
  reason: 'duplicate' | 'stale' | 'digest-retention';
  /** 人类可读说明 (命中信号 / 重复于 / digest 超出保留数)。 */
  detail: string;
  /**
   * plan 时源文件内容的 sha256 — run 移动前重读对比, 源被并发更新
   * (--force 场景) 则 fail/replan, 不归档非预期内容 (Codex P1 on #2561:
   * recheck the shard before moving it)。读失败 (并发删除) 为 null。
   */
  expectedHash: string | null;
  /**
   * 重复组保留副本 (reason=duplicate 时) — plan 审阅时点的
   * 语义 contentHash + raw sha256。run 校验 keep 仍存在且 raw 一致:
   * 仅改 updatedAt (排名元数据) 也必须 replan, 否则会归档
   * 策略现在认为更新的那条 (Codex P1 on #2561: Bind duplicate
   * keepers to their ranking metadata)。
   */
  keep?: { filename: string; contentHash: string; expectedHash: string };
  /**
   * digest 精简的保留集 (reason=digest-retention 时) — plan 审阅时点
   * 各 keep 文件的 raw sha256, run 在归档前复验仍存在且内容一致,
   * 任一变化则失败要求重新规划 (不把仍在保留窗口内的
   * digest 归档掉) (Codex P1 on #2561: re-verify digest keep set before archive)。
   */
  digestKeep?: Array<{ filename: string; expectedHash: string }>;
}

/** 完全重复组 (title+description+body 三者一致, 仅 filename 不同)。 */
export interface DuplicateGroup {
  /** 归一化内容 hash (忽略 updatedAt 与 frontmatter 排版差异)。 */
  hash: string;
  /** 保留的文件名 (updatedAt 最新; 并列取 slug 字典序最小保证确定性)。 */
  keep: string;
  /** 归档的重复文件。 */
  archive: string[];
}

/** 近似重复组 (title 相同但内容不同) — 只报告, 不自动处理。 */
export interface NearDuplicateGroup {
  title: string;
  filenames: string[];
}

/** 终态候选 (只报告, 不自动归档)。 */
export interface StaleCandidate {
  filename: string;
  /** signal = 强信号 (高置信); weak-signal = 英文 broad 词 (低置信); age = 仅时间过期 (低置信)。 */
  reason: 'signal' | 'weak-signal' | 'age';
  /** 命中的信号词 (reason 为 signal / weak-signal 时)。 */
  matchedSignal?: string;
  updatedAt: string;
  /**
   * plan (用户审阅) 时点源文件内容的 sha256 — `--archive-stale` 执行时对比,
   * 源在审阅后被更新则 fail/replan, 不归档用户未审阅的新版本 (Greptile P1 /
   * Codex P1 on #2561: 终态计划未绑定文件版本)。
   */
  expectedHash: string | null;
}

/** digest 保留策略结果。 */
export interface DigestRetention {
  /** 保留的最新 N 个 digest (updatedAt 降序取前 N)。 */
  keep: string[];
  /** 归档的其余 digest。 */
  archive: string[];
}

/** 清理计划 (plan 输出, 纯只读扫描)。 */
export interface CleanupPlan {
  /** 分片目录绝对路径。 */
  shardDir: string;
  /** 当前所有合法分片 (含 digest)。 */
  records: MemoryRecord[];
  /** 完全重复组 (run 归档 archive, 保留 keep)。 */
  duplicates: DuplicateGroup[];
  /** 近似重复组 (只报告)。 */
  nearDuplicates: NearDuplicateGroup[];
  /** 终态候选 (只报告; --archive-stale 才归档)。 */
  staleCandidates: StaleCandidate[];
  /** digest 保留策略。 */
  digests: DigestRetention;
  /** 汇总: run 默认归档的动作 = 完全重复 + digest 冗余 (确定性, 无语义判断)。 */
  archiveItems: ArchiveItem[];
}

export interface CleanupPlanOptions {
  deps?: MemoryCleanupDeps;
  /** digest 保留数 (默认 2)。 */
  keepDigests?: number;
  /** age 过期阈值 (天, 默认 90)。 */
  staleAgeDays?: number;
}

export interface CleanupRunOptions {
  deps?: MemoryCleanupDeps;
  /** 归档前先复制一份到该根目录 (可选真备份)。 */
  backupRoot?: string;
  /**
   * 是否归档终态候选 (默认 false)。终态判定是语义判断, 单靠信号词不可靠
   * (#2561 review), 默认只报告; 用户确认后显式置 true 才把 staleCandidates
   * 一并归档。
   */
  archiveStale?: boolean;
}

/**
 * 审阅计划里的分片文件名必须是本 shard 的 basename:
 * `<type>_<slug>.md`, 不得含分隔符/穿越/绝对路径
 * (Codex P1 on #2561: Reject unsafe filenames in reviewed plans)。
 */
export function assertSafeReviewedFilename(filename: string): void {
  if (typeof filename !== 'string' || filename.length === 0) {
    throw new Error('reviewed stale candidate missing filename');
  }
  if (filename !== path.basename(filename) || filename !== path.posix.basename(filename)) {
    throw new Error(`reviewed plan filename is not a shard basename: ${filename}`);
  }
  if (/[\\/]/.test(filename) || filename.includes('\0') || filename.includes('..')) {
    throw new Error(`reviewed plan filename is not a shard basename: ${filename}`);
  }
  if (!parseFilename(filename)) {
    throw new Error(`reviewed plan filename is not a canonical shard name: ${filename}`);
  }
}

/** dry-run 审阅过的终态候选 (filename + expectedHash) — apply 绑定集合用。 */
export interface ReviewedStaleCandidate {
  filename: string;
  expectedHash: string | null;
  reason?: StaleCandidate['reason'];
  matchedSignal?: string;
  updatedAt?: string;
}

export interface CleanupRunResult {
  /** 成功归档的文件。 */
  archived: ArchiveItem[];
  /** 归档失败/跳过的文件 (保留在原地, 下次重跑)。 */
  failed: Array<{ filename: string; error: string }>;
  /**
   * 归档后重建 MEMORY.md 失败时的错误 (索引可能 stale, 会把已归档文件继续
   * 注入后续会话 — 见 Codex P2 on #2561: store.init() 只修 FTS 不重建索引)。
   * 成功时为 undefined; 调用方 (CLI) 应告警并非零退出。
   */
  indexRebuildError?: string;
  /**
   * parked 恢复失败且规范 src 缺失时跳过 rebuildIndex,
   * 避免 MEMORY.md 把仍在 `.cleanup-parked-*` 的分片踢出索引
   * (Codex P1 on #2561: Preserve the index when parked restoration fails)。
   */
  skipIndexRebuild?: boolean;
}

/**
 * 扫描单个分片目录, 生成清理计划。纯只读, 不修改任何文件 (dry-run 安全)。
 * 目录不存在 → 返回空计划。分片 I/O 错误 (EACCES/EPERM/锁) 抛出,
 * 不得吞成空计划再让 apply 用残缺 list 重写 MEMORY.md (Codex P1 on #2561)。
 */
export async function planMemoryCleanup(
  shardDir: string,
  opts: CleanupPlanOptions = {},
): Promise<CleanupPlan> {
  const now = opts.deps?.now ?? (() => new Date().toISOString());
  const keepDigests =
    opts.keepDigests === undefined ? DEFAULT_KEEP_DIGESTS : parseKeepDigests(opts.keepDigests);
  const staleAgeDays = opts.staleAgeDays ?? DEFAULT_STALE_AGE_DAYS;

  const plan: CleanupPlan = {
    shardDir,
    records: [],
    duplicates: [],
    nearDuplicates: [],
    staleCandidates: [],
    digests: { keep: [], archive: [] },
    archiveItems: [],
  };

  const storage = new MemoryStorage(shardDir);
  // 分类与 raw 来自同一次读取 (listWithRaw), 避免 list() 后再读把
  // expectedHash 绑到宿主刷新后的新字节 (Codex P1 on #2561: 将
  // updatedAt 纳入候选版本校验 / 分类与原始字节同一读)。
  // 目录不存在: listWithRaw 对 readdir ENOENT 返 []; 其他 I/O 向上抛。
  const listed = await storage.listWithRaw();
  const records = listed.map((x) => x.rec);
  const rawByName = new Map(listed.map((x) => [x.rec.filename, x.raw]));
  plan.records = records;

  // ── 1. 完全重复: title+description+body 三者一致 → 一组 ─────────────
  const byHash = new Map<string, MemoryRecord[]>();
  for (const rec of records) {
    const hash = contentHash(rec);
    const arr = byHash.get(hash) ?? [];
    arr.push(rec);
    byHash.set(hash, arr);
  }
  for (const group of byHash.values()) {
    if (group.length < 2) continue;
    // 保留 updatedAt 最新; 并列取 filename 字典序最小 (确定性)。
    // 用纪元时间而不是 ISO 字符串字典序: `...T09:00:00-08:00` 比
    // `...T12:00:00Z` 更新, 但 `>` 会把 Z 排在前 (Codex P1 on #2561:
    // compare duplicate timestamps chronologically)。无效时间戳视为最旧。
    const keep = group.reduce((a, b) =>
      compareRecordsByUpdatedAt(b, a, rawByName.get(b.filename), rawByName.get(a.filename)) < 0
        ? b
        : a,
    );
    const archive = group.filter((r) => r.filename !== keep.filename).map((r) => r.filename);
    plan.duplicates.push({
      hash: contentHash(keep),
      keep: keep.filename,
      archive,
    });
    const keepRawHash = hashOfRaw(rawByName.get(keep.filename));
    if (keepRawHash === null) continue;
    for (const f of archive) {
      const expectedHash = hashOfRaw(rawByName.get(f));
      if (expectedHash === null) continue;
      plan.archiveItems.push({
        filename: f,
        reason: 'duplicate',
        detail: `duplicate of ${keep.filename}`,
        expectedHash,
        // 绑定保留副本的审阅时点 raw + 语义 hash: 只改 updatedAt 也必须
        // replan, 否则会归档策略现在认为更新的那条 (Codex P1 on #2561:
        // Bind duplicate keepers to their ranking metadata)。
        keep: {
          filename: keep.filename,
          contentHash: contentHash(keep),
          expectedHash: keepRawHash,
        },
      });
    }
  }

  // ── 2. 近似重复: 同 title 且至少两个不同内容 hash → 只报告 ─────────
  // 完全重复组 (同 title + 同 content hash) 已在第 1 步; 不得再当成
  // 「同 title 不同内容」报告, 否则 dry-run 既显示自动归档又要求人工复核
  // (Codex P2 on #2561)。
  const byTitle = new Map<string, MemoryRecord[]>();
  for (const rec of records) {
    const key = rec.frontmatter.title.trim();
    const arr = byTitle.get(key) ?? [];
    arr.push(rec);
    byTitle.set(key, arr);
  }
  for (const [title, group] of byTitle) {
    const hashes = new Set(group.map((r) => contentHash(r)));
    if (hashes.size < 2) continue;
    plan.nearDuplicates.push({ title, filenames: group.map((r) => r.filename) });
  }

  // ── 3. 终态候选: 只报告, 不自动归档 ──────────────────────────────────
  const ageCutoff = new Date(now()).getTime() - staleAgeDays * 24 * 60 * 60 * 1000;
  for (const rec of records) {
    const type = rec.frontmatter.type;
    // 只对 project/reference 判定「终态」; user/feedback 是偏好/纠正, 不适用
    // 「归档」语义 (digest 走第 4 步单独处理)。
    if (type !== 'project' && type !== 'reference') continue;

    const expectedHash = hashOfRaw(rawByName.get(rec.filename));
    if (expectedHash === null) continue;

    const haystack = `${rec.frontmatter.description}\n${rec.body}`.toLowerCase();
    const strong = STALE_STRONG_SIGNALS.find((s) => haystack.includes(s.toLowerCase()));
    if (strong) {
      plan.staleCandidates.push({
        filename: rec.filename,
        reason: 'signal',
        matchedSignal: strong,
        updatedAt: rec.frontmatter.updatedAt,
        expectedHash,
      });
      continue;
    }
    const weak = STALE_WEAK_SIGNALS.find((s) => haystack.includes(s.toLowerCase()));
    if (weak) {
      plan.staleCandidates.push({
        filename: rec.filename,
        reason: 'weak-signal',
        matchedSignal: weak,
        updatedAt: rec.frontmatter.updatedAt,
        expectedHash,
      });
      continue;
    }
    // YAML 未加引号的 ISO 会被 gray-matter 解成 Date, parseRawShard 再写成
    // now — 必须从 raw frontmatter 取龄, 与 duplicate/digest 路径一致
    // (Codex P1 on #2561: Parse raw YAML dates for stale-age classification)。
    const ts =
      parseFrontmatterUpdatedAt(rawByName.get(rec.filename)) ??
      parseUpdatedAtMs(rec.frontmatter.updatedAt);
    if (ts !== null && ts < ageCutoff) {
      plan.staleCandidates.push({
        filename: rec.filename,
        reason: 'age',
        updatedAt: rec.frontmatter.updatedAt,
        expectedHash,
      });
    }
  }

  // ── 4. digest 精简: 保留最新 N, 其余归档 ──────────────────────────────
  // 只接受 frontmatter 里可解析的 updatedAt — 正文里的 `updatedAt:` 字串
  // 或无效值不能当真实时间戳 (否则精简会误归档实际最新 digest)
  // (Codex P1 on #2561: only accept valid digest timestamps in frontmatter)。
  // 缺字段 / 无效 → 不参与精简 (仅报告, 不归档)。
  // 排序用纪元时间 (不是 ISO 字符串字典序): `...T09:00:00-08:00` 比
  // `...T12:00:00Z` 更新, 但 localeCompare 会把 Z 排在前
  // (Codex P1 on #2561: compare digest timestamps chronologically)。
  // duplicate 通过会先归档语义相同的旧 digest; retention keepers
  // 必须按归档后仍活跃的集合绑定, 否则 run 先执行 duplicate
  // 后 digest-retention 会 keeper 校验失败 (Codex P1 on #2561:
  // Reconcile duplicate digests before binding retention keepers)。
  const duplicateArchived = new Set(
    plan.archiveItems.filter((i) => i.reason === 'duplicate').map((i) => i.filename),
  );
  const digestMeta: Array<{ rec: MemoryRecord; ts: number }> = [];
  for (const r of records) {
    // filename type 与 frontmatter type 都必须是 digest。listWithRaw
    // 只把 parseFilename 留给 slug, 人工把 `project_notes.md` 改成
    // `type: digest` 不能进自动精简 (Codex P1 on #2561: Validate the
    // filename type before pruning digests)。
    if (parseFilename(r.filename)?.type !== 'digest') continue;
    if (r.frontmatter.type !== 'digest') continue;
    if (duplicateArchived.has(r.filename)) continue;
    const raw = rawByName.get(r.filename);
    const ts = parseFrontmatterUpdatedAt(raw);
    if (ts === null) continue;
    digestMeta.push({ rec: r, ts });
  }
  digestMeta.sort((a, b) => {
    if (b.ts !== a.ts) return b.ts - a.ts;
    return a.rec.filename.localeCompare(b.rec.filename);
  });
  const digests = digestMeta.map((d) => d.rec);
  plan.digests = {
    keep: digests.slice(0, keepDigests).map((r) => r.filename),
    archive: digests.slice(keepDigests).map((r) => r.filename),
  };
  const digestKeep: Array<{ filename: string; expectedHash: string }> = [];
  for (const f of plan.digests.keep) {
    const keepHash = hashOfRaw(rawByName.get(f));
    if (keepHash === null) continue;
    digestKeep.push({ filename: f, expectedHash: keepHash });
  }
  for (const f of plan.digests.archive) {
    const expectedHash = hashOfRaw(rawByName.get(f));
    if (expectedHash === null) continue;
    plan.archiveItems.push({
      filename: f,
      reason: 'digest-retention',
      detail: `digest beyond keep-latest-${keepDigests}`,
      expectedHash,
      digestKeep,
    });
  }

  return plan;
}

/** 分类同一读的 raw → expectedHash; 缺 raw (并发删除) 则跳过候选。 */
function hashOfRaw(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  return sha256(Buffer.from(raw, 'utf8'));
}

/**
 * 终态候选集的稳定指纹 (filename + expectedHash, 排序后 sha256)。
 * dry-run JSON 带上, 供自动化校验 apply 时集合未变。
 */
export function staleSetFingerprint(
  candidates: Array<{ filename: string; expectedHash: string | null }>,
): string {
  const lines = candidates
    .map((c) => `${c.filename}\t${c.expectedHash ?? ''}`)
    .sort();
  return createHash('sha256').update(lines.join('\n'), 'utf8').digest('hex');
}

/**
 * 把 apply 时计划的终态候选换成 dry-run 审阅集 (不归档审阅后新出现的 stale)。
 * 返回 live 扫描多出的候选, 供 CLI 报告; plan.staleCandidates 改写为审阅集。
 */
export function bindReviewedStaleCandidates(
  plan: CleanupPlan,
  reviewed: ReviewedStaleCandidate[],
): { extraLive: StaleCandidate[] } {
  const reviewedNames = new Set<string>();
  const bound: StaleCandidate[] = [];
  for (const r of reviewed) {
    if (reviewedNames.has(r.filename)) continue;
    reviewedNames.add(r.filename);
    bound.push({
      filename: r.filename,
      reason: r.reason ?? 'signal',
      matchedSignal: r.matchedSignal,
      updatedAt: r.updatedAt ?? '',
      expectedHash: r.expectedHash,
    });
  }
  const extraLive = plan.staleCandidates.filter((c) => !reviewedNames.has(c.filename));
  plan.staleCandidates = bound;
  return { extraLive };
}

/** dry-run --write-plan 落盘格式 (version=1)。 */
export interface ReviewedStalePlanFile {
  version: 1;
  shardDir?: string;
  keepDigests?: number | null;
  archiveStale?: boolean;
  staleFingerprint: string;
  staleCandidates: ReviewedStaleCandidate[];
}

/** 校验 --from-plan JSON, 指纹必须与候选集一致。 */
export function parseReviewedStalePlan(raw: unknown): ReviewedStalePlanFile {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('reviewed plan must be an object');
  }
  const obj = raw as Record<string, unknown>;
  if (obj.version !== 1) {
    throw new Error(`unsupported reviewed plan version: ${String(obj.version)}`);
  }
  if (!Array.isArray(obj.staleCandidates)) {
    throw new Error('reviewed plan missing staleCandidates');
  }
  const staleCandidates: ReviewedStaleCandidate[] = [];
  for (const item of obj.staleCandidates) {
    if (typeof item !== 'object' || item === null) {
      throw new Error('reviewed stale candidate must be an object');
    }
    const c = item as Record<string, unknown>;
    if (typeof c.filename !== 'string' || c.filename.length === 0) {
      throw new Error('reviewed stale candidate missing filename');
    }
    assertSafeReviewedFilename(c.filename);
    if (c.expectedHash !== null && typeof c.expectedHash !== 'string') {
      throw new Error(`reviewed stale candidate ${c.filename} has invalid expectedHash`);
    }
    const reason =
      c.reason === 'signal' || c.reason === 'weak-signal' || c.reason === 'age'
        ? c.reason
        : undefined;
    staleCandidates.push({
      filename: c.filename,
      expectedHash: c.expectedHash,
      reason,
      matchedSignal: typeof c.matchedSignal === 'string' ? c.matchedSignal : undefined,
      updatedAt: typeof c.updatedAt === 'string' ? c.updatedAt : undefined,
    });
  }
  const fingerprint = staleSetFingerprint(staleCandidates);
  if (typeof obj.staleFingerprint !== 'string' || obj.staleFingerprint !== fingerprint) {
    throw new Error('reviewed plan staleFingerprint does not match staleCandidates');
  }
  return {
    version: 1,
    shardDir: typeof obj.shardDir === 'string' ? obj.shardDir : undefined,
    keepDigests:
      obj.keepDigests === undefined || obj.keepDigests === null
        ? null
        : parseKeepDigests(obj.keepDigests),
    archiveStale: obj.archiveStale === true,
    staleFingerprint: fingerprint,
    staleCandidates,
  };
}

/**
 * 从 YAML frontmatter 解析 updatedAt 纪元毫秒。只认分隔符 `---` 之间的
 * `updatedAt:` 字段; 正文里的同名字串忽略。无效 / 缺字段 → null。
 */
function parseUpdatedAtMs(value: string | undefined): number | null {
  if (!value) return null;
  const ts = Date.parse(value);
  return Number.isNaN(ts) ? null : ts;
}

/** 按绝对时间比较: 更新的在前; 无效时间戳视为最旧; 并列按 filename。
 * 优先 raw frontmatter 的 updatedAt (YAML 未加引号的 ISO 会被 gray-matter
 * 解析成 Date, parseRawShard 再写成 now — 字典序/扫描序会归档真正更新的那份;
 * Codex P1 on #2561: Preserve YAML Date values when ranking duplicates)。
 */
function compareRecordsByUpdatedAt(
  a: MemoryRecord,
  b: MemoryRecord,
  rawA?: string,
  rawB?: string,
): number {
  const ta = parseFrontmatterUpdatedAt(rawA) ?? parseUpdatedAtMs(a.frontmatter.updatedAt);
  const tb = parseFrontmatterUpdatedAt(rawB) ?? parseUpdatedAtMs(b.frontmatter.updatedAt);
  if (ta !== tb) {
    if (ta === null) return 1;
    if (tb === null) return -1;
    return tb - ta;
  }
  return a.filename.localeCompare(b.filename);
}

function parseFrontmatterUpdatedAt(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return null;
  // 走 YAML parser, 不要用 raw-line regex: `updatedAt: 2026-01-01T00:00:00Z # verified`
  // 合法 YAML 会被 gray-matter 解成 Date, 但行尾注释会让 regex 失败, 随后
  // parseRawShard 用扫描时间替换, duplicate ranking 可能保留后读到的文件
  // (Codex P1 on #2561: Parse commented timestamps with the YAML parser)。
  try {
    const parsed = matter(`---\n${match[1]}\n---\n`);
    const value = parsed.data?.updatedAt;
    if (typeof value === 'string') return parseUpdatedAtMs(value);
    if (value instanceof Date && !Number.isNaN(value.getTime())) return value.getTime();
    return null;
  } catch {
    return null;
  }
}

/**
 * 执行清理计划 — 把待归档项 (默认 = 完全重复 + digest 冗余; archiveStale 时
 * 额外含终态候选) 归档进 `<shard>/.archive/` (幂等)。
 */
export async function runMemoryCleanup(
  plan: CleanupPlan,
  opts: CleanupRunOptions = {},
): Promise<CleanupRunResult> {
  const now = opts.deps?.now ?? (() => new Date().toISOString());
  const result: CleanupRunResult = { archived: [], failed: [] };
  const archiveDir = path.join(plan.shardDir, ARCHIVE_DIR_NAME);
  const stamp = now().replace(/[:.]/g, '-');

  // 待归档 = 默认的确定性项 (重复 + digest) 加上 (可选) 终态候选。
  // 终态候选用 plan 阶段记录的 expectedHash (用户审阅时点的版本), 而非 run
  // 时重读 — 审阅后被更新则移动前校验不通过 (Greptile P1 / Codex P1 on #2561)。
  const seen = new Set<string>();
  const items: ArchiveItem[] = [];
  for (const item of plan.archiveItems) {
    if (seen.has(item.filename)) continue;
    seen.add(item.filename);
    items.push(item);
  }
  if (opts.archiveStale) {
    for (const c of plan.staleCandidates) {
      if (seen.has(c.filename)) continue;
      seen.add(c.filename);
      items.push({
        filename: c.filename,
        reason: 'stale',
        detail: c.matchedSignal
          ? `matches stale signal "${c.matchedSignal}"`
          : 'age-expired project/reference',
        expectedHash: c.expectedHash,
      });
    }
  }

  for (const item of items) {
    const src = path.join(plan.shardDir, item.filename);
    try {
      // 重复组保留副本校验 (Codex P1 on #2561 第二十九轮): keep 在 plan 后
      // 被更新/删除则重复组不再成立 — 归档待删副本会让最后一份已审阅内容
      // 退出 MEMORY.md/FTS 正常路径, 必须失败并要求重新规划。
      const earlyKeeperError = await verifyBoundKeepers(plan.shardDir, item);
      if (earlyKeeperError) {
        result.failed.push({ filename: item.filename, error: earlyKeeperError });
        continue;
      }
      // 幂等 + 移动前校验: 只对 ENOENT (源已被上次运行归档) 静默跳过;
      // 其他读错误 (EACCES/EPERM/瞬态锁定) 必须暴露为 failed, 不能伪装成
      // 幂等 — 否则 CLI 报成功但分片仍在索引里, 自动化不重试 (Codex P2 on
      // #2561)。源内容与 plan 时不一致 (--force 场景被并发更新) 同样
      // fail/replan, 不归档非预期内容。
      let srcContent: Buffer;
      try {
        srcContent = await fs.readFile(src);
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') continue;
        throw e;
      }
      if (sha256(srcContent) !== item.expectedHash) {
        result.failed.push({
          filename: item.filename,
          error: 'source changed since plan; kept, re-run to replan',
        });
        continue;
      }

      // 可选真备份: 归档前写一份到 backupRoot (数据保全)。用 writeFile 'wx'
      // 原子预留目标, 同名冲突 (重复 backup-dir / 同 clock rerun / 并发) 递增
      // 后缀重试, 绝不覆盖已有备份 (Greptile P1 / Codex P1 on #2561)。
      if (opts.backupRoot) {
        await writeExclusive(opts.backupRoot, item.filename, stamp, srcContent);
      }

      // 归档 = 排他写快照 + rename 原子移动 + 对比恢复。三件事各司其职
      // (Greptile/Codex on #2561 第六/七/九/十轮收敛的形态):
      //   1) writeExclusive 把审阅时点快照 A 写入 .archive ('wx' 排他,
      //      严格 no-clobber — 不覆盖已有归档);
      //   2) rename(src, trash) 原子移动 src — 移动后 src 路径即空, 宿主
      //      并发写落到新 src 文件; 无 link 的共享 inode 污染 (Codex P1 on
      //      #2561 第十轮: avoid hard-linking live shards);
      //   3) 对比 trash 与快照 A: 一致 → 删 trash (归档完成); 不一致或 trash
      //      读失败 (宿主并发写的新内容) → no-clobber 恢复 src (见
      //      restoreTrash — Greptile P1 / Codex P1 on #2561 第十一轮)。
      await writeExclusive(archiveDir, item.filename, stamp, srcContent);
      // 归档边界再验 keeper (Codex P1 on #2561: recheck the keeper at the
      // archive boundary) — 首次校验之后还有读源 / 备份 / 写快照, --force
      // 下 keeper 可能在窗口内被改掉。移动前再验一次, 否则会把仍该保留的
      // 副本归档出 MEMORY.md。
      const keeperError = await verifyBoundKeepers(plan.shardDir, item);
      if (keeperError) {
        result.failed.push({ filename: item.filename, error: keeperError });
        continue;
      }
      // trash 目标排他预留 (Codex P2 on #2561 第二十二轮): 失败清理遗留的
      // cleanup-trash 文件是 live-writer 内容的恢复路径 — 同 stamp rerun 或
      // 并发清理时 rename(src, trash) 会覆盖既有 trash, 丢弃唯一可达副本。
      const trash = await reserveTrashTarget(src, plan.shardDir, item.filename, stamp);
      const trashContent = await fs.readFile(trash).catch(() => null);
      if (trashContent !== null && trashContent.equals(srcContent)) {
        // 归档完成。不立即 unlink: --force 或宿主检测漏掉的已打开 fd
        // (storage.ts:294 writeFile(fullPath)) 可能在对比后写入 renamed inode,
        // unlink 删除最后路径名会让新写入内容不可达 (Codex P1 on #2561
        // 第十三轮: preserve trash until open-fd writers are impossible)。
        // 把 trash 移入 .archive (保留路径名, 后续 open fd 写入仍可达), 与
        // 快照 A 并存。用 **link 排他预留 + unlink 删源** 实现 no-clobber 移动:
        // POSIX rename 会静默覆盖已存在目标 — 32-bit 随机后缀碰撞时不能允许
        // 覆盖既有 retained 归档 (它可能是 open-fd 迟到内容的唯一可达副本,
        // Codex P2 on #2561 第二十一轮: reserve retained archive paths
        // exclusively)。link 到已存在目标抛 EEXIST → 换随机后缀重试; link
        // 不可用 (ENOTSUP/EPERM/ENOSYS, 文件系统不支持硬链接) 或移动失败
        // (Windows 锁 = 活跃 writer 仍持有 fd) → trash 保留原位, 二次校验改
        // 读原位 trash。
        let retained: string | null = null;
        for (let attempt = 0; attempt < 8 && retained === null; attempt += 1) {
          const candidate = path.join(
            archiveDir,
            `${item.filename}.${stamp}.${randomBytes(4).toString('hex')}`,
          );
          try {
            await fs.link(trash, candidate);
            // link 成功 (目标已原子排他预留), 删源路径名 — unlink 失败
            // (Windows 锁) 则两份副本并存, 安全方向; 不保留共享 inode 状态
            // (R11 约定)。
            await fs.unlink(trash).catch(() => {});
            retained = candidate;
          } catch (e) {
            const code = (e as NodeJS.ErrnoException).code;
            if (code === 'EEXIST') continue; // 随机后缀碰撞 → 换一个重试
            retained = trash; // link 不可用 / 源被锁 → 保留原位
          }
        }
        if (retained === null) retained = trash; // 多次碰撞 (极不可能) → 原位
        // 二次校验 (Codex P1 on #2561 第十四轮: 不要把仍可能被写入的 trash
        // 标成已归档): 对比只证明「那一刻」没写入, open fd 可能在移动后把新
        // 内容写进 retained inode。重读 retained 对比快照 A — 不一致说明
        // writer 已写入, 必须把新内容复制回活动 src (绝不让它只落在 .archive
        // 随机副本、退出 MEMORY.md/FTS 正常路径), 并记 failed。
        //
        // readFile 失败 (EPERM/EACCES/瞬态锁 — retained 是刚移动出来的文件,
        // 不存在 ENOENT 场景) 不能当「已归档」成功处理: src 已 rename 走、
        // MEMORY.md 将重建, 若标成功 writer 的分片退出正常路径但 CLI 报成功
        // (Codex P1 on #2561 第十五轮: do not treat unreadable retained shards
        // as archived)。
        const retainedContent = await fs.readFile(retained).catch(() => null);
        if (retainedContent === null || !retainedContent.equals(srcContent)) {
          // writer 已写入或 retained 不可读 → 尝试把 retained 内容恢复回 src。
          // 恢复成功也**不 unlink retained**: writer 的 open fd 仍指向 retained
          // inode, copy 后删除会让后续写入落到无路径 inode — 内容既不在 src
          // 也不在 .archive, writer 报成功但记忆丢失 (Codex P1 on #2561 第十七
          // 轮: keep retained files until writers close)。retained 在 .archive
          // 内, list 跳过, 不污染索引, 数据保全优先。失败 (EEXIST 宿主重建 /
          // EACCES / EPERM / ENOSPC …) 一律不抛错 — retained 同样保留可达
          // (Greptile P1 on #2561 第十五/十六轮: 恢复失败后活动分片不能缺失)。
          // 错误信息必须如实区分 restored / restore failed (Greptile P1 on
          // #2561 第十八轮: 恢复失败仍声称已恢复 — src 缺失时不能误导)。
          await restoreRetainedAndRecord(retained, src, item, result);
          continue;
        }
        // 三次确认 (Codex P1 on #2561 第十六轮: keep active shards until live
        // writers are ruled out): 二次校验通过后、标 archived 前再读一次 —
        // 排除「reread 之后 open fd 写入」的窗口。仍不一致或不可读则与二次
        // 校验同样处理 (恢复 src + failed), 绝不标成功。
        const finalContent = await fs.readFile(retained).catch(() => null);
        if (finalContent === null || !finalContent.equals(srcContent)) {
          await restoreRetainedAndRecord(retained, src, item, result);
          continue;
        }
        // quiesce 重试确认 (Codex P1 on #2561 第二十四轮: keep live-writer
        // shards active until quiesced): 最终读通过后 open fd 仍可能在极短窗口
        // 内写入。无 OS 锁下无法从数学上排除 live writer, 用「短窗口多次重读」
        // 尽力排除 — 期间任何一次读到不一致/不可读 → 恢复 src + failed, 不标
        // 成功; 始终一致才标 archived。这是无锁方案可辩护的工程极限, 数学级
        // 排除需锁文件协议 (宿主配合, #2519 合入后的产品决策)。
        let quiesced = true;
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const quiesceContent = await fs.readFile(retained).catch(() => null);
          if (quiesceContent === null || !quiesceContent.equals(srcContent)) {
            quiesced = false;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        // 最后一次 delay 后再读: 循环是先读后睡, 末次 sleep 期间的写入
        // 否则会标 archived, 新内容只留在 archive 名下
        // (Codex P1 on #2561: Re-read after the final quiescence delay)。
        if (quiesced) {
          const afterDelay = await fs.readFile(retained).catch(() => null);
          if (afterDelay === null || !afterDelay.equals(srcContent)) {
            quiesced = false;
          }
        }
        if (!quiesced) {
          await restoreRetainedAndRecord(retained, src, item, result);
          continue;
        }
        result.archived.push(item);
      } else {
        // 宿主并发写的新内容 (或 trash 读失败) → no-clobber 恢复 src
        await restoreTrash(trash, src, item, result);
      }
    } catch (e) {
      result.failed.push({ filename: item.filename, error: String(e) });
      if ((e as { skipIndexRebuild?: boolean }).skipIndexRebuild) {
        result.skipIndexRebuild = true;
      }
    }
  }

  // 重建 MEMORY.md, 让下一次会话的 getIndex() 立即反映清理后的索引 (移除已
  // 归档条目的索引行)。失败必须暴露 — 静默吞掉会让旧索引继续把已归档文件
  // 注入后续会话, 且 store.init() 只修 FTS 不会重建 MEMORY.md (Codex P2 on
  // #2561)。
  //
  // 不设「仅当有归档才重建」的 guard: 首次 --apply 归档后 rebuildIndex 失败
  // (exit 4), 用户修复后重跑时 plan 已无 archiveItems、archived 为空 — 若
  // 跳过重建, 重跑会 exit 0 但旧 MEMORY.md 仍引用已归档文件 (Codex P2 on
  // #2561: rebuild MEMORY.md on repair reruns)。rebuildIndex 幂等, 无新归档
  // 时执行也安全。
  // parked 恢复失败且规范 src 缺失时跳过重建: list() 看不见 `.cleanup-parked-*`,
  // 会把仍有效的记忆从 MEMORY.md/FTS 踢掉 (Codex P1 on #2561: Preserve the
  // index when parked restoration fails)。
  if (!result.skipIndexRebuild) {
    try {
      await new MemoryStorage(plan.shardDir).rebuildIndex();
    } catch (e) {
      result.indexRebuildError = String(e);
    }
  }

  return result;
}

/**
 * 排他移动 src 到 <shard>/.cleanup-trash-<stamp>-<rand> 目标, 返回 trash 路径。
 *
 * 失败清理遗留的 cleanup-trash 文件是 live-writer 内容的恢复路径 — 同 stamp
 * rerun 或并发清理时 rename(src, trash) 会覆盖既有 trash, 丢弃唯一可达副本
 * (Codex P2 on #2561 第二十二轮: reserve trash targets before renaming)。
 * 用 link 原子排他预留 (EEXIST 换随机后缀重试), 再 rename src 到唯一 parked 名 — **绝不 unlink(src)**; link 不可用
 * (ENOTSUP/EPERM/ENOSYS) 时 fallback rename (随机后缀)。pathname unlink 会删掉
 * 比较之后原子替换上来的新 inode (Codex P0 on #2561: unlink only the reserved trash inode)
 */
async function reserveTrashTarget(
  src: string,
  shardDir: string,
  filename: string,
  stamp: string,
): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = path.join(
      shardDir,
      `${filename}.cleanup-trash-${stamp}-${randomBytes(4).toString('hex')}`,
    );
    try {
      await fs.link(src, candidate);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') continue;
      // link 不可用 (文件系统不支持硬链接) → fallback rename。目标仍需
      // no-clobber: 失败清理遗留的 .cleanup-trash-* 恢复文件是 live-writer
      // 内容的唯一可达副本, 随机后缀碰撞时 rename 会覆盖它 (Codex P2 on
      // #2561 第二十五轮: reserve fallback trash moves exclusively)。先探测
      // 目标不存在再 rename, 存在则换随机后缀重试 (fallback 场景 + 32-bit
      // 随机后缀, 探测-rename 的残余窗口极小, 工程可接受)。
      if (await pathExists(candidate)) continue;
      await fs.rename(src, candidate);
      return candidate;
    }
    try {
      await detachReservedSource(src, candidate, shardDir, filename, stamp);
      return candidate;
    } catch (e) {
      const err = e as NodeJS.ErrnoException & { parkedPath?: string };
      const code = err.code;
      if (code === 'CLEANUP_SOURCE_LOCKED' || code === 'CLEANUP_SOURCE_REPLACED') {
        await fs.unlink(candidate).catch(() => {});
        throw e;
      }
      // rename(src → parked) 已成功、后续 lstat/readFile 瞬态失败时, src 已空。
      // 必须先把 parked 恢复到 src, 再删 candidate 重试; 否则下一轮 ENOENT,
      // rebuildIndex 也看不到 .cleanup-parked-* (Codex P1 on #2561:
      // restore parked source before retrying reservation)。
      if (err.parkedPath) {
        const restored = await restoreParkedSource(src, err.parkedPath);
        if (restored !== 'link') {
          // copy 成功也停止重试: src 只是 detached copy, parked inode 上仍可能
          // 有 open writer; 再当 cleanup 源会归档副本、后续写入只落在非规范
          // .cleanup-parked-* (Codex P1 on #2561: Stop retrying after restoring
          // parked data by copy)。copy 失败同样 fail/replan, parked 保留。
          await fs.unlink(candidate).catch(() => {});
          const srcPresent = await pathExists(src);
          throw Object.assign(
            new Error(
              restored === 'copy'
                ? 'parked restored by exclusive copy; replan required (open writer may still target parked inode)'
                : 'unable to restore parked source without clobbering src; parked kept for recovery',
            ),
            {
              code: 'CLEANUP_SOURCE_LOCKED',
              skipIndexRebuild: restored !== 'copy' && !srcPresent,
            },
          );
        }
      }
      await fs.unlink(candidate).catch(() => {});
      continue;
    }
  }
  throw new Error(`unable to reserve trash target for ${filename}`);
}

/**
 * Move the src directory entry to a unique parked name, then drop that extra
 * name only when it still names the reserved trash inode. Never unlink(src):
 * pathname unlink can delete a replacement inode that landed between the
 * inode comparison and the unlink (Codex P0 on #2561).
 */
async function detachReservedSource(
  src: string,
  reserved: string,
  shardDir: string,
  filename: string,
  stamp: string,
): Promise<void> {
  const parked = path.join(
    shardDir,
    `${filename}.cleanup-parked-${stamp}-${randomBytes(4).toString('hex')}`,
  );
  if (await pathExists(parked)) {
    throw Object.assign(new Error('parked path collision'), { code: 'EEXIST' });
  }
  try {
    await fs.rename(src, parked);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return; // src name already gone; reserved holds the inode
    throw Object.assign(
      new Error(`unable to remove source after reservation: ${String(e)}`),
      { code: 'CLEANUP_SOURCE_LOCKED' },
    );
  }
  let parkedStat: Awaited<ReturnType<typeof fs.lstat>>;
  let reservedStat: Awaited<ReturnType<typeof fs.lstat>>;
  let parkedBuf: Buffer;
  let reservedBuf: Buffer;
  try {
    ;[parkedStat, reservedStat, parkedBuf, reservedBuf] = await Promise.all([
      fs.lstat(parked),
      fs.lstat(reserved),
      fs.readFile(parked),
      fs.readFile(reserved),
    ]);
  } catch (e) {
    // Caller restores parked → src before retrying. Never swallow this into a
    // generic retry while src is empty (Codex P1 on #2561).
    (e as NodeJS.ErrnoException & { parkedPath?: string }).parkedPath = parked;
    throw e;
  }
  // Identity = same inode when the FS reports a real ino. Byte equality is
  // **only** a fallback when inode identity is unavailable (both ino=0, e.g.
  // Windows). Do not OR bytes into a reliable POSIX inode check: an editor
  // can atomically replace src with a distinct inode of the same bytes, then
  // keep writing through the open fd — treating parked as reserved would
  // unlink it and lose later writes (Codex P1 on #2561: Restrict byte
  // fallback to unavailable inode identities). Never use nlink.
  const posixInodeAvailable = parkedStat.ino !== 0 || reservedStat.ino !== 0;
  const sameReservedInode = posixInodeAvailable
    ? parkedStat.ino === reservedStat.ino && parkedStat.dev === reservedStat.dev
    : parkedBuf.equals(reservedBuf);
  if (sameReservedInode) {
    // parked is an extra name for the reserved inode — drop it, not live src.
    await fs.unlink(parked).catch(() => {});
    return;
  }
  // parked is the replacement inode — restore it onto src so list()/MEMORY.md
  // still see a canonical shard. Never unlink that inode on restore failure.
  try {
    await fs.link(parked, src);
    await fs.unlink(parked).catch(() => {});
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') {
      // ENOTSUP/EPERM/…: exclusive copy back to src; keep parked for an open
      // writer (Codex P1 on #2561: Restore replacement files when hard links
      // fail). Do not POSIX-rename — that can clobber a concurrent recreate.
      try {
        await fs.copyFile(parked, src, fs.constants.COPYFILE_EXCL);
      } catch {
        // copy also failed — leave parked reachable, do not clobber src,
        // and do not rebuild MEMORY.md while the canonical name is missing
        // (Codex P1 on #2561: Preserve the index when parked restoration fails).
        throw Object.assign(
          new Error(
            'source replaced after trash reservation; unable to restore canonical src; parked kept',
          ),
          { code: 'CLEANUP_SOURCE_REPLACED', skipIndexRebuild: true, parkedPath: parked },
        );
      }
    }
  }
  throw Object.assign(
    new Error('source replaced after trash reservation; replan required'),
    { code: 'CLEANUP_SOURCE_REPLACED' },
  );
}

type ParkedRestoreKind = 'link' | 'copy' | false;

/**
 * Put parked back on src without clobbering a concurrent recreate.
 * POSIX rename overwrites an existing src (TOCTOU after pathExists, or when
 * stat EACCES is treated as missing). Use exclusive link / COPYFILE_EXCL;
 * if the name cannot be reserved, leave parked and return false
 * (Codex P1 on #2561: no-clobber parked restore).
 *
 * `'link'` = src 与 parked 同一 inode, 调用方可删 reservation 后重试。
 * `'copy'` = 只把字节写回 src, parked inode 仍可能被 open writer 使用 —
 * 不得当完整恢复去重试 cleanup (Codex P1 on #2561: Stop retrying after
 * restoring parked data by copy)。
 */
async function restoreParkedSource(src: string, parked: string): Promise<ParkedRestoreKind> {
  try {
    await fs.link(parked, src);
    await fs.unlink(parked).catch(() => {});
    return 'link';
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
    try {
      await fs.copyFile(parked, src, fs.constants.COPYFILE_EXCL);
      return 'copy';
    } catch {
      return false;
    }
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch (e) {
    // Only ENOENT is absence. EACCES/EPERM must not look missing or a later
    // rename would clobber an unreadable live shard.
    return (e as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}

/** 归一化内容 hash — 忽略 updatedAt 与 frontmatter 排版差异, 只比语义内容。 */
function contentHash(rec: MemoryRecord): string {
  const canonical = [
    rec.frontmatter.type,
    rec.frontmatter.title.trim(),
    rec.frontmatter.description.trim(),
    rec.body.trim(),
  ].join('\u0000');
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/** Buffer 的 sha256 (用于 plan 时点 vs run 时点的源内容对比)。 */
function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** 校验 duplicate keeper / digest keep 集仍与 plan 一致; 变化则返回错误文案。 */
async function verifyBoundKeepers(
  shardDir: string,
  item: ArchiveItem,
): Promise<string | null> {
  const storage = new MemoryStorage(shardDir);
  if (item.keep) {
    const keepRec = await storage.readWithRaw(item.keep.filename);
    if (
      !keepRec ||
      contentHash(keepRec.rec) !== item.keep.contentHash ||
      sha256(Buffer.from(keepRec.raw, 'utf8')) !== item.keep.expectedHash
    ) {
      return `duplicate keeper ${item.keep.filename} changed since plan; replan required`;
    }
  }
  if (item.digestKeep) {
    for (const k of item.digestKeep) {
      const keepRec = await storage.readWithRaw(k.filename);
      if (!keepRec || sha256(Buffer.from(keepRec.raw, 'utf8')) !== k.expectedHash) {
        return `digest keeper ${k.filename} changed since plan; replan required`;
      }
    }
  }
  return null;
}

/**
 * 排他写入 content 到 dir 下 (同名冲突时递增后缀), 返回最终目标路径。
 *
 * 用 `writeFile(flag:'wx')` **原子预留**目标: 目标已存在时抛 EEXIST, 递增后缀
 * 重试。相比「先探测再非排他写」, 消除了并发 TOCTOU 竞态 — 两个进程不会
 * 同时观察到同一路径不存在并覆盖对方 (Greptile P1 / Codex P1 on #2561)。
 */
async function writeExclusive(
  dir: string,
  filename: string,
  stamp: string,
  content: Buffer,
): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  const base = path.join(dir, filename);
  for (let attempt = 0; ; attempt += 1) {
    const target = attempt === 0 ? base : path.join(dir, `${filename}.${stamp}.${attempt}`);
    try {
      await fs.writeFile(target, content, { flag: 'wx' });
      return target;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      // EEXIST → 目标已被占用 (同名历史 / 并发写入), 递增后缀重试。
    }
  }
}

/**
 * no-clobber 恢复 trash 到 src — 归档对比不一致时, 宿主并发写的新内容
 * (或 trash 读失败) 要放回 src, 保留活动分片。
 *
 * 优先 `fs.link` 排他恢复: src 已存在 (宿主在 src 被移到 trash 后重建并写入
 * 新内容) 则 link 抛 EEXIST, **绝不覆盖新写入** — POSIX rename 会静默覆盖
 * 已存在目标 (Greptile P1 / Codex P1 on #2561 第十一轮: 恢复重命名覆盖最新
 * 写入)。src 不存在时 link + unlink(trash) 完成恢复。
 *
 * 文件系统不支持硬链接或权限拒绝 (ENOTSUP/EPERM 等非 EEXIST) 时, link 失败
 * 会让 src 保持缺失、trash 名不可达 → 记忆从 list()/MEMORY.md 消失 (Greptile
 * P1 on #2561 第十三轮)。fallback 用 copyFile + COPYFILE_EXCL 排他复制恢复
 * (不依赖硬链接, src 被重建则 EEXIST), 仍失败才抛错 — 此时 trash 保留在原位
 * 可人工找回, 不静默丢数据。
 */
async function restoreTrash(
  trash: string,
  src: string,
  item: ArchiveItem,
  result: CleanupRunResult,
): Promise<void> {
  try {
    await fs.link(trash, src);
    await fs.unlink(trash).catch(() => {});
    result.failed.push({
      filename: item.filename,
      error: 'source changed during archive; restored (archive holds reviewed copy)',
    });
    return;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') {
      // src 已被宿主重建 (新写入) → 不覆盖, 保留 trash 供人工找回
      result.failed.push({
        filename: item.filename,
        error: 'source recreated during archive; newer copy kept, trash kept for manual review',
      });
      return;
    }
    // 非 EEXIST (ENOTSUP/EPERM/ENOSYS …) → 硬链接不可用, fallback 排他复制。
    try {
      await fs.copyFile(trash, src, fs.constants.COPYFILE_EXCL);
      // 恢复成功也**不 unlink trash**: writer 的 open fd 仍指向 trash inode,
      // copy 后删除会让后续写入落到无路径 inode — 内容既不在 src 也不在
      // .archive, writer 报成功但记忆丢失 (Codex P1 on #2561 第十八轮: keep
      // copied trash reachable for live writers, 与 retained 路径一致)。
      result.failed.push({
        filename: item.filename,
        error:
          'source changed during archive; restored via copy (trash kept reachable, archive holds reviewed copy)',
      });
      return;
    } catch (e2) {
      if ((e2 as NodeJS.ErrnoException).code === 'EEXIST') {
        // fallback 复制也撞上宿主重建的 src → 不覆盖, 保留 trash 供找回
        result.failed.push({
          filename: item.filename,
          error: 'source recreated during archive; newer copy kept, trash kept for manual review',
        });
        return;
      }
      // 双重恢复 (link + copy) 都失败。不再 rename 兜底: POSIX rename 会覆盖
      // 探测后、rename 前宿主重建的 src (Codex P1 on #2561: atomic protect live
      // shard before trash rename)。无法原子预留 src 时保留 trash 并失败。
      if (!(await pathExists(src))) {
        try {
          await fs.copyFile(trash, src, fs.constants.COPYFILE_EXCL);
          result.failed.push({
            filename: item.filename,
            error:
              'source changed during archive; restored via copy fallback (trash kept reachable, archive holds reviewed copy)',
          });
          return;
        } catch (e3) {
          if ((e3 as NodeJS.ErrnoException).code === 'EEXIST') {
            result.failed.push({
              filename: item.filename,
              error:
                'source recreated during archive; newer copy kept, trash kept for manual review',
            });
            return;
          }
        }
      }
      result.failed.push({
        filename: item.filename,
        error:
          'source changed during archive; all restore paths failed — trash kept reachable for manual recovery',
      });
    }
  }
}

/**
 * retained 恢复失败且规范 src 仍缺失时跳过 rebuildIndex: list() 看不见
 * `.archive` 内的 retained 名, 会把仍有效的记忆从 MEMORY.md/FTS 踢掉
 * (Codex P1 on #2561: Preserve the index when retained restoration fails)。
 */
async function restoreRetainedAndRecord(
  retained: string,
  src: string,
  item: { filename: string },
  result: CleanupRunResult,
): Promise<void> {
  const restored = await restoreRetained(retained, src);
  if (restored) {
    result.failed.push({
      filename: item.filename,
      error:
        'source written during archive; restored to active shard (retained kept reachable in .archive)',
    });
    return;
  }
  if (!(await pathExists(src))) {
    result.skipIndexRebuild = true;
  }
  result.failed.push({
    filename: item.filename,
    error:
      'source written during archive; restore failed — src not restored, retained kept reachable in .archive for manual recovery',
  });
}

/**
 * 尝试把 retained 内容排他复制回活动 src (恢复), 返回是否成功。
 *
 * 任何失败 (EEXIST 宿主已重建 src / EACCES / EPERM / ENOSPC …) 都返回
 * false 而非抛错: retained 保留在 .archive 可达, 数据不丢 — 恢复失败不能再
 * 让活动分片缺失或删除新内容 (Greptile P1 / Codex P1 on #2561 第十五/十六轮)。
 *
 * copyFile 失败后用 fs.link 原子排他预留 src (EEXIST = 宿主已重建, 不覆盖)。
 * 不在 stat 之后 rename: POSIX rename 会覆盖窗口内新写入 (Codex P1 on #2561)。
 * link / COPYFILE_EXCL 都失败则保留 retained 并返回 false, 数据不丢。
 */
async function restoreRetained(retained: string, src: string): Promise<boolean> {
  try {
    await fs.copyFile(retained, src, fs.constants.COPYFILE_EXCL);
    return true;
  } catch {
    // copyFile 失败 (ENOSPC/EACCES/EEXIST)。不得走「stat 后再 rename」:
    // POSIX rename 覆盖已存在目标, stat→rename 窗口内宿主重建 src 会丢
    // 新写入 (Codex P1 on #2561: 在 rename 恢复前原子预留 src)。
    // 改用 link 原子排他预留 (EEXIST = 宿主已写入, 不覆盖); link 不可用
    // 时再试一次 COPYFILE_EXCL。两者都失败则保留 retained、返回 false,
    // 绝不 rename 覆盖。
    try {
      await fs.copyFile(retained, src, fs.constants.COPYFILE_EXCL);
      return true;
    } catch {
      try {
        await fs.link(retained, src);
        return true;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
        try {
          await fs.copyFile(retained, src, fs.constants.COPYFILE_EXCL);
          return true;
        } catch {
          return false;
        }
      }
    }
  }
}

// 注: 归档移动逻辑内联在 runMemoryCleanup (writeExclusive 快照 + rename 原子
// 移动 + 对比恢复), 不再使用 link+unlink — link 共享 inode, 宿主并发写会
// 污染归档副本 (Codex P1 on #2561 第十轮)。restoreTrash 用 link 仅是「排他
// 探测 + 恢复」, link 后立即 unlink(trash), 不保留共享 inode 状态。
