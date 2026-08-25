import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readBoundedFileNoFollowSync } from '../utils/readBoundedFile.js';

import {
  GHOST_LOCALE_MAX_BYTES,
  GHOST_SKILL_MD_MAX_BYTES,
  ghostManifestToAuthorFormat,
  isValidGhostId,
  validateGhostManifestLocaleResource,
  validateNormalizedGhostManifest,
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
import {
  mutateGhostSnapshotWithStableParent,
  type GhostSnapshotMutationRequest,
} from './ghostSnapshotCapability.js';

// v2 pairs receipts with the unambiguous ghostContentTree framing. Keeping v1
// readable would let an old ambiguous digest authorize a snapshot under the
// new verifier, so old receipts intentionally fail closed and require approval
// to be written again.
const RECEIPT_SCHEMA_VERSION = 2;
const MAX_RECEIPT_BYTES = 2 * 1024 * 1024;
const MAX_PENDING_MUTATION_BYTES = 64 * 1024;
const MAX_ICON_DATA_URL_BYTES = 768 * 1024;
const MAX_MIGRATION_LEDGER_BYTES = 64 * 1024;
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
   * 批准时点的来源指纹：市场/本地包是 `.cindy` 文件哈希，随包种子是内容目录哈希。
   * 组织市场 Broker 资格会把它与 ledger 的 Release sha256 比对；除此以外运行时不会
   * 重算可变安装目录的整包字节，所以不要据此认为安装内容持续完整。
   */
  packageSha256?: string;
  /**
   * 旧版 Forge 安装写入的来源标记。新安装不再写入；保留只读是为了让升级前
   * 已获 Broker 资格的存量插件不会在客户端升级后突然失效。
   */
  installOrigin?: string;
  /**
   * 按 skill item 目录钉住的固化字节指纹(`item.dir` → sha256)。声明了 skill 能力
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
 * 这道门,删掉某个 receipt 就能骗一次"从当前可变安装目录重建验证状态",而安装目录可被
 * 同权限进程改写。ledger 门是充分守卫——能删 ledger 的进程本就能直接往状态根写一份
 * 结构合法的伪造 receipt(§7 已登记"状态根无写保护"缺口),迁移路径严格弱于它。
 */
export interface GhostLegacyMigrationLedger {
  version: 1;
  /** 迁移完成时刻(ISO)。仅审计,不参与判定。 */
  migratedAt: string;
  /** 实际 backfill 出 receipt 的 id 清单,便于事后分辨"正常安装写入"与"迁移来的"。 */
  migratedIds: string[];
  /**
   * 迁移读不出核心事实而 fail closed 的 id(坏 manifest / 技能目录含链接等)。
   * 记进台账供支持排查与 UI 提示;这些 id 走每插件的重新安装恢复入口。
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
  /**
   * Owner recovery 在搬目录前冻结的批准投影摘要，按 id 索引。
   * 仅对恢复路径进入 pending 的 id 有效；主迁移候选不含此字段。
   * retry 路径用它在重试前验证内容未被篡改。
   */
  recoveryApprovalProjectionSha256ById?: Record<string, string>;
}

/**
 * 装入/更新事务的提交日志(状态根内,崩溃后仍在)。用来消除「目录已 rename、receipt
 * 还没写」这段崩溃窗口:
 * - install:崩溃留下"有 finalDir、无 receipt、无 ledger"的目录,与 legacy 安装无法
 *   区分 —— 全新 owner 首个安装崩在这里,下轮迁移会把它(含崩溃窗口内被同权限进程
 *   改写的 manifest)当存量安装收编,检查的是 A、最后固化的是 B。
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
  constructor(
    private readonly getRootDir: () => string,
    private readonly mutateSnapshot: (
      request: GhostSnapshotMutationRequest,
    ) => Promise<void> = mutateGhostSnapshotWithStableParent,
  ) {}

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
    let bytes: Buffer | null;
    try {
      bytes = readBoundedFileNoFollowSync(receiptPath, MAX_RECEIPT_BYTES, {
        containWithin: this.rootDir(),
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { state: 'missing' };
      }
      return {
        state: 'unreadable',
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    if (!bytes) {
      return { state: 'invalid', reason: 'receipt 不是普通文件或超过大小上限' };
    }
    const text = bytes.toString('utf8');
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
    // 此处**绝不**自动写 migration ledger —— 自动写 completed 的旧逻辑会在迁移
    // 扫描因瞬时故障失败、且 builtin/市场写入首份 receipt 后永久关闭迁移门，使所有
    // 存量插件变成 legacy-unapproved（P0 红线）。
    //
    // 代之以 per-id 迁移标记:receipt 初次落账时同步写 `.migrated-<id>` 哨兵文件。
    // coordinator 扫描时见到”无 receipt + 有哨兵”就跳过 —— 这是新模型装的插件、
    // 不是 legacy，删掉 receipt 不能骗到一次从可变目录重铸批准。
    //
    // 标记写入在 receipt 之前，receipt 写失败必须回滚标记，避免留一个
    // 无 receipt 的哨兵把合法 legacy 插件永久挡在迁移之外。
    // ensureMigrationMarker 返回 true 仅当本次调用实际创建了 marker，
    // 因此不存在 TOCTOU：检查和创建在同一个调用内完成。
    // Once published, retain the marker on receipt-write failure. Another
    // writer may have observed it and committed the receipt; pathname-based
    // rollback could remove that install's only durable migration guard.
    if (!this.hasMigrationLedger()) {
      await this.ensureMigrationMarker(receipt.id);
    }
    const target = this.receiptPath(receipt.id);
    const temp = path.join(
      root,
      `.${receipt.id}-${process.pid}-${crypto.randomBytes(6).toString('hex')}.tmp`,
    );
    const persistedReceipt = {
      ...validated.receipt,
      manifest: ghostManifestToAuthorFormat(validated.receipt.manifest),
    };
    try {
      await fs.promises.writeFile(temp, `${JSON.stringify(persistedReceipt, null, 2)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      });
      await fs.promises.rename(temp, target);
    } catch (error) {
      throw error;
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
    const parentDir = path.join(this.rootDir(), 'skill-snapshots');
    const parentStats = await fs.promises.lstat(parentDir, { bigint: true });
    await this.mutateSnapshot({
      parentDir,
      expectedParent: {
        realPath: await fs.promises.realpath(parentDir),
        dev: parentStats.dev,
        ino: parentStats.ino,
      },
      operation: 'remove',
      targetName: id,
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
    // Startup recovery is synchronous, while the only safe recursive cleanup
    // capability is the cwd-bound utility worker. Removing the receipt is the
    // authorization boundary; retain the now-unreferenced snapshot for later
    // asynchronous cleanup rather than performing a pathname-based rmSync.
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
      // 与 receipt 同源:no-follow + 限量 + realpath 根内复核。FIFO / symlink 到
      // 无界大文件必须在 parse 前就被拒绝,否则启动路径(migrationDoorClosed)
      // 会阻塞或分配无界内存,而不是把台账按不可读关门。
      const bytes = readBoundedFileNoFollowSync(
        this.migrationLedgerPath(),
        MAX_MIGRATION_LEDGER_BYTES,
        { containWithin: this.rootDir() },
      );
      if (bytes === null) return null;
      const raw = JSON.parse(
        bytes.toString('utf8'),
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
      if (
        raw.recoveryApprovalProjectionSha256ById !== undefined &&
        (typeof raw.recoveryApprovalProjectionSha256ById !== 'object' ||
          raw.recoveryApprovalProjectionSha256ById === null ||
          Array.isArray(raw.recoveryApprovalProjectionSha256ById) ||
          Object.keys(raw.recoveryApprovalProjectionSha256ById).some(
            (k) => !isValidGhostId(k) || !/^[a-f0-9]{64}$/.test(raw.recoveryApprovalProjectionSha256ById![k]),
          ))
      ) {
        return null;
      }
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

  /** 是否已跑过一轮 legacy 迁移(全局一次性门;存在即按"已跑"处理,宁可不再迁)。 */
  hasMigrationLedger(): boolean {
    try {
      // 只要路径存在就视为已迁,不论它是普通文件还是 symlink / FIFO / 设备节点:
      // 把非普通 ledger 判成"不存在"会让迁移门重开,允许从当前可变安装目录重铸授权。
      fs.lstatSync(this.migrationLedgerPath());
      return true;
    } catch (error) {
      // ENOENT = 从未迁过,可以迁;其它错误(权限等)= 状态未知,保守当作"已迁",
      // 绝不因为读不动 ledger 就把迁移(=从可变安装目录重建授权)再放开一次。
      return (error as NodeJS.ErrnoException).code !== 'ENOENT';
    }
  }

  /**
   * Per-id migration marker path. 与 receipt 同位（状态根内）,coordinator 扫描
   * 时用它区分"安装了 receipt 之前就是 legacy"与"新模型安装后 receipt 被删"。
   */
  private migrationMarkerPath(id: string): string {
    if (!isValidGhostId(id)) throw new Error('invalid ghost id for migration marker path');
    return path.join(this.rootDir(), `.migrated-${id}`);
  }

  /**
   * 确保 per-id 迁移标记存在。receipt 初次落账时调用；标记是零字节普通文件,
   * 在 migration ledger 按 completed 关闭前钉住"此 id 已进入新模型"。
   */
  async ensureMigrationMarker(id: string): Promise<boolean> {
    // Returns true only when this call published the marker, so the
    // caller knows whether to roll it back on receipt write failure.
    // EXISTENT: the marker is already in place (concurrent writer or
    //   surviving marker from a failed rollback) — safe to proceed.
    // ERROR: temp write or link/rename failed for a reason other than
    //   EEXIST — fail the receipt write, do not publish the receipt
    //   without the per-id migration guard.
    const initialState = this.migrationMarkerState(id);
    if (initialState.state === 'present') return false;
    if (initialState.state === 'unavailable') throw initialState.error;
    const root = this.rootDir();
    await fs.promises.mkdir(root, { recursive: true });
    const target = this.migrationMarkerPath(id);
    const temp = path.join(root, `.migrated-${id}-${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`);
    try {
      await fs.promises.writeFile(temp, '', { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      // Publish via hard-link first so the operation is no-clobber:
      // link fails with EEXIST if a concurrent writer already created
      // the marker, while rename would silently replace it and claim
      // ownership.  If link is not available (EXDEV, cross-device),
      // fall back to a pre-rename existence check + rename.
      try {
        await fs.promises.link(temp, target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          // Concurrent writer already published the marker — safe.
          return false;
        }
        if ((error as NodeJS.ErrnoException).code === 'EXDEV') {
          // Cross-device: re-check before rename so we don't clobber.
          const stateBeforeRename = this.migrationMarkerState(id);
          if (stateBeforeRename.state === 'present') return false;
          if (stateBeforeRename.state === 'unavailable') throw stateBeforeRename.error;
          await fs.promises.rename(temp, target);
        } else {
          throw error;
        }
      }
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        // Concurrent writer already published the marker — safe.
        return false;
      }
      // EACCES, EPERM, EBUSY, EIO, etc.: the state root is not writable,
      // so the receipt write will also likely fail.  Throw now rather than
      // proceeding with a receipt that lacks the migration guard.
      throw error;
    } finally {
      await fs.promises.rm(temp, { force: true }).catch(() => undefined);
    }
  }

  /** 是否存在 per-id 迁移标记(表明此 id 是通过新模型安装,而非 legacy)。 */
  hasMigrationMarker(id: string): boolean {
    // The migration coordinator only re-opens legacy candidacy on definite
    // absence. Unknown marker state must keep backfill closed.
    return this.migrationMarkerState(id).state !== 'missing';
  }

  private migrationMarkerState(
    id: string,
  ):
    | { state: 'present' }
    | { state: 'missing' }
    | { state: 'unavailable'; error: unknown } {
    try {
      fs.lstatSync(this.migrationMarkerPath(id));
      return { state: 'present' };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { state: 'missing' };
      }
      return { state: 'unavailable', error };
    }
  }

  /** 回滚 per-id 迁移标记(receipt 写入失败时调用)。 */
  async removeMigrationMarker(id: string): Promise<void> {
    await fs.promises.rm(this.migrationMarkerPath(id), { force: true });
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
    let bytes: Buffer | null;
    try {
      // Single-handle bounded read: the earlier lstat+readFileSync pair had a
      // TOCTOU window where a FIFO/symlink/huge file could replace the journal
      // between the two calls.  readBoundedFileNoFollowSync opens, stats, and
      // reads from the same handle with O_NONBLOCK so a FIFO/device blocks
      // neither the open nor the subsequent read.
      bytes = readBoundedFileNoFollowSync(markerPath, MAX_PENDING_MUTATION_BYTES, {
        containWithin: this.rootDir(),
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'missing' };
      return {
        state: 'unreadable',
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    if (!bytes) {
      return { state: 'invalid', reason: 'journal is not a regular file or exceeds size limit' };
    }
    const text = bytes.toString('utf8');
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
    const snapshotsRoot = path.join(this.rootDir(), 'skill-snapshots');
    try { await fs.promises.mkdir(snapshotsRoot, { recursive: false }); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const rootStats = await fs.promises.lstat(snapshotsRoot, { bigint: true });
    if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) throw new Error('skill snapshot root unavailable');
    await this.mutateSnapshot({
      parentDir: snapshotsRoot,
      expectedParent: {
        realPath: await fs.promises.realpath(snapshotsRoot),
        dev: rootStats.dev,
        ino: rootStats.ino,
      },
      operation: 'ensure',
      targetName: `${receipt.id}/${receipt.revision}`,
      receipt,
      ...(skillSourceDir ? { sourceDir: skillSourceDir } : {}),
    });
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
    // The content walker pins the resolved directory identity while hashing,
    // but an approved snapshot must also remain rooted at the Host-managed
    // lexical path. A same-bytes symlink/junction is still an authorization
    // escape because the projected global skill link would resolve outside
    // the approval state root.
    if (await classifyGhostDirEntry(snapshotDir).catch(() => null) !== 'directory') return false;
    const actual = await hashApprovedSkillContent(receipt.manifest, snapshotDir).catch(() => null);
    if (!actual) return false;
    if (await classifyGhostDirEntry(snapshotDir).catch(() => null) !== 'directory') return false;
    return (receipt.manifest.skill?.items ?? []).every(
      (item) => actual[item.dir] === receipt.skillContentSha256[item.dir],
    );
  }

  /**
   * 回收同一插件下非当前 revision 的技能快照与崩溃残留的 `.tmp` 目录。
   *
   * 只在新 receipt 已经原子提交之后跑:此刻旧 revision 已不是批准事实，留着
   * 就是每次更新泄漏一份完整拷贝。共享技能根里指向旧 revision 的链接会因此
   * 短暂断链，直到下一轮对账重指——对越出沙箱的 skill 能力来说，短暂"技能不可
   * 用"是正确的收敛方向，留着旧批准版本继续生效不是。
   *
   * best-effort:批准事实已经落盘，回收失败只记为待清理状态，不回滚安装。
   */
  private async pruneStaleSkillSnapshots(receipt: GhostInstallReceipt): Promise<void> {
    void receipt;
    return;
    /* Pathname-based recursive deletion cannot close the parent-swap TOCTOU
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
    let verifiedParent: string;
    try {
      const [realRoot, realParent] = await Promise.all([
        fs.promises.realpath(this.rootDir()),
        fs.promises.realpath(parent),
      ]);
      if (!isPathInsideDir(realRoot, realParent)) return;
      verifiedParent = realParent;
    } catch {
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(verifiedParent, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(
      entries
        .filter((entry) => entry.name !== receipt.revision)
        .map(async (entry) => {
          try {
            // Re-validate the managed parent immediately before each destructive
            // child removal: another process may have swapped the lexical
            // snapshot parent for a symlink/junction after the initial check.
            const [realRoot, currentParent] = await Promise.all([
              fs.promises.realpath(this.rootDir()),
              fs.promises.realpath(parent),
            ]);
            if (currentParent !== verifiedParent || !isPathInsideDir(realRoot, currentParent)) {
              return;
            }
            await fs.promises.rm(path.join(currentParent, entry.name), {
              recursive: true,
              force: true,
            });
          } catch {
            // Best-effort cleanup; a later receipt reconciliation can retry.
          }
        }),
    ); */
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
 * 随包种子逐字节对账后授予,而本函数仅供 legacy 迁移非随包插件使用。非随包目录里
 * 出现官方档镜像本身就不可信,照抄会让列表把一个可变目录里的插件展示成「Cindy 官方」。
 */
export function readLegacyInstallTrust(dir: string): GhostTrustInfo | null {
  const file = path.join(dir, '.cindy-trust.json');
  try {
    const realDir = fs.realpathSync(dir);
    const bytes = readBoundedFileNoFollowSync(file, MAX_RECEIPT_BYTES, { containWithin: realDir });
    if (bytes === null) return null;
    try {
      const trust = validateTrust(JSON.parse(bytes.toString('utf8')));
      if (!trust || trust.level === 'cindy-official') return null;
      return trust;
    } catch {
      return null;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EIO') throw error;
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
  installOrigin?: string;
}): GhostInstallReceipt {
  if (input.installOrigin !== undefined && !isPersistableInstallOrigin(input.installOrigin)) {
    throw new Error('receipt installOrigin 不合法');
  }
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
    ...(input.installOrigin !== undefined ? { installOrigin: input.installOrigin } : {}),
  };
}

const MAX_INSTALL_ORIGIN_CHARS = 64;
const INSTALL_ORIGIN_PATTERN = /^[a-z0-9-]+$/;

function isPersistableInstallOrigin(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MAX_INSTALL_ORIGIN_CHARS &&
    INSTALL_ORIGIN_PATTERN.test(value)
  );
}

/** 旧 receipt 的授权视图：只有历史 agent-forge 值有效，其余一律降级。 */
export function effectiveInstallOrigin(
  receipt: Pick<GhostInstallReceipt, 'installOrigin'>,
): 'manual' | 'agent-forge' {
  return receipt.installOrigin === 'agent-forge' ? 'agent-forge' : 'manual';
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
  const manifestResult = validateNormalizedGhostManifest(value.manifest);
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
  let installOrigin: string | undefined;
  if (value.installOrigin !== undefined) {
    if (
      typeof value.installOrigin !== 'string' ||
      !isPersistableInstallOrigin(value.installOrigin)
    ) {
      return { ok: false, reason: 'receipt installOrigin 不合法' };
    }
    installOrigin = value.installOrigin;
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
      ...(installOrigin !== undefined ? { installOrigin } : {}),
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
