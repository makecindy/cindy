import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import JSZip from 'jszip';

import {
  GHOST_MANIFEST_FILE,
  GHOST_LOCALE_MAX_BYTES,
  GHOST_SKILL_MD_MAX_BYTES,
  ghostLocalePathFor,
  ghostInstallApprovalToken,
  ghostIconMimeType,
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
import {
  verifyGhostZipSignatures,
  type GhostTrustRegistry,
} from './ghostSignature.js';
import { isPathInsideDir } from './dirDeposit.js';
import {
  collectGhostContentFiles,
  hashGhostContentFiles,
  resolveGhostContentPathSync,
} from './ghostContentTree.js';
import { checkSkillMdConsistency } from './skillSlot.js';
import {
  createGhostInstallReceipt,
  GhostInstallReceiptStore,
  hashApprovedSkillContent,
  type GhostInstallReceipt,
  type GhostInstallReceiptReadResult,
} from './ghostInstallReceipt.js';

/** 普通沙箱插件维持小包上限；随包 Node/CLI 允许更大的预打包产物。 */
export const MAX_BASIC_CINDY_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_NODE_CINDY_FILE_BYTES = 128 * 1024 * 1024;
/** 身份卡本身只应是小 JSON；先限流读取，避免在识别包类型前被单文件撑爆内存。 */
const MAX_GHOST_MANIFEST_BYTES = 256 * 1024;
/**
 * icon 文件大小上限。icon 以 data URL 形态随 ghosts:list(sendSync)下发,
 * 上限同时保护装载与首帧同步 IPC 的载荷体积。
 */
const MAX_GHOST_ICON_BYTES = 512 * 1024; // 512 KB
/** 解压后总大小/条目数上限；Node 包允许携带已打包 CLI，但仍有硬闸。 */
export const MAX_BASIC_UNCOMPRESSED_BYTES = 32 * 1024 * 1024;
export const MAX_NODE_UNCOMPRESSED_BYTES = 256 * 1024 * 1024;
export const MAX_BASIC_ZIP_ENTRIES = 256;
export const MAX_NODE_ZIP_ENTRIES = 2_048;
/** 停用标记文件名(安装目录内;存在即停用)。 */
const DISABLED_MARKER_FILE = '.disabled';
/** 安装时已验证的信任结果快照(作者包不能提供，staging 阶段由主机写)。 */
const TRUST_METADATA_FILE = '.cindy-trust.json';

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
  /** 装/卸成功后通知(index.ts 用它广播 ghosts:changed 到所有窗口)。 */
  onChanged?: (ghosts: InstalledGhost[]) => void;
  /** 当前宿主语言；插件未提供时由 shared 契约固定回退英文。 */
  getLocale?: () => string;
  /**
   * `approveTrustedBundledInstall` 的 builtin-only 边界:id 是否对应一颗随包种子。
   * 生产接线必须提供 —— 该入口不经用户确认就铸出批准,此前这条边界只靠"唯一
   * 调用者是随包对账"的纪律,没有运行期强制。未注入时不加门(单测直接驱动)。
   */
  isTrustedBundledId?: (id: string) => boolean;
  /** Cindy 维护的发布者/审核公钥表；缺省为空，签名仍验完整性但不抬身份等级。 */
  trustRegistry?: GhostTrustRegistry;
  log?: GhostManagerLogger;
}

/** install / update 的失败分类 —— IPC 层据此映射错误码。 */
export type InstallRejection =
  | { code: 'source-not-found'; reason: string }
  | { code: 'file-invalid'; reason: string }
  | { code: 'already-installed'; reason: string }
  | { code: 'not-installed'; reason: string }
  | { code: 'command-conflict'; reason: string }
  | { code: 'state-changed'; reason: string }
  | { code: 'io'; reason: string };

