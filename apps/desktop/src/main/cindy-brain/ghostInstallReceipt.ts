import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  GHOST_LOCALE_MAX_BYTES,
  GHOST_SKILL_MD_MAX_BYTES,
  isValidGhostId,
  validateGhostManifest,
  validateGhostManifestLocaleResource,
  type GhostManifest,
  type GhostManifestLocaleResource,
  type GhostTrustInfo,
} from '../../shared/ghost.js';
import {
  classifyGhostDirEntry,
  classifyGhostDirEntrySync,
  collectGhostContentFiles,
  hashGhostContentFiles,
  isRegularGhostDirEntry,
  resolveGhostContentPath,
} from './ghostContentTree.js';
import { isPathInsideDir } from './dirDeposit.js';
import { checkSkillMdConsistency } from './skillSlot.js';

// v2 pairs receipts with the unambiguous ghostContentTree framing. Keeping v1
// readable would let an old ambiguous digest authorize a snapshot under the
// new verifier, so old receipts intentionally fail closed and require approval
// to be written again.
const RECEIPT_SCHEMA_VERSION = 2;
const MAX_RECEIPT_BYTES = 2 * 1024 * 1024;
const MAX_PENDING_MUTATION_BYTES = 64 * 1024;
const MAX_ICON_DATA_URL_BYTES = 768 * 1024;
/**
 * 受管 icon 快照的完整形态:声明的图片 mime + 严格 base64 载荷。载荷字符集也要
 * 校验 —— 只认前缀会让被改写的 receipt 把任意字符串塞进 renderer 的 img src。
 */
const ICON_DATA_URL_RE = /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/;

/**
 * 一次明确批准的插件安装事实；只允许 Host 写入安装目录之外的状态根。
 *
 * receipt 钉住的是**授权事实**(批准过的 manifest / trust / 启停 / revision)。
 * 它不保证安装目录里的内容字节此后一直没被改过 —— 逻辑页代码仍从可变的安装
 * 目录加载，只有技能目录因为越出沙箱而被拷成快照。
 */
export interface GhostInstallReceipt {
  schemaVersion: typeof RECEIPT_SCHEMA_VERSION;
  id: string;
  revision: string;
  manifest: GhostManifest;
  localeResources: Record<string, GhostManifestLocaleResource>;
  enabled: boolean;
  trust: GhostTrustInfo;
  /**
   * 批准时点的来源指纹，仅供审计与人工比对：市场/本地包是 `.cindy` 文件哈希，
   * 随包种子是内容目录哈希。**运行时不校验它**，不要据此认为安装内容持续完整。
   */
  packageSha256?: string;
  /**
   * 按 skill item 目录钉住的批准字节指纹(`item.dir` → sha256)。声明了 skill 槽
   * 时逐项必填，没声明时是空对象。
   *
   * 这一项**是运行期判据**，与只作审计用的 `packageSha256` 不同：快照缺失需要从
   * 可变安装目录重建时，必须先重算并逐字节对上才允许重建。少了它，改写 SKILL.md
   * 正文或往技能目录塞辅助文件就能在一次"启用"里被固化成已批准快照并全局挂链，
   * 而 frontmatter 一致性校验只看 name/description，拦不住这类漂移。
   */
  skillContentSha256: Record<string, string>;
  iconDataUrl?: string;
}

export type GhostInstallReceiptReadResult =
  | { state: 'approved'; receipt: GhostInstallReceipt }
  | { state: 'legacy-unapproved' }
  | { state: 'invalid'; reason: string };

export type GhostInstallReceiptRecoveryReadResult =
  | { state: 'approved'; receipt: GhostInstallReceipt }
  | { state: 'missing' }
  | { state: 'invalid'; reason: string }
  | { state: 'unreadable'; reason: string };

/**
 * 一次性 legacy 迁移的落地台账。存在即表示"本机已跑过一轮从旧安装布局 backfill
 * receipt 的迁移"——此后任何缺失 receipt 都按删除/损坏 fail closed,不再触发迁移。
 *
 * 它是迁移的**全局一次性门**(见 `GhostManager.migrateLegacyApprovalsOnce`):没有
 * 这道门,删掉某个 receipt 就能骗一次"从当前可变安装目录重建授权",而安装目录可被
 * 同权限进程改写。ledger 门是充分守卫——能删 ledger 的进程本就能直接往状态根写一份
 * 结构合法的伪造 receipt(§7 已登记"状态根无写保护"缺口),迁移路径严格弱于它。
 */
export interface GhostLegacyMigrationLedger {
  version: 1;
  /** 迁移完成时刻(ISO)。仅审计,不参与判定。 */
  migratedAt: string;
  /** 实际 backfill 出 receipt 的 id 清单,便于事后分辨"用户确认过"与"迁移来的"。 */
  migratedIds: string[];
  /**
   * 迁移读不出核心事实而 fail closed 的 id(坏 manifest / 技能目录含链接等)。
   * 记进台账供支持排查与 UI 提示;这些 id 走每插件的重新确认恢复入口。
   */
  failedIds?: string[];
  /**
   * 迁移状态机,缺省按 `completed` 读(与旧台账兼容)。
   *
   * `in-progress` 在**首个 backfill 动笔之前**原子落盘,记下本轮要迁的完整 id 清单
   * (`pendingIds`)。这是崩溃安全的关键:迁移中途崩溃/断电时,receipt 首写自动落
   * 台账的守卫(见 `write`)不会把门焊死 —— 下次启动看到 `in-progress` 就按
   * `pendingIds` 续跑,已写出 receipt 的 id 自然跳过,全部处理完才原子改写成
   * `completed`。清单钉死在动笔前,续跑**只认清单内的 id**:迁移窗口期间新装再删
   * receipt 的 id 不在清单里,骗不到续跑重铸。
   */
  state?: 'in-progress' | 'completed';
  /** 仅 `in-progress`:本轮待迁 id 全集(动笔前钉死)。 */
  pendingIds?: string[];
}

