import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import JSZip from 'jszip';

import {
  GHOST_MANIFEST_FILE,
  GHOST_MANIFEST_MAX_BYTES,
  GHOST_LOCALE_MAX_BYTES,
  GHOST_ICON_MAX_BYTES,
  GHOST_INSTALL_MANIFEST_MAX_BYTES,
  GHOST_SLOTS,
  GHOST_MANUAL_ENTRY_FILE,
  GHOST_MANUAL_MD_MAX_BYTES,
  GHOST_SKILL_MD_MAX_BYTES,
  ghostLocalePathFor,
  ghostInstallApprovalToken,
  ghostIconMimeType,
  isOfficialGhostId,
  isValidGhostId,
  resolveGhostManifestLocale,
  validateGhostManifest,
  validateGhostManifestLocaleResource,
  withGhostResolvedLocale,
  type GhostManifest,
  type GhostManifestLocaleResource,
  type GhostTrustInfo,
  type InstalledGhost,
} from '../../shared/ghost.js';
import { verifyGhostZipSignatures, type GhostTrustRegistry } from './ghostSignature.js';
import { isPathInsideDir } from './dirDeposit.js';
import {
  classifyGhostDirEntry,
  classifyGhostDirEntrySync,
  collectGhostContentFiles,
  hashGhostContentBuffers,
  hashGhostContentFiles,
  resolveGhostContentPathSync,
  type GhostDirEntryKind,
} from './ghostContentTree.js';
import { readBoundedFileNoFollowSync } from '../utils/readBoundedFile.js';
import { checkSkillMdConsistency } from './skillSlot.js';
import {
  createGhostInstallReceipt,
  GhostInstallReceiptStore,
  hashApprovedSkillContent,
  readLegacyInstallTrust,
  type GhostInstallReceipt,
  type GhostInstallReceiptReadResult,
} from './ghostInstallReceipt.js';
import { parseInstalledGhostManifest } from '../installedGhostManifest.js';
import {
  decodeGhostManualMarkdown,
  ghostManualLogicalPathForEntry,
} from './ghostManualValidation.js';

/** 普通沙箱插件维持小包上限；随包 Node/CLI 允许更大的预打包产物。 */
export const MAX_BASIC_CINDY_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_NODE_CINDY_FILE_BYTES = 128 * 1024 * 1024;
/** 身份卡本身只应是小 JSON；先限流读取，避免在识别包类型前被单文件撑爆内存。 */
const MAX_GHOST_MANIFEST_BYTES = GHOST_MANIFEST_MAX_BYTES;

async function readRegularFileStableWithLimit(
  filePath: string,
  maxBytes: number,
): Promise<Buffer> {
  // 顶层 .cindy 路径允许是用户选择的 symlink；确认前后由整包 sha256 对账，
  // 单次读取则始终绑定同一个已打开句柄，避免 stat/read 的二次解析窗口。
  const handle = await fs.promises.open(
    filePath,
    fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0),
  );
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) {
      throw new Error('source is not a regular file');
    }
    if (opened.size > maxBytes) {
      throw new Error(`source exceeds ${maxBytes} bytes`);
    }
    const bytes = Buffer.allocUnsafe(opened.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.byteLength - offset, null);
      if (bytesRead === 0) throw new Error('source file shrank while being read');
      offset += bytesRead;
    }
    const after = await handle.stat();
    const sameIdentity = after.isFile() &&
      after.size === opened.size &&
      after.mtimeMs === opened.mtimeMs &&
      after.ctimeMs === opened.ctimeMs &&
      ((opened.dev === 0 && opened.ino === 0) ||
        (after.dev === opened.dev && after.ino === opened.ino));
    if (!sameIdentity) throw new Error('source file changed while being read');
    return bytes;
  } finally {
    await handle.close().catch(() => undefined);
  }
}
/** 解压后总大小/条目数上限；Node 包允许携带已打包 CLI，但仍有硬闸。 */
export const MAX_BASIC_UNCOMPRESSED_BYTES = 32 * 1024 * 1024;
export const MAX_NODE_UNCOMPRESSED_BYTES = 256 * 1024 * 1024;
export const MAX_BASIC_ZIP_ENTRIES = 256;
export const MAX_NODE_ZIP_ENTRIES = 2_048;
/** 停用标记文件名(安装目录内;存在即停用)。 */
const DISABLED_MARKER_FILE = '.disabled';
/** 安装时由主机写入的信任快照与权限 receipt；作者包不能提供。 */
export const TRUST_METADATA_FILE = '.cindy-trust.json';

function isZipSymbolicLink(entry: JSZip.JSZipObject): boolean {
  return (
    typeof entry.unixPermissions === 'number' && (entry.unixPermissions & 0o170000) === 0o120000
  );
}

/** 只有宿主安装/播种路径可以写入的 Cindy 官方身份。 */
export const CINDY_OFFICIAL_GHOST_TRUST: GhostTrustInfo = Object.freeze({
  level: 'cindy-official',
  publisherSigned: true,
  publisherVerified: true,
  reviewed: true,
  publisherName: 'Cindy Plugin Market',
});

export type GhostHostTrustOverride = 'cindy-official';

/**
 * 判断一个已投影的 trust 是否确实来自完整官方 receipt。
 *
 * 这是 gh-cli 凭证路径的共同安全谓词：不能只看 level，否则残缺或被篡改
 * 的 `.cindy-trust.json` 可能被误当成官方插件。其它 trust level 仍保留其
 * 原有兼容字段语义；只有官方 level 要求这组不可缺省的完整字段。
 */
export function isCindyOfficialTrustInfo(
  trust: GhostTrustInfo | null | undefined,
): boolean {
  return (
    trust?.level === CINDY_OFFICIAL_GHOST_TRUST.level &&
    trust.publisherSigned === CINDY_OFFICIAL_GHOST_TRUST.publisherSigned &&
    trust.publisherVerified === CINDY_OFFICIAL_GHOST_TRUST.publisherVerified &&
    trust.reviewed === CINDY_OFFICIAL_GHOST_TRUST.reviewed &&
    trust.publisherName === CINDY_OFFICIAL_GHOST_TRUST.publisherName
  );
}

/** 完整校验官方 Host receipt；只看 level 会把损坏 receipt 误当成已回填。 */
export function hasCindyOfficialTrustMetadata(dir: string): boolean {
  try {
    const bytes = readBoundedFileNoFollowSync(path.join(dir, TRUST_METADATA_FILE), 64 * 1024);
    if (bytes === null) return false;
    const raw = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
    return isCindyOfficialTrustInfo(raw as unknown as GhostTrustInfo);
  } catch {
    return false;
  }
}

/** 注入式日志接口 —— manager 不直接依赖 main/logger,单测零 electron。 */
export interface GhostManagerLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  /** 可选:仅用于"本该收敛却失败"的状态(如撤销批准失败后转进程内隔离)。 */
  error?(message: string, meta?: Record<string, unknown>): void;
}

export interface GhostManagerOptions {
  /** 意识仓库根目录(生产:userData/cindy-brain;测试:os.tmpdir 下临时目录)。 */
  getRootDir: () => string;
  /** Host 批准状态根；必须位于插件安装根之外。 */
  getStateDir?: () => string;
  /**
   * 当前 owner 的稳定代际键。生产接线使用 activeOwnerScopeKey，使同一账号被重新
   * commit 时也能使排队中的旧 mutation 失效；测试可只依赖动态 content/state root。
   */
  getOwnerContextKey?: () => string;
  /** 装/卸成功后通知(index.ts 用它广播 ghosts:changed 到所有窗口)。 */
  onChanged?: (ghosts: InstalledGhost[]) => void;
  /** 当前宿主语言；插件未提供时由 shared 契约固定回退英文。 */
  getLocale?: () => string;
  /**
   * `approveTrustedBundledInstall` 的 builtin-only 边界:id 是否对应一颗随包种子。
   * 该入口不经用户确认就铸出批准，因此 id 与 source 都必须由生产接线明确放行。
   */
  isTrustedBundledId?: (id: string) => boolean;
  /** sourceDir 是否就是该 id 的随包只读种子目录，而非任意本机可变目录。 */
  isTrustedBundledSource?: (id: string, sourceDir: string) => boolean;
  /** Persist the user's builtin-uninstall intent before approval/content removal. */
  recordBuiltinTombstone?: (id: string) => void;
  /** Complete a user-initiated builtin restore before the install journal commits. */
  clearBuiltinTombstone?: (id: string) => void;
  /** Cindy 维护的发布者/审核公钥表；缺省为空，签名仍验完整性但不抬身份等级。 */
  trustRegistry?: GhostTrustRegistry;
  log?: GhostManagerLogger;
  /** Test-only stable snapshot mutation seam; production defaults to the worker. */
  mutateSnapshot?: ConstructorParameters<typeof GhostInstallReceiptStore>[1];
}

/** install / update 的失败分类 —— IPC 层据此映射错误码。 */
export type InstallRejection =
  | { code: 'source-not-found'; reason: string }
  | { code: 'file-invalid'; reason: string }
  | { code: 'host-unsupported'; reason: string }
  | { code: 'already-installed'; reason: string }
  | { code: 'not-installed'; reason: string }
  | { code: 'command-conflict'; reason: string }
  | { code: 'state-changed'; reason: string }
  | {
      code: 'io';
      reason: string;
      /**
       * 更新失败后连旧版本目录都没能滚回原位(Windows 文件锁/AV 等):此时安装目录
       * 可能是新字节或缺失,调用方**不得**按"旧版本还在"重启运行时。
       */
      rollbackFailed?: boolean;
    };

/**
 * Reversible side effect prepared after the new package directory is in place.
 * Durable writes happen before this object is returned; `commit` only publishes
 * best-effort notifications after the receipt has committed.
 */
export interface GhostPackageCommitPreparation {
  commit(): void;
  rollback(): void;
}

export type UninstallRejection =
  | { code: 'invalid-id'; reason: string }
  | { code: 'not-installed'; reason: string }
  | { code: 'approval-required'; reason: string }
  | { code: 'io'; reason: string };

export type UninstallResult = { ok: true } | { rejection: UninstallRejection };

export interface GhostUninstallOptions {
  notify?: boolean;
  /**
   * User-initiated removal records a builtin tombstone by default. Host
   * reconciliation may explicitly skip it when removing a currently ineligible
   * seed; that is lifecycle cleanup, not a durable user uninstall decision.
   */
  recordBuiltinTombstone?: boolean;
}

interface InstalledReapprovalProjection {
  manifest: GhostManifest;
  trust: GhostTrustInfo;
  localeResources: Record<string, GhostManifestLocaleResource>;
  iconDataUrl?: string;
  skillContentSha256: Record<string, string>;
}

export interface LegacyGhostApprovalProjection {
  manifest: GhostManifest;
  enabled: boolean;
  trust: GhostTrustInfo;
  localeResources: Record<string, GhostManifestLocaleResource>;
  iconDataUrl?: string;
  skillContentSha256: Record<string, string>;
}

export function hashLegacyGhostApprovalProjection(
  projection: LegacyGhostApprovalProjection,
): string {
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        version: 1,
        manifest: projection.manifest,
        enabled: projection.enabled,
        trust: projection.trust,
        localeResources: projection.localeResources,
        iconDataUrl: projection.iconDataUrl ?? null,
        skillContentSha256: projection.skillContentSha256,
      }),
    )
    .digest('hex');
}

function sameLegacyApprovalDirectoryIdentity(expected: fs.Stats, current: fs.Stats): boolean {
  if (!current.isDirectory() || current.isSymbolicLink()) return false;
  if (expected.dev !== 0 || expected.ino !== 0 || current.dev !== 0 || current.ino !== 0) {
    return expected.dev === current.dev && expected.ino === current.ino;
  }
  return expected.birthtimeMs === current.birthtimeMs && expected.ctimeMs === current.ctimeMs;
}

function sameLegacyApprovalCanonicalPath(left: string, right: string): boolean {
  const fold = (value: string): string =>
    process.platform === 'win32' ? value.toLowerCase() : value;
  return fold(path.resolve(left)) === fold(path.resolve(right));
}

function assertStableLegacyApprovalDirectory(
  dir: string,
  expectedStats: fs.Stats,
  expectedRealPath: string,
): void {
  const currentStats = fs.lstatSync(dir);
  const currentRealPath = fs.realpathSync(dir);
  if (
    !sameLegacyApprovalDirectoryIdentity(expectedStats, currentStats) ||
    !sameLegacyApprovalCanonicalPath(expectedRealPath, currentRealPath)
  ) {
    throw new Error('legacy approval directory changed while reading');
  }
}

