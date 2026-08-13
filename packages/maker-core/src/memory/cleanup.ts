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

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { MemoryStorage } from './storage.js';
import type { MemoryRecord } from './types.js';

/** 归档子目录名 — 退出 storage.list()/MEMORY.md/FTS 正常路径的可逆软删除区。 */
export const ARCHIVE_DIR_NAME = '.archive';

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
}

/**
 * 扫描单个分片目录, 生成清理计划。纯只读, 不修改任何文件 (dry-run 安全)。
 * 目录不存在 / 不可读 → 返回空计划 (records 空, 各列表空)。
 */
export async function planMemoryCleanup(
  shardDir: string,
  opts: CleanupPlanOptions = {},
): Promise<CleanupPlan> {
  const now = opts.deps?.now ?? (() => new Date().toISOString());
  const keepDigests = opts.keepDigests ?? DEFAULT_KEEP_DIGESTS;
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

  let records: MemoryRecord[];
  try {
    // 复用 storage.list(): 解析 frontmatter、跳过坏文件、按 type+slug 排序。
    records = await new MemoryStorage(shardDir).list();
  } catch {
    return plan;
  }
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
    const keep = group.reduce((a, b) =>
      b.frontmatter.updatedAt > a.frontmatter.updatedAt ||
      (b.frontmatter.updatedAt === a.frontmatter.updatedAt && b.filename < a.filename)
        ? b
        : a,
    );
    const archive = group.filter((r) => r.filename !== keep.filename).map((r) => r.filename);
    plan.duplicates.push({
      hash: contentHash(keep),
      keep: keep.filename,
      archive,
    });
    for (const f of archive) {
      plan.archiveItems.push({
        filename: f,
        reason: 'duplicate',
        detail: `duplicate of ${keep.filename}`,
        expectedHash: await fileSha256(path.join(shardDir, f)),
      });
    }
  }

  // ── 2. 近似重复: 同 title 但内容不同 → 只报告 ────────────────────────
  const byTitle = new Map<string, string[]>();
  for (const rec of records) {
    const key = rec.frontmatter.title.trim();
    const arr = byTitle.get(key) ?? [];
    arr.push(rec.filename);
    byTitle.set(key, arr);
  }
  for (const [title, filenames] of byTitle) {
    if (filenames.length < 2) continue;
    plan.nearDuplicates.push({ title, filenames });
  }

  // ── 3. 终态候选: 只报告, 不自动归档 ──────────────────────────────────
  const ageCutoff = new Date(now()).getTime() - staleAgeDays * 24 * 60 * 60 * 1000;
  for (const rec of records) {
    const type = rec.frontmatter.type;
    // 只对 project/reference 判定「终态」; user/feedback 是偏好/纠正, 不适用
    // 「归档」语义 (digest 走第 4 步单独处理)。
    if (type !== 'project' && type !== 'reference') continue;

    // 记录 plan (用户审阅) 时点的源内容 hash — --archive-stale 执行时对比,
    // 审阅后被更新则 fail/replan, 不归档未审阅的新版本 (Greptile P1 / Codex
    // P1 on #2561)。
    const expectedHash = await fileSha256(path.join(shardDir, rec.filename));

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
    const ts = Date.parse(rec.frontmatter.updatedAt);
    if (!Number.isNaN(ts) && ts < ageCutoff) {
      plan.staleCandidates.push({
        filename: rec.filename,
        reason: 'age',
        updatedAt: rec.frontmatter.updatedAt,
        expectedHash,
      });
    }
  }

  // ── 4. digest 精简: 保留最新 N, 其余归档 ──────────────────────────────
  const digests = records
    .filter((r) => r.frontmatter.type === 'digest')
    .sort((a, b) => {
      const d = b.frontmatter.updatedAt.localeCompare(a.frontmatter.updatedAt);
      if (d !== 0) return d;
      return a.filename.localeCompare(b.filename);
    });
  plan.digests = {
    keep: digests.slice(0, keepDigests).map((r) => r.filename),
    archive: digests.slice(keepDigests).map((r) => r.filename),
  };
  for (const f of plan.digests.archive) {
    plan.archiveItems.push({
      filename: f,
      reason: 'digest-retention',
      detail: `digest beyond keep-latest-${keepDigests}`,
      expectedHash: await fileSha256(path.join(shardDir, f)),
    });
  }

  return plan;
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
  const items: ArchiveItem[] = [...plan.archiveItems];
  if (opts.archiveStale) {
    for (const c of plan.staleCandidates) {
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
      // (Greptile/Codex on #2561 第六/七/九/十轮收敛的最终形态):
      //   1) writeExclusive 把审阅时点快照 A 写入 .archive ('wx' 排他,
      //      严格 no-clobber — 不覆盖已有归档);
      //   2) rename(src, trash) 原子移动 src — 移动后 src 路径即空, 宿主
      //      并发写落到新 src 文件; 无 link 的共享 inode 污染 (Codex P1 on
      //      #2561 第十轮: avoid hard-linking live shards);
      //   3) 对比 trash 与快照 A: 一致 → 删 trash (归档完成); 不一致 (宿主在
      //      rename 前写了新内容 B) → 恢复 src (B 保留, 归档保留审阅快照 A)。
      await writeExclusive(archiveDir, item.filename, stamp, srcContent);
      const trash = path.join(plan.shardDir, `${item.filename}.cleanup-trash-${stamp}`);
      await fs.rename(src, trash);
      let trashContent: Buffer;
      try {
        trashContent = await fs.readFile(trash);
      } catch (e) {
        // trash 读失败 (罕见竞态) → 保守恢复 src, 归档快照已落盘, 数据不丢
        await fs.rename(trash, src).catch(() => {});
        throw e;
      }
      if (trashContent.equals(srcContent)) {
        await fs.unlink(trash);
        result.archived.push(item);
      } else {
        // 宿主并发写的新内容 → 恢复 src, 归档保留审阅快照 A
        await fs.rename(trash, src);
        result.failed.push({
          filename: item.filename,
          error: 'source changed during archive; restored (archive holds reviewed copy)',
        });
      }
    } catch (e) {
      result.failed.push({ filename: item.filename, error: String(e) });
    }
  }

  // 归档改变了 list() 结果 → 重建 MEMORY.md (移除已归档条目的索引行),
  // 让下一次会话的 getIndex() 立即反映瘦身后的索引。失败必须暴露 — 静默吞掉
  // 会让旧索引继续把已归档文件注入后续会话, 且 store.init() 只修 FTS 不会
  // 重建 MEMORY.md (Codex P2 on #2561)。
  if (result.archived.length > 0) {
    try {
      await new MemoryStorage(plan.shardDir).rebuildIndex();
    } catch (e) {
      result.indexRebuildError = String(e);
    }
  }

  return result;
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

/** 读文件并返回内容 sha256; 读失败 (并发删除) 返回 null。 */
async function fileSha256(p: string): Promise<string | null> {
  try {
    return sha256(await fs.readFile(p));
  } catch {
    return null;
  }
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

// 注: 归档移动逻辑内联在 runMemoryCleanup (writeExclusive 快照 + rename 原子
// 移动 + 对比恢复), 不再使用 link+unlink — link 共享 inode, 宿主并发写会
// 污染归档副本 (Codex P1 on #2561 第十轮)。