/**
 * 装入/更新事务的提交日志(状态根内,崩溃后仍在)。用来消除「目录已 rename、receipt
 * 还没写」这段崩溃窗口:
 * - install:崩溃留下"有 finalDir、无 receipt、无 ledger"的目录,与 legacy 安装无法
 *   区分 —— 全新 owner 首个安装崩在这里,下轮迁移会把它(含崩溃窗口内被同权限进程
 *   改写的 manifest)当存量批准掉,用户确认的是 A、被授权的是 B。
 * - update:`final→backup`、`staging→final`、写 receipt 三步;第二三步之间崩溃留下
 *   "新字节 + 旧 receipt",恢复器旧逻辑(final 在位就删 backup)会把它固化成"按旧批准
 *   跑新代码"。
 *
 * 新 marker 用 `receiptRevision` 作为本次事务的提交 nonce，避免更新前后包 hash 相同
 * 时把旧 receipt 误认成本次提交。`packageSha256` 与 phase 只用于兼容旧 marker；无法
 * 区分新旧 receipt 时必须走保守恢复方向，不得删除唯一 backup。
 */
export type GhostPendingMutation =
  | {
      kind: 'install';
      packageSha256: string;
      /** Revision of the receipt this transaction intends to publish. */
      receiptRevision?: string;
      clearBuiltinTombstone?: boolean;
    }
  | {
      kind: 'update';
      packageSha256: string;
      backupDirName: string;
      /** Revision of the receipt this transaction intends to publish. */
      receiptRevision?: string;
      /** Durable phase for distinguishing pre-rename crashes from swapped content. */
      phase?: 'prepared' | 'backed-up' | 'published';
      /** Hash of the previously approved bytes, when an approval existed. */
      oldPackageSha256?: string;
    }
  // uninstall 不带 packageSha256:它的提交信号不是"receipt 写到某版本",而是"receipt +
  // 内容目录都已移除"。恢复见到它就把两者删干净(顺序无关,幂等)。
  | { kind: 'uninstall'; builtinTombstone?: boolean };

export type GhostPendingMutationReadResult =
  | { state: 'valid'; mutation: GhostPendingMutation }
  | { state: 'missing' }
  | { state: 'invalid'; reason: string }
  | { state: 'unreadable'; reason: string };

export type GhostPendingMutationListResult =
  { state: 'ok'; ids: string[]; blocked: boolean } | { state: 'unreadable'; reason: string };

/** Host-owned receipt store：严格读取、同目录临时文件 + rename 原子提交。 */
export class GhostInstallReceiptStore {
  constructor(private readonly getRootDir: () => string) {}

  rootDir(): string {
    return path.resolve(this.getRootDir());
  }

  read(id: string): GhostInstallReceiptReadResult {
    const result = this.readForRecovery(id);
    if (result.state === 'approved') return result;
    if (result.state === 'missing') return { state: 'legacy-unapproved' };
    return { state: 'invalid', reason: result.reason };
  }