function readLegacyDisabledMarkerForApproval(dir: string): boolean {
  const marker = path.join(dir, DISABLED_MARKER_FILE);
  try {
    const kind = classifyGhostDirEntrySync(marker);
    if (kind === 'file') return true;
    throw new Error('legacy disabled marker is not a regular file');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function readLegacyLocaleResourcesForApproval(
  dir: string,
  realDir: string,
  manifest: GhostManifest,
): Record<string, GhostManifestLocaleResource> {
  const resources: Record<string, GhostManifestLocaleResource> = {};
  for (const localePath of Object.values(manifest.locales ?? {})) {
    if (!localePath) continue;
    const absPath = resolveGhostContentPathSync(dir, localePath, {
      expect: 'file',
      label: 'legacy locale',
    });
    const bytes = readBoundedFileNoFollowSync(absPath, GHOST_LOCALE_MAX_BYTES, {
      containWithin: realDir,
    });
    if (bytes === null) throw new Error(`legacy locale missing or oversized: ${localePath}`);
    let raw: unknown;
    try {
      raw = JSON.parse(bytes.toString('utf8'));
    } catch (error) {
      throw new Error(
        `legacy locale is not valid JSON: ${localePath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    const validated = validateGhostManifestLocaleResource(raw, manifest);
    if (!validated.ok) throw new Error(`legacy locale invalid: ${localePath}`);
    resources[localePath] = validated.resource;
  }
  return resources;
}

function readLegacyIconDataUrlForApproval(
  dir: string,
  realDir: string,
  manifest: GhostManifest,
): string | undefined {
  if (manifest.icon === undefined) return undefined;
  try {
    const iconPath = resolveGhostContentPathSync(dir, manifest.icon, {
      expect: 'file',
      label: 'legacy icon',
    });
    const bytes = readBoundedFileNoFollowSync(iconPath, GHOST_ICON_MAX_BYTES, {
      containWithin: realDir,
    });
    if (bytes === null) return undefined;
    return buildIconDataUrl(manifest.icon, bytes) ?? undefined;
  } catch {
    // Icon data is presentation-only. A broken optional icon must not make an
    // otherwise valid legacy approval ineligible for zero-operation migration.
    return undefined;
  }
}

/**
 * Read the complete legacy approval fact once. Recovery freezes only its digest,
 * then both the pre-rename gate and receipt backfill re-read this same projection.
 */
export async function readLegacyGhostApprovalProjection(
  dir: string,
  id: string,
): Promise<{ projection: LegacyGhostApprovalProjection; sha256: string }> {
  const dirStats = fs.lstatSync(dir);
  if (!dirStats.isDirectory() || dirStats.isSymbolicLink()) {
    throw new Error('legacy approval source is not a real directory');
  }
  const realDir = fs.realpathSync(dir);
  assertStableLegacyApprovalDirectory(dir, dirStats, realDir);
  const manifestPath = resolveGhostContentPathSync(dir, GHOST_MANIFEST_FILE, {
    expect: 'file',
    label: 'legacy manifest',
  });
  const rawBytes = readBoundedFileNoFollowSync(manifestPath, GHOST_MANIFEST_MAX_BYTES, {
    containWithin: realDir,
  });
  if (rawBytes === null) throw new Error('legacy manifest is missing or oversized');
  let raw: unknown;
  try {
    raw = JSON.parse(rawBytes.toString('utf8'));
  } catch (error) {
    throw new Error(`invalid manifest JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  // Installed legacy manifests may carry the pre-manual top-level metadata
  // field. Keep the compatibility rule identical across discovery and the
  // approval projection freeze; all other manifest validation stays strict.
  const validated = parseInstalledGhostManifest(raw);
  if (!validated.ok) throw new Error(`invalid manifest: ${validated.reason}`);
  if (validated.manifest.id !== id) throw new Error('manifest id != install dir name');

  const trust: GhostTrustInfo = readLegacyInstallTrust(dir) ?? {
    level: 'unverified',
    publisherSigned: false,
    publisherVerified: false,
    reviewed: false,
  };
  const projection: LegacyGhostApprovalProjection = {
    manifest: validated.manifest,
    enabled: !readLegacyDisabledMarkerForApproval(dir),
    trust,
    localeResources: readLegacyLocaleResourcesForApproval(dir, realDir, validated.manifest),
    skillContentSha256: await hashApprovedSkillContent(validated.manifest, dir),
  };
  const iconDataUrl = readLegacyIconDataUrlForApproval(dir, realDir, validated.manifest);
  if (iconDataUrl !== undefined) projection.iconDataUrl = iconDataUrl;
  assertStableLegacyApprovalDirectory(dir, dirStats, realDir);
  return { projection, sha256: hashLegacyGhostApprovalProjection(projection) };
}

function hashInstalledReapprovalProjection(
  projection: InstalledReapprovalProjection,
): string {
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        version: 1,
        manifest: projection.manifest,
        trust: projection.trust,
        localeResources: projection.localeResources,
        iconDataUrl: projection.iconDataUrl ?? null,
        skillContentSha256: projection.skillContentSha256,
      }),
    )
    .digest('hex');
}

/**
 * `runExclusiveMutation` 回调内唯一可用的嵌套 mutation capability。
 * capability 在回调结束后立即失效，避免调用者绕过串行 lane 或复用旧 owner 上下文。
 */
export interface GhostExclusiveMutation {
  writeDisabledMarker(id: string): void;
  publishTrustedBundledSeed(
    id: string,
    sourceDir: string,
    options: {
      disabled: boolean;
      trust?: typeof CINDY_OFFICIAL_GHOST_TRUST;
    },
  ): Promise<void>;
  approveTrustedBundledInstall(
    manifest: GhostManifest,
    markerEnabled: boolean,
    options: { sourceDir: string },
  ): Promise<boolean>;
  removeInstallApproval(id: string): Promise<boolean>;
  uninstall(id: string, options?: GhostUninstallOptions): Promise<UninstallResult>;
}

/**
 * 区分“包本身坏了”和“包使用了更新版 Cindy 才认识的契约”。
 *
 * 这里只收窄识别两个可证明是 Host 版本差异的形状：未来 schemaVersion，或
 * 字符串形态的未知 capability slot。其它畸形输入仍交给完整 manifest 校验，
 * 不能借友好提示放松安装安全边界。
 */
export function ghostManifestHostUnsupportedReason(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (
    typeof record.schemaVersion === 'number' &&
    Number.isInteger(record.schemaVersion) &&
    record.schemaVersion > 2
  ) {
    return `插件使用了更新的清单格式(schemaVersion ${record.schemaVersion})`;
  }
  if (!Array.isArray(record.slots)) return null;
  const supported = new Set<string>([...GHOST_SLOTS, 'model']);
  const unknown = [
    ...new Set(record.slots.filter((slot): slot is string => typeof slot === 'string')),
  ].filter((slot) => !supported.has(slot));
  return unknown.length > 0 ? `插件需要当前 Cindy 尚不支持的能力:${unknown.join(' / ')}` : null;
}

/**
 * 插件仓库的 main 端管理者:一个插件一个内容目录(rootDir/<id>/)，Host
 * receipt 才是 manifest / trust / enabled / revision 的授权事实。
 *
 * 设计要点:
 * - **目录只证明在装**:list() 实扫内容目录，但批准状态来自安装根之外的
 *   receipt；旧安装没有 receipt 时保持不可运行，更新需完整重新确认；
 * - **装载先落 staging 再切正式**(对齐 skillhub/installService 的做法):
 *   解压全程发生在 `.cindy-installing-*` 临时目录,校验全过才 rename 到
 *   rootDir/<id>,任何一步失败都不会留下半截安装;
 * - **防 zip 三件套**:条目数 / 解压总量上限防 zip bomb,路径归一化 +
 *   越界检查防 zip-slip(压缩包里的 ../ 路径跳不出 staging);
 * - **卸载防御**:id 先过格式校验(shared/ghost 同一份规则),再确认
 *   目标是 rootDir 的直接子目录,杜绝借 id 删任意路径。
 */
export class GhostManager {
  private readonly receiptStore: GhostInstallReceiptStore;
  private ownerContextKey: string;
  private mutationTail: Promise<void> = Promise.resolve();
  private activeMutationContext: {
    ownerContextKey: string;
    contentRoot: string;
    stateRoot: string;
  } | null = null;
  /**
   * 本进程内被判定"批准状态不可信"的插件 id。
   *
   * 用途只有一个:撤销陈旧批准**失败**时的兜底。撤销失败的成因(状态根不可写)与
   * 写批准失败的成因是同一个,所以不能再指望往状态根写任何东西来表达"已失效" ——
   * 内存标记是此时唯一还能用的机制。下次启动重新对账,成功即自愈;仍然失败就仍然
   * 隔离,始终 fail closed。
   */
  private readonly untrustedApprovals = new Set<string>();
  /** Owner namespaces whose mutation journal could not be authoritatively scanned. */
  private readonly recoveryBlockedApprovalNamespaces = new Set<string>();

  /**
   * 进程内隔离集合的键:以**当前 owner 的状态根**为命名空间。集合是 manager 级
   * 单例、owner 切换不重建 —— 裸用 id 会让 A 账号的隔离污染 B 账号的同 id 插件
   * (B 无辜被投影成 invalid);而切换边界时清空集合又是反方向的 fail open
   * (切回 A 时隔离丢失,盘上陈旧 receipt 复活)。按状态根命名空间两头都对:
   * B 的键不命中,切回 A 键重新命中、隔离持续到自愈。
   */
  private isolationKey(id: string): string {
    return `${this.receiptStore.rootDir()}\u0000${id}`;
  }

  constructor(private readonly options: GhostManagerOptions) {
    this.receiptStore = new GhostInstallReceiptStore(
      () => this.stateRootDir(),
      this.options.mutateSnapshot,
    );
    const contentRoot = this.resolveContentRoot();
    const stateRoot = this.resolveStateRoot();
    this.assertDisjointRoots(contentRoot, stateRoot);
    this.ownerContextKey = this.currentOwnerContextKey();
    this.recoverInterruptedMutationsSync();
  }

  private resolveContentRoot(): string {
    // 返回 realpath:state/content root 可以位于 symlinked 祖先之下(重定位的
    // Home/AppData),而 bounded 读取的 containWithin 必须是 realpath 产物,
    // 否则合法文件会被判在根外而把已批准插件当成 invalid。
    return this.assertManagedRootPath(
      path.resolve(this.options.getRootDir()),
      'ghost content root',
    );
  }

  private resolveStateRoot(): string {
    if (this.options.getStateDir) {
      return this.assertManagedRootPath(
        path.resolve(this.options.getStateDir()),
        'ghost approval state root',
      );
    }
    const root = this.resolveContentRoot();
    return this.assertManagedRootPath(
      path.join(path.dirname(root), `${path.basename(root)}-install-state`),
      'ghost approval state root',
    );
  }

  private contentRootDir(): string {
    return this.activeMutationContext?.contentRoot ?? this.resolveContentRoot();
  }

  private stateRootDir(): string {
    return this.activeMutationContext?.stateRoot ?? this.resolveStateRoot();
  }

  private assertDisjointRoots(contentRoot: string, stateRoot: string): void {
    const physicalContentRoot = this.assertManagedRootPath(contentRoot, 'ghost content root');
    const physicalStateRoot = this.assertManagedRootPath(stateRoot, 'ghost approval state root');
    if (
      isPathInsideDir(physicalContentRoot, physicalStateRoot) ||
      isPathInsideDir(physicalStateRoot, physicalContentRoot)
    ) {
      throw new Error('ghost install content and approval state roots must be disjoint');
    }
  }

  /**
   * Managed roots themselves must be real directories (or not exist yet), but their ancestors may
   * be links: relocated Home/AppData is a supported OS layout. Return a physical identity by
   * resolving the nearest existing ancestor so lexical aliases cannot bypass the disjointness gate.
   */
  private assertManagedRootPath(absPath: string, label: string): string {
    const resolved = path.resolve(absPath);
    try {
      const kind = classifyGhostDirEntrySync(resolved);
      if (kind !== 'directory') throw new Error(`${label} is not a real directory`);
      return fs.realpathSync.native(resolved);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    const missingSegments: string[] = [];
    let ancestor = resolved;
    while (true) {
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw new Error(`${label} has no existing directory ancestor`);
      missingSegments.unshift(path.basename(ancestor));
      ancestor = parent;
      try {
        const realAncestor = fs.realpathSync.native(ancestor);
        if (!fs.statSync(realAncestor).isDirectory()) {
          throw new Error(`${label} ancestor is not a directory`);
        }
        return path.join(realAncestor, ...missingSegments);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
    }
  }

  /**
   * The manager is retained by IPC closures, while owner-scoped roots are resolved
   * dynamically by the host. Re-run synchronous recovery whenever that namespace
   * changes before any list/mutation can consume the new owner's files.
   */
  private ensureCurrentOwnerContextSync(): void {
    if (this.activeMutationContext) return;
    const next = this.currentOwnerContextKey();
    if (next === this.ownerContextKey) return;
    this.assertDisjointRoots(this.resolveContentRoot(), this.resolveStateRoot());
    this.ownerContextKey = next;
    this.recoverInterruptedMutationsSync();
  }

  private currentOwnerContextKey(): string {
    return `${this.options.getOwnerContextKey?.() ?? ''}\u0000${this.resolveContentRoot()}\u0000${this.resolveStateRoot()}`;
  }

  private approvalNamespaceKey(): string {
    return this.activeMutationContext?.ownerContextKey ?? this.ownerContextKey;
  }

  /**
   * A journal scan failure cannot identify which installed id may be between
   * content publication and receipt commit. Quarantine every real installed id
   * for this owner until a later manager instance can complete recovery.
   */
  private quarantineAllInstalledApprovalsSync(): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.contentRootDir(), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || !isValidGhostId(entry.name)) continue;
      try {
        if (classifyGhostDirEntrySync(path.join(this.contentRootDir(), entry.name)) !== 'directory') {
          continue;
        }
      } catch {
        continue;
      }
      this.untrustedApprovals.add(this.isolationKey(entry.name));
    }
  }

  /**
   * 启动一次性:恢复装入/更新的"目录已 rename、receipt 还没写"崩溃现场。构造期同步跑
   * (目录极小,与 resolveGhostRepoRoot 的启动期迁移同一先例)。
   *
   * **事务标记(状态根内)是权威判据**:装入/更新在 rename 动盘前落标记、写完 receipt
   * 清标记,标记带本次 `packageSha256`。恢复时同步读 receipt,`receipt.packageSha256 ===
   * marker.packageSha256` 即"已提交":
   * - install 未提交 → finalDir 是不完整安装,删掉(否则迁移会把它当 legacy 收编,而
   *   崩溃窗口内 manifest 可能已被同权限进程改写 = 用户确认 A 却授权 B);已提交 → 保留;
   * - update 未提交 → 回滚到 backup(旧字节+旧 receipt 自洽);已提交 → 回收陈旧 backup。
   *   这修掉了"final 在位就删 backup"把"新字节+旧 receipt"固化成"按旧批准跑新代码"的洞。
   *
   * 无标记的孤儿 `.cindy-updating-*`(journal 之前的崩溃残留)沿用原启发式兜底:final
   * 缺位且唯一 backup → 搬回(§5 插件不得凭空消失);final 在位 → 陈旧 backup 回收。
   * `.cindy-installing-*` staging 残留一律回收(从未发布)。
   */
  private recoverInterruptedMutationsSync(): void {
    const root = this.contentRootDir();

    // 1) 标记驱动恢复(权威)。
    const handledBackupNames = new Set<string>();
    const blockedMutationIds = new Set<string>();
    const pendingScan = this.receiptStore.listPendingMutationIdsSync();
    if (pendingScan.state === 'unreadable') {
      this.recoveryBlockedApprovalNamespaces.add(this.approvalNamespaceKey());
      this.quarantineAllInstalledApprovalsSync();
      (this.options.log?.error ?? this.options.log?.warn)?.call(
        this.options.log,
        'ghost mutation journal root unreadable; skipped all recovery heuristics',
        { error: pendingScan.reason },
      );
      return;
    }
    let recoveryHeuristicsBlocked = false;
    if (pendingScan.blocked) {
      this.recoveryBlockedApprovalNamespaces.add(this.approvalNamespaceKey());
      this.quarantineAllInstalledApprovalsSync();
      recoveryHeuristicsBlocked = true;
      (this.options.log?.error ?? this.options.log?.warn)?.call(
        this.options.log,
        'invalid ghost mutation journal marker blocks orphan-backup heuristics',
      );
    } else {
      // The journal namespace is authoritative again. Known pending ids still
      // receive per-id isolation below if their individual recovery fails.
      this.recoveryBlockedApprovalNamespaces.delete(this.approvalNamespaceKey());
    }
    for (const id of pendingScan.ids) {
      const markerResult = this.receiptStore.readPendingMutationSync(id);
      const finalDir = path.join(root, id);
      if (markerResult.state === 'missing') continue;
      // A pending transaction means the receipt cannot authorize finalDir until
      // recovery proves commit/rollback and clears the marker.
      this.untrustedApprovals.add(this.isolationKey(id));
      if (markerResult.state !== 'valid') {
        blockedMutationIds.add(id);
        recoveryHeuristicsBlocked = true;
        (this.options.log?.error ?? this.options.log?.warn)?.call(
          this.options.log,
          'ghost mutation journal unavailable; left for manual/next-launch recovery',
          { id, state: markerResult.state, reason: markerResult.reason },
        );
        continue;
      }
      const marker = markerResult.mutation;
      try {
        if (marker.kind === 'uninstall') {
          // 卸载崩在半途:把批准与内容目录都删净(幂等,顺序无关)。撤批准已在卸载时
          // 先行,这里兜住"receipt 或目录仍残留"的任意组合 —— 收尾后该 id 干净消失。
          this.untrustedApprovals.add(this.isolationKey(id));
          if (marker.builtinTombstone) {
            if (!this.options.recordBuiltinTombstone) {
              throw new Error('builtin uninstall recovery has no tombstone writer');
            }
            this.options.recordBuiltinTombstone(id);
          }
          this.receiptStore.removeSync(id);
          if (this.recoveryEntryKind(finalDir) === 'directory') {
            fs.rmSync(finalDir, { recursive: true, force: true });
          }
        } else {
          const approval = this.receiptStore.readForRecovery(id);
          if (approval.state === 'unreadable') {
            blockedMutationIds.add(id);
            recoveryHeuristicsBlocked = true;
            (this.options.log?.error ?? this.options.log?.warn)?.call(
              this.options.log,
              'ghost approval receipt unreadable during recovery; journal retained',
              { id, kind: marker.kind, reason: approval.reason },
            );
            continue;
          }
          if (marker.kind === 'install') {
            // 未提交装入(无已批准 receipt)= 不完整安装,删 finalDir;有已批准 receipt = 完整
            // 安装,保留(绝不删有有效批准的插件)。只删真目录,junction/链接跳过(避免穿透)。
            const finalKind = this.recoveryEntryKind(finalDir);
            const receiptCommitted =
              approval.state === 'approved' &&
              (marker.receiptRevision !== undefined
                ? approval.receipt.revision === marker.receiptRevision
                : approval.receipt.packageSha256 === marker.packageSha256);
            const committed = receiptCommitted && finalKind === 'directory';
            if (receiptCommitted && finalKind !== 'directory') {
              throw new Error('committed install receipt has no published directory');
            }
            if (committed && marker.clearBuiltinTombstone) {
              if (!this.options.clearBuiltinTombstone) {
                throw new Error('builtin install recovery has no tombstone clearer');
              }
              this.options.clearBuiltinTombstone(id);
            }
            if (!committed && finalKind === 'directory') {
              fs.rmSync(finalDir, { recursive: true, force: true });
            }
          } else {
            handledBackupNames.add(marker.backupDirName);
            const backupPath = path.join(root, marker.backupDirName);
            const backupKind = this.recoveryEntryKind(backupPath);
            const finalKind = this.recoveryEntryKind(finalDir);
            const committed =
              approval.state === 'approved' &&
              finalKind === 'directory' &&
              (marker.receiptRevision !== undefined
                ? approval.receipt.revision === marker.receiptRevision
                : approval.receipt.packageSha256 === marker.packageSha256 &&
                  (marker.oldPackageSha256 !== undefined
                    ? marker.oldPackageSha256 !== marker.packageSha256
                    : marker.phase === 'published'));
            if (committed) {
              if (backupKind === 'directory') {
                fs.rmSync(backupPath, { recursive: true, force: true }); // 陈旧旧字节
              } else if (backupKind !== 'missing') {
                throw new Error('managed update backup is not a real directory');
              }
            } else {
              // 回滚:finalDir 可能是未提交新字节,删;backup 若在则搬回(旧字节+旧 receipt)。
              if (
                marker.receiptRevision !== undefined &&
                approval.state === 'approved' &&
                approval.receipt.revision === marker.receiptRevision &&
                finalKind !== 'directory'
              ) {
                throw new Error('committed update receipt has no published directory');
              }
              // A prepared (or legacy phase-less) marker with no backup means the
              // process crashed before final -> backup. Preserve the old final and
              // receipt instead of deleting valid installed bytes.
              if (backupKind === 'missing' && finalKind === 'directory') {
                if (marker.phase === 'prepared') {
                  this.receiptStore.clearPendingMutationSync(id);
                  this.untrustedApprovals.delete(this.isolationKey(id));
                  continue;
                }
                // A legacy v1 marker has no phase information. Preserve the
                // marker and block heuristics rather than guessing whether the
                // final bytes are old or newly published.
                throw new Error('managed update final present without backup at an unknown phase');
              }
              if (finalKind === 'directory') {
                fs.rmSync(finalDir, { recursive: true, force: true });
              } else if (finalKind !== 'missing') {
                throw new Error('managed update final is not a real directory');
              }
              if (backupKind === 'directory') {
                fs.renameSync(backupPath, finalDir);
              } else if (backupKind === 'missing') {
                // Neither side is available; keep the journal and receipt for a
                // later retry rather than deleting authorization state.
                throw new Error('managed update final and backup are both missing');
              } else {
                throw new Error('managed update backup is not a real directory');
              }
            }
          }
        }
        this.receiptStore.clearPendingMutationSync(id);
        this.untrustedApprovals.delete(this.isolationKey(id));
      } catch (err) {
        // 动盘失败:留着标记,下次启动幂等重试。
        blockedMutationIds.add(id);
        recoveryHeuristicsBlocked = true;
        (this.options.log?.error ?? this.options.log?.warn)?.call(
          this.options.log,
          'interrupted ghost mutation recovery failed; left for next launch',
          {
            id,
            kind: marker?.kind,
            error: err instanceof Error ? err.message : String(err),
          },
        );
      }
    }

    // Any unreadable/invalid journal means the state-root view is not authoritative.
    // Do not run unjournaled backup/staging heuristics in that condition.
    if (recoveryHeuristicsBlocked) return;

    // 2) 无标记的孤儿 backup + staging 残留。
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      return; // 根目录还不存在 = 没装过任何插件
    }
    const backups = entries.filter(
      (entry) => entry.name.startsWith('.cindy-updating-') && !handledBackupNames.has(entry.name),
    );
    for (const entry of backups) {
      const match = /^\.cindy-updating-(.+)-[0-9a-f]{8}$/.exec(entry.name);
      if (!match || !isValidGhostId(match[1])) continue;
      const id = match[1];
      if (blockedMutationIds.has(id)) continue;
      const backupPath = path.join(root, entry.name);
      try {
        if (classifyGhostDirEntrySync(backupPath) !== 'directory') continue;
      } catch {
        continue;
      }
      const finalDir = path.join(root, id);
      // 按解析后的 id 精确比对,不能用前缀 startsWith:合法 id 允许带 `-`,
      // `.cindy-updating-foo-<hex>` 是 `.cindy-updating-foo-bar-<hex>` 的前缀,
      // 若用前缀匹配,foo 与 foo-bar 同时留有 backup 时,foo 的唯一 backup 会被
      // 误统计成多个而判为"多备份,留待人工",崩溃后 foo 持续消失(评审 P1)。
      const siblings = backups.filter((other) => {
        const otherMatch = /^\.cindy-updating-(.+)-[0-9a-f]{8}$/.exec(other.name);
        return otherMatch !== null && otherMatch[1] === id;
      });
      let finalKind: GhostDirEntryKind | 'missing';
      try {
        finalKind = classifyGhostDirEntrySync(finalDir);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          finalKind = 'missing';
        } else {
          (this.options.log?.error ?? this.options.log?.warn)?.call(
            this.options.log,
            'interrupted-update final path unreadable; backup left untouched',
            { id, backup: entry.name, error: err instanceof Error ? err.message : String(err) },
          );
          continue;
        }
      }
      if (finalKind === 'directory') {
        try {
          fs.rmSync(backupPath, { recursive: true, force: true });
        } catch (err) {
          this.options.log?.warn('stale ghost update backup cleanup failed', {
            id,
            backup: entry.name,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        continue;
      }
      if (finalKind !== 'missing') {
        (this.options.log?.error ?? this.options.log?.warn)?.call(
          this.options.log,
          'interrupted-update final path is not a directory; backup left untouched',
          { id, backup: entry.name, finalKind },
        );
        continue;
      }
      if (siblings.length !== 1) {
        (this.options.log?.error ?? this.options.log?.warn)?.call(
          this.options.log,
          'multiple interrupted-update backups for one ghost; left untouched for manual recovery',
          {
            id,
            backups: siblings.map((other) => other.name),
          },
        );
        continue;
      }
      try {
        fs.renameSync(backupPath, finalDir);
        this.options.log?.info('ghost restored from interrupted update backup', { id });
      } catch (err) {
        (this.options.log?.error ?? this.options.log?.warn)?.call(
          this.options.log,
          'ghost interrupted-update recovery failed; plugin stays missing until manual recovery',
          {
            id,
            backup: entry.name,
            error: err instanceof Error ? err.message : String(err),
          },
        );
      }
    }
    for (const entry of entries) {
      if (!entry.name.startsWith('.cindy-installing-')) continue;
      try {
        fs.rmSync(path.join(root, entry.name), { recursive: true, force: true });
      } catch {
        // staging 残留清不掉只占磁盘,不影响正确性;下次启动再试。
      }
    }
  }

  /** `<root>/<id>` 是否真目录(非链接/junction;判据同 ghostContentTree,避免穿透删除)。 */
  private isRealDirChild(root: string, id: string): boolean {
    try {
      return classifyGhostDirEntrySync(path.join(root, id)) === 'directory';
    } catch {
      return false;
    }
  }

  /** Recovery distinguishes a missing path from transiently unreadable state. */
  private recoveryEntryKind(absPath: string): GhostDirEntryKind | 'missing' {
    try {
      return classifyGhostDirEntrySync(absPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
      throw error;
    }
  }

  /**
   * 从 `.cindy` 包的内存投影算技能字节指纹(P0-8)。
   *
   * 批准基线必须取自**用户确认过、且不可再被本机进程改写**的来源。旧写法在
   * staging→final 发布之后才从 finalDir 首读 —— publish 与首次 hash 之间被换掉的
   * SKILL.md 正文/辅助文件会同时成为 receipt 指纹与快照,后续校验全自洽,篡改被
   * 洗成批准事实。包投影(JSZip 内存条目)在 inspect 时已被 packageSha256 钉住、
   * 与用户确认的是同一份字节;据它算指纹后,发布后的目录漂移会在快照落盘对账时
   * 如实 fail closed(拒装),而不是被钉进批准。
   */
  private async hashSkillContentFromPackage(
    manifest: GhostManifest,
    allEntries: JSZip.JSZipObject[],
    prefix: string,
  ): Promise<Record<string, string>> {
    const items = manifest.skill?.items ?? [];
    if (items.length === 0) return {};
    const result: Record<string, string> = {};
    for (const item of items) {
      const itemPrefix = `${item.dir}/`;
      const files: { path: string; bytes: Buffer }[] = [];
      for (const entry of allEntries) {
        if (entry.dir) continue;
        const rel = entry.name.slice(prefix.length);
        if (!rel.startsWith(itemPrefix)) continue;
        files.push({ path: rel.slice(itemPrefix.length), bytes: await entry.async('nodebuffer') });
      }
      result[item.dir] = hashGhostContentBuffers(files);
    }
    return result;
  }

  /** Forge 等 Host 能力必须排除的受管根（内容根 + 批准状态根）。 */
  managedRootDirs(): string[] {
    return [this.contentRootDir(), this.receiptStore.rootDir()];
  }

  approvalStateRoot(): string {
    return this.receiptStore.rootDir();
  }

  /**
   * 启停投影:receipt 为主,安装目录 `.disabled` 镜像**只往停用方向覆盖**(读时合并)。
   *
   * 为什么在读侧合并而不是只信 receipt:停用必须永远能成功(规则 §3 收敛方向不对称)。
   * 状态根不可写时 `setEnabled(false)` 仍能写镜像;若 list() 只读 receipt,那次停用会在
   * 重启后静默复活 —— fail open。镜像只能把启停态往下拉,不能往上翻(重新启用只有
   * setEnabled(true) 成功写 receipt 一条路),与随包对账的合并规则同向。
   */
  private effectiveEnabled(dir: string, receiptEnabled: boolean): boolean {
    return receiptEnabled && !this.isDisabledMarkerPresentSync(dir);
  }

  /** Compatibility marker reads fail closed and never follow a link/non-regular entry. */
  private isDisabledMarkerPresentSync(dir: string): boolean {
    const marker = path.join(dir, DISABLED_MARKER_FILE);
    try {
      // A regular marker means disabled; any non-regular entry also fails closed.
      classifyGhostDirEntrySync(marker);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      return true;
    }
  }

  private writeDisabledMarkerSync(dir: string): void {
    if (classifyGhostDirEntrySync(dir) !== 'directory') {
      throw new Error('ghost disabled marker parent is not a real directory');
    }
    const marker = path.join(dir, DISABLED_MARKER_FILE);
    try {
      if (classifyGhostDirEntrySync(marker) !== 'file') {
        throw new Error('ghost disabled marker is not a regular file');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    fs.writeFileSync(marker, '');
  }

  /**
   * 读批准状态的**唯一入口**:进程内隔离优先于磁盘上的 receipt。
   *
   * 所有消费方(list / setEnabled / update 的 token 比对)都必须走这里 —— 各自直接
   * 调 receiptStore.read() 会让隔离在某条路径上失效,那类"同一判定散落多处"的分叉
   * 正是本 PR 前几轮反复出问题的原因。
   */
  private readApproval(id: string): GhostInstallReceiptReadResult {
    if (this.recoveryBlockedApprovalNamespaces.has(this.approvalNamespaceKey())) {
      return { state: 'invalid', reason: 'ghost mutation journal namespace is unreadable' };
    }
    if (this.untrustedApprovals.has(this.isolationKey(id))) {
      return { state: 'invalid', reason: '批准状态已被判定不可信(撤销失败)' };
    }
    return this.receiptStore.read(id);
  }

  /**
   * 技能链接对账前重新核验批准快照。
   *
   * `list()` 是首帧同步 API,不能在里面流式重算目录摘要；因此由异步 reconciler
   * 对每个准备挂链的插件调用本入口。receipt revision 若已变化、快照缺失/不可读、
   * 含非普通条目或字节不符一律 false,让对账器撤掉已有链接并拒绝新建。
   */
  async verifyApprovedSkillSnapshot(ghost: InstalledGhost): Promise<boolean> {
    this.ensureCurrentOwnerContextSync();
    if (
      ghost.approval.state !== 'approved' ||
      !ghost.manifest.skill?.items.length ||
      !ghost.approvedSkillRoot
    ) {
      return false;
    }
    const current = this.readApproval(ghost.manifest.id);
    if (current.state !== 'approved' || current.receipt.revision !== ghost.approval.revision) {
      return false;
    }
    const expectedRoot = this.receiptStore.skillSnapshotRoot(
      current.receipt.id,
      current.receipt.revision,
    );
    if (path.resolve(ghost.approvedSkillRoot) !== path.resolve(expectedRoot)) {
      return false;
    }
    return this.receiptStore.skillSnapshotMatchesReceipt(current.receipt, expectedRoot);
  }

  /**
   * Serialize content-directory and approval-receipt mutations as one Host transaction lane.
   * The owner generation and both roots are captured after queue wait and remain fixed for the
   * whole callback, so a concurrent session commit cannot redirect later awaits into another
   * owner's namespace.
   */
  async runExclusiveMutation<T>(
    operation: (mutation: GhostExclusiveMutation) => Promise<T>,
  ): Promise<T> {
    this.ensureCurrentOwnerContextSync();
    const queuedOwnerContextKey = this.ownerContextKey;
    const previous = this.mutationTail;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.mutationTail = previous.then(() => gate);
    await previous;
    let capabilityActive = true;
    try {
      const currentOwnerContextKey = this.currentOwnerContextKey();
      if (
        this.ownerContextKey !== queuedOwnerContextKey ||
        currentOwnerContextKey !== queuedOwnerContextKey
      ) {
        throw new Error('ghost owner context changed while mutation was queued');
      }
      const contentRoot = this.resolveContentRoot();
      const stateRoot = this.resolveStateRoot();
      this.assertDisjointRoots(contentRoot, stateRoot);
      this.activeMutationContext = {
        ownerContextKey: currentOwnerContextKey,
        contentRoot,
        stateRoot,
      };
      const assertCapabilityActive = (): void => {
        if (
          !capabilityActive ||
          this.activeMutationContext?.ownerContextKey !== currentOwnerContextKey
        ) {
          throw new Error('ghost exclusive mutation capability is no longer active');
        }
      };
      const mutation: GhostExclusiveMutation = {
        writeDisabledMarker: (id) => {
          assertCapabilityActive();
          if (!isValidGhostId(id) || !this.isRealDirChild(this.contentRootDir(), id)) {
            throw new Error('ghost disabled marker target is not a managed plugin directory');
          }
          this.writeDisabledMarkerSync(path.join(this.contentRootDir(), id));
        },
        publishTrustedBundledSeed: async (id, sourceDir, options) => {
          assertCapabilityActive();
          await this.publishTrustedBundledSeedUnlocked(id, sourceDir, options);
        },
        approveTrustedBundledInstall: async (manifest, markerEnabled, options) => {
          assertCapabilityActive();
          return this.approveTrustedBundledInstallUnlocked(manifest, markerEnabled, options);
        },
        removeInstallApproval: async (id) => {
          assertCapabilityActive();
          return this.removeInstallApprovalUnlocked(id);
        },
        uninstall: async (id, options = {}) => {
          assertCapabilityActive();
          return this.uninstallUnlocked(id, options);
        },
      };
      return await operation(mutation);
    } finally {
      capabilityActive = false;
      this.activeMutationContext = null;
      release();
    }
  }

  /**
   * 一次性 legacy backfill 迁移(docs/dev-rules/plugin-security-and-authoring.md 第 5 节
   * 红线的落地)。#1080 把授权事实从可变安装目录搬到 Host receipt,升级前装的插件没有
   * receipt —— 若不迁移,它们会一律落到 `legacy-unapproved`、被列停用、要用户逐个重新
   * 确认(这正是 #1080 被回滚的原因)。这里从旧的三份事实源(`ghost.json` /
   * `.cindy-trust.json` / `.disabled`)重建等价 receipt,让存量插件升级后**无感可用**。
   *
   * 三条不变量:
   * - **全局一次性**:状态根有迁移 ledger 即视为已迁过,此后缺 receipt 一律 fail closed,
   *   不再迁。理由见 `GhostLegacyMigrationLedger` 头注释(否则删 receipt 就能骗一次
   *   "从可变安装目录重建授权")。
   * - **不扩权、不等于新确认**:receipt 权限集 = 当前 `ghost.json` 声明,等价于旧模型
   *   无条件授权的那一组;此后任何 manifest/权限变化照旧走完整确认(update 流程不变)。
   * - **只写状态根、绝不动安装目录**:三份旧文件原样保留,因此回滚到旧客户端时它照旧
   *   从安装目录判定启停,不会错位(§5 兜底第 4 条 回滚余地)。
   *
   * 随包种子 id 跳过 —— 它们走 provisioning 的 `approveTrustedBundledInstall`(有权威
   * 字节可比,是更强的迁移形态)。
   */
  async migrateLegacyApprovalsOnce(): Promise<{
    migrated: string[];
    skipped: string[];
    failed: string[];
    retryPending: string[];
  }> {
    return this.runExclusiveMutation(() => this.migrateLegacyApprovalsUnlocked());
  }

  /** True only while the durable migration ledger still carries retry work. */
  hasPendingLegacyApprovalMigration(): boolean {
    return this.receiptStore.readMigrationLedger()?.state === 'in-progress';
  }

  private async migrateLegacyApprovalsUnlocked(): Promise<{
    migrated: string[];
    skipped: string[];
    failed: string[];
    retryPending: string[];
  }> {
    const result = {
      migrated: [] as string[],
      skipped: [] as string[],
      failed: [] as string[],
      retryPending: [] as string[],
    };
    // 一次性门(状态机见 GhostLegacyMigrationLedger 头注释),判据缺一不可:
    // 1) 台账 completed(或存在但读不出)= 迁过,不再迁;in-progress = 上一轮中途
    //    崩溃,按钉死的 pendingIds 续跑 —— receipt 首写自动落台账的守卫(见
    //    receiptStore.write)只在"完全没有台账"时动笔,不会把 in-progress 焊死。
    // 2) 首轮必须先扫描完整安装根,不能因**任意一个**有效 receipt 提前关门。#1080
    //    曾经写出 receipt 却没有 migration ledger；那类历史 mixed 状态里 A 已批准、B
    //    仍是 legacy，提前 completed 会让 B 永久失效。新代码通过 receipt 提交前先写
    //    ledger 保证不再自然产生这种状态；能删 ledger 的状态根写者本就能伪造 receipt，
    //    不属于安装根可变这一条威胁模型新增的能力。
    // 之所以"安装根为空/未诞生时不落台账":为 owner 命名空间的 legacy 恢复流程留门
    // (它会在之后才把旧目录搬进来);这个留门被"装一个插件→删 receipt"利用的路由
    // 第 2 道判据 + receipt 首写自动落台账挡住。
    if (this.receiptStore.migrationDoorClosed()) {
      if (this.receiptStore.hasMigrationLedger() && !this.receiptStore.readMigrationLedger()) {
        // 台账存在但读不出:门保守关死(成因与保守方向见 migrationDoorClosed 注释),
        // 但这必须可观测 —— 它意味着状态根被外力改写过。
        (this.options.log?.error ?? this.options.log?.warn)?.call(
          this.options.log,
          'legacy migration ledger unreadable; migration door kept closed',
          { path: this.receiptStore.rootDir() },
        );
      }
      return result;
    }
    const resumeLedger = this.receiptStore.readMigrationLedger();
    const resumePending =
      resumeLedger?.state === 'in-progress' ? new Set(resumeLedger.pendingIds ?? []) : null;
    const resumeApprovalProjectionDigest =
      resumeLedger?.recoveryApprovalProjectionSha256ById ?? undefined;

    const root = this.contentRootDir();
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        // 安装根未诞生:全新用户,或 legacy 恢复流程还没把旧目录搬进来。没有可迁
        // 对象,也**不写台账** —— 门要给随后搬入的旧目录留着(见头注释)。
        // (in-progress 续跑轮走不到这里出 ENOENT 的话,门保持 in-progress,下轮再试。)
        return result;
      }
      // EACCES/EIO 等真实故障:本轮放弃且不改台账,下次启动重试。吞掉错误照写
      // 台账会把迁移永久封死在一次环境抖动上。
      throw err;
    }

    // 先收候选、后动笔:in-progress 台账必须在**首个 backfill 之前**原子落盘,
    // 否则第一份 receipt 的自动落账守卫就会把门写成 completed,中途崩溃即焊死。
    const candidates: string[] = [];
    const blockedByPendingJournal: string[] = [];
    const unreadableReceiptIds: string[] = [];
    const preMigrated: string[] = [];
    let sawApprovedNonBundledInstall = false;
    // 续跑只对白名单内、且本轮仍可观察到的对象建重试队列；已消失的目录视为
    // 已被卸载/清理，不应把全局迁移门永久卡在一个不存在的 id 上。
    const pendingForRetry = new Set<string>();
    for (const entry of entries) {
      const id = entry.name;
      if (id.startsWith('.') || !isValidGhostId(id)) continue;
      // 判据走 ghostContentTree(lstat 分类),不信 Dirent 类型位:根子项是 junction/
      // 链接时一律不进迁移,也与 §3「只有真目录才算安装」同向。
      if (classifyGhostDirEntrySync(path.join(root, id)) !== 'directory') continue;
      // 随包种子交给 provisioning,不在迁移范围。
      if (this.options.isTrustedBundledId?.(id)) {
        result.skipped.push(id);
        continue;
      }
      // 续跑轮只认动笔前钉死的清单:清单外的 id(迁移窗口期间新装再删 receipt 的)
      // 骗不到续跑重铸,保持 fail closed。
      if (resumePending && !resumePending.has(id)) {
        result.skipped.push(id);
        continue;
      }
      const approval = this.receiptStore.readForRecovery(id);
      if (approval.state === 'approved') {
        sawApprovedNonBundledInstall = true;
        // 首轮:迁移前不该有,防御性跳过。续跑轮:上一轮崩溃前已写出的 receipt,
        // 计入 migrated 让最终台账如实反映"这些是迁移铸出的"。
        (resumePending ? preMigrated : result.skipped).push(id);
        pendingForRetry.delete(id);
        continue;
      }
      if (approval.state === 'unreadable') {
        // 暂时读不动批准事实不等于 legacy。尤其不能把它放进普通 pendingIds:
        // 若 receipt 随后消失，续跑会把可变安装目录误当成旧授权事实重新铸批准。
        // 记为确定性 fail-closed 审计项；原 receipt 恢复可读时仍自然生效，真的丢失
        // 则只能走完整重新批准，不能自动 backfill。
        result.failed.push(id);
        pendingForRetry.delete(id);
        unreadableReceiptIds.push(id);
        this.options.log?.warn('legacy migration found an unreadable receipt; automatic backfill blocked', {
          id,
          reason: approval.reason,
        });
        continue;
      }
      // 有未清的事务标记 = 一次装入/更新崩在半途、启动恢复还没收干净(通常恢复已在
      // 构造期把它清掉,这里兜住"恢复删 finalDir 失败"的残留)。绝不迁移这种目录 ——
      // 它的字节来源不是"用户确认过的旧安装",而是一次未完成事务的中间态。
      if (this.hasPendingMutationJournal(id)) {
        result.skipped.push(id);
        blockedByPendingJournal.push(id);
        continue;
      }
      // Per-id 迁移标记:新模型 receipt 落账时同步写入。无 receipt 但有标记 = 新模型
      // 安装后 receipt 被删,不是 legacy —— 绝不从可变安装目录重铸批准。
      if (this.receiptStore.hasMigrationMarker(id)) {
        result.skipped.push(id);
        continue;
      }
      candidates.push(id);
    }

    if (
      candidates.length === 0 &&
      !resumePending &&
      blockedByPendingJournal.length === 0 &&
      unreadableReceiptIds.length === 0
    ) {
      // 历史 mixed 状态若只剩有效的非随包 receipt，补写 completed 收口；空目录或
      // 只有随包目录仍不落台账，给 owner legacy 恢复流程留门。
      if (sawApprovedNonBundledInstall) {
        await this.receiptStore.writeMigrationLedger({
          version: 1,
          migratedAt: new Date().toISOString(),
          migratedIds: [],
          state: 'completed',
        });
      }
      return result;
    }
    if (
      resumePending ||
      candidates.length > 0 ||
      blockedByPendingJournal.length > 0 ||
      unreadableReceiptIds.length > 0
    ) {
      const checkpointPendingIds = [
        ...new Set([...candidates, ...blockedByPendingJournal]),
      ].sort();
      const checkpointFailedIds = [
        ...new Set([...(resumeLedger?.failedIds ?? []), ...unreadableReceiptIds]),
      ].sort();
      await this.receiptStore.writeMigrationLedger({
        version: 1,
        migratedAt: new Date().toISOString(),
        migratedIds: [...new Set([...(resumeLedger?.migratedIds ?? []), ...preMigrated])].sort(),
        state: checkpointPendingIds.length > 0 ? 'in-progress' : 'completed',
        ...(checkpointPendingIds.length > 0 ? { pendingIds: checkpointPendingIds } : {}),
        ...(checkpointFailedIds.length > 0 ? { failedIds: checkpointFailedIds } : {}),
        ...(checkpointPendingIds.length > 0 && resumeApprovalProjectionDigest
          ? {
              recoveryApprovalProjectionSha256ById: Object.fromEntries(
                Object.entries(resumeApprovalProjectionDigest).filter(([id]) =>
                  checkpointPendingIds.includes(id)),
              ),
            }
          : {}),
      });
    }

    for (const id of candidates) {
      try {
        const migrated = await this.backfillLegacyApproval(path.join(root, id), id, {
          expectedApprovalProjectionSha256:
            resumeApprovalProjectionDigest?.[id],
        });
        (migrated ? result.migrated : result.skipped).push(id);
        pendingForRetry.delete(id);
      } catch (err) {
        // 错误分类决定这个 id 的余生,不能一锅端:
        // - 带 errno 的环境错(EACCES/ENOSPC/EBUSY…,状态根写不动、文件被占等)是
        //   **瞬时**故障,不属于 §5 的"旧事实读不出/自相矛盾" —— 记 retryPending,
        //   台账停在 in-progress,下次启动自动续跑;写进 completed 的 failedIds 会把
        //   一次环境抖动永久封成"需要人工重新确认"。
        // - 无 errno 的校验错(manifest 不合法、技能目录含链接、locale 装入后损坏)
        //   与 ENOENT(声明的文件缺失 = 内容状态,不是抖动)是**确定性**内容无效,
        //   记 failed、fail closed,走每插件恢复 UI。
        const transient = isTransientBackfillError(err);
        if (transient) {
          result.retryPending.push(id);
          pendingForRetry.add(id);
          this.options.log?.warn(
            'legacy ghost approval migration hit transient IO; will retry next launch',
            {
              id,
              code: (err as NodeJS.ErrnoException | null)?.code,
              error: err instanceof Error ? err.message : String(err),
            },
          );
        } else {
          result.failed.push(id);
          pendingForRetry.delete(id);
          this.options.log?.warn('legacy ghost approval migration failed; kept fail-closed', {
            id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    // 收尾状态机(原子改写):
    // - 有瞬时失败 → 台账停在 in-progress,pendingIds = 仅剩的重试对象,下次启动
    //   自动续跑(§5 兜底第 1 条"能自动就别打扰用户");确定性 failed 不进 pendingIds,
    //   续跑白名单挡住"迁移窗口期间新装再删 receipt"的老路。
    // - 全部落定(只剩确定性 failed 或全成功)→ completed;续跑轮把上一轮已记的
    //   failedIds 一并带上,台账始终如实反映全量。
    const migratedIds = [...new Set([...result.migrated, ...preMigrated])].sort();
    const failedIds = [...new Set([...result.failed, ...(resumeLedger?.failedIds ?? [])])].sort();
    for (const id of blockedByPendingJournal) pendingForRetry.add(id);
    const retryIds = [...pendingForRetry].sort();
    // Preserve frozen recovery digests for pending ids that still need retry.
    // The generic retry path (migrateLegacyApprovalsOnce) reads these back
    // and passes expectedApprovalProjectionSha256 to backfillLegacyApproval.
    const nextRecoveryDigests =
      retryIds.length > 0 && resumeLedger?.recoveryApprovalProjectionSha256ById
        ? Object.fromEntries(
            Object.entries(resumeLedger.recoveryApprovalProjectionSha256ById).filter(
              ([id]) => pendingForRetry.has(id),
            ),
          )
        : undefined;
    await this.receiptStore.writeMigrationLedger({
      version: 1,
      migratedAt: new Date().toISOString(),
      migratedIds,
      ...(retryIds.length > 0
        ? {
            state: 'in-progress' as const,
            pendingIds: retryIds,
            ...(nextRecoveryDigests && Object.keys(nextRecoveryDigests).length > 0
              ? { recoveryApprovalProjectionSha256ById: nextRecoveryDigests }
              : {}),
          }
        : { state: 'completed' as const }),
      ...(failedIds.length > 0 ? { failedIds } : {}),
    });
    if (result.migrated.length > 0) this.options.onChanged?.(this.list());
    return result;
  }

  /**
   * legacy 恢复流程(owner 命名空间认领旧布局目录)专用的 backfill 旁路。
   *
   * 为什么允许绕过一次性 ledger 门:`ids` 来自恢复流程**刚从旧布局根搬进安装根**的
   * 目录 —— 这个来源本身就是旧世界的授权事实(与首轮迁移同一信任级),不是可变安装
   * 目录里凭空冒出来的目录。调用方只传本次恢复实际搬动/新增的 id;逐 id 仍然只在
   * 没有有效 receipt 时 backfill,随包 id 照旧交给 provisioning。结果并进 ledger,
   * 事后可分辨来源。
   */
  /**
   * 有未清事务标记 = 一次装入/更新崩在半途、启动恢复还没收干净。任何会**写 receipt**
   * 的入口(主迁移、legacy backfill、用户重新确认)都必须让路:绝不对一次未完成事务的
   * 中间态字节铸出批准 —— 否则 journal 之后的恢复会回滚字节却留下这份 receipt/技能快照,
   * 形成永不自愈的错位授权(约束 B-2/B-5/I-1)。journal 由启动恢复负责收敛,收敛后这些
   * 入口自然放行;若恢复被卡死,退出通道由批量恢复入口负责(见约束文档 §8 已知项),
   * 而不是靠这里对中间态铸批准。
   */
  private hasPendingMutationJournal(id: string): boolean {
    return this.receiptStore.readPendingMutationSync(id).state !== 'missing';
  }

  async backfillRecoveredLegacyGhosts(
    ids: readonly string[],
    options: {
      includePending?: boolean;
      expectedApprovalProjectionSha256ById: Readonly<Record<string, string>>;
    },
  ): Promise<{ migrated: string[]; failed: string[]; pending?: string[] }> {
    return this.runExclusiveMutation(async () => {
      const out = { migrated: [] as string[], failed: [] as string[] };
      const retryIds: string[] = [];
      const root = this.contentRootDir();
      const hasLedger = this.receiptStore.hasMigrationLedger();
      const prev = this.receiptStore.readMigrationLedger();
      if (hasLedger && !prev) {
        throw new Error('legacy migration ledger exists but is unreadable; recovery queue preserved');
      }
      const pendingForRetry = new Set(prev?.pendingIds ?? []);
      const permanentlyBlockedIds = new Set(prev?.failedIds ?? []);
      const workIds = [...new Set(ids)].filter(
        (id): id is string =>
          isValidGhostId(id) &&
          this.options.isTrustedBundledId?.(id) !== true &&
          !permanentlyBlockedIds.has(id),
      );
      // Persist the complete recovery work queue before the first backfill. If the
      // first receipt write or subsequent processing crashes, receiptStore.write()
      // cannot auto-close the migration door and the remaining ids are still durable.
      // Frozen digests are persisted alongside pending ids so that the generic
      // retry path in migrateLegacyApprovalsOnce can verify content hasn't changed.
      const queuedIds = [...new Set([...pendingForRetry, ...workIds])].sort();
      const hadQueuedWork = queuedIds.length > 0;
      if (queuedIds.length > 0) {
        await this.receiptStore.writeMigrationLedger({
          version: 1,
          migratedAt: prev?.migratedAt ?? new Date().toISOString(),
          migratedIds: prev?.migratedIds ?? [],
          ...(prev?.failedIds?.length ? { failedIds: prev.failedIds } : {}),
          state: 'in-progress',
          pendingIds: queuedIds,
          recoveryApprovalProjectionSha256ById: (() => {
            // Merge carried-over digests from the previous ledger with the current
            // call's frozen digests. A later recovery pass for a different id must
            // not drop older digests, or the generic retry path will backfill without
            // the pre-rename baseline.
            const merged: Record<string, string> = {
              ...prev?.recoveryApprovalProjectionSha256ById,
            };
            for (const id of queuedIds) {
              const current = options.expectedApprovalProjectionSha256ById[id];
              if (current !== undefined) merged[id] = current;
            }
            return merged;
          })(),
        });
        for (const id of queuedIds) pendingForRetry.add(id);
      }
      for (const id of workIds) {
        const approval = this.receiptStore.readForRecovery(id);
        if (approval.state === 'approved') {
          pendingForRetry.delete(id);
          continue;
        }
        if (approval.state === 'unreadable') {
          // This id demonstrably had a receipt, so it is not eligible for legacy
          // auto-approval. Keeping it in pendingIds would let a later receipt
          // deletion turn mutable installed bytes into a new authorization fact.
          out.failed.push(id);
          pendingForRetry.delete(id);
          this.options.log?.warn('recovered legacy receipt unreadable; automatic backfill blocked', {
            id,
            reason: approval.reason,
          });
          continue;
        }
        if (this.hasPendingMutationJournal(id)) {
          // 与主迁移循环 candidates 阶段同一道闸:恢复未收敛前绝不对中间态字节铸批准,
          // 留在重试队列,等启动恢复收敛 journal 后下一轮再处理。
          retryIds.push(id);
          pendingForRetry.add(id);
          this.options.log?.warn('recovered legacy ghost has an unsettled mutation journal; will retry', {
            id,
          });
          continue;
        }
        try {
          const targetDir = path.join(root, id);
          const expectedApprovalProjectionSha256 =
            options.expectedApprovalProjectionSha256ById[id];
          if (expectedApprovalProjectionSha256 === undefined) {
            throw new Error(`recovered legacy approval projection is missing or invalid: ${id}`);
          }
          if (!/^[a-f0-9]{64}$/.test(expectedApprovalProjectionSha256)) {
            throw new Error(`recovered legacy approval projection is missing or invalid: ${id}`);
          }
          if (
            await this.backfillLegacyApproval(targetDir, id, {
              expectedApprovalProjectionSha256,
            })
          ) {
            out.migrated.push(id);
          }
          pendingForRetry.delete(id);
        } catch (err) {
          // 与主迁移循环同一分类:瞬时 IO 抖动不记 failed(否则写进 completed 台账就
          // 把一次环境抖动永久封成"需要人工重新确认"),只记日志、留待下次恢复触发重试;
          // 确定性内容无效才 fail closed。
          if (isTransientBackfillError(err)) {
            retryIds.push(id);
            pendingForRetry.add(id);
            this.options.log?.warn('recovered legacy ghost backfill hit transient IO; will retry', {
              id,
              error: err instanceof Error ? err.message : String(err),
            });
          } else {
            out.failed.push(id);
            pendingForRetry.delete(id);
            this.options.log?.warn('recovered legacy ghost backfill failed; kept fail-closed', {
              id,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }
      if (
        hadQueuedWork ||
        out.migrated.length > 0 ||
        out.failed.length > 0 ||
        retryIds.length > 0 ||
        pendingForRetry.size > 0
      ) {
        const failedIds = [...new Set([...(prev?.failedIds ?? []), ...out.failed])].sort();
        await this.receiptStore.writeMigrationLedger({
          version: 1,
          migratedAt: new Date().toISOString(),
          migratedIds: [...new Set([...(prev?.migratedIds ?? []), ...out.migrated])].sort(),
          ...(failedIds.length > 0 ? { failedIds } : {}),
          // 旁路 backfill 的瞬时失败也必须进入持久化 work queue；目录已经搬入安装根，
          // 下一轮不会再次出现在”刚恢复”清单里，不能只靠内存日志重试。
          // 同时钉死恢复冻结的批准投影摘要，确保重试时内容未变。
          state: pendingForRetry.size > 0 ? 'in-progress' : 'completed',
          ...(pendingForRetry.size > 0
            ? {
                pendingIds: [...pendingForRetry].sort(),
                recoveryApprovalProjectionSha256ById: (() => {
                  // Merge carried-over digests from the previous ledger with the
                  // current call's frozen digests. An id pending from a prior
                  // recovery pass won't appear in options but must retain its
                  // pre-rename baseline for the generic retry path.
                  const merged: Record<string, string> = {
                    ...prev?.recoveryApprovalProjectionSha256ById,
                  };
                  for (const id of pendingForRetry) {
                    const current = options.expectedApprovalProjectionSha256ById[id];
                    if (current !== undefined) merged[id] = current;
                  }
                  return Object.fromEntries(
                    [...pendingForRetry]
                      .filter((id) => merged[id] !== undefined)
                      .map((id) => [id, merged[id]]),
                  );
                })(),
              }
            : {}),
        });
      }
      if (out.migrated.length > 0) this.options.onChanged?.(this.list());
      const pending = [...new Set(retryIds)].sort();
      return options.includePending && pending.length > 0 ? { ...out, pending } : out;
    });
  }

  /**
   * 从旧安装目录的三份事实源重建一份等价 receipt。返回是否真的写了 receipt。
   *
   * 分级 fail 策略(对齐 §5"读不出核心事实才 fail closed,展示元数据缺失则降级"):
   * - `ghost.json` 读不出/不合法 → 抛错 → 调用方计入 failed、保持 fail closed;
   * - `.disabled` 镜像 → 旧模型的启停事实(不存在=启用);
   * - `.cindy-trust.json` 缺失/损坏 → 保守 `unverified`(展示信号,能力由 slot 授予);
   * - locale 声明存在但文件损坏 → 抛错 → fail closed。装入流程本就逐个校验声明的
   *   locale、不合格拒装(见 `install` 里 `locale 文件不合格` 分支),所以旧安装天然不含
   *   坏 locale;迁移时读到坏 locale 只可能是**装入后被损坏**,属 §5 的"自相矛盾即
   *   fail closed",也与 receipt「localeResources 键集必须等于 manifest.locales」的
   *   不变量一致(跳过坏 locale 会写出被 validateReceipt 拒绝的 receipt);
   * - `packageSha256` **不算**(它是 audit-only、运行期不消费,见 §7);省掉它让迁移更快、
   *   更不会因安装目录里的异常条目误伤——真正的运行期判据 `skillContentSha256` 仍逐字节算,
   *   技能目录含链接等异常会在那里如实 fail closed。
   */
  private async backfillLegacyApproval(
    dir: string,
    id: string,
    options: { expectedApprovalProjectionSha256?: string } = {},
  ): Promise<boolean> {
    const { projection, sha256 } = await readLegacyGhostApprovalProjection(dir, id);
    if (
      options.expectedApprovalProjectionSha256 !== undefined &&
      sha256 !== options.expectedApprovalProjectionSha256
    ) {
      throw new Error('legacy approval projection changed after recovery discovery');
    }

    await this.receiptStore.write(
      createGhostInstallReceipt({
        manifest: projection.manifest,
        localeResources: projection.localeResources,
        enabled: projection.enabled,
        trust: projection.trust,
        skillContentSha256: projection.skillContentSha256,
        ...(projection.iconDataUrl !== undefined ? { iconDataUrl: projection.iconDataUrl } : {}),
      }),
      { skillSourceDir: dir },
    );
    this.options.log?.info('legacy ghost approval migrated', {
      id,
      enabled: projection.enabled,
      trustLevel: projection.trust.level,
      origin: 'legacy-migration',
    });
    return true;
  }

  /**
   * 「从已装目录重新确认」第一步:只读出确认卡需要的事实,零副作用。
   *
   * 这是本地包批准丢失(一次性迁移之后 receipt 又损坏/被删)时的第三条恢复路径 ——
   * 不用用户翻出原始 `.cindy` 文件,也不自动放行:字节从已装目录读,权限清单在确认卡
   * 上**全量**展示(无批准基线,全部按新增项列),用户逐条看过点确认才开 receipt。
   * 本地 `.cindy` 的运行字节本来就一直从这个可变目录现读(§7 登记),两条恢复路径的
   * 差别只是字节来源,授权边界同样是那张确认卡。
   *
   * `manifestSha256` 是「确认卡展示的」与「confirm 时批准的」之间的字节绑定:renderer
   * 原样回传,confirm 侧重读重算,对不上即拒 —— 与更新流程的 `expectedPackageSha256`
   * 同形,防确认间隙里 ghost.json 被换(#636 的同类窗口)。
   *
   * 随包插件一律拒:它们的批准由 provisioning 与种子逐字节对账后自动补,重启即恢复,
   * 不走人工确认(也不能走 —— 这条路的 trust 封顶在非官方档)。
   */
  async inspectInstalledReapproval(id: string): Promise<
    | {
        manifest: GhostManifest;
        trust: GhostTrustInfo;
        manifestSha256: string;
        approvalProjectionSha256: string;
        /** `.disabled` 镜像的读数:确认卡"立即开启"勾选的默认值,不重置用户停用偏好。 */
        localeResources: Record<string, GhostManifestLocaleResource>;
        iconDataUrl?: string;
        skillContentSha256: Record<string, string>;
        previouslyEnabled: boolean;
      }
    | { rejection: InstallRejection }
  > {
    this.ensureCurrentOwnerContextSync();
    if (!isValidGhostId(id) || this.options.isTrustedBundledId?.(id)) {
      return { rejection: { code: 'file-invalid', reason: '该插件不支持从安装目录重新确认' } };
    }
    if (this.readApproval(id).state === 'approved') {
      return { rejection: { code: 'state-changed', reason: '插件批准状态已恢复,无需重新确认' } };
    }
    // 有未清事务标记时绝不铸批准:否则启动恢复回滚字节后会留下这份 receipt/技能快照,
    // 形成永不自愈的错位授权(B-2/B-5/I-1)。确认第二步会经此再查一次(持互斥锁,
    // 与 install/update 不交错),所以只在这里设闸即可覆盖 inspect 与 confirm 两步。
    if (this.hasPendingMutationJournal(id)) {
      return {
        rejection: {
          code: 'state-changed',
          reason: '插件有未完成的安装/更新事务正在恢复,请重启应用完成恢复后再重新确认',
        },
      };
    }
    const dir = path.join(this.contentRootDir(), id);
    try {
      if (classifyGhostDirEntrySync(dir) !== 'directory') {
        return { rejection: { code: 'not-installed', reason: `意识 ${id} 未装入` } };
      }
    } catch {
      return { rejection: { code: 'not-installed', reason: `意识 ${id} 未装入` } };
    }
    let rawBytes: Buffer;
    try {
      const manifestPath = resolveGhostContentPathSync(dir, GHOST_MANIFEST_FILE, {
        expect: 'file',
        label: 'installed manifest',
      });
      const bytes = readBoundedFileNoFollowSync(manifestPath, GHOST_MANIFEST_MAX_BYTES, {
        containWithin: fs.realpathSync(dir),
      });
      if (bytes === null) throw new Error('manifest is missing or oversized');
      rawBytes = bytes;
    } catch (err) {
      return {
        rejection: {
          code: 'not-installed',
          reason: `安装目录里读不到清单:${err instanceof Error ? err.message : String(err)}`,
        },
      };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBytes.toString('utf8'));
    } catch (err) {
      return {
        rejection: {
          code: 'file-invalid',
          reason: `清单不是合法 JSON:${err instanceof Error ? err.message : String(err)}`,
        },
      };
    }
    const validated = validateGhostManifest(parsed);
    if (!validated.ok) return { rejection: { code: 'file-invalid', reason: validated.reason } };
    if (validated.manifest.id !== id) {
      return { rejection: { code: 'file-invalid', reason: '清单 id 与安装目录不一致' } };
    }
    // tokenBroker 门控与装入侧同一条规则(XDT 授权 broker 仅第一方官方插件可用,
    // 不区分 dev/packaged):走已装目录重新确认的都不是随包插件,声明即拒。
    if (
      !isOfficialGhostId(id) &&
      (validated.manifest.network?.secrets ?? []).some((s) => s.oauth?.tokenBroker !== undefined)
    ) {
      return {
        rejection: {
          code: 'file-invalid',
          reason: `id "${id}" 声明了 oauth.tokenBroker——XDT 授权 broker 仅第一方官方插件可用`,
        },
      };
    }
    let localeResources: Record<string, GhostManifestLocaleResource>;
    let skillContentSha256: Record<string, string>;
    let trust: GhostTrustInfo;
    try {
      trust = readLegacyInstallTrust(dir) ?? {
        level: 'unverified',
        publisherSigned: false,
        publisherVerified: false,
        reviewed: false,
      };
    } catch (err) {
      return {
        rejection: {
          code: 'file-invalid',
          reason: `安装目录信任数据不可读: ${err instanceof Error ? err.message : String(err)}`,
        },
      };
    }
    try {
      localeResources = this.readApprovedLocaleResources(dir, validated.manifest);
      skillContentSha256 = await hashApprovedSkillContent(validated.manifest, dir);
    } catch (err) {
      return {
        rejection: {
          code: 'file-invalid',
          reason: `安装目录批准内容不可读或不一致: ${err instanceof Error ? err.message : String(err)}`,
        },
      };
    }
    const iconDataUrl = this.readInstalledIconDataUrl(dir, validated.manifest) ?? undefined;
    const projection: InstalledReapprovalProjection = {
      manifest: validated.manifest,
      trust,
      localeResources,
      ...(iconDataUrl !== undefined ? { iconDataUrl } : {}),
      skillContentSha256,
    };
    return {
      manifest: projection.manifest,
      trust: projection.trust,
      localeResources: projection.localeResources,
      ...(projection.iconDataUrl !== undefined ? { iconDataUrl: projection.iconDataUrl } : {}),
      skillContentSha256: projection.skillContentSha256,
      manifestSha256: crypto.createHash('sha256').update(rawBytes).digest('hex'),
      approvalProjectionSha256: hashInstalledReapprovalProjection(projection),
      previouslyEnabled: !this.isDisabledMarkerPresentSync(dir),
    };
  }

  /**
   * 「从已装目录重新确认」第二步:用户在确认卡上点了同意,据此开 receipt。
   *
   * 与迁移(`backfillLegacyApproval`)的本质区别:**这是一次真实的用户确认**(用户
   * 刚看完全量权限清单),不受迁移 ledger 一次性门约束,来源记 `user-reapproval`。
   * 与迁移的共同点:trust 走同一个封顶读取器、技能字节现算钉指纹、只写状态根。
   */
  async reapproveInstalled(
    id: string,
    opts: {
      enable: boolean;
      expectedManifestSha256: string;
      expectedApprovalProjectionSha256: string;
      expectedInstalledApproval: string;
    },
  ): Promise<{ ghost: InstalledGhost } | { rejection: InstallRejection }> {
    return this.runExclusiveMutation(() => this.reapproveInstalledUnlocked(id, opts));
  }

  private async reapproveInstalledUnlocked(
    id: string,
    opts: {
      enable: boolean;
      expectedManifestSha256: string;
      expectedApprovalProjectionSha256: string;
      expectedInstalledApproval: string;
    },
  ): Promise<{ ghost: InstalledGhost } | { rejection: InstallRejection }> {
    // 确认期间批准状态不得变过:与更新流程同款前置条件(token 由 Main 现读比对)。
    const currentToken = ghostInstallApprovalToken(
      this.list().find((g) => g.manifest.id === id)?.approval,
    );
    if (currentToken !== opts.expectedInstalledApproval || currentToken.startsWith('approved')) {
      return {
        rejection: { code: 'state-changed', reason: '插件批准状态在确认后发生了变化,请重新确认' },
      };
    }
    // 重走只读检查(含随包拒收/清单校验),并绑定确认卡展示时的清单字节。
    const inspected = await this.inspectInstalledReapproval(id);
    if ('rejection' in inspected) return inspected;
    if (inspected.manifestSha256 !== opts.expectedManifestSha256) {
      return {
        rejection: { code: 'state-changed', reason: '插件清单在确认后发生了变化,请重新确认' },
      };
    }
    if (inspected.approvalProjectionSha256 !== opts.expectedApprovalProjectionSha256) {
      return {
        rejection: {
          code: 'state-changed',
          reason: '安装目录批准内容在确认后发生了变化,请重新确认',
        },
      };
    }
    // 指令查重与装入/更新同一条规则(豁免自己):重新确认不是给撞名指令开的后门。
    if (inspected.manifest.command !== undefined) {
      const commandFold = inspected.manifest.command.toLowerCase();
      const holder = this.list().find(
        (g) =>
          g.manifest.id !== id &&
          g.manifest.command !== undefined &&
          g.manifest.command.toLowerCase() === commandFold,
      );
      if (holder) {
        return {
          rejection: {
            code: 'command-conflict',
            reason: `指令 /${inspected.manifest.command} 已被已装意识「${holder.manifest.name}」(${holder.manifest.id})占用`,
          },
        };
      }
    }
    const contentRoot = this.contentRootDir();
    const dir = path.join(contentRoot, id);
    if (!this.isRealDirChild(contentRoot, id)) {
      return {
        rejection: { code: 'state-changed', reason: '插件安装目录在确认后发生了变化,请重新确认' },
      };
    }
    const marker = path.join(dir, DISABLED_MARKER_FILE);
    let markerExisted = false;
    try {
      try {
        if (classifyGhostDirEntrySync(marker) !== 'file') {
          throw new Error('ghost disabled marker is not a regular file');
        }
        markerExisted = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      // 先提交兼容镜像，再提交权威 receipt。否则 marker 失败会留下“返回成功但实际
      // 启停态与 receipt 矛盾”的部分成功。没有状态变化时不触碰 marker。
      if (opts.enable) {
        if (markerExisted) await fs.promises.rm(marker, { force: true });
      } else if (!markerExisted) {
        await fs.promises.writeFile(marker, '', { flag: 'wx' });
      }
    } catch (err) {
      return {
        rejection: {
          code: 'io',
          reason: `启停标记写入失败:${err instanceof Error ? err.message : String(err)}`,
        },
      };
    }
    try {
      const localeResources = inspected.localeResources;
      const iconDataUrl = inspected.iconDataUrl;
      const skillContentSha256 = inspected.skillContentSha256;
      await this.receiptStore.write(
        createGhostInstallReceipt({
          manifest: inspected.manifest,
          localeResources,
          enabled: opts.enable,
          trust: inspected.trust,
          skillContentSha256,
          ...(iconDataUrl !== undefined ? { iconDataUrl } : {}),
        }),
        { skillSourceDir: dir },
      );
    } catch (err) {
      const markerChanged = opts.enable ? markerExisted : !markerExisted;
      if (markerChanged) {
        try {
          if (!this.isRealDirChild(contentRoot, id)) {
            throw new Error('ghost install directory changed before marker rollback');
          }
          if (markerExisted) {
            try {
              if (classifyGhostDirEntrySync(marker) !== 'file') {
                throw new Error('ghost disabled marker is not a regular file');
              }
            } catch (markerError) {
              if ((markerError as NodeJS.ErrnoException).code !== 'ENOENT') throw markerError;
              await fs.promises.writeFile(marker, '', { flag: 'wx' });
            }
          } else {
            await fs.promises.rm(marker, { force: true });
          }
        } catch (rollbackErr) {
          (this.options.log?.error ?? this.options.log?.warn)?.call(
            this.options.log,
            'ghost reapproval receipt failed and marker rollback also failed',
            {
              id,
              error: rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr),
            },
          );
        }
      }
      return {
        rejection: { code: 'io', reason: err instanceof Error ? err.message : String(err) },
      };
    }
    this.untrustedApprovals.delete(this.isolationKey(id));
    this.options.log?.info('ghost reapproved from installed dir', {
      id,
      enabled: opts.enable,
      trustLevel: inspected.trust.level,
      origin: 'user-reapproval',
    });
    const ghost = this.list().find((g) => g.manifest.id === id);
    if (!ghost) return { rejection: { code: 'io', reason: '重新确认后读不到插件清单' } };
    this.options.onChanged?.(this.list());
    return { ghost };
  }

  /** 扫描已装意识(同步 —— renderer 首帧 sendSync 拉取,目录极小不卡启动)。 */
  list(): InstalledGhost[] {
    this.ensureCurrentOwnerContextSync();
    const root = this.contentRootDir();
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      return []; // 根目录还不存在 = 没装过任何意识
    }

    const result: InstalledGhost[] = [];
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue; // staging / 系统目录
      const dir = path.join(root, entry.name);
      // 判据走 ghostContentTree(lstat 分类),不信 Dirent 类型位:根子项是 junction/
      // 链接时不算已装插件 —— 与迁移扫描、内容树遍历同一份判据(§3)。
      try {
        if (classifyGhostDirEntrySync(dir) !== 'directory') continue;
      } catch {
        continue; // lstat 不动(条目消失/权限)= 不算已装
      }
      if (!isValidGhostId(entry.name)) {
        this.options.log?.warn('ghost dir skipped: invalid directory id', { dir });
        continue;
      }
      const approvalResult = this.readApproval(entry.name);
      if (approvalResult.state === 'approved') {
        const receipt = approvalResult.receipt;
        const localizedManifest = this.localizeApprovedManifest(receipt);
        result.push({
          manifest: localizedManifest,
          dir,
          enabled: this.effectiveEnabled(dir, receipt.enabled),
          approval: { state: 'approved', revision: receipt.revision },
          trust: receipt.trust,
          ...(receipt.manifest.skill?.items.length
            ? {
                approvedSkillRoot: this.receiptStore.skillSnapshotRoot(
                  receipt.id,
                  receipt.revision,
                ),
              }
            : {}),
          ...(receipt.iconDataUrl !== undefined ? { iconDataUrl: receipt.iconDataUrl } : {}),
          ...(this.options.isTrustedBundledId?.(entry.name) ? { builtin: true } : {}),
        });
        continue;
      }
      if (approvalResult.state === 'invalid') {
        this.options.log?.warn('ghost approval receipt invalid; plugin kept disabled', {
          id: entry.name,
          reason: approvalResult.reason,
        });
      }

      // 老安装没有 Host 批准快照，或快照损坏：只读取清单用于设置页恢复，
      // 不把 live manifest / trust / enabled 当成运行授权。
      let raw: unknown;
      try {
        // 我们的逐段 no-follow 路径解析(拒符号链接段)+ main 的单句柄限量读(拒链接、
        // 拒无界字节):已安装目录可能被外部/同步盘改动,list() 每次市场快照都跑,两道叠加。
        const manifestPath = resolveGhostContentPathSync(dir, GHOST_MANIFEST_FILE, {
          expect: 'file',
          label: 'installed manifest',
        });
        const bytes = readBoundedFileNoFollowSync(manifestPath, MAX_GHOST_MANIFEST_BYTES);
        if (bytes === null) throw new Error('manifest is not a bounded regular file');
        raw = JSON.parse(bytes.toString('utf-8'));
      } catch (err) {
        this.options.log?.warn('ghost dir skipped: unreadable manifest', {
          dir,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
      const parsedInstalled = parseInstalledGhostManifest(raw);
      const v = parsedInstalled;
      if (parsedInstalled.ok && parsedInstalled.legacyManualIgnored) {
        this.options.log?.warn('ghost legacy manual metadata ignored', {
          code: 'LEGACY_MANUAL_METADATA_IGNORED',
          manifestId: parsedInstalled.manifest.id,
        });
      }
      if (!v.ok) {
        this.options.log?.warn('ghost dir skipped: invalid manifest', { dir, reason: v.reason });
        continue;
      }
      if (v.manifest.id !== entry.name) {
        this.options.log?.warn('ghost dir skipped: dir name != manifest id', {
          dir,
          manifestId: v.manifest.id,
        });
        continue;
      }
      // 历史 manifest / receipt 中可能保留已移除的资源搜索元数据；它不参与当前
      // 运行时入口，插件本体与已批准的其它能力仍按现有授权照常可用。
      const manifest = v.manifest;
      // icon 读失败只降级为无图标(warn),不影响意识本体可用。
      // receipt 模型:无有效批准的安装一律 enabled:false + approval:{state},不按
      // .disabled 镜像判运行(那是被 revert 的旧模型、#636 漏洞路径)。trust 只在
      // 已批准投影里由 receipt 给出,legacy 投影不借安装目录 hostMetadata 冒充可信。
      const iconDataUrl = this.readInstalledIconDataUrl(dir, v.manifest);
      const localizedManifest = this.readInstalledLocalizedManifest(dir, v.manifest);
      result.push({
        manifest: localizedManifest,
        dir,
        enabled: false,
        approval: { state: approvalResult.state },
        // 未批准安装目录里的 trust 镜像是可变字节，不能作为可信展示事实。
        trust: {
          level: 'unverified',
          publisherSigned: false,
          publisherVerified: false,
          reviewed: false,
        },
        ...(iconDataUrl !== null ? { iconDataUrl } : {}),
        ...(this.options.isTrustedBundledId?.(entry.name) ? { builtin: true } : {}),
      });
    }
    result.sort((a, b) => a.manifest.id.localeCompare(b.manifest.id));
    return result;
  }

  /**
   * Mutation callers may immediately use the returned object to spawn a
   * resident runtime.  Always return the same authorization projection that
   * list()/runtime lookup can currently observe instead of a hand-built
   * "approved" object that could bypass an active quarantine.
   */
  private projectCommittedMutationResult(fallback: InstalledGhost): {
    ghost: InstalledGhost;
    list: InstalledGhost[];
  } {
    const list = this.list();
    const ghost =
      list.find((item) => item.manifest.id === fallback.manifest.id) ??
      ({
        ...fallback,
        enabled: false,
        approval: { state: 'invalid' },
        approvedSkillRoot: undefined,
      } satisfies InstalledGhost);
    return { ghost, list };
  }

  /** receipt 内的 base manifest + 已批准 locale 资源；不再读取可变安装目录。 */
  private localizeApprovedManifest(receipt: GhostInstallReceipt): GhostManifest {
    const requestedLocale = this.options.getLocale?.();
    const runtimeManifest = withGhostResolvedLocale(receipt.manifest, requestedLocale);
    const localePath = ghostLocalePathFor(receipt.manifest, requestedLocale);
    const fallbackPath = receipt.manifest.locales?.en;
    const candidates = [
      ...new Set([localePath, fallbackPath].filter((value): value is string => Boolean(value))),
    ];
    for (const candidate of candidates) {
      const resource = receipt.localeResources[candidate];
      if (resource) return resolveGhostManifestLocale(runtimeManifest, resource);
    }
    return runtimeManifest;
  }

  /**
   * 读取当前宿主语言对应的 locale 文件。已安装目录被用户手工改坏时不让
   * 整个插件消失：记录告警并回退原 manifest；正常安装路径已在 parse 阶段严验。
   */
  private readInstalledLocalizedManifest(dir: string, manifest: GhostManifest): GhostManifest {
    const requestedLocale = this.options.getLocale?.();
    const runtimeManifest = withGhostResolvedLocale(manifest, requestedLocale);
    const localePath = ghostLocalePathFor(manifest, requestedLocale);
    if (!localePath) return runtimeManifest;
    const fallbackPath = manifest.locales?.en;
    const candidates = [
      ...new Set([localePath, fallbackPath].filter((value): value is string => Boolean(value))),
    ];
    for (const candidatePath of candidates) {
      try {
        // 逐段 no-follow 解析(判据与批准侧、技能目录同源,链接一律拒)+ 单句柄限量读:
        // 我们的 resolveGhostContentPathSync 拒符号链接段,main 的 readBoundedFileNoFollowSync
        // 单句柄一次完成"限量 + no-follow + containWithin",消掉 lstat→readFileSync 的 TOCTOU。
        const absPath = resolveGhostContentPathSync(dir, candidatePath, {
          expect: 'file',
          label: 'ghost locale',
        });
        const bytes = readBoundedFileNoFollowSync(absPath, GHOST_LOCALE_MAX_BYTES, {
          containWithin: fs.realpathSync(dir),
        });
        if (bytes === null) {
          throw new Error(`locale 文件缺失、超过 ${GHOST_LOCALE_MAX_BYTES} 字节或位于插件目录之外`);
        }
        const raw = JSON.parse(bytes.toString('utf8'));
        const validated = validateGhostManifestLocaleResource(raw, manifest);
        if (!validated.ok) throw new Error(validated.reason);
        return resolveGhostManifestLocale(runtimeManifest, validated.resource);
      } catch (err) {
        this.options.log?.warn('ghost locale candidate invalid', {
          id: manifest.id,
          localePath: candidatePath,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    this.options.log?.warn('ghost locale fallback to base manifest', {
      id: manifest.id,
      localePath,
    });
    return runtimeManifest;
  }

  /**
   * 启用 / 停用一张意识。停用不删任何东西,只把批准 receipt 的 enabled 翻过来
   * (安装目录里的 `.disabled` 只作为旧版本兼容镜像同步维护)。幂等。
   *
   * 两个方向不对称:**启用需要有效批准状态**(无批准的存量安装必须先重新确认
   * 权限),**停用必须永远能成功** —— 停用是安全的收敛方向,不能因为技能快照
   * 被外部删掉之类的环境问题把插件卡在"既不能用也不能关"。
   */
  async setEnabled(
    id: string,
    enabled: boolean,
  ): Promise<{ ok: true } | { rejection: UninstallRejection }> {
    return this.runExclusiveMutation(() => this.setEnabledUnlocked(id, enabled));
  }

  private async setEnabledUnlocked(
    id: string,
    enabled: boolean,
  ): Promise<{ ok: true } | { rejection: UninstallRejection }> {
    if (!isValidGhostId(id)) {
      return { rejection: { code: 'invalid-id', reason: '非法意识 id' } };
    }
    const dir = path.join(this.contentRootDir(), id);
    // pathExists(fs.access)跟随链接:`<root>/<id>` 被换成 junction 时,下面对
    // `<dir>/.disabled` 的写/删会穿透到安装根之外的目标。判据改用 ghostContentTree 的
    // lstat 分类(与 list()「只有真目录才算安装」同源):不存在(ENOENT→抛错)或非真目录
    // (链接/文件)一律按未装入拒,标记读写不越过安装根边界。
    let dirKind: GhostDirEntryKind | null;
    try {
      dirKind = classifyGhostDirEntrySync(dir);
    } catch {
      dirKind = null;
    }
    if (dirKind !== 'directory') {
      return { rejection: { code: 'not-installed', reason: `意识 ${id} 未装入` } };
    }
    const receiptResult = this.readApproval(id);
    if (receiptResult.state !== 'approved' && enabled) {
      return {
        rejection: {
          code: 'approval-required',
          reason: `插件 ${id} 缺少有效的安装批准状态，请重新选择安装包并确认权限`,
        },
      };
    }
    // Re-check immediately before touching the compatibility mirror. This does not
    // replace OS-level handle protection, but prevents a stale initial classification
    // from authorizing a link/file target in the common race window.
    if (!this.isRealDirChild(this.contentRootDir(), id)) {
      return { rejection: { code: 'not-installed', reason: `意识 ${id} 未装入` } };
    }
    const marker = path.join(dir, DISABLED_MARKER_FILE);
    // 回滚基准取"镜像先前是否在盘上",不是 receipt.enabled:两者可以背离(旧客户端
    // 只写镜像 → receipt=true + 镜像在,读时合并 = 停用)。按 receipt 回滚会在
    // "启用失败"后把镜像永久丢掉 —— 有效状态从停用静默翻成启用,还带不回来。
    const markerExisted = this.isDisabledMarkerPresentSync(dir);
    // 阶段 1:镜像。两阶段的错误必须分开 —— 镜像写失败时**什么都还没落盘**,
    // 把它报成"已停用"是谎报:重启后按 receipt.enabled=true 原样复活,而用户
    // 以为已经关掉了。停用方向的"必须永远能成功"指的是不被环境卡死在"既不能用
    // 也不能关",不是"任何失败都谎称成功"。
    try {
      if (enabled) {
        try {
          if (classifyGhostDirEntrySync(marker) !== 'file') {
            throw new Error('ghost disabled marker is not a regular file');
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        await fs.promises.rm(marker, { force: true });
      } else {
        try {
          if (classifyGhostDirEntrySync(marker) !== 'file') {
            throw new Error('ghost disabled marker is not a regular file');
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        await fs.promises.writeFile(marker, '');
      }
    } catch (err) {
      return {
        rejection: {
          code: 'io',
          reason: `启停标记写入失败:${err instanceof Error ? err.message : String(err)}`,
        },
      };
    }
    // 阶段 2:receipt。走到这里镜像已确认落盘,catch 里才允许按"镜像已生效"降级。
    if (receiptResult.state === 'approved') {
      try {
        // 快照被外部删掉时从当前安装目录重建(内容与批准 manifest 的一致性由
        // ensureSkillSnapshot 的 SKILL.md 逐字校验兜住);停用方向即使重建不了
        // 也照样落盘,由技能对账把落链撤掉。
        await this.receiptStore.write(
          { ...receiptResult.receipt, enabled },
          { skillSourceDir: dir, requireSkillSnapshot: enabled },
        );
      } catch (err) {
        if (!enabled) {
          // 停用降级成功的前提是阶段 1 已确认镜像在盘上:list() 的读时合并会把
          // 启停态压成停用(重启后依然),旧客户端也按镜像判 —— 停用已经生效,
          // 如实返回 ok,receipt 留待下次成功写入收敛。
          this.options.log?.warn('ghost disable persisted via mirror only; receipt write failed', {
            id,
            error: err instanceof Error ? err.message : String(err),
          });
          this.options.onChanged?.(this.list());
          return { ok: true };
        }
        // 启用方向 fail closed:receipt 没写成就不算启用,镜像原样放回 ——
        // 有效启停态(读时合并)与旧客户端(只认镜像)都回到操作前。
        if (markerExisted) {
          await fs.promises.writeFile(marker, '').catch((rollbackErr) => {
            // 回滚也写不动的终态要可观测:receipt 仍是停用(读时合并 fail closed
            // 不受影响),但只认镜像的旧客户端会把它看成启用 —— 状态不一致,升级
            // error 级,不静默。
            (this.options.log?.error ?? this.options.log?.warn)?.call(
              this.options.log,
              'ghost enable failed and mirror rollback also failed; old clients may see it enabled',
              {
                id,
                error: rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr),
              },
            );
          });
        }
        return {
          rejection: { code: 'io', reason: err instanceof Error ? err.message : String(err) },
        };
      }
    }
    this.options.log?.info('ghost enabled state changed', { id, enabled });
    this.options.onChanged?.(this.list());
    return { ok: true };
  }

  /**
   * 按清单声明读安装目录里的 icon,转 data URL。未声明 / 文件缺失 / 超限 /
   * 读失败一律返回 null(仅 warn 降级,不拖垮 list)。
   */
  private readInstalledIconDataUrl(dir: string, manifest: GhostManifest): string | null {
    if (manifest.icon === undefined) return null;
    try {
      // 逐段 no-follow 解析(拒符号链接段,判据与技能目录 / locale 同源)+ 单句柄限量读:
      // stat 后再 readFileSync 是两次独立打开,并发方可在其间把 icon 换成指向宿主任意
      // 文件的链接,字节会被包成 dataURL 经 IPC 送进 Renderer。containWithin 堵中间目录链接。
      const iconPath = resolveGhostContentPathSync(dir, manifest.icon, {
        expect: 'file',
        label: 'ghost icon',
      });
      const bytes = readBoundedFileNoFollowSync(iconPath, GHOST_ICON_MAX_BYTES, {
        containWithin: fs.realpathSync(dir),
      });
      if (bytes === null) {
        this.options.log?.warn('ghost icon skipped: missing or oversize', {
          dir,
          icon: manifest.icon,
        });
        return null;
      }
      return buildIconDataUrl(manifest.icon, bytes);
    } catch {
      this.options.log?.warn('ghost icon skipped: unreadable', { dir, icon: manifest.icon });
      return null;
    }
  }

  /**
   * 只验不装:读 .cindy → 解包 → 校验清单,返回清单(含 icon data URL),
   * 零副作用。「装意识前弹确认」(README 安全原则)的数据来源 —— 三个装入
   * 入口(设置页 / 拖入 / 双击)都先 inspect 给用户看明白,确认后才 install。
   */
  async inspect(lizFilePath: string): Promise<
    | {
        manifest: GhostManifest;
        /** 包内原始清单，仅供 Main 安全比较。 */
        canonicalManifest: GhostManifest;
        trust: GhostTrustInfo;
        packageSha256: string;
        iconDataUrl?: string;
      }
    | { rejection: InstallRejection }
  > {
    const parsed = await this.parse(lizFilePath);
    if ('rejection' in parsed) return parsed;
    return {
      manifest: parsed.manifest,
      canonicalManifest: parsed.canonicalManifest,
      trust: parsed.trust,
      packageSha256: parsed.packageSha256,
      ...(parsed.iconDataUrl !== undefined ? { iconDataUrl: parsed.iconDataUrl } : {}),
    };
  }

  /** 装入的前半程(读文件 / 解包 / 校验清单),inspect 与 install 共用。 */
  private async parse(lizFilePath: string): Promise<
    | {
        manifest: GhostManifest;
        // 同一份包内清单的两个名字:approvedManifest 供 receipt 写入(我们),
        // canonicalManifest 供 inspect/可恢复复核比对(main)。parse 里都置为 v.manifest。
        approvedManifest: GhostManifest;
        canonicalManifest: GhostManifest;
        localeResources: Record<string, GhostManifestLocaleResource>;
        trust: GhostTrustInfo;
        packageSha256: string;
        iconDataUrl?: string;
        allEntries: JSZip.JSZipObject[];
        prefix: string;
      }
    | { rejection: InstallRejection }
  > {
    // 1) 读源文件(带体积上限)。stat 后再 readFile 是两次独立打开,期间文件
    // 可被换成超大文件绕过上限——单句柄限量读。允许跟随链接:用户拖入的
    // .cindy 本身可以是链接,防篡改由 expectedPackageSha256 对账负责。
    let buf: Buffer;
    try {
      buf = await readRegularFileStableWithLimit(lizFilePath, MAX_NODE_CINDY_FILE_BYTES);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { rejection: { code: 'source-not-found', reason: '文件不存在' } };
      }
      if (err instanceof Error && err.message.includes('exceeds')) {
        return {
          rejection: {
            code: 'file-invalid',
            reason: `文件超过 ${MAX_NODE_CINDY_FILE_BYTES} 字节上限`,
          },
        };
      }
      return {
        rejection: { code: 'io', reason: err instanceof Error ? err.message : String(err) },
      };
    }

    // 2) 解析 zip + 找 ghost.json(容忍"压缩时多包了一层文件夹"的常见做法)
    let zip: JSZip;
    try {
      zip = await JSZip.loadAsync(buf);
    } catch {
      return { rejection: { code: 'file-invalid', reason: '不是合法的 .cindy 压缩包' } };
    }
    const allEntries = Object.values(zip.files).filter((e) => !e.name.startsWith('__MACOSX/'));
    if (allEntries.length === 0) {
      return { rejection: { code: 'file-invalid', reason: '压缩包是空的' } };
    }
    if (allEntries.length > MAX_NODE_ZIP_ENTRIES) {
      return {
        rejection: {
          code: 'file-invalid',
          reason: `压缩包条目过多:${allEntries.length}(上限 ${MAX_NODE_ZIP_ENTRIES})`,
        },
      };
    }
    // 检查/签名/保留文件对账都按原始条目名,解压却按 canonical 路径落盘;
    // 若二者可指向不同文件,恶意包就能「检查一份清单、装入另一份」
    // (如根部放无害 ghost.json,再用 x/../ghost.json 在 staging 里盖掉它)。
    // 读清单之前一刀切拒绝非规范路径,让后续所有按名对账都可信。
    const nonCanonicalEntry = allEntries.find((entry) => hasNonCanonicalZipPath(entry.name));
    if (nonCanonicalEntry) {
      return {
        rejection: { code: 'file-invalid', reason: `压缩包内有非法路径:${nonCanonicalEntry.name}` },
      };
    }

    const prefix = detectSingleTopFolderPrefix(allEntries.map((e) => e.name));
    // ZIP 条目名在检查阶段区分大小写，但 Windows / 默认 macOS 解压落盘不区分。
    // 折叠后撞同一路径会让后写条目覆盖先写条目（包括 ghost.json），必须在
    // 读取清单前整体拒绝。
    const seenEntryPaths = new Set<string>();
    const aliasedEntry = allEntries.find((entry) => {
      const rel = entry.name.slice(prefix.length).replace(/\/$/, '');
      if (rel.length === 0) return false;
      const folded = rel.toLowerCase();
      if (seenEntryPaths.has(folded)) return true;
      seenEntryPaths.add(folded);
      return false;
    });
    if (aliasedEntry) {
      return {
        rejection: {
          code: 'file-invalid',
          reason: `压缩包含大小写折叠后重复的路径:${aliasedEntry.name.slice(prefix.length)}`,
        },
      };
    }
    // 这两个点文件只属于主机：包若能自带它们，就可伪造停用状态或覆盖
    // 签名信任快照。大小写也折叠检查，避免在 Windows/macOS 上撞同一文件。
    const reservedHostFile = allEntries.find((entry) => {
      if (entry.dir || !entry.name.startsWith(prefix)) return false;
      const rel = entry.name.slice(prefix.length).toLowerCase();
      return rel === DISABLED_MARKER_FILE || rel === TRUST_METADATA_FILE;
    });
    if (reservedHostFile) {
      return {
        rejection: {
          code: 'file-invalid',
          reason: `压缩包不能包含主机保留文件:${reservedHostFile.name.slice(prefix.length)}`,
        },
      };
    }
    const manifestEntry = zip.file(`${prefix}${GHOST_MANIFEST_FILE}`);
    if (!manifestEntry) {
      return {
        rejection: { code: 'file-invalid', reason: `压缩包根部缺少 ${GHOST_MANIFEST_FILE}` },
      };
    }

    // 3) 校验清单
    let manifestRaw: unknown;
    try {
      manifestRaw = JSON.parse(
        (
          await readZipEntryBufferWithLimit(
            manifestEntry,
            MAX_GHOST_MANIFEST_BYTES,
            GHOST_MANIFEST_FILE,
          )
        ).toString('utf8'),
      );
    } catch {
      return {
        rejection: { code: 'file-invalid', reason: `${GHOST_MANIFEST_FILE} 不是合法 JSON` },
      };
    }
    const hostUnsupportedReason = ghostManifestHostUnsupportedReason(manifestRaw);
    if (hostUnsupportedReason) {
      return { rejection: { code: 'host-unsupported', reason: hostUnsupportedReason } };
    }
    const v = validateGhostManifest(manifestRaw);
    if (!v.ok) {
      return { rejection: { code: 'file-invalid', reason: `清单不合格:${v.reason}` } };
    }
    if (!v.manifest.node && buf.byteLength > MAX_BASIC_CINDY_FILE_BYTES) {
      return {
        rejection: {
          code: 'file-invalid',
          reason: `普通沙箱插件文件过大:${buf.byteLength} 字节(上限 ${MAX_BASIC_CINDY_FILE_BYTES})`,
        },
      };
    }
    const maxEntries = v.manifest.node ? MAX_NODE_ZIP_ENTRIES : MAX_BASIC_ZIP_ENTRIES;
    if (allEntries.length > maxEntries) {
      return {
        rejection: {
          code: 'file-invalid',
          reason: `压缩包条目过多:${allEntries.length}(上限 ${maxEntries})`,
        },
      };
    }
    if (v.manifest.node && !zip.file(`${prefix}${v.manifest.node.entry}`)) {
      return {
        rejection: {
          code: 'file-invalid',
          reason: `清单声明了 node.entry,但压缩包内缺少 ${v.manifest.node.entry}`,
        },
      };
    }
    let localizedManifest = withGhostResolvedLocale(v.manifest, this.options.getLocale?.());
    const localeResources: Record<string, GhostManifestLocaleResource> = {};
    if (v.manifest.locales !== undefined) {
      const resources = new Map<string, GhostManifestLocaleResource>();
      for (const localePath of Object.values(v.manifest.locales)) {
        if (!localePath) continue;
        const localeEntry = zip.file(`${prefix}${localePath}`);
        if (!localeEntry) {
          return {
            rejection: {
              code: 'file-invalid',
              reason: `清单声明了 locale,但压缩包内缺少 ${localePath}`,
            },
          };
        }
        let localeRaw: unknown;
        try {
          localeRaw = JSON.parse(
            (
              await readZipEntryBufferWithLimit(
                localeEntry,
                GHOST_LOCALE_MAX_BYTES,
                `locale ${localePath}`,
              )
            ).toString('utf8'),
          );
        } catch {
          return {
            rejection: {
              code: 'file-invalid',
              reason: `locale 文件不是合法 JSON 或超过 ${GHOST_LOCALE_MAX_BYTES} 字节:${localePath}`,
            },
          };
        }
        const validated = validateGhostManifestLocaleResource(localeRaw, v.manifest);
        if (!validated.ok) {
          return {
            rejection: {
              code: 'file-invalid',
              reason: `locale 文件不合格(${localePath}):${validated.reason}`,
            },
          };
        }
        resources.set(localePath, validated.resource);
        localeResources[localePath] = validated.resource;
      }
      const localePath = ghostLocalePathFor(v.manifest, this.options.getLocale?.());
      const resource = localePath ? resources.get(localePath) : undefined;
      if (resource) localizedManifest = resolveGhostManifestLocale(localizedManifest, resource);
    }
    const maxUncompressedBytes = v.manifest.node
      ? MAX_NODE_UNCOMPRESSED_BYTES
      : MAX_BASIC_UNCOMPRESSED_BYTES;
    try {
      // inspect 阶段先用流式解压把总量算清。这样恶意压缩包不能等到确认后，
      // 或借签名/图标读取，在“检查上限之前”先撑出一个超大内存块。
      await assertZipUncompressedLimit(allEntries, maxUncompressedBytes);
    } catch (err) {
      return {
        rejection: {
          code: 'file-invalid',
          reason: err instanceof Error ? err.message : String(err),
        },
      };
    }

    // 5) 签名是包级完整性闸：无签名允许但标未验证；一旦带了签名却对不上
    // 任一文件/版本/公钥，直接拒装，不能静默降级成“无签名”。
    const signature = await verifyGhostZipSignatures(
      zip,
      prefix,
      v.manifest,
      this.options.trustRegistry,
    );
    if (!signature.ok) {
      return { rejection: { code: 'file-invalid', reason: `签名验证失败:${signature.reason}` } };
    }

    // 4) 清单声明了 icon → 包内必须真有,且不超限(装入前就把账算清,
    //    不留"装完没图标"的哑弹)。
    let iconDataUrl: string | undefined;
    if (v.manifest.icon !== undefined) {
      const iconEntry = zip.file(`${prefix}${v.manifest.icon}`);
      if (!iconEntry) {
        return {
          rejection: {
            code: 'file-invalid',
            reason: `清单声明了 icon,但压缩包内缺少 ${v.manifest.icon}`,
          },
        };
      }
      let iconData: Buffer;
      try {
        iconData = await readZipEntryBufferWithLimit(iconEntry, GHOST_ICON_MAX_BYTES, 'icon');
      } catch {
        return {
          rejection: {
            code: 'file-invalid',
            reason: `icon 过大(上限 ${GHOST_ICON_MAX_BYTES} 字节)`,
          },
        };
      }
      iconDataUrl = buildIconDataUrl(v.manifest.icon, iconData) ?? undefined;
    }

    // 5) skill 槽:声明的每个技能目录必须真有 SKILL.md,且 frontmatter 与清单
    //    声明逐字一致——确认框展示的必须就是 Agent 实际读到的,装入前把账算清。
    //    对未本地化的 v.manifest 校验即可:skill 字段不在本地化白名单
    //    (GhostManifestLocaleResource)内,localizedManifest 与之恒等。
    for (const skillItem of v.manifest.skill?.items ?? []) {
      const relPath = `${skillItem.dir}/SKILL.md`;
      const skillEntry = zip.file(`${prefix}${relPath}`);
      if (!skillEntry) {
        return {
          rejection: {
            code: 'file-invalid',
            reason: `skill 条目声明了 ${skillItem.dir},但压缩包内缺少 ${relPath}`,
          },
        };
      }
      let skillMd: Buffer;
      try {
        skillMd = await readZipEntryBufferWithLimit(
          skillEntry,
          GHOST_SKILL_MD_MAX_BYTES,
          `skill ${relPath}`,
        );
      } catch {
        return {
          rejection: {
            code: 'file-invalid',
            reason: `${relPath} 过大(上限 ${GHOST_SKILL_MD_MAX_BYTES} 字节)`,
          },
        };
      }
      const consistencyError = checkSkillMdConsistency(skillMd.toString('utf8'), skillItem);
      if (consistencyError) {
        return {
          rejection: {
            code: 'file-invalid',
            reason: `skill 条目 ${skillItem.dir}:${consistencyError}`,
          },
        };
      }
    }

    // 5.5) manual:声明目录内只允许普通 Markdown 文件；逐文件限量并严格
    // 校验 UTF-8/二进制内容。入口固定为 MANUAL.md，装入前一次性对账。
    const validatedManualEntries = new Set<string>();
    for (const manualItem of v.manifest.manual?.items ?? []) {
      const unitPrefix = `${prefix}${manualItem.dir}/`;
      const entryPath = `${unitPrefix}${GHOST_MANUAL_ENTRY_FILE}`;
      const entry = zip.file(entryPath);
      if (!entry || entry.dir || isZipSymbolicLink(entry)) {
        return {
          rejection: {
            code: 'file-invalid',
            reason: `manual 条目声明了 ${manualItem.dir},但压缩包内缺少普通文件 ${manualItem.dir}/${GHOST_MANUAL_ENTRY_FILE}`,
          },
        };
      }
      const unitEntries = allEntries.filter(
        (candidate) => {
          const normalizedName = candidate.name.replace(/\\/g, '/');
          return normalizedName.startsWith(unitPrefix) && normalizedName !== unitPrefix;
        },
      );
      for (const manualEntry of unitEntries) {
        const normalizedEntryName = manualEntry.name.replace(/\\/g, '/');
        const relativePath = normalizedEntryName.slice(unitPrefix.length).replace(/\/$/, '');
        if (relativePath.length === 0) continue;
        if (
          manualEntry.name.includes('\\') ||
          isZipSymbolicLink(manualEntry) ||
          ghostManualLogicalPathForEntry(
            manualItem.name,
            relativePath,
            manualEntry.dir ? 'directory' : 'file',
          ) === null
        ) {
          return {
            rejection: {
              code: 'file-invalid',
              reason: `manual 条目无法形成合法 ghost_manual 路径:${manualItem.dir}/${relativePath}`,
            },
          };
        }
        if (manualEntry.dir) continue;
        if (validatedManualEntries.has(manualEntry.name)) continue;
        let manualBytes: Buffer;
        try {
          manualBytes = await readZipEntryBufferWithLimit(
            manualEntry,
            GHOST_MANUAL_MD_MAX_BYTES,
            `manual ${manualItem.dir}/${relativePath}`,
          );
        } catch {
          return {
            rejection: {
              code: 'file-invalid',
              reason: `${manualItem.dir}/${relativePath} 过大(上限 ${GHOST_MANUAL_MD_MAX_BYTES} 字节)`,
            },
          };
        }
        const decoded = decodeGhostManualMarkdown(manualBytes);
        if (!decoded.ok) {
          return {
            rejection: {
              code: 'file-invalid',
              reason: `manual 文件不合格(${manualItem.dir}/${relativePath}):${decoded.reason}`,
            },
          };
        }
        validatedManualEntries.add(manualEntry.name);
      }
    }

    return {
      manifest: localizedManifest,
      approvedManifest: v.manifest,
      canonicalManifest: v.manifest,
      localeResources,
      trust: signature.trust,
      packageSha256: crypto.createHash('sha256').update(buf).digest('hex'),
      ...(iconDataUrl !== undefined ? { iconDataUrl } : {}),
      allEntries,
      prefix,
    };
  }

  async install(
    lizFilePath: string,
    opts?: {
      initiallyEnabled?: boolean;
      expectedPackageSha256?: string;
      trustOverride?: GhostHostTrustOverride;
    },
  ) {
    return this.runExclusiveMutation(() => this.installUnlocked(lizFilePath, opts));
  }

  private async installUnlocked(
    lizFilePath: string,
    opts?: {
      initiallyEnabled?: boolean;
      expectedPackageSha256?: string;
      trustOverride?: GhostHostTrustOverride;
    },
  ): Promise<{ ghost: InstalledGhost } | { rejection: InstallRejection }> {
    // 装入初始启用态由 UI 层决定(装入确认框勾选,默认沉睡);缺省 true
    // 保持既有调用方(测试等)语义不变。
    const initiallyEnabled = opts?.initiallyEnabled ?? true;
    // 1–3) 读文件 / 解包 / 校验清单(与 inspect 共用)
    const parsed = await this.parse(lizFilePath);
    if ('rejection' in parsed) return parsed;
    if (
      opts?.expectedPackageSha256 !== undefined &&
      parsed.packageSha256 !== opts.expectedPackageSha256
    ) {
      return {
        rejection: {
          code: 'file-invalid',
          reason: '插件文件在确认后发生了变化，请重新选择并确认',
        },
      };
    }
    const {
      manifest,
      approvedManifest,
      localeResources,
      packageSha256,
      iconDataUrl,
      allEntries,
      prefix,
    } = parsed;
    const clearBuiltinTombstoneOnCommit =
      this.options.isTrustedBundledId?.(manifest.id) === true &&
      this.options.clearBuiltinTombstone !== undefined;
    const trust = opts?.trustOverride === 'cindy-official'
      ? CINDY_OFFICIAL_GHOST_TRUST
      : parsed.trust;

    // 4) 目标目录冲突检查
    const root = this.contentRootDir();
    const finalDir = path.join(root, manifest.id);
    if (await pathExists(finalDir)) {
      return { rejection: { code: 'already-installed', reason: `意识 ${manifest.id} 已装入` } };
    }

    // 4.5) 显式指令查重(2026-07-09 Lizi 定案):command 由意识作者自定,
    // 与本机已装意识撞名即拒——不静默改名(确定性),由用户抽离旧的或
    // 作者换名解决。大小写折叠比较,防 /Draw 与 /draw 并存互踩。
    if (manifest.command !== undefined) {
      const commandFold = manifest.command.toLowerCase();
      const holder = this.list().find(
        (g) => g.manifest.command !== undefined && g.manifest.command.toLowerCase() === commandFold,
      );
      if (holder) {
        return {
          rejection: {
            code: 'command-conflict',
            reason: `指令 /${manifest.command} 已被已装意识「${holder.manifest.name}」(${holder.manifest.id})占用`,
          },
        };
      }
    }

    // 5) 解压到 staging(zip-slip / zip bomb 防御),全过才切正式目录
    const stagingDir = path.join(
      root,
      `.cindy-installing-${manifest.id}-${crypto.randomBytes(4).toString('hex')}`,
    );
    const receiptRevision = crypto.randomUUID();
    // receipt 在内容落到 finalDir 之后才创建:技能字节指纹必须从这次批准的内容
    // 目录现算,不能凭空构造。
    let receipt: GhostInstallReceipt | undefined;
    try {
      // 初始沉睡:标记在 staging 阶段就位,rename 后首个广播即沉睡态,
      // 不存在"先启用一帧再熄灯"的跳变(规则 7)。
      await this.extractToStaging(allEntries, prefix, stagingDir, {
        disabled: !initiallyEnabled,
        maxUncompressedBytes: manifest.node
          ? MAX_NODE_UNCOMPRESSED_BYTES
          : MAX_BASIC_UNCOMPRESSED_BYTES,
        trust,
      });
      // 事务标记必须在 rename 动盘**之前**落:否则 rename→写 receipt 之间崩溃会留下
      // "有 finalDir、无 receipt、无 ledger"的目录,与 legacy 安装无法区分,被迁移当
      // 存量批准掉(而崩溃窗口内同权限进程可改写 finalDir 的 manifest)。带 packageSha256
      // 让启动恢复能判定 receipt 是否已提交。
      await this.receiptStore.writePendingMutation(manifest.id, {
        kind: 'install',
        packageSha256,
        receiptRevision,
        ...(clearBuiltinTombstoneOnCommit ? { clearBuiltinTombstone: true } : {}),
      });
      this.untrustedApprovals.add(this.isolationKey(manifest.id));
      await fs.promises.rename(stagingDir, finalDir);
      try {
        receipt = createGhostInstallReceipt({
          manifest: approvedManifest,
          localeResources,
          enabled: initiallyEnabled,
          trust,
          // 指纹取自包投影而不是刚发布的 finalDir:发布后被换的字节应当在快照
          // 对账时被拒,而不是被首读钉成批准基线(P0-8)。
          skillContentSha256: await this.hashSkillContentFromPackage(
            approvedManifest,
            allEntries,
            prefix,
          ),
          packageSha256,
          revision: receiptRevision,
          ...(iconDataUrl !== undefined ? { iconDataUrl } : {}),
        });
        await this.receiptStore.write(receipt, { skillSourceDir: finalDir });
        let tombstoneClearPending = false;
        if (clearBuiltinTombstoneOnCommit) {
          try {
            this.options.clearBuiltinTombstone?.(manifest.id);
          } catch (error) {
            tombstoneClearPending = true;
            (this.options.log?.error ?? this.options.log?.warn)?.call(
              this.options.log,
              'builtin tombstone clear deferred to install recovery',
              {
                id: manifest.id,
                error: error instanceof Error ? error.message : String(error),
              },
            );
          }
        }
        // receipt 已就位 = 事务提交,清标记。清失败只多留一份标记,下轮恢复见
        // receipt.packageSha256 与标记相符即判已提交、幂等清理。
        if (!tombstoneClearPending) {
          try {
            await this.receiptStore.clearPendingMutation(manifest.id);
            this.untrustedApprovals.delete(this.isolationKey(manifest.id));
          } catch {
            // Keep quarantine while the durable journal remains.
          }
        } else {
          // The receipt and installed bytes are committed.  The remaining
          // journal only records a deferred builtin tombstone side effect and
          // must not keep an otherwise valid builtin disabled in-process.
          this.untrustedApprovals.delete(this.isolationKey(manifest.id));
        }
      } catch (error) {
        try {
          await fs.promises.rm(finalDir, { recursive: true, force: true });
          await this.receiptStore.clearPendingMutation(manifest.id);
          this.untrustedApprovals.delete(this.isolationKey(manifest.id));
        } catch (rollbackError) {
          // Keep the install journal whenever rollback cannot prove the published
          // directory is gone. Migration treats that journal as a hard block, and
          // startup recovery can finish the cleanup without re-minting approval
          // from uncommitted mutable bytes.
          (this.options.log?.error ?? this.options.log?.warn)?.call(
            this.options.log,
            'ghost install approval failed and rollback remains pending',
            {
              id: manifest.id,
              error:
                rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
            },
          );
        }
        throw error;
      }
    } catch (err) {
      await fs.promises.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
      if (err instanceof InstallExtractError) {
        return { rejection: { code: 'file-invalid', reason: err.message } };
      }
      return {
        rejection: { code: 'io', reason: err instanceof Error ? err.message : String(err) },
      };
    }
    if (!receipt) {
      return { rejection: { code: 'io', reason: '安装批准状态未能生成' } };
    }

    const ghost: InstalledGhost = {
      manifest,
      dir: finalDir,
      enabled: initiallyEnabled,
      approval: { state: 'approved', revision: receipt.revision },
      trust,
      ...(iconDataUrl !== undefined ? { iconDataUrl } : {}),
    };
    this.options.log?.info('ghost installed', { id: manifest.id, version: manifest.version });
    const projected = this.projectCommittedMutationResult(ghost);
    this.options.onChanged?.(projected.list);
    return { ghost: projected.ghost };
  }

  /**
   * 原位更新一个已装意识(装入的姊妹操作,同一 .cindy 契约):
   * - 目标必须已装且 id 一致(装没装以目录为准,与 list 同一事实源);
   * - 唤醒/沉睡状态延续当前值(更新 ≠ 重新授权运行,也不偷偷点亮);
   * - 换目录走「旧目录改名备份 → staging 转正 → 删备份」,任何一步失败
   *   都把旧版原样滚回,不存在"旧的删了新的没就位"的中间态;
   * - 布局位置天然保留(panelKind 由 id 决定,id 未变)。
   * 调用方(IPC 层)负责先熄灯沙箱,更新后由下一次派活/渲染拉起新代码。
   */
  async update(
    lizFilePath: string,
    opts: {
      expectedInstalledApproval: string;
      expectedPackageSha256?: string;
      trustOverride?: GhostHostTrustOverride;
      beforePackageCommit?: () => GhostPackageCommitPreparation | void;
      /** 目录换位完成后、任何通知或运行时收尾前触发。 */
      onPackagePlaced?: () => void;
    },
  ) {
    return this.runExclusiveMutation(() => this.updateUnlocked(lizFilePath, opts));
  }

  private async updateUnlocked(
    lizFilePath: string,
    opts: {
      expectedInstalledApproval: string;
      expectedPackageSha256?: string;
      trustOverride?: GhostHostTrustOverride;
      /** 新目录已换位、旧目录仍可回滚时执行；抛错会恢复旧版本。 */
      beforePackageCommit?: () => GhostPackageCommitPreparation | void;
      /** 目录换位完成后、任何通知或运行时收尾前触发。 */
      onPackagePlaced?: () => void;
    },
  ): Promise<{ ghost: InstalledGhost } | { rejection: InstallRejection }> {
    const parsed = await this.parse(lizFilePath);
    if ('rejection' in parsed) return parsed;
    if (
      opts?.expectedPackageSha256 !== undefined &&
      parsed.packageSha256 !== opts.expectedPackageSha256
    ) {
      return {
        rejection: {
          code: 'file-invalid',
          reason: '插件文件在确认后发生了变化，请重新选择并确认',
        },
      };
    }
    const {
      manifest,
      approvedManifest,
      localeResources,
      packageSha256,
      iconDataUrl,
      allEntries,
      prefix,
    } = parsed;
    const trust = opts?.trustOverride === 'cindy-official'
      ? CINDY_OFFICIAL_GHOST_TRUST
      : parsed.trust;

    const root = this.contentRootDir();
    const finalDir = path.join(root, manifest.id);
    if (!this.isRealDirChild(root, manifest.id)) {
      return {
        rejection: { code: 'not-installed', reason: `意识 ${manifest.id} 未装入,无从更新` },
      };
    }
    const approvalResult = this.readApproval(manifest.id);
    const actualApproval = approvalTokenFor(approvalResult);
    if (actualApproval !== opts.expectedInstalledApproval) {
      return {
        rejection: {
          code: 'state-changed',
          reason: '插件批准状态在确认后发生了变化，请重新检查权限',
        },
      };
    }
    // 延续当前唤醒/沉睡状态。旧安装尚无 receipt 时只在完整重新确认后
    // 采用原 `.disabled` 镜像；损坏 receipt 一律保持停用。
    const enabled =
      approvalResult.state === 'approved'
        ? // 读时合并后的有效值:receipt 可能因状态根短暂不可写而停在陈旧的 enabled=true,
          // 用户的停用镜像不能被一次更新静默冲掉。
          this.effectiveEnabled(finalDir, approvalResult.receipt.enabled)
        : approvalResult.state === 'legacy-unapproved'
          ? !this.isDisabledMarkerPresentSync(finalDir)
          : false;

    // 指令查重同 install,但豁免自己(新版本沿用/改名自己的指令都合法)。
    if (manifest.command !== undefined) {
      const commandFold = manifest.command.toLowerCase();
      const holder = this.list().find(
        (g) =>
          g.manifest.id !== manifest.id &&
          g.manifest.command !== undefined &&
          g.manifest.command.toLowerCase() === commandFold,
      );
      if (holder) {
        return {
          rejection: {
            code: 'command-conflict',
            reason: `指令 /${manifest.command} 已被已装意识「${holder.manifest.name}」(${holder.manifest.id})占用`,
          },
        };
      }
    }

    const rand = crypto.randomBytes(4).toString('hex');
    const stagingDir = path.join(root, `.cindy-installing-${manifest.id}-${rand}`);
    const backupDir = path.join(root, `.cindy-updating-${manifest.id}-${rand}`);
    try {
      await this.extractToStaging(allEntries, prefix, stagingDir, {
        disabled: !enabled,
        maxUncompressedBytes: manifest.node
          ? MAX_NODE_UNCOMPRESSED_BYTES
          : MAX_BASIC_UNCOMPRESSED_BYTES,
        trust,
      });
    } catch (err) {
      await fs.promises.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
      if (err instanceof InstallExtractError) {
        return { rejection: { code: 'file-invalid', reason: err.message } };
      }
      return {
        rejection: { code: 'io', reason: err instanceof Error ? err.message : String(err) },
      };
    }

    // 事务标记在两次 rename 动盘**之前**落:staging→final 之后、写 receipt 之前崩溃会
    // 留下"新字节 + 旧 receipt";恢复器旧逻辑(final 在位就删 backup)会把它固化成"按旧
    // 批准跑新代码"。标记带本次 packageSha256 + backup 目录名,让恢复能判定 receipt 是否
    // 已提交:未提交则回滚到 backup。
    const receiptRevision = crypto.randomUUID();
    try {
      await this.receiptStore.writePendingMutation(manifest.id, {
        kind: 'update',
        packageSha256,
        backupDirName: path.basename(backupDir),
        receiptRevision,
        phase: 'prepared',
        ...(approvalResult.state === 'approved' && approvalResult.receipt.packageSha256
          ? { oldPackageSha256: approvalResult.receipt.packageSha256 }
          : {}),
      });
    } catch (err) {
      await fs.promises.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
      return {
        rejection: { code: 'io', reason: err instanceof Error ? err.message : String(err) },
      };
    }
    // The durable update journal is the start of the live transaction, not just
    // a restart-recovery hint.  Quarantine the id before the first directory
    // exchange so concurrent list/spawn/host calls cannot project the old
    // receipt onto the new finalDir while the new receipt and skill snapshot
    // are still being committed.
    this.untrustedApprovals.add(this.isolationKey(manifest.id));
    const clearUpdateQuarantineAfterRollback = async (): Promise<void> => {
      try {
        await this.receiptStore.clearPendingMutation(manifest.id);
        this.untrustedApprovals.delete(this.isolationKey(manifest.id));
      } catch {
        // Keep the in-process quarantine if the journal cannot be cleared;
        // restart recovery must see the marker before authorization resumes.
      }
    };
    // 换目录:旧版先挪去备份位,新版 rename 失败即滚回,保证任何时刻都有一份完整版本在位。
    try {
      await fs.promises.rename(finalDir, backupDir);
    } catch (err) {
      await fs.promises.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
      await clearUpdateQuarantineAfterRollback();
      return {
        rejection: { code: 'io', reason: err instanceof Error ? err.message : String(err) },
      };
    }
    // Advance the durable phase after the old directory is safely in backup. If
    // this write is interrupted, recovery can infer the same state from the
    // presence of the backup and will never treat a pre-rename final as new code.
    await this.receiptStore
      .writePendingMutation(manifest.id, {
        kind: 'update',
        packageSha256,
        backupDirName: path.basename(backupDir),
        receiptRevision,
        phase: 'backed-up',
        ...(approvalResult.state === 'approved' && approvalResult.receipt.packageSha256
          ? { oldPackageSha256: approvalResult.receipt.packageSha256 }
          : {}),
      })
      .catch((error) => {
        (this.options.log?.error ?? this.options.log?.warn)?.call(
          this.options.log,
          'ghost update phase journal write failed; continuing with recoverable marker',
          {
            id: manifest.id,
            error: error instanceof Error ? error.message : String(error),
          },
        );
      });
    try {
      await fs.promises.rename(stagingDir, finalDir);
    } catch (err) {
      let rolledBack = true;
      await fs.promises.rename(backupDir, finalDir).catch((rollbackErr) => {
        rolledBack = false;
        (this.options.log?.error ?? this.options.log?.warn)?.call(
          this.options.log,
          'ghost update rollback failed; install dir left inconsistent',
          {
            id: manifest.id,
            backupDir,
            error: rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr),
          },
        );
      });
      await fs.promises.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
      // 只有回滚成功时才能清标记。回滚失败必须保留 journal，让下次启动继续收敛；
      // 清掉它会让 orphan-backup 启发式把新字节与旧 receipt 固化在一起。
      if (rolledBack) {
        await clearUpdateQuarantineAfterRollback();
      }
      return {
        rejection: {
          code: 'io',
          reason: err instanceof Error ? err.message : String(err),
          ...(rolledBack ? {} : { rollbackFailed: true }),
        },
      };
    }
    // Durable side effects (currently OAuth client migration) join the package
    // transaction after the new manifest is in place but before its receipt is
    // committed. Later failures compensate both this side effect and the
    // directory swap; either rollback failure keeps journal + quarantine.
    let packageCommitPreparation: GhostPackageCommitPreparation | undefined;
    let receipt: GhostInstallReceipt;
    try {
      packageCommitPreparation = opts.beforePackageCommit?.() ?? undefined;
      receipt = createGhostInstallReceipt({
        manifest: approvedManifest,
        localeResources,
        enabled,
        trust,
        // 同 install:指纹取自包投影,发布后的目录漂移在快照对账时 fail closed(P0-8)。
        skillContentSha256: await this.hashSkillContentFromPackage(
          approvedManifest,
          allEntries,
          prefix,
        ),
        packageSha256,
        revision: receiptRevision,
        ...(iconDataUrl !== undefined ? { iconDataUrl } : {}),
      });
      await this.receiptStore.write(receipt, { skillSourceDir: finalDir });
    } catch (err) {
      let sideEffectRolledBack = !(
        err instanceof Error &&
        'rollbackFailed' in err &&
        err.rollbackFailed === true
      );
      if (packageCommitPreparation) {
        try {
          packageCommitPreparation.rollback();
        } catch (rollbackErr) {
          sideEffectRolledBack = false;
          (this.options.log?.error ?? this.options.log?.warn)?.call(
            this.options.log,
            'ghost update side-effect rollback failed',
            {
              id: manifest.id,
              error: rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr),
            },
          );
        }
      }
      let directoryRolledBack = false;
      if (sideEffectRolledBack) {
        directoryRolledBack = true;
        await fs.promises.rm(finalDir, { recursive: true, force: true }).catch(() => undefined);
        await fs.promises.rename(backupDir, finalDir).catch((rollbackErr) => {
          directoryRolledBack = false;
          (this.options.log?.error ?? this.options.log?.warn)?.call(
            this.options.log,
            'ghost update rollback failed after receipt write failure',
            {
              id: manifest.id,
              backupDir,
              error: rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr),
            },
          );
        });
      } else {
        // Preserve the normal interrupted-update shape (new final + old backup)
        // when the side effect cannot be compensated. Startup first restores the
        // old package from this journal, then OAuth reconciliation can safely
        // restore only accounts tagged for that rolled-back client transition.
        (this.options.log?.error ?? this.options.log?.warn)?.call(
          this.options.log,
          'ghost update left package swap for startup recovery after side-effect rollback failure',
          { id: manifest.id, backupDir },
        );
      }
      const rolledBack = sideEffectRolledBack && directoryRolledBack;
      if (rolledBack) {
        await clearUpdateQuarantineAfterRollback();
      }
      return {
        rejection: {
          code: 'io',
          reason: err instanceof Error ? err.message : String(err),
          ...(rolledBack ? {} : { rollbackFailed: true }),
        },
      };
    }
    // receipt 已就位 = 事务提交,清标记后再回收 backup;顺序保证"标记在 ⟺ 可能未提交"。
    try {
      await this.receiptStore.clearPendingMutation(manifest.id);
      this.untrustedApprovals.delete(this.isolationKey(manifest.id));
    } catch {
      // Keep quarantine while the durable journal remains; recovery retries it.
    }
    try {
      packageCommitPreparation?.commit();
    } catch (err) {
      // Receipt and package bytes are already committed. Notification failure
      // must not report a false update rollback to the caller.
      this.options.log?.warn('ghost update side-effect commit notification failed', {
        id: manifest.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    await fs.promises.rm(backupDir, { recursive: true, force: true }).catch(() => {});

    const ghost: InstalledGhost = {
      manifest,
      dir: finalDir,
      enabled,
      approval: { state: 'approved', revision: receipt.revision },
      trust,
      ...(iconDataUrl !== undefined ? { iconDataUrl } : {}),
    };
    opts?.onPackagePlaced?.();
    this.options.log?.info('ghost updated', { id: manifest.id, version: manifest.version });
    const projected = this.projectCommittedMutationResult(ghost);
    this.options.onChanged?.(projected.list);
    return { ghost: projected.ghost };
  }

  /**
   * 随包种子已经由 provisioning 层逐字节对账后，为其建立 Host 批准状态。
   * 该入口不得用于市场包或任意本地目录；它不替代用户安装确认。id 必须落在注入的
   * 随包种子清单里(`isTrustedBundledId`)。
   *
   * `markerEnabled` 是安装目录 `.disabled` 兼容镜像的读数,**只往停用方向合并,
   * 不往启用方向翻**:receipt 才是授权事实,镜像文件可被外部因素移除(AV 隔离
   * 恢复/同步冲突解析/手动清理),拿它覆写 receipt 会让用户显式停用的插件在下一轮
   * 对账被静默重新启用 —— 无确认、无审计,且带 skill 槽的插件会随之重新挂进全局
   * 技能链。反方向(镜像说停用、receipt 说启用)必须照办:停用是安全方向,而且
   * 旧客户端只会写镜像文件。重新启用只有用户显式 `setEnabled(true)` 一条路。
   */
  private async publishTrustedBundledSeedUnlocked(
    id: string,
    sourceDirInput: string,
    options: {
      disabled: boolean;
      trust?: typeof CINDY_OFFICIAL_GHOST_TRUST;
    },
  ): Promise<void> {
    if (
      !isValidGhostId(id) ||
      this.options.isTrustedBundledId?.(id) !== true ||
      this.options.isTrustedBundledSource?.(id, sourceDirInput) !== true
    ) {
      throw new Error('builtin seed publish source is not trusted');
    }
    const sourceDir = path.resolve(sourceDirInput);
    if (classifyGhostDirEntrySync(sourceDir) !== 'directory') {
      throw new Error('builtin seed publish source is not a real directory');
    }
    const packageSha256 = await hashApprovedDirectory(sourceDir);
    const root = this.contentRootDir();
    const finalDir = path.join(root, id);
    const rand = crypto.randomBytes(4).toString('hex');
    const stagingDir = path.join(root, `.cindy-installing-${id}-${rand}`);
    const backupDir = path.join(root, `.cindy-updating-${id}-${rand}`);
    let finalKind: GhostDirEntryKind | 'missing';
    try {
      finalKind = classifyGhostDirEntrySync(finalDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      finalKind = 'missing';
    }
    if (finalKind !== 'missing' && finalKind !== 'directory') {
      throw new Error('builtin installed path is not a real directory');
    }

    try {
      await copyBundledSeedDirectory(sourceDir, stagingDir);
      if (options.disabled) {
        await fs.promises.writeFile(path.join(stagingDir, DISABLED_MARKER_FILE), '');
      }
      if (options.trust) {
        await fs.promises.writeFile(
          path.join(stagingDir, TRUST_METADATA_FILE),
          `${JSON.stringify(options.trust, null, 2)}\n`,
        );
      }
      if (finalKind === 'missing') {
        await this.receiptStore.writePendingMutation(id, { kind: 'install', packageSha256 });
        this.untrustedApprovals.add(this.isolationKey(id));
        await fs.promises.rename(stagingDir, finalDir);
        return;
      }

      await this.receiptStore.writePendingMutation(id, {
        kind: 'update',
        packageSha256,
        backupDirName: path.basename(backupDir),
        phase: 'prepared',
      });
      this.untrustedApprovals.add(this.isolationKey(id));
      await fs.promises.rename(finalDir, backupDir);
      await this.receiptStore.writePendingMutation(id, {
        kind: 'update',
        packageSha256,
        backupDirName: path.basename(backupDir),
        phase: 'backed-up',
      });
      await fs.promises.rename(stagingDir, finalDir);
      await this.receiptStore.writePendingMutation(id, {
        kind: 'update',
        packageSha256,
        backupDirName: path.basename(backupDir),
        phase: 'published',
      });
    } catch (error) {
      await fs.promises.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
      const backupKind = await classifyGhostDirEntry(backupDir).catch((entryError) => {
        if ((entryError as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw entryError;
      });
      const publishedKind = await classifyGhostDirEntry(finalDir).catch((entryError) => {
        if ((entryError as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw entryError;
      });
      if (backupKind === 'directory' && publishedKind === null) {
        try {
          await fs.promises.rename(backupDir, finalDir);
          await this.receiptStore.clearPendingMutation(id);
          this.untrustedApprovals.delete(this.isolationKey(id));
        } catch {
          // Keep the journal for startup recovery when rollback cannot complete now.
        }
      } else if (backupKind === null && publishedKind === null) {
        try {
          await this.receiptStore.clearPendingMutation(id);
          this.untrustedApprovals.delete(this.isolationKey(id));
        } catch {
          // Keep the in-process quarantine while the journal remains.
        }
      }
      throw error;
    }
  }

  async approveTrustedBundledInstall(
    manifest: GhostManifest,
    markerEnabled: boolean,
    options: { sourceDir: string },
  ): Promise<boolean> {
    return this.runExclusiveMutation((mutation) =>
      mutation.approveTrustedBundledInstall(manifest, markerEnabled, options),
    );
  }

  private async approveTrustedBundledInstallUnlocked(
    manifest: GhostManifest,
    markerEnabled: boolean,
    options: { sourceDir: string },
  ): Promise<boolean> {
    if (this.options.isTrustedBundledId?.(manifest.id) !== true) {
      throw new Error(
        `approveTrustedBundledInstall 只服务随包种子插件:${manifest.id} 不在种子清单里`,
      );
    }
    const dir = path.join(this.contentRootDir(), manifest.id);
    if (!options || typeof options.sourceDir !== 'string' || options.sourceDir.trim() === '') {
      throw new Error('approveTrustedBundledInstall requires a verified bundled source directory');
    }
    const sourceDir = path.resolve(options.sourceDir);
    if (sourceDir === path.resolve(dir)) {
      throw new Error('approveTrustedBundledInstall refuses the mutable installed directory');
    }
    if (this.options.isTrustedBundledSource?.(manifest.id, sourceDir) !== true) {
      throw new Error('approveTrustedBundledInstall source is outside the trusted seed roster');
    }
    if (classifyGhostDirEntrySync(sourceDir) !== 'directory') {
      throw new Error('approveTrustedBundledInstall source is not a real directory');
    }
    const sourceManifestPath = resolveGhostContentPathSync(sourceDir, GHOST_MANIFEST_FILE, {
      expect: 'file',
      label: 'bundled manifest',
    });
    const sourceManifestRaw = JSON.parse(fs.readFileSync(sourceManifestPath, 'utf8')) as unknown;
    const sourceManifest = validateGhostManifest(sourceManifestRaw);
    const expectedManifest = validateGhostManifest(manifest);
    if (
      !sourceManifest.ok ||
      !expectedManifest.ok ||
      !isDeepStrictEqual(sourceManifest.manifest, expectedManifest.manifest)
    ) {
      throw new Error('approveTrustedBundledInstall source manifest does not match approval');
    }
    const localeResources = this.readApprovedLocaleResources(sourceDir, manifest);
    const iconDataUrl = this.readInstalledIconDataUrl(sourceDir, manifest) ?? undefined;
    const packageSha256 = await hashApprovedDirectory(sourceDir);
    const skillContentSha256 = await hashApprovedSkillContent(manifest, sourceDir);
    const pendingPublish = this.receiptStore.readPendingMutationSync(manifest.id);
    if (pendingPublish.state === 'invalid' || pendingPublish.state === 'unreadable') {
      throw new Error(`builtin seed publish journal is ${pendingPublish.state}`);
    }
    if (pendingPublish.state === 'valid' && pendingPublish.mutation.kind === 'uninstall') {
      throw new Error('builtin seed publish journal conflicts with uninstall');
    }
    if (
      pendingPublish.state === 'valid' &&
      (pendingPublish.mutation.kind === 'install' || pendingPublish.mutation.kind === 'update') &&
      pendingPublish.mutation.packageSha256 !== packageSha256
    ) {
      throw new Error('builtin seed publish journal does not match immutable source');
    }
    const trust = CINDY_OFFICIAL_GHOST_TRUST;
    const current = this.readApproval(manifest.id);
    // priorEnabled 直接读盘上的 receipt 而不是 readApproval 的投影:进程内隔离态的
    // receipt 不可作授权事实,但"曾经停用"这个位只用于往下拉,是 fail closed 方向,
    // 采纳它只会更保守 —— 否则"隔离 + 镜像同时丢失"的组合会让自愈把插件带回启用。
    const persisted = current.state === 'approved' ? current : this.receiptStore.read(manifest.id);
    const priorEnabled = persisted.state === 'approved' ? persisted.receipt.enabled : undefined;
    const enabled = priorEnabled === undefined ? markerEnabled : markerEnabled && priorEnabled;
    if (enabled !== markerEnabled) {
      // receipt 钉着停用而镜像丢了:把 `.disabled` 补写回去,守住"回滚到旧客户端时
      // 按镜像判启停"的降级承诺。写不进不影响批准事实,receipt 仍是权威。
      try {
        this.writeDisabledMarkerSync(dir);
      } catch (err) {
        this.options.log?.warn('ghost disabled mirror rewrite failed', {
          id: manifest.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (
      current.state === 'approved' &&
      isDeepStrictEqual(current.receipt.manifest, manifest) &&
      isDeepStrictEqual(current.receipt.localeResources, localeResources) &&
      isDeepStrictEqual(current.receipt.trust, trust) &&
      isDeepStrictEqual(current.receipt.skillContentSha256, skillContentSha256) &&
      current.receipt.packageSha256 === packageSha256 &&
      current.receipt.iconDataUrl === iconDataUrl
    ) {
      // Receipt equality is not enough for a no-op: the skill snapshot is a
      // separately materialized authorization projection and may have been
      // deleted or modified by an external cleanup/sync process. Re-enter the
      // normal receipt writer when the derived snapshot is unhealthy so the
      // immutable bundled seed can rebuild it without user action.
      const snapshotHealthy =
        (manifest.skill?.items.length ?? 0) === 0 ||
        (await this.receiptStore.skillSnapshotMatchesReceipt(
          current.receipt,
          this.receiptStore.skillSnapshotRoot(manifest.id, current.receipt.revision),
        ));
      if (!snapshotHealthy) {
        // Snapshot repair must persist the same one-way disabled merge as the
        // healthy-snapshot path. Otherwise deleting the compatibility marker
        // after this early return could silently re-enable the plugin.
        await this.receiptStore.write({
          ...current.receipt,
          enabled,
        }, { skillSourceDir: sourceDir });
        await this.finishTrustedBundledPublish(manifest.id, pendingPublish);
        this.untrustedApprovals.delete(this.isolationKey(manifest.id));
        return true;
      }
      if (current.receipt.enabled !== enabled) {
        await this.receiptStore.write({
          ...current.receipt,
          enabled,
        }, { skillSourceDir: sourceDir });
        await this.finishTrustedBundledPublish(manifest.id, pendingPublish);
        this.untrustedApprovals.delete(this.isolationKey(manifest.id));
        return true;
      }
      await this.finishTrustedBundledPublish(manifest.id, pendingPublish);
      // Receipt already matches the immutable seed — no write needed,
      // but the process-internal untrusted approval quarantine from
      // publishTrustedBundledSeed must still be cleared.  The other
      // two branches (full write and enabled toggle) both clear it;
      // without it here, the no-op path leaves the plugin quarantined
      // until the next restart (P1, PRRT_kwDOTgdRUs6YcxiH).
      this.untrustedApprovals.delete(this.isolationKey(manifest.id));
      return false;
    }
    await this.receiptStore.write(
      createGhostInstallReceipt({
        manifest,
        localeResources,
        enabled,
        trust,
        skillContentSha256,
        packageSha256,
        ...(iconDataUrl !== undefined ? { iconDataUrl } : {}),
      }),
      { skillSourceDir: sourceDir },
    );
    await this.finishTrustedBundledPublish(manifest.id, pendingPublish);
    this.untrustedApprovals.delete(this.isolationKey(manifest.id));
    return true;
  }

  private async finishTrustedBundledPublish(
    id: string,
    pending: ReturnType<GhostInstallReceiptStore['readPendingMutationSync']>,
  ): Promise<void> {
    if (pending.state === 'missing') return;
    if (pending.state !== 'valid' || pending.mutation.kind === 'uninstall') {
      throw new Error('builtin seed publish journal cannot be committed');
    }
    await this.receiptStore.clearPendingMutation(id);
    if (pending.mutation.kind === 'update') {
      await fs.promises
        .rm(path.join(this.contentRootDir(), pending.mutation.backupDirName), {
          recursive: true,
          force: true,
        })
        .catch(() => undefined);
    }
  }

  /**
   * 撤销 Host 批准。**契约是"调用返回后该插件一定不再被授权运行"**：正常路径删掉
   * receipt 与技能快照；删不掉(状态根不可写等)时退回进程内隔离，不把失败原样抛给
   * 调用方去自己 fail closed —— 那正是上一版留下 fail-open 的地方。
   */
  async removeInstallApproval(id: string): Promise<boolean> {
    return this.runExclusiveMutation((mutation) => mutation.removeInstallApproval(id));
  }

  private async removeInstallApprovalUnlocked(id: string): Promise<boolean> {
    try {
      await this.receiptStore.remove(id);
      this.untrustedApprovals.delete(this.isolationKey(id));
      return true;
    } catch (err) {
      this.untrustedApprovals.add(this.isolationKey(id));
      // 这行是"插件已转进程内隔离"的唯一可观测信号,不能因为注入的 logger 没实现
      // error 就静默丢掉 —— 退化到 warn。
      const log = this.options.log;
      (log?.error ?? log?.warn)?.call(
        log,
        'ghost approval could not be removed; kept untrusted in-process',
        { id, error: err instanceof Error ? err.message : String(err) },
      );
      return false;
    }
  }

  private readApprovedLocaleResources(
    dir: string,
    manifest: GhostManifest,
  ): Record<string, GhostManifestLocaleResource> {
    const resources: Record<string, GhostManifestLocaleResource> = {};
    const realDir = fs.realpathSync(dir);
    for (const localePath of Object.values(manifest.locales ?? {})) {
      if (!localePath) continue;
      // 逐段解析:只 lstat 最终段挡不住"中间段被换成链接"——那会把插件目录之外的
      // JSON 读成已批准的界面文案钉进 receipt。判据与技能目录同源。
      const absPath = resolveGhostContentPathSync(dir, localePath, {
        expect: 'file',
        label: 'bundled locale',
      });
      const bytes = readBoundedFileNoFollowSync(absPath, GHOST_LOCALE_MAX_BYTES, {
        containWithin: realDir,
      });
      if (bytes === null) throw new Error(`bundled locale missing or oversized: ${localePath}`);
      const raw = JSON.parse(bytes.toString('utf8')) as unknown;
      const validated = validateGhostManifestLocaleResource(raw, manifest);
      if (!validated.ok) throw new Error(`bundled locale invalid: ${localePath}`);
      resources[localePath] = validated.resource;
    }
    return resources;
  }

  /** 解压 zip 条目到 staging 目录(install / update 共用;含 zip-slip / bomb 防御)。 */
  private async extractToStaging(
    allEntries: JSZip.JSZipObject[],
    prefix: string,
    stagingDir: string,
    opts: {
      disabled: boolean;
      maxUncompressedBytes: number;
      trust: GhostTrustInfo;
    },
  ): Promise<void> {
    await fs.promises.mkdir(stagingDir, { recursive: true });
    let totalBytes = 0;
    for (const entry of allEntries) {
      const relName = entry.name.slice(prefix.length);
      if (relName.length === 0) continue; // 顶层包裹文件夹本身
      const dest = safeJoin(stagingDir, relName);
      if (!dest) throw new InstallExtractError(`压缩包内有非法路径:${entry.name}`);
      if (entry.dir) {
        await fs.promises.mkdir(dest, { recursive: true });
        continue;
      }
      const data = await entry.async('nodebuffer');
      totalBytes += data.byteLength;
      if (totalBytes > opts.maxUncompressedBytes) {
        throw new InstallExtractError(`解压后总大小超过上限(${opts.maxUncompressedBytes} 字节)`);
      }
      await fs.promises.mkdir(path.dirname(dest), { recursive: true });
      await fs.promises.writeFile(dest, data);
    }
    if (opts.disabled) {
      await fs.promises.writeFile(path.join(stagingDir, DISABLED_MARKER_FILE), '');
    }
    await fs.promises.writeFile(
      path.join(stagingDir, TRUST_METADATA_FILE),
      `${JSON.stringify(
        {
          ...opts.trust,
        },
        null,
        2,
      )}\n`,
    );
  }

  /**
   * 卸下一个意识(删除其目录;布局树里的位置记录由布局引擎保留)。
   *
   * Host 需要在内置意识卸载后先写 tombstone，再向 renderer 发布一份
   * 已安装 + 可恢复相互一致的快照。notify=false 只延后广播，不改变卸载语义。
   */
  async uninstall(id: string, options: GhostUninstallOptions = {}) {
    return this.runExclusiveMutation(() => this.uninstallUnlocked(id, options));
  }

  private async uninstallUnlocked(
    id: string,
    options: GhostUninstallOptions = {},
  ): Promise<UninstallResult> {
    if (!isValidGhostId(id)) {
      return { rejection: { code: 'invalid-id', reason: '非法意识 id' } };
    }
    const root = this.contentRootDir();
    const dir = path.join(root, id);
    // 双保险:id 格式校验已排除路径穿越,这里再确认是 root 的直接子目录。
    if (path.dirname(dir) !== path.resolve(root) && path.dirname(dir) !== root) {
      return { rejection: { code: 'invalid-id', reason: '非法意识 id' } };
    }
    if (!this.isRealDirChild(root, id)) {
      return { rejection: { code: 'not-installed', reason: `意识 ${id} 未装入` } };
    }
    // 顺序是安全要点:先撤批准(receipt + 快照 + 隔离),再删内容目录。反过来(旧写法)
    // 若崩在两步之间,会留下"孤立 approved receipt + 目录暂缺";之后同 id 路径被恢复/
    // 同权限进程新建目录时,list() 会拿这份陈旧 receipt 授权那个目录(manifest/slots/
    // trust 全来自 receipt),等于卸载过的插件被"借尸还魂"。事务标记让崩溃后的启动恢复
    // 把这次卸载收尾干净。
    const builtinTombstone =
      options.recordBuiltinTombstone !== false && this.options.isTrustedBundledId?.(id) === true;
    await this.receiptStore.writePendingMutation(id, {
      kind: 'uninstall',
      ...(builtinTombstone ? { builtinTombstone: true } : {}),
    });
    this.untrustedApprovals.add(this.isolationKey(id));
    if (builtinTombstone) {
      try {
        if (!this.options.recordBuiltinTombstone) {
          throw new Error('builtin uninstall has no tombstone writer');
        }
        this.options.recordBuiltinTombstone(id);
      } catch (err) {
        // Tombstone persistence is part of the uninstall transaction.  If it
        // fails, roll back the pending journal and in-process quarantine so a
        // reported failure cannot be completed by startup recovery later.
        const journalCleared = await this.receiptStore
          .clearPendingMutation(id)
          .then(() => true)
          .catch(() => false);
        if (journalCleared) this.untrustedApprovals.delete(this.isolationKey(id));
        return {
          rejection: { code: 'io', reason: err instanceof Error ? err.message : String(err) },
        };
      }
    }
    // 走同一个撤销入口:成功即清掉隔离记录,失败由该入口转进程内隔离并记日志。撤批准
    // 在删目录之前 —— 即便随后删目录失败/崩溃,也不会留下"目录在 + 旧 receipt 授权"。
    const approvalRemoved = await this.removeInstallApprovalUnlocked(id);
    try {
      await fs.promises.rm(dir, { recursive: true, force: true });
    } catch (err) {
      // 批准已撤、标记还在:插件此刻已 fail closed(list 无 receipt → legacy-unapproved),
      // 下次启动恢复据标记把残留目录删净。如实报 io,不假装卸载完成。
      return {
        rejection: { code: 'io', reason: err instanceof Error ? err.message : String(err) },
      };
    }
    // Receipt 删除失败时保留 uninstall journal，即使内容目录已经删掉；下次启动
    // 仍需据 journal 清理孤立 receipt，不能让进程内隔离随重启丢失。
    if (approvalRemoved) {
      await this.receiptStore.clearPendingMutation(id).catch(() => undefined);
      this.untrustedApprovals.delete(this.isolationKey(id));
    } else {
      this.options.log?.warn('ghost uninstall left journal for approval cleanup', { id });
    }
    this.options.log?.info('ghost uninstalled', { id });
    if (options.notify !== false) this.options.onChanged?.(this.list());
    return { ok: true };
  }
}

/** staging 期的"内容不合格"错误(与环境 IO 错误区分,映射 file-invalid)。 */
class InstallExtractError extends Error {}

function approvalTokenFor(result: GhostInstallReceiptReadResult): string {
  return result.state === 'approved'
    ? ghostInstallApprovalToken({
        state: 'approved',
        revision: result.receipt.revision,
      })
    : ghostInstallApprovalToken({ state: result.state });
}

/** 流式读取 zip 单条目；超过上限立刻停流，不先分配整个恶意条目。 */
async function readZipEntryBufferWithLimit(
  entry: JSZip.JSZipObject,
  maxBytes: number,
  label: string,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  await consumeZipEntry(entry, (chunk, stream) => {
    total += chunk.byteLength;
    if (total > maxBytes) {
      stream.destroy();
      throw new InstallExtractError(`${label} 超过上限(${maxBytes} 字节)`);
    }
    chunks.push(chunk);
  });
  return Buffer.concat(chunks, total);
}

/** 流式核对整个包的真实解压总量；JSZip 同时会校验声明大小与真实输出一致。 */
async function assertZipUncompressedLimit(
  entries: JSZip.JSZipObject[],
  maxBytes: number,
): Promise<void> {
  let total = 0;
  for (const entry of entries) {
    if (entry.dir) continue;
    await consumeZipEntry(entry, (chunk, stream) => {
      total += chunk.byteLength;
      if (total > maxBytes) {
        stream.destroy();
        throw new InstallExtractError(`解压后总大小超过上限(${maxBytes} 字节)`);
      }
    });
  }
}

/** 把 JSZip 的 Node 流收成 Promise，并保证回调抛错时终止继续解压。 */
async function consumeZipEntry(
  entry: JSZip.JSZipObject,
  onChunk: (chunk: Buffer, stream: NodeJS.ReadableStream & { destroy(): void }) => void,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const stream = entry.nodeStream() as NodeJS.ReadableStream & { destroy(): void };
    let settled = false;
    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    stream.on('data', (value) => {
      if (settled) return;
      try {
        onChunk(Buffer.isBuffer(value) ? value : Buffer.from(value), stream);
      } catch (err) {
        fail(err);
      }
    });
    stream.on('error', fail);
    stream.on('end', () => {
      if (settled) return;
      settled = true;
      resolve();
    });
  });
}

/** icon 字节 → data URL(扩展名白名单已由清单校验保证,mime 不命中返回 null 兜底)。 */
function buildIconDataUrl(iconPath: string, data: Buffer): string | null {
  const mime = ghostIconMimeType(iconPath);
  if (!mime) return null;
  return `data:${mime};base64,${data.toString('base64')}`;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.promises.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * legacy backfill 的错误分类:**带 errno 且非 ENOENT** = 瞬时环境故障
 * (EACCES/EBUSY/EIO/ENOSPC…,状态根写不动、文件被占等),应下次启动自动重试,不能
 * 记进 completed 台账的 failedIds 永久封死(§5 瞬时故障自动重试)。无 errno 的校验错
 * (manifest 不合法、技能目录含链接、locale 装入后损坏)与 ENOENT(声明文件缺失 = 内容
 * 状态)是**确定性**内容无效,fail closed 走每插件恢复 UI。
 *
 * 前提:`backfillLegacyApproval` 及其调用链对 fs 错误原样传播、保留 errno —— 一旦某处
 * 把它包成不带 code 的 `new Error()`,瞬时故障就会被误判成确定性 failed(本函数的判据
 * 就落空了),这正是被修掉的 P1。
 */
function isTransientBackfillError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return typeof code === 'string' && code !== 'ENOENT';
}

/** Copy a bundled seed without following links; dot entries are Host state and are skipped. */
async function copyBundledSeedDirectory(from: string, to: string): Promise<void> {
  await fs.promises.mkdir(to, { recursive: true });
  for (const entry of await fs.promises.readdir(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    const kind = await classifyGhostDirEntry(source);
    if (kind !== 'directory' && kind !== 'file') {
      throw new Error(`builtin seed rejects non-regular entry: ${entry.name}`);
    }
    if (entry.name.startsWith('.')) continue;
    if (kind === 'directory') await copyBundledSeedDirectory(source, target);
    else await fs.promises.copyFile(source, target);
  }
}

/**
 * 安装目录内容指纹(`packageSha256`,审计用的漂移检测器,不作授权判据)。
 *
 * 遍历、类型判定与指纹格式全部取自 `ghostContentTree`,与技能指纹
 * `hashApprovedSkillContent`、随包种子指纹 `fingerprintDirContent` 同一份实现;
 * 这里的显式策略是"点开头条目不算内容、非普通条目一律拒"。跟随链接在这条路径上
 * 最多多写一次批准、不构成绕过,判据对齐是因为"同一判据散落多处且各处不一致"
 * 本身就是缺陷温床。
 */
async function hashApprovedDirectory(root: string): Promise<string> {
  const tree = await collectGhostContentFiles(root, {
    dotEntries: 'skip',
    nonRegular: 'throw',
    label: 'bundled Plugin',
  });
  return hashGhostContentFiles(root, tree.files, tree.rootIdentity);
}

/**
 * 检测所有条目是否都在同一个顶层文件夹下(用户右键压缩常见形态),
 * 是则返回该前缀(含尾部 /),否则返回空串。
 */
function detectSingleTopFolderPrefix(names: string[]): string {
  let top: string | null = null;
  for (const name of names) {
    const normalized = name.replace(/\\/g, '/');
    const slash = normalized.indexOf('/');
    if (slash <= 0) return ''; // 根部就有文件 → 没有统一包裹层
    const first = normalized.slice(0, slash);
    if (top === null) top = first;
    else if (top !== first) return '';
  }
  return top === null ? '' : `${top}/`;
}

/**
 * 非规范 zip 条目路径:绝对路径、盘符、`.`/`..` 段或空段(`a//b`)。
 * 这些名字解析(canonical)后可与原始名指向不同文件,必须整包拒绝。
 * 目录条目的尾部 `/` 是 zip 的合法形态,不算空段。
 */
function hasNonCanonicalZipPath(name: string): boolean {
  const normalized = name.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) return true;
  const segments = normalized.split('/');
  return segments.some(
    (seg, i) => seg === '.' || seg === '..' || (seg === '' && i !== segments.length - 1),
  );
}

/** 防 zip-slip:解压目标必须严格落在 dest 内部(不含 dest 本身),越界返回 null。 */
function safeJoin(dest: string, relPath: string): string | null {
  const normalized = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
  const resolved = path.resolve(dest, normalized);
  const rel = path.relative(path.resolve(dest), resolved);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return resolved;
}