export type UninstallRejection =
  | { code: 'invalid-id'; reason: string }
  | { code: 'not-installed'; reason: string }
  | { code: 'approval-required'; reason: string }
  | { code: 'io'; reason: string };

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
  private mutationTail: Promise<void> = Promise.resolve();
  /**
   * 本进程内被判定"批准状态不可信"的插件 id。
   *
   * 用途只有一个:撤销陈旧批准**失败**时的兜底。撤销失败的成因(状态根不可写)与
   * 写批准失败的成因是同一个,所以不能再指望往状态根写任何东西来表达"已失效" ——
   * 内存标记是此时唯一还能用的机制。下次启动重新对账,成功即自愈;仍然失败就仍然
   * 隔离,始终 fail closed。
   */
  private readonly untrustedApprovals = new Set<string>();

  constructor(private readonly options: GhostManagerOptions) {
    this.receiptStore = new GhostInstallReceiptStore(
      options.getStateDir ??
        (() => {
          const root = path.resolve(options.getRootDir());
          return path.join(path.dirname(root), `${path.basename(root)}-install-state`);
        }),
    );
    const contentRoot = path.resolve(options.getRootDir());
    const stateRoot = this.receiptStore.rootDir();
    if (
      isPathInsideDir(contentRoot, stateRoot) ||
      isPathInsideDir(stateRoot, contentRoot)
    ) {
      throw new Error('ghost install content and approval state roots must be disjoint');
    }
  }

  /** Forge 等 Host 能力必须排除的受管根（内容根 + 批准状态根）。 */
  managedRootDirs(): string[] {
    return [path.resolve(this.options.getRootDir()), this.receiptStore.rootDir()];
  }

  approvalStateRoot(): string {
    return this.receiptStore.rootDir();
  }

  /**
   * 读批准状态的**唯一入口**:进程内隔离优先于磁盘上的 receipt。
   *
   * 所有消费方(list / setEnabled / update 的 token 比对)都必须走这里 —— 各自直接
   * 调 receiptStore.read() 会让隔离在某条路径上失效,那类"同一判定散落多处"的分叉
   * 正是本 PR 前几轮反复出问题的原因。
   */
  private readApproval(id: string): GhostInstallReceiptReadResult {
    if (this.untrustedApprovals.has(id)) {
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
    if (
      ghost.approval.state !== 'approved' ||
      !ghost.manifest.skill?.items.length ||
      !ghost.approvedSkillRoot
    ) {
      return false;
    }
    const current = this.readApproval(ghost.manifest.id);
    if (
      current.state !== 'approved' ||
      current.receipt.revision !== ghost.approval.revision
    ) {
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

  /** Serialize content-directory and approval-receipt mutations as one Host transaction lane. */
  async runExclusiveMutation<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationTail;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.mutationTail = previous.then(() => gate);
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  /** 扫描已装意识(同步 —— renderer 首帧 sendSync 拉取,目录极小不卡启动)。 */
  list(): InstalledGhost[] {
    const root = this.options.getRootDir();
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      return []; // 根目录还不存在 = 没装过任何意识
    }

    const result: InstalledGhost[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.')) continue; // staging / 系统目录
      const dir = path.join(root, entry.name);
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
          enabled: receipt.enabled,
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
      const manifestPath = path.join(dir, GHOST_MANIFEST_FILE);
      let raw: unknown;
      try {
        raw = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      } catch (err) {
        this.options.log?.warn('ghost dir skipped: unreadable manifest', {
          dir,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
      const v = validateGhostManifest(raw);
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
      // icon 读失败只降级为无图标(warn),不影响意识本体可用。
      const iconDataUrl = this.readInstalledIconDataUrl(dir, v.manifest);
      const localizedManifest = this.readInstalledLocalizedManifest(dir, v.manifest);
      result.push({
        manifest: localizedManifest,
        dir,
        enabled: false,
        approval: { state: approvalResult.state },
        ...(iconDataUrl !== null ? { iconDataUrl } : {}),
      });
    }
    result.sort((a, b) => a.manifest.id.localeCompare(b.manifest.id));
    return result;
  }

  /** receipt 内的 base manifest + 已批准 locale 资源；不再读取可变安装目录。 */
  private localizeApprovedManifest(receipt: GhostInstallReceipt): GhostManifest {
    const requestedLocale = this.options.getLocale?.();
    const runtimeManifest = withGhostResolvedLocale(receipt.manifest, requestedLocale);
    const localePath = ghostLocalePathFor(receipt.manifest, requestedLocale);
    const fallbackPath = receipt.manifest.locales?.en;
    const candidates = [...new Set([localePath, fallbackPath].filter((value): value is string => Boolean(value)))];
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
    const candidates = [...new Set([localePath, fallbackPath].filter((value): value is string => Boolean(value)))];
    for (const candidatePath of candidates) {
      try {
        // 逐段解析(判据与批准侧 readApprovedLocaleResources、技能目录同源)。
        // 上一版在这里用 realpath + 目录钳制自成一套:同一件事两种写法,改了一处
        // 忘另一处正是这条链路反复出问题的形态,现在统一成"链接一律拒"。
        const absPath = resolveGhostContentPathSync(dir, candidatePath, {
          expect: 'file',
          label: 'ghost locale',
        });
        const stat = fs.lstatSync(absPath);
        if (stat.size > GHOST_LOCALE_MAX_BYTES) {
          throw new Error(`locale 文件缺失或超过 ${GHOST_LOCALE_MAX_BYTES} 字节`);
        }
        const raw = JSON.parse(fs.readFileSync(absPath, 'utf8'));
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
    const dir = path.join(this.options.getRootDir(), id);
    if (!(await pathExists(dir))) {
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
    const marker = path.join(dir, DISABLED_MARKER_FILE);
    const previousEnabled =
      receiptResult.state === 'approved' ? receiptResult.receipt.enabled : false;
    try {
      if (enabled) {
        await fs.promises.rm(marker, { force: true });
      } else {
        await fs.promises.writeFile(marker, '');
      }
      if (receiptResult.state === 'approved') {
        // 快照被外部删掉时从当前安装目录重建(内容与批准 manifest 的一致性由
        // ensureSkillSnapshot 的 SKILL.md 逐字校验兜住);停用方向即使重建不了
        // 也照样落盘，由技能对账把落链撤掉。
        await this.receiptStore.write(
          { ...receiptResult.receipt, enabled },
          { skillSourceDir: dir, requireSkillSnapshot: enabled },
        );
      }
    } catch (err) {
      // `.disabled` 是旧版本兼容镜像；receipt 写失败时尽力把镜像回滚，
      // 避免降级运行旧客户端时看到与批准状态相反的启用态。
      if (previousEnabled) {
        await fs.promises.rm(marker, { force: true }).catch(() => undefined);
      } else {
        await fs.promises.writeFile(marker, '').catch(() => undefined);
      }
      return { rejection: { code: 'io', reason: err instanceof Error ? err.message : String(err) } };
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
      // 逐段解析而不是 `stat` 直读:`stat` 静默穿透链接,会把插件目录之外的字节
      // 读成 icon 下发给 renderer 并钉进 receipt。判据与技能目录 / locale 同源。
      const iconPath = resolveGhostContentPathSync(dir, manifest.icon, {
        expect: 'file',
        label: 'ghost icon',
      });
      const stat = fs.lstatSync(iconPath);
      if (stat.size > MAX_GHOST_ICON_BYTES) {
        this.options.log?.warn('ghost icon skipped: missing or oversize', { dir, icon: manifest.icon });
        return null;
      }
      return buildIconDataUrl(manifest.icon, fs.readFileSync(iconPath));
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
  async inspect(
    lizFilePath: string,
  ): Promise<
    | {
        manifest: GhostManifest;
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
      trust: parsed.trust,
      packageSha256: parsed.packageSha256,
      ...(parsed.iconDataUrl !== undefined ? { iconDataUrl: parsed.iconDataUrl } : {}),
    };
  }

  /** 装入的前半程(读文件 / 解包 / 校验清单),inspect 与 install 共用。 */
  private async parse(
    lizFilePath: string,
  ): Promise<
    | {
        manifest: GhostManifest;
        approvedManifest: GhostManifest;
        localeResources: Record<string, GhostManifestLocaleResource>;
        trust: GhostTrustInfo;
        packageSha256: string;
        iconDataUrl?: string;
        allEntries: JSZip.JSZipObject[];
        prefix: string;
      }
    | { rejection: InstallRejection }
  > {
    // 1) 读源文件(带体积上限)
    let buf: Buffer;
    try {
      const stat = await fs.promises.stat(lizFilePath);
      if (!stat.isFile()) {
        return { rejection: { code: 'source-not-found', reason: '路径不是文件' } };
      }
      if (stat.size > MAX_NODE_CINDY_FILE_BYTES) {
        return {
          rejection: { code: 'file-invalid', reason: `文件过大:${stat.size} 字节(上限 ${MAX_NODE_CINDY_FILE_BYTES})` },
        };
      }
      buf = await fs.promises.readFile(lizFilePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { rejection: { code: 'source-not-found', reason: '文件不存在' } };
      }
      return { rejection: { code: 'io', reason: err instanceof Error ? err.message : String(err) } };
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
        rejection: { code: 'file-invalid', reason: `压缩包条目过多:${allEntries.length}(上限 ${MAX_NODE_ZIP_ENTRIES})` },
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
      return { rejection: { code: 'file-invalid', reason: `压缩包根部缺少 ${GHOST_MANIFEST_FILE}` } };
    }

    // 3) 校验清单
    let manifestRaw: unknown;
    try {
      manifestRaw = JSON.parse(
        (await readZipEntryBufferWithLimit(
          manifestEntry,
          MAX_GHOST_MANIFEST_BYTES,
          GHOST_MANIFEST_FILE,
        )).toString('utf8'),
      );
    } catch {
      return { rejection: { code: 'file-invalid', reason: `${GHOST_MANIFEST_FILE} 不是合法 JSON` } };
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
        rejection: { code: 'file-invalid', reason: `压缩包条目过多:${allEntries.length}(上限 ${maxEntries})` },
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
            (await readZipEntryBufferWithLimit(
              localeEntry,
              GHOST_LOCALE_MAX_BYTES,
              `locale ${localePath}`,
            )).toString('utf8'),
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
          rejection: { code: 'file-invalid', reason: `清单声明了 icon,但压缩包内缺少 ${v.manifest.icon}` },
        };
      }
      let iconData: Buffer;
      try {
        iconData = await readZipEntryBufferWithLimit(
          iconEntry,
          MAX_GHOST_ICON_BYTES,
          'icon',
        );
      } catch {
        return {
          rejection: {
            code: 'file-invalid',
            reason: `icon 过大(上限 ${MAX_GHOST_ICON_BYTES} 字节)`,
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
          rejection: { code: 'file-invalid', reason: `skill 条目声明了 ${skillItem.dir},但压缩包内缺少 ${relPath}` },
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
          rejection: { code: 'file-invalid', reason: `skill 条目 ${skillItem.dir}:${consistencyError}` },
        };
      }
    }

    return {
      manifest: localizedManifest,
      approvedManifest: v.manifest,
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
    opts?: { initiallyEnabled?: boolean; expectedPackageSha256?: string },
  ) {
    return this.runExclusiveMutation(() => this.installUnlocked(lizFilePath, opts));
  }

  private async installUnlocked(
    lizFilePath: string,
    opts?: { initiallyEnabled?: boolean; expectedPackageSha256?: string },
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
      trust,
      packageSha256,
      iconDataUrl,
      allEntries,
      prefix,
    } = parsed;

    // 4) 目标目录冲突检查
    const root = this.options.getRootDir();
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
    const stagingDir = path.join(root, `.cindy-installing-${manifest.id}-${crypto.randomBytes(4).toString('hex')}`);
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
      await fs.promises.rename(stagingDir, finalDir);
      try {
        receipt = createGhostInstallReceipt({
          manifest: approvedManifest,
          localeResources,
          enabled: initiallyEnabled,
          trust,
          skillContentSha256: await hashApprovedSkillContent(approvedManifest, finalDir),
          packageSha256,
          ...(iconDataUrl !== undefined ? { iconDataUrl } : {}),
        });
        await this.receiptStore.write(receipt, { skillSourceDir: finalDir });
        this.untrustedApprovals.delete(manifest.id);
      } catch (error) {
        await fs.promises.rm(finalDir, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
    } catch (err) {
      await fs.promises.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
      if (err instanceof InstallExtractError) {
        return { rejection: { code: 'file-invalid', reason: err.message } };
      }
      return { rejection: { code: 'io', reason: err instanceof Error ? err.message : String(err) } };
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
    this.options.onChanged?.(this.list());
    return { ghost };
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
    opts: { expectedInstalledApproval: string; expectedPackageSha256?: string },
  ) {
    return this.runExclusiveMutation(() => this.updateUnlocked(lizFilePath, opts));
  }

  private async updateUnlocked(
    lizFilePath: string,
    opts: { expectedInstalledApproval: string; expectedPackageSha256?: string },
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
      trust,
      packageSha256,
      iconDataUrl,
      allEntries,
      prefix,
    } = parsed;

    const root = this.options.getRootDir();
    const finalDir = path.join(root, manifest.id);
    if (!(await pathExists(finalDir))) {
      return { rejection: { code: 'not-installed', reason: `意识 ${manifest.id} 未装入,无从更新` } };
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
        ? approvalResult.receipt.enabled
        : approvalResult.state === 'legacy-unapproved'
          ? !fs.existsSync(path.join(finalDir, DISABLED_MARKER_FILE))
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
      return { rejection: { code: 'io', reason: err instanceof Error ? err.message : String(err) } };
    }

    // 换目录:旧版先挪去备份位,新版 rename 失败即滚回,保证任何时刻都有一份完整版本在位。
    try {
      await fs.promises.rename(finalDir, backupDir);
    } catch (err) {
      await fs.promises.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
      return { rejection: { code: 'io', reason: err instanceof Error ? err.message : String(err) } };
    }
    try {
      await fs.promises.rename(stagingDir, finalDir);
    } catch (err) {
      await fs.promises.rename(backupDir, finalDir).catch(() => {});
      await fs.promises.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
      return { rejection: { code: 'io', reason: err instanceof Error ? err.message : String(err) } };
    }
    // 与 install 同理:技能字节指纹从这次换入的内容目录现算。
    let receipt: GhostInstallReceipt;
    try {
      receipt = createGhostInstallReceipt({
        manifest: approvedManifest,
        localeResources,
        enabled,
        trust,
        skillContentSha256: await hashApprovedSkillContent(approvedManifest, finalDir),
        packageSha256,
        ...(iconDataUrl !== undefined ? { iconDataUrl } : {}),
      });
      await this.receiptStore.write(receipt, { skillSourceDir: finalDir });
      this.untrustedApprovals.delete(manifest.id);
    } catch (err) {
      await fs.promises.rm(finalDir, { recursive: true, force: true }).catch(() => undefined);
      await fs.promises.rename(backupDir, finalDir).catch(() => undefined);
      return { rejection: { code: 'io', reason: err instanceof Error ? err.message : String(err) } };
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
    this.options.log?.info('ghost updated', { id: manifest.id, version: manifest.version });
    this.options.onChanged?.(this.list());
    return { ghost };
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
  async approveTrustedBundledInstall(
    manifest: GhostManifest,
    markerEnabled: boolean,
  ): Promise<boolean> {
    if (this.options.isTrustedBundledId?.(manifest.id) === false) {
      throw new Error(
        `approveTrustedBundledInstall 只服务随包种子插件:${manifest.id} 不在种子清单里`,
      );
    }
    const dir = path.join(this.options.getRootDir(), manifest.id);
    const localeResources = this.readApprovedLocaleResources(dir, manifest);
    const iconDataUrl = this.readInstalledIconDataUrl(dir, manifest) ?? undefined;
    const packageSha256 = await hashApprovedDirectory(dir);
    const skillContentSha256 = await hashApprovedSkillContent(manifest, dir);
    const trust: GhostTrustInfo = {
      level: 'cindy-official',
      publisherSigned: false,
      publisherVerified: false,
      reviewed: true,
    };
    const current = this.readApproval(manifest.id);
    // priorEnabled 直接读盘上的 receipt 而不是 readApproval 的投影:进程内隔离态的
    // receipt 不可作授权事实,但"曾经停用"这个位只用于往下拉,是 fail closed 方向,
    // 采纳它只会更保守 —— 否则"隔离 + 镜像同时丢失"的组合会让自愈把插件带回启用。
    const persisted =
      current.state === 'approved' ? current : this.receiptStore.read(manifest.id);
    const priorEnabled =
      persisted.state === 'approved' ? persisted.receipt.enabled : undefined;
    const enabled =
      priorEnabled === undefined ? markerEnabled : markerEnabled && priorEnabled;
    if (enabled !== markerEnabled) {
      // receipt 钉着停用而镜像丢了:把 `.disabled` 补写回去,守住"回滚到旧客户端时
      // 按镜像判启停"的降级承诺。写不进不影响批准事实,receipt 仍是权威。
      try {
        fs.writeFileSync(path.join(dir, DISABLED_MARKER_FILE), '');
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
      if (current.receipt.enabled !== enabled) {
        await this.receiptStore.write({
          ...current.receipt,
          enabled,
        });
        this.untrustedApprovals.delete(manifest.id);
        return true;
      }
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
      { skillSourceDir: dir },
    );
    this.untrustedApprovals.delete(manifest.id);
    return true;
  }

  /**
   * 撤销 Host 批准。**契约是"调用返回后该插件一定不再被授权运行"**：正常路径删掉
   * receipt 与技能快照；删不掉(状态根不可写等)时退回进程内隔离，不把失败原样抛给
   * 调用方去自己 fail closed —— 那正是上一版留下 fail-open 的地方。
   */
  async removeInstallApproval(id: string): Promise<void> {
    try {
      await this.receiptStore.remove(id);
      this.untrustedApprovals.delete(id);
    } catch (err) {
      this.untrustedApprovals.add(id);
      // 这行是"插件已转进程内隔离"的唯一可观测信号,不能因为注入的 logger 没实现
      // error 就静默丢掉 —— 退化到 warn。
      const log = this.options.log;
      (log?.error ?? log?.warn)?.call(
        log,
        'ghost approval could not be removed; kept untrusted in-process',
        { id, error: err instanceof Error ? err.message : String(err) },
      );
    }
  }

  private readApprovedLocaleResources(
    dir: string,
    manifest: GhostManifest,
  ): Record<string, GhostManifestLocaleResource> {
    const resources: Record<string, GhostManifestLocaleResource> = {};
    for (const localePath of Object.values(manifest.locales ?? {})) {
      if (!localePath) continue;
      // 逐段解析:只 lstat 最终段挡不住"中间段被换成链接"——那会把插件目录之外的
      // JSON 读成已批准的界面文案钉进 receipt。判据与技能目录同源。
      const absPath = resolveGhostContentPathSync(dir, localePath, {
        expect: 'file',
        label: 'bundled locale',
      });
      const stat = fs.lstatSync(absPath);
      if (stat.size > GHOST_LOCALE_MAX_BYTES) {
        throw new Error(`bundled locale missing or oversized: ${localePath}`);
      }
      const raw = JSON.parse(fs.readFileSync(absPath, 'utf8')) as unknown;
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
    opts: { disabled: boolean; maxUncompressedBytes: number; trust: GhostTrustInfo },
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
      `${JSON.stringify(opts.trust, null, 2)}\n`,
    );
  }

  /**
   * 卸下一个意识(删除其目录;布局树里的位置记录由布局引擎保留)。
   *
   * Host 需要在内置意识卸载后先写 tombstone，再向 renderer 发布一份
   * 已安装 + 可恢复相互一致的快照。notify=false 只延后广播，不改变卸载语义。
   */
  async uninstall(
    id: string,
    options: { notify?: boolean } = {},
  ) {
    return this.runExclusiveMutation(() => this.uninstallUnlocked(id, options));
  }

  private async uninstallUnlocked(
    id: string,
    options: { notify?: boolean } = {},
  ): Promise<{ ok: true } | { rejection: UninstallRejection }> {
    if (!isValidGhostId(id)) {
      return { rejection: { code: 'invalid-id', reason: '非法意识 id' } };
    }
    const root = this.options.getRootDir();
    const dir = path.join(root, id);
    // 双保险:id 格式校验已排除路径穿越,这里再确认是 root 的直接子目录。
    if (path.dirname(dir) !== path.resolve(root) && path.dirname(dir) !== root) {
      return { rejection: { code: 'invalid-id', reason: '非法意识 id' } };
    }
    if (!(await pathExists(dir))) {
      return { rejection: { code: 'not-installed', reason: `意识 ${id} 未装入` } };
    }
    try {
      await fs.promises.rm(dir, { recursive: true, force: true });
    } catch (err) {
      return { rejection: { code: 'io', reason: err instanceof Error ? err.message : String(err) } };
    }
    // 走同一个撤销入口:成功即清掉隔离记录,失败由该入口转进程内隔离并记日志。
    // 内容目录已经删除，插件不可能再运行；孤立 receipt 与 skill snapshot 仅是待回收
    // 状态，不能把“清理延后”误报成“插件仍已安装”。
    await this.removeInstallApproval(id);
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
 * 安装目录内容指纹(`packageSha256`,审计用的漂移检测器,不作授权判据)。
 *
 * 遍历、类型判定与指纹格式全部取自 `ghostContentTree`,与技能指纹
 * `hashApprovedSkillContent`、随包种子指纹 `fingerprintDirContent` 同一份实现;
 * 这里的显式策略是"点开头条目不算内容、非普通条目一律拒"。跟随链接在这条路径上
 * 最多多写一次批准、不构成绕过,判据对齐是因为"同一判据散落多处且各处不一致"
 * 本身就是缺陷温床。
 */
async function hashApprovedDirectory(root: string): Promise<string> {
  const { files } = await collectGhostContentFiles(root, {
    dotEntries: 'skip',
    nonRegular: 'throw',
    label: 'bundled Plugin',
  });
  return hashGhostContentFiles(root, files);
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