  /** Recovery must not confuse transient state-root IO with missing/corrupt approval state. */
  readForRecovery(id: string): GhostInstallReceiptRecoveryReadResult {
    const receiptPath = this.receiptPath(id);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(receiptPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { state: 'missing' };
      }
      return {
        state: 'unreadable',
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    if (!stat.isFile() || stat.size > MAX_RECEIPT_BYTES) {
      return { state: 'invalid', reason: 'receipt 不是普通文件或超过大小上限' };
    }
    let text: string;
    try {
      text = fs.readFileSync(receiptPath, 'utf8');
    } catch (error) {
      return {
        state: 'unreadable',
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch (error) {
      return { state: 'invalid', reason: error instanceof Error ? error.message : String(error) };
    }
    const validated = validateReceipt(parsed, id);
    return validated.ok
      ? { state: 'approved', receipt: validated.receipt }
      : { state: 'invalid', reason: validated.reason };
  }

  /**
   * 写入批准事实。`skillSourceDir` 是快照缺失时的取字节来源:装入/更新传新
   * 内容目录，纯状态改写(启停)传当前安装目录即可自愈。
   *
   * `requireSkillSnapshot: false` 用于**必须成功的收敛方向**(停用):快照
   * 已被外部删掉时不该把插件卡在"既不能用也不能关"的状态，此时按无 skill
   * 落链继续写批准事实，由对账撤掉链接。
   */
  async write(
    receipt: GhostInstallReceipt,
    options: { skillSourceDir?: string; requireSkillSnapshot?: boolean } = {},
  ): Promise<void> {
    const validated = validateReceipt(receipt, receipt.id);
    if (!validated.ok)
      throw new Error(`refusing to write invalid ghost receipt: ${validated.reason}`);

    const root = this.rootDir();
    await fs.promises.mkdir(root, { recursive: true });
    try {
      await this.ensureSkillSnapshot(receipt, options.skillSourceDir);
    } catch (error) {
      if (options.requireSkillSnapshot !== false) throw error;
    }
    // Migration ledger 是 receipt 对外生效的前置提交记录。正常装入/更新若先写
    // receipt、后 best-effort 落 ledger，会自然制造“有效 receipt + 无 ledger”的
    // mixed 状态；下一版既不能安全判断其它无 receipt 目录是 legacy 还是被删批准。
    // legacy migration/recovery 已在首个 backfill 前写好 in-progress，因此这里仅在
    // **完全没有** ledger 时先写 completed，且失败必须阻断 receipt 提交。
    if (!this.hasMigrationLedger()) {
      await this.writeMigrationLedger({
        version: 1,
        migratedAt: new Date().toISOString(),
        migratedIds: [],
        state: 'completed',
      });
    }
    const target = this.receiptPath(receipt.id);
    const temp = path.join(
      root,
      `.${receipt.id}-${process.pid}-${crypto.randomBytes(6).toString('hex')}.tmp`,
    );
    try {
      await fs.promises.writeFile(temp, `${JSON.stringify(receipt, null, 2)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      });
      await fs.promises.rename(temp, target);
    } finally {
      await fs.promises.rm(temp, { force: true }).catch(() => undefined);
    }
    await this.pruneStaleSkillSnapshots(receipt);
  }

  async remove(id: string): Promise<void> {
    const receiptPath = this.receiptPath(id);
    const receiptKind = await classifyCleanupEntry(receiptPath);
    if (receiptKind === 'missing') {
      // ENOENT is already-clean and must remain idempotent.
    } else if (receiptKind !== 'file') {
      throw new Error(`ghost receipt path is not a regular file: ${receiptPath}`);
    } else {
      await fs.promises.rm(receiptPath, { force: true });
    }
    // Validate both managed snapshot path segments before recursive deletion.
    // Missing segments mean cleanup is already complete; links, non-directories,
    // and transient IO failures remain observable so the caller keeps its journal.
    const snapshotPath = await this.assertManagedSnapshotParent(id, { createMissing: false });
    if (!snapshotPath) return;
    await fs.promises.rm(snapshotPath, {
      recursive: true,
      force: true,
    });
  }

  /** `remove` 的同步版:启动恢复(构造期同步)收尾未完成卸载用,判据同 `remove`。 */
  removeSync(id: string): void {
    const receiptPath = this.receiptPath(id);
    const receiptKind = classifyCleanupEntrySync(receiptPath);
    if (receiptKind === 'missing') {
      // ENOENT is already-clean and must remain idempotent.
    } else if (receiptKind !== 'file') {
      throw new Error(`ghost receipt path is not a regular file: ${receiptPath}`);
    } else {
      fs.rmSync(receiptPath, { force: true });
    }
    const snapshotPath = this.assertManagedSnapshotParentSync(id, { createMissing: false });
    if (!snapshotPath) return;
    fs.rmSync(snapshotPath, { recursive: true, force: true });
  }

  skillSnapshotRoot(id: string, revision: string): string {
    if (!isValidGhostId(id) || !isRevision(revision)) {
      throw new Error('invalid ghost skill snapshot identity');
    }
    return path.join(this.rootDir(), 'skill-snapshots', id, revision);
  }

  /**
   * 快照父路径(`<状态根>/skill-snapshots/<id>`)的逐段遏制断言。
   *
   * 任何 readdir / mkdir / rename / rm 之前都必须过这道:父段被同权限进程换成
   * junction/链接时,这些操作会**穿透**到状态根之外 —— 把 §7 登记的「状态根可写→
   * 可伪造批准」升级成「任意外部目录删除/写入」,是一次真实的权限升级(已在
   * Windows 上实测复现)。判据与 ghostContentTree 同源:逐段 lstat、链接一律拒,
   * 最后再 realpath 对账"物理路径仍在状态根内"(状态根自身的祖先允许是链接 ——
   * relocated home 场景,所以以 realpath(root) 为基准而不是词法路径)。
   *
   * `createMissing`:装入/更新路径按需补建缺失段;prune/remove 等回收路径不建,
   * 段缺失(ENOENT)返回 null 表示"没有可回收对象"。段存在但不是真目录一律抛错,
   * 由调用方决定 fail closed 还是跳过 —— 绝不带着可疑父段继续动盘。
   */
  private async assertManagedSnapshotParent(
    id: string,
    opts: { createMissing: boolean },
  ): Promise<string | null> {
    if (!isValidGhostId(id)) throw new Error('invalid ghost id for snapshot path');
    const root = this.rootDir();
    let current = root;
    for (const segment of ['skill-snapshots', id]) {
      current = path.join(current, segment);
      let kind: Awaited<ReturnType<typeof classifyGhostDirEntry>> | null;
      try {
        kind = await classifyGhostDirEntry(current);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        kind = null;
      }
      if (kind === null) {
        if (!opts.createMissing) return null;
        // 非 recursive:上一段刚验证过是真目录,逐段建才不会静默沿着链接铺路。
        await fs.promises.mkdir(current);
        continue;
      }
      if (kind !== 'directory') {
        throw new Error(
          `skill snapshot path segment is not a real directory: ${segment} (${kind})`,
        );
      }
    }
    const [realRoot, realParent] = await Promise.all([
      fs.promises.realpath(root),
      fs.promises.realpath(current),
    ]);
    if (!isPathInsideDir(realRoot, realParent)) {
      throw new Error('skill snapshot parent escaped the approval state root');
    }
    return current;
  }

  private assertManagedSnapshotParentSync(
    id: string,
    opts: { createMissing: boolean },
  ): string | null {
    if (!isValidGhostId(id)) throw new Error('invalid ghost id for snapshot path');
    const root = this.rootDir();
    let current = root;
    for (const segment of ['skill-snapshots', id]) {
      current = path.join(current, segment);
      let kind: ReturnType<typeof classifyGhostDirEntrySync> | null;
      try {
        kind = classifyGhostDirEntrySync(current);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        kind = null;
      }
      if (kind === null) {
        if (!opts.createMissing) return null;
        fs.mkdirSync(current);
        continue;
      }
      if (kind !== 'directory') {
        throw new Error(
          `skill snapshot path segment is not a real directory: ${segment} (${kind})`,
        );
      }
    }
    const realRoot = fs.realpathSync(root);
    const realParent = fs.realpathSync(current);
    if (!isPathInsideDir(realRoot, realParent)) {
      throw new Error('skill snapshot parent escaped the approval state root');
    }
    return current;
  }

  /** 迁移台账路径。点开头,不会与任何合法 ghost id 的 `<id>.json` receipt 撞名。 */
  private migrationLedgerPath(): string {
    return path.join(this.rootDir(), '.legacy-migration.json');
  }

  /** 读迁移台账(缺失/损坏返回 null;追加 id 时用,判定门只看 hasMigrationLedger)。 */
  readMigrationLedger(): GhostLegacyMigrationLedger | null {
    try {
      const raw = JSON.parse(
        fs.readFileSync(this.migrationLedgerPath(), 'utf8'),
      ) as GhostLegacyMigrationLedger;
      if (
        !raw ||
        raw.version !== 1 ||
        typeof raw.migratedAt !== 'string' ||
        !isValidUniqueGhostIdArray(raw.migratedIds)
      ) {
        return null;
      }
      if (raw.state !== undefined && raw.state !== 'in-progress' && raw.state !== 'completed') {
        return null;
      }
      if (raw.failedIds !== undefined && !isValidUniqueGhostIdArray(raw.failedIds)) return null;
      if (
        raw.state === 'in-progress' &&
        (!isValidUniqueGhostIdArray(raw.pendingIds) || raw.pendingIds.length === 0)
      ) {
        return null;
      }
      if (raw.state !== 'in-progress' && raw.pendingIds !== undefined) return null;
      return raw;
    } catch {
      return null;
    }
  }

  /**
   * 迁移门是否已关死。三种情况:
   * - 无台账 → 开(首轮迁移 / legacy 恢复流程的留门);
   * - 台账 `in-progress` → 开(上一轮中途崩溃,按 pendingIds 续跑);
   * - 台账 `completed` / 无 state(旧格式)/ **存在但读不出** → 关。
   * 损坏台账按"关"处理是刻意的保守方向:台账由原子 temp+rename 写出,自然损坏面
   * 趋近于零;能改坏它的进程与 §7「可直接伪造合法 receipt」同类,把门放开反而是
   * 给这类进程送一条重铸授权的路。调用方发现"存在但读不出"应记 error 日志。
   */
  migrationDoorClosed(): boolean {
    if (!this.hasMigrationLedger()) return false;
    const ledger = this.readMigrationLedger();
    return ledger === null || ledger.state !== 'in-progress';
  }

  /** 是否已跑过一轮 legacy 迁移(全局一次性门;读不动按"存在"处理,宁可不再迁)。 */
  hasMigrationLedger(): boolean {
    try {
      return fs.lstatSync(this.migrationLedgerPath()).isFile();
    } catch (error) {
      // ENOENT = 从未迁过,可以迁;其它错误(权限等)= 状态未知,保守当作"已迁",
      // 绝不因为读不动 ledger 就把迁移(=从可变安装目录重建授权)再放开一次。
      return (error as NodeJS.ErrnoException).code !== 'ENOENT';
    }
  }

  async writeMigrationLedger(ledger: GhostLegacyMigrationLedger): Promise<void> {
    const root = this.rootDir();
    await fs.promises.mkdir(root, { recursive: true });
    const target = this.migrationLedgerPath();
    const temp = path.join(
      root,
      `.legacy-migration-${process.pid}-${crypto.randomBytes(6).toString('hex')}.tmp`,
    );
    try {
      await fs.promises.writeFile(temp, `${JSON.stringify(ledger, null, 2)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      });
      await fs.promises.rename(temp, target);
    } finally {
      await fs.promises.rm(temp, { force: true }).catch(() => undefined);
    }
  }

  /** 事务标记路径。点开头,不与 `<id>.json` receipt 或 `.legacy-migration.json` 撞名。 */
  private pendingMutationPath(id: string): string {
    if (!isValidGhostId(id)) throw new Error('invalid ghost id for pending mutation path');
    return path.join(this.rootDir(), `.pending-${id}.json`);
  }

  /** 事务开始:装入/更新 rename 动盘**之前**落标记(原子 temp+rename;re-begin 覆盖)。 */
  async writePendingMutation(id: string, entry: GhostPendingMutation): Promise<void> {
    const root = this.rootDir();
    await fs.promises.mkdir(root, { recursive: true });
    const target = this.pendingMutationPath(id);
    const temp = path.join(
      root,
      `.pending-${id}-${process.pid}-${crypto.randomBytes(6).toString('hex')}.tmp`,
    );
    try {
      await fs.promises.writeFile(temp, `${JSON.stringify({ version: 1, id, ...entry })}\n`, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      });
      await fs.promises.rename(temp, target);
    } finally {
      await fs.promises.rm(temp, { force: true }).catch(() => undefined);
    }
  }

  /** 事务提交:receipt 写成功后清标记。删不动只多留一份标记,下轮恢复幂等重判。 */
  async clearPendingMutation(id: string): Promise<void> {
    await fs.promises.rm(this.pendingMutationPath(id), { force: true });
  }

  /** 同步清标记(启动恢复在构造期同步跑,不能留 fire-and-forget 的异步删除)。 */
  clearPendingMutationSync(id: string): void {
    fs.rmSync(this.pendingMutationPath(id), { force: true });
  }

  readPendingMutationSync(id: string): GhostPendingMutationReadResult {
    let raw: Record<string, unknown>;
    const markerPath = this.pendingMutationPath(id);
    try {
      const stat = fs.lstatSync(markerPath);
      if (!stat.isFile() || stat.size > MAX_PENDING_MUTATION_BYTES) {
        return { state: 'invalid', reason: 'journal is not a regular file or exceeds size limit' };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'missing' };
      return {
        state: 'unreadable',
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    let text: string;
    try {
      text = fs.readFileSync(markerPath, 'utf8');
    } catch (error) {
      return {
        state: 'unreadable',
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch (error) {
      return { state: 'invalid', reason: error instanceof Error ? error.message : String(error) };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { state: 'invalid', reason: 'journal must be an object' };
    }
    raw = parsed as Record<string, unknown>;
    if (raw.version !== 1 || raw.id !== id) {
      return { state: 'invalid', reason: 'journal version/id mismatch' };
    }
    if (raw.kind === 'uninstall') {
      if (raw.builtinTombstone !== undefined && typeof raw.builtinTombstone !== 'boolean') {
        return { state: 'invalid', reason: 'journal builtinTombstone is invalid' };
      }
      return {
        state: 'valid',
        mutation: {
          kind: 'uninstall',
          ...(raw.builtinTombstone === true ? { builtinTombstone: true } : {}),
        },
      };
    }
    if (typeof raw.packageSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(raw.packageSha256)) {
      return { state: 'invalid', reason: 'journal packageSha256 is invalid' };
    }
    if (raw.kind === 'install') {
      if (
        raw.receiptRevision !== undefined &&
        (typeof raw.receiptRevision !== 'string' || !isRevision(raw.receiptRevision))
      ) {
        return { state: 'invalid', reason: 'journal receiptRevision is invalid' };
      }
      if (
        raw.clearBuiltinTombstone !== undefined &&
        typeof raw.clearBuiltinTombstone !== 'boolean'
      ) {
        return { state: 'invalid', reason: 'journal clearBuiltinTombstone is invalid' };
      }
      return {
        state: 'valid',
        mutation: {
          kind: 'install',
          packageSha256: raw.packageSha256,
          ...(typeof raw.receiptRevision === 'string'
            ? { receiptRevision: raw.receiptRevision }
            : {}),
          ...(raw.clearBuiltinTombstone === true ? { clearBuiltinTombstone: true } : {}),
        },
      };
    }
    if (
      raw.kind === 'update' &&
      typeof raw.backupDirName === 'string' &&
      isManagedBackupDirName(id, raw.backupDirName)
    ) {
      const phase = raw.phase === undefined ? undefined : raw.phase;
      if (
        phase !== undefined &&
        phase !== 'prepared' &&
        phase !== 'backed-up' &&
        phase !== 'published'
      ) {
        return { state: 'invalid', reason: 'journal update phase is invalid' };
      }
      const oldPackageSha256 = raw.oldPackageSha256;
      const receiptRevision = raw.receiptRevision;
      if (
        receiptRevision !== undefined &&
        (typeof receiptRevision !== 'string' || !isRevision(receiptRevision))
      ) {
        return { state: 'invalid', reason: 'journal receiptRevision is invalid' };
      }
      if (
        oldPackageSha256 !== undefined &&
        (typeof oldPackageSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(oldPackageSha256))
      ) {
        return { state: 'invalid', reason: 'journal oldPackageSha256 is invalid' };
      }
      return {
        state: 'valid',
        mutation: {
          kind: 'update',
          packageSha256: raw.packageSha256,
          backupDirName: raw.backupDirName,
          ...(receiptRevision !== undefined ? { receiptRevision } : {}),
          ...(phase !== undefined ? { phase } : {}),
          ...(oldPackageSha256 !== undefined ? { oldPackageSha256 } : {}),
        },
      };
    }
    return { state: 'invalid', reason: 'journal kind/backupDirName is invalid' };
  }

  /** 状态根里所有未清的事务标记 id(启动恢复用)。 */
  listPendingMutationIdsSync(): GhostPendingMutationListResult {
    let names: string[];
    try {
      names = fs.readdirSync(this.rootDir());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { state: 'ok', ids: [], blocked: false };
      }
      return {
        state: 'unreadable',
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    const ids: string[] = [];
    let blocked = false;
    for (const name of names) {
      const match = /^\.pending-(.+)\.json$/.exec(name);
      if (!match) continue;
      if (isValidGhostId(match[1])) ids.push(match[1]);
      else blocked = true;
    }
    return { state: 'ok', ids, blocked };
  }

  private receiptPath(id: string): string {
    if (!isValidGhostId(id)) throw new Error('invalid ghost id for receipt path');
    return path.join(this.rootDir(), `${id}.json`);
  }

  private async ensureSkillSnapshot(
    receipt: GhostInstallReceipt,
    skillSourceDir: string | undefined,
  ): Promise<void> {
    const items = receipt.manifest.skill?.items ?? [];
    if (items.length === 0) return;
    const target = this.skillSnapshotRoot(receipt.id, receipt.revision);
    // 父段遏制必须先于**任何**对 target 的操作:lstat/rm/rename 都会穿透被换成
    // junction 的父段,读写到状态根之外(见 assertManagedSnapshotParent 头注释)。
    const parent = await this.assertManagedSnapshotParent(receipt.id, { createMissing: true });
    if (!parent) throw new Error('skill snapshot parent unavailable');
    let existing: fs.Stats | null;
    try {
      existing = await fs.promises.lstat(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      existing = null;
    }
    if (existing) {
      if (!existing.isDirectory()) {
        throw new Error('approved skill snapshot target is not a directory');
      }
      // 快照已存在**不等于**它还是被批准的那份字节:状态根里的目录同样可被同权限
      // 进程改写,而主 Agent 是顺着共享技能链接持续读它的。所以这里必须重算,
      // 不能像上一版那样直接早退信任它。
      if (await this.skillSnapshotMatchesReceipt(receipt, target)) return;
      // 对不上的快照一律不可信:删掉,退回下面的重建路径 —— 重建本身仍要过安装
      // 目录的字节校验,所以"损坏快照"能自愈,"安装字节已漂移"仍然拒。
      await fs.promises.rm(target, { recursive: true, force: true });
    }
    if (!skillSourceDir) {
      throw new Error('approved skill snapshot is missing');
    }
    const temp = path.join(
      parent,
      `.${receipt.revision}-${process.pid}-${crypto.randomBytes(6).toString('hex')}.tmp`,
    );
    try {
      await fs.promises.mkdir(temp, { recursive: false });

      // 顺序是安全要点,不要改回"先校验源目录、再复制":源目录随时可被同权限进程
      // 改写,校验和复制各读一次就有一个可换字节的窗口,复制出来的快照可能不是被
      // 校验过的那一份。因此**先复制到 temp,再对 temp 里(即将成为快照的)那份字节
      // 做全部权威校验**,校验通过才 rename 就位。
      // 清单允许嵌套的 skill dir(如 skills/foo 与 skills/foo/bar —— 校验只拒重复,
      // 不拒前缀嵌套)。祖先目录的整树复制已经带上了嵌套项的字节,再按嵌套项复制一次
      // 会撞上 COPYFILE_EXCL 直接失败 —— 那会让一份合法清单在装入/更新/迁移/重新确认
      // 四条路上全军覆没(§5 红线)。按深度排序、祖先先复制,已覆盖的嵌套项跳过复制;
      // 指纹校验仍逐 item 进行(嵌套项的根就在祖先拷出的树里)。大小写折叠比较,
      // 与清单查重同口径。
      const copiedRoots: string[] = [];
      const itemsByDepth = [...items].sort(
        (a, b) => a.dir.split('/').length - b.dir.split('/').length,
      );
      for (const item of itemsByDepth) {
        const dirFold = item.dir.toLowerCase();
        if (copiedRoots.some((root) => dirFold === root || dirFold.startsWith(`${root}/`))) {
          continue;
        }
        // 与算指纹同一个解析入口:逐段确认真目录,挡住"中间段被换成链接"这条从技能
        // 目录之外取字节的路子。两侧必须共用,否则一侧穿透、一侧不穿透,复制的和
        // 算指纹的就不是同一组字节。
        const source = await resolveGhostContentPath(skillSourceDir, item.dir, {
          expect: 'directory',
          label: 'approved skill',
        });
        // 复制前的便宜预检:只为早失败、少做无用功(避免整份拷一个超大 SKILL.md)。
        // **这不是安全边界** —— 它读的是可变源目录,结论随时可能过期,真正说话的是
        // 下面对 temp 的校验。
        const sourceSkillMdStat = await fs.promises
          .lstat(path.join(source, 'SKILL.md'))
          .catch(() => null);
        if (
          sourceSkillMdStat &&
          (!sourceSkillMdStat.isFile() || sourceSkillMdStat.size > GHOST_SKILL_MD_MAX_BYTES)
        ) {
          throw new Error(
            `approved skill ${item.dir}/SKILL.md is not a regular file or exceeds ${GHOST_SKILL_MD_MAX_BYTES} bytes`,
          );
        }
        await copyRegularDirectory(source, path.join(temp, ...item.dir.split('/')));
        copiedRoots.push(dirFold);
      }

      // 权威校验一律针对 temp:此刻这些字节已经脱离可变安装目录,复制期间被换过也
      // 会在这里暴露。**尺寸上限必须排在算指纹之前** —— 源目录那道预检不是安全边界
      // (预检后可被换成超大文件),若先算指纹就等于上限在权威路径上一次都没生效。
      for (const item of items) {
        const copiedSkillMdPath = path.join(temp, ...item.dir.split('/'), 'SKILL.md');
        // 包一层领域错误:这一段现在排在算指纹之前,SKILL.md 缺失时若直接抛裸 ENOENT,
        // 日志里就看不出是"技能内容被动过"这件事(只有被篡改时才可达,两种写法都
        // fail closed,纯粹为可读性)。
        const copiedSkillMdStat = await fs.promises.lstat(copiedSkillMdPath).catch((error) => {
          throw new Error(
            `approved skill ${item.dir}/SKILL.md is unreadable in the snapshot: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        });
        if (!copiedSkillMdStat.isFile() || copiedSkillMdStat.size > GHOST_SKILL_MD_MAX_BYTES) {
          throw new Error(
            `approved skill ${item.dir}/SKILL.md is not a regular file or exceeds ${GHOST_SKILL_MD_MAX_BYTES} bytes`,
          );
        }
      }
      // 指纹判定走与"接受既有快照""发布后复核"同一个 helper:同一判据只有一份实现,
      // 否则三处各写一遍、日后只改其中一处,就是这条链路前几轮反复出问题的形态。
      if (!(await this.skillSnapshotMatchesReceipt(receipt, temp))) {
        throw new Error(
          `approved skill content for ${receipt.id} no longer matches the bytes approved at install time`,
        );
      }
      for (const item of items) {
        // 指纹相符已经蕴含 frontmatter 一致(批准时点那份过过这道校验),这里重跑一遍
        // 是防止钉指纹那条路径本身有 bug,并给出更具体的错误。
        const consistencyError = checkSkillMdConsistency(
          await fs.promises.readFile(path.join(temp, ...item.dir.split('/'), 'SKILL.md'), 'utf8'),
          item,
        );
        if (consistencyError) {
          throw new Error(`approved skill ${item.dir} is inconsistent: ${consistencyError}`);
        }
      }

      await fs.promises.rename(temp, target);

      // rename 之前 temp 位于状态根内、同权限进程仍可改写它,所以就位之后再核一遍:
      // 这一步把"校验通过 → rename"之间那段窗口收掉 —— 在那段里被换过的字节到这里
      // 会暴露,并且不会留在盘上。
      //
      // 残留窗口(已知、未关):这次核对之后、主 Agent 顺着共享技能链接读取之前,快照
      // 仍可被改写。要真正关掉需要给状态根写保护或在消费侧校验,都不在本函数范围内;
      // 该缺口已正式登记在 docs/dev-rules/plugin-security-and-authoring.md 第 6 节
      // (与"内容根字节可变"是两条并列的不同缺口)。
      if (!(await this.skillSnapshotMatchesReceipt(receipt, target))) {
        await fs.promises.rm(target, { recursive: true, force: true }).catch(() => undefined);
        throw new Error('approved skill snapshot changed while being published');
      }
    } finally {
      await fs.promises.rm(temp, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /**
   * 快照目录里的字节是否仍等于 receipt 钉住的批准指纹。
   *
   * 三处调用共用同一判据(接受既有快照 / 复制后发布前 / 发布后复核) —— 这类判定散落
   * 多处再各写一遍,就是本 PR 前几轮反复出问题的成因。读不动或含非普通条目一律按
   * 不匹配处理:调用方对"不匹配"的收敛动作都是删掉重建或拒绝,始终 fail closed。
   */
  async skillSnapshotMatchesReceipt(
    receipt: GhostInstallReceipt,
    snapshotDir: string,
  ): Promise<boolean> {
    const actual = await hashApprovedSkillContent(receipt.manifest, snapshotDir).catch(() => null);
    if (!actual) return false;
    return (receipt.manifest.skill?.items ?? []).every(
      (item) => actual[item.dir] === receipt.skillContentSha256[item.dir],
    );
  }

  /**
   * 回收同一插件下非当前 revision 的技能快照与崩溃残留的 `.tmp` 目录。
   *
   * 只在新 receipt 已经原子提交之后跑:此刻旧 revision 已不是批准事实，留着
   * 就是每次更新泄漏一份完整拷贝。共享技能根里指向旧 revision 的链接会因此
   * 短暂断链，直到下一轮对账重指——对越出沙箱的 skill 槽来说，短暂"技能不可
   * 用"是正确的收敛方向，留着旧批准版本继续生效不是。
   *
   * best-effort:批准事实已经落盘，回收失败只记为待清理状态，不回滚安装。
   */
  private async pruneStaleSkillSnapshots(receipt: GhostInstallReceipt): Promise<void> {
    // 父段遏制先行:`<id>` 段被换成 junction 时,readdir 会列出外部目录的条目、
    // 随后的逐项 recursive rm 就会把**外部目录的内容**删掉(Windows 实测可复现)。
    // 回收是 best-effort:父段可疑就整体跳过,绝不带着可疑父段动盘。
    let parent: string | null;
    try {
      parent = await this.assertManagedSnapshotParent(receipt.id, { createMissing: false });
    } catch {
      return;
    }
    if (!parent) return;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(parent, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(
      entries
        .filter((entry) => entry.name !== receipt.revision)
        .map((entry) =>
          fs.promises
            .rm(path.join(parent, entry.name), { recursive: true, force: true })
            .catch(() => undefined),
        ),
    );
  }
}

function isValidUniqueGhostIdArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((id) => isValidGhostId(id)) &&
    new Set(value).size === value.length
  );
}

function isManagedBackupDirName(id: string, name: string): boolean {
  return new RegExp(`^\\.cindy-updating-${escapeRegExp(id)}-[0-9a-f]{8}$`).test(name);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

type CleanupEntryKind = 'missing' | 'file' | 'directory' | 'link' | 'other';

async function classifyCleanupEntry(absPath: string): Promise<CleanupEntryKind> {
  try {
    return await classifyGhostDirEntry(absPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    throw error;
  }
}

function classifyCleanupEntrySync(absPath: string): CleanupEntryKind {
  try {
    return classifyGhostDirEntrySync(absPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    throw error;
  }
}

/**
 * 迁移专用:读旧安装目录里的 `.cindy-trust.json` 信任镜像。#1080 之前授权事实就散在
 * 安装目录三文件里,升级迁移要从它们重建等价 receipt。
 *
 * 缺失/损坏/非普通文件一律返回 `null` —— trust 只是**展示与来源信号**(能力由 manifest
 * slot 授予,不由 trust 等级授予),读不出时调用方用保守默认(`unverified`)而不是让整个
 * 迁移失败:旧模型读的也是同一个文件,缺了同样显示不出 verified,不比旧模型少展示什么。
 *
 * `cindy-official` 一律**封顶拒收**(按镜像损坏处理):官方档只该由 provisioning 在与
 * 随包种子逐字节对账后授予,而本函数的两个调用方(legacy 迁移 / 从已装目录重新确认)都
 * 只服务非随包插件 —— 非随包目录里出现官方档镜像本身就不可信,照抄会让确认卡/列表把
 * 一个可变目录里的插件展示成「Cindy 官方」。
 */
export function readLegacyInstallTrust(dir: string): GhostTrustInfo | null {
  const file = path.join(dir, '.cindy-trust.json');
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > MAX_RECEIPT_BYTES) return null;
    const trust = validateTrust(JSON.parse(fs.readFileSync(file, 'utf8')));
    if (!trust || trust.level === 'cindy-official') return null;
    return trust;
  } catch {
    return null;
  }
}

export function createGhostInstallReceipt(input: {
  manifest: GhostManifest;
  localeResources: Record<string, GhostManifestLocaleResource>;
  enabled: boolean;
  trust: GhostTrustInfo;
  /** 由 `hashApprovedSkillContent` 从**这次批准的内容目录**现算，不可沿用旧值。 */
  skillContentSha256: Record<string, string>;
  packageSha256?: string;
  revision?: string;
  iconDataUrl?: string;
}): GhostInstallReceipt {
  return {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    id: input.manifest.id,
    revision: input.revision ?? crypto.randomUUID(),
    manifest: input.manifest,
    localeResources: input.localeResources,
    enabled: input.enabled,
    trust: input.trust,
    skillContentSha256: input.skillContentSha256,
    ...(input.packageSha256 ? { packageSha256: input.packageSha256 } : {}),
    ...(input.iconDataUrl ? { iconDataUrl: input.iconDataUrl } : {}),
  };
}

/**
 * 逐 skill item 目录算规范化内容指纹(排序后的相对路径 + 字节)。
 *
 * 判据全部取自 `ghostContentTree`(路径逐段解析 + 条目类型判定 + 指纹格式),与
 * 快照拷贝侧 `copyRegularDirectory`、安装目录漂移指纹 `hashApprovedDirectory`、
 * 随包种子指纹 `fingerprintDirContent` 共用同一份实现。差异只有显式策略:技能
 * 目录**不跳过点开头条目**(技能指令可以引用目录里的任意文件,漏掉一类就是漏掉
 * 一条改写通道),非普通条目一律拒。
 */
export async function hashApprovedSkillContent(
  manifest: GhostManifest,
  sourceDir: string | undefined,
): Promise<Record<string, string>> {
  const items = manifest.skill?.items ?? [];
  if (items.length === 0) return {};
  if (!sourceDir) throw new Error('skill content hash requires a source directory');
  const result: Record<string, string> = {};
  for (const item of items) {
    const itemRoot = await resolveGhostContentPath(sourceDir, item.dir, {
      expect: 'directory',
      label: 'approved skill',
    });
    const tree = await collectGhostContentFiles(itemRoot, {
      dotEntries: 'include',
      nonRegular: 'throw',
      label: `approved skill ${item.dir}`,
    });
    result[item.dir] = await hashGhostContentFiles(itemRoot, tree.files, tree.rootIdentity);
  }
  return result;
}

function validateReceipt(
  raw: unknown,
  expectedId: string,
): { ok: true; receipt: GhostInstallReceipt } | { ok: false; reason: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'receipt 必须是对象' };
  }
  const value = raw as Record<string, unknown>;
  if (value.schemaVersion !== RECEIPT_SCHEMA_VERSION) {
    return { ok: false, reason: 'receipt schemaVersion 不受支持' };
  }
  if (value.id !== expectedId || !isValidGhostId(expectedId)) {
    return { ok: false, reason: 'receipt id 与安装目录不一致' };
  }
  if (typeof value.revision !== 'string' || !isRevision(value.revision)) {
    return { ok: false, reason: 'receipt revision 不合法' };
  }
  const manifestResult = validateGhostManifest(value.manifest);
  if (!manifestResult.ok || manifestResult.manifest.id !== expectedId) {
    return {
      ok: false,
      reason: manifestResult.ok ? 'receipt manifest id 不一致' : manifestResult.reason,
    };
  }
  if (typeof value.enabled !== 'boolean') {
    return { ok: false, reason: 'receipt enabled 不合法' };
  }
  const trust = validateTrust(value.trust);
  if (!trust) return { ok: false, reason: 'receipt trust 不合法' };
  if (
    value.packageSha256 !== undefined &&
    (typeof value.packageSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.packageSha256))
  ) {
    return { ok: false, reason: 'receipt packageSha256 不合法' };
  }
  // 技能字节指纹是运行期判据,必填且键集必须与清单声明严格一致 —— 留"字段缺失就
  // 跳过校验"的可选口子等于给漂移留一条绕过路径。receipt 格式尚未随任何版本发布,
  // 不存在需要兼容的旧 receipt。
  const skillContentSha256: Record<string, string> = {};
  {
    const raw = value.skillContentSha256;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ok: false, reason: 'receipt skillContentSha256 不合法' };
    }
    const expectedDirs = (manifestResult.manifest.skill?.items ?? [])
      .map((item) => item.dir)
      .sort();
    const actualDirs = Object.keys(raw as Record<string, unknown>).sort();
    if (
      expectedDirs.length !== actualDirs.length ||
      expectedDirs.some((dir, index) => dir !== actualDirs[index])
    ) {
      return { ok: false, reason: 'receipt skillContentSha256 与 manifest 声明不一致' };
    }
    for (const [dir, digest] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)) {
        return { ok: false, reason: `receipt skillContentSha256 不合法:${dir}` };
      }
      skillContentSha256[dir] = digest;
    }
  }
  if (
    value.iconDataUrl !== undefined &&
    (typeof value.iconDataUrl !== 'string' ||
      Buffer.byteLength(value.iconDataUrl, 'utf8') > MAX_ICON_DATA_URL_BYTES ||
      !ICON_DATA_URL_RE.test(value.iconDataUrl))
  ) {
    return { ok: false, reason: 'receipt iconDataUrl 不合法' };
  }
  if (
    !value.localeResources ||
    typeof value.localeResources !== 'object' ||
    Array.isArray(value.localeResources)
  ) {
    return { ok: false, reason: 'receipt localeResources 不合法' };
  }
  const expectedLocalePaths = [
    ...new Set(Object.values(manifestResult.manifest.locales ?? {})),
  ].sort();
  const actualLocalePaths = Object.keys(value.localeResources as Record<string, unknown>).sort();
  if (
    expectedLocalePaths.length !== actualLocalePaths.length ||
    expectedLocalePaths.some((localePath, index) => localePath !== actualLocalePaths[index])
  ) {
    return { ok: false, reason: 'receipt localeResources 与 manifest 声明不一致' };
  }
  const localeResources: Record<string, GhostManifestLocaleResource> = {};
  for (const [localePath, resource] of Object.entries(
    value.localeResources as Record<string, unknown>,
  )) {
    if (Buffer.byteLength(JSON.stringify(resource), 'utf8') > GHOST_LOCALE_MAX_BYTES) {
      return { ok: false, reason: `receipt locale 超过大小上限:${localePath}` };
    }
    const validated = validateGhostManifestLocaleResource(resource, manifestResult.manifest);
    if (!validated.ok) return { ok: false, reason: `receipt locale 不合法:${localePath}` };
    localeResources[localePath] = validated.resource;
  }
  return {
    ok: true,
    receipt: {
      schemaVersion: RECEIPT_SCHEMA_VERSION,
      id: expectedId,
      revision: value.revision,
      manifest: manifestResult.manifest,
      localeResources,
      enabled: value.enabled,
      trust,
      skillContentSha256,
      ...(typeof value.packageSha256 === 'string' ? { packageSha256: value.packageSha256 } : {}),
      ...(typeof value.iconDataUrl === 'string' ? { iconDataUrl: value.iconDataUrl } : {}),
    },
  };
}

function isRevision(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}

async function copyRegularDirectory(source: string, target: string): Promise<void> {
  // 类型判据与 hashApprovedSkillContent 同源(ghostContentTree):两侧必须同形,
  // 否则指纹算的和快照拷的可能不是同一组字节。
  if ((await classifyGhostDirEntry(source)) !== 'directory') {
    throw new Error(`skill source is not a directory: ${source}`);
  }
  await fs.promises.mkdir(target, { recursive: true });
  const entries = await fs.promises.readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    const kind = await classifyGhostDirEntry(from);
    if (!isRegularGhostDirEntry(kind)) {
      throw new Error(
        `skill snapshot rejects ${kind === 'link' ? 'link' : 'non-regular'} entry: ${from}`,
      );
    }
    if (kind === 'directory') {
      await copyRegularDirectory(from, to);
    } else {
      await fs.promises.copyFile(from, to, fs.constants.COPYFILE_EXCL);
    }
  }
}

function validateTrust(raw: unknown): GhostTrustInfo | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (
    !['cindy-official', 'reviewed', 'verified-publisher', 'unverified'].includes(
      String(value.level),
    ) ||
    typeof value.publisherSigned !== 'boolean' ||
    typeof value.publisherVerified !== 'boolean' ||
    typeof value.reviewed !== 'boolean'
  ) {
    return null;
  }
  const optionalStrings = ['publisherName', 'publisherKeyId', 'reviewerName'] as const;
  for (const key of optionalStrings) {
    if (value[key] !== undefined && typeof value[key] !== 'string') return null;
  }
  if (value.unknownReviewer !== undefined && typeof value.unknownReviewer !== 'boolean') {
    return null;
  }
  return value as unknown as GhostTrustInfo;
}
