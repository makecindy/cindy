import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import JSZip from 'jszip';

import {
  GHOST_MANIFEST_FILE,
  GHOST_LOCALE_MAX_BYTES,
  GHOST_ICON_MAX_BYTES,
  GHOST_INSTALL_MANIFEST_MAX_BYTES,
  GHOST_SKILL_MD_MAX_BYTES,
  ghostLocalePathFor,
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
import {
  readBoundedFileFollowLinks,
  readBoundedFileNoFollowSync,
} from '../utils/readBoundedFile.js';
import { checkSkillMdConsistency } from './skillSlot.js';

/** 普通沙箱插件维持小包上限；随包 Node/CLI 允许更大的预打包产物。 */
export const MAX_BASIC_CINDY_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_NODE_CINDY_FILE_BYTES = 128 * 1024 * 1024;
/** 身份卡本身只应是小 JSON；先限流读取，避免在识别包类型前被单文件撑爆内存。 */
const MAX_GHOST_MANIFEST_BYTES = GHOST_INSTALL_MANIFEST_MAX_BYTES;
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
}

export interface GhostManagerOptions {
  /** 意识仓库根目录(生产:userData/cindy-brain;测试:os.tmpdir 下临时目录)。 */
  getRootDir: () => string;
  /** 装/卸成功后通知(index.ts 用它广播 ghosts:changed 到所有窗口)。 */
  onChanged?: (ghosts: InstalledGhost[]) => void;
  /** 当前宿主语言；插件未提供时由 shared 契约固定回退英文。 */
  getLocale?: () => string;
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
  | { code: 'io'; reason: string };

export type UninstallRejection =
  | { code: 'invalid-id'; reason: string }
  | { code: 'not-installed'; reason: string }
  | { code: 'io'; reason: string };

/**
 * 意识仓库的 main 端管理者:一个意识一个子目录(rootDir/<id>/),目录即事实。
 *
 * 设计要点:
 * - **目录即注册表**:没有额外的 DB / 索引文件,list() 每次实扫磁盘 ——
 *   装了什么打开文件夹一目了然,坏一个目录只影响那一个意识(跳过 + warn);
 * - **装载先落 staging 再切正式**(对齐 skillhub/installService 的做法):
 *   解压全程发生在 `.cindy-installing-*` 临时目录,校验全过才 rename 到
 *   rootDir/<id>,任何一步失败都不会留下半截安装;
 * - **防 zip 三件套**:条目数 / 解压总量上限防 zip bomb,路径归一化 +
 *   越界检查防 zip-slip(压缩包里的 ../ 路径跳不出 staging);
 * - **卸载防御**:id 先过格式校验(shared/ghost 同一份规则),再确认
 *   目标是 rootDir 的直接子目录,杜绝借 id 删任意路径。
 */
export class GhostManager {
  constructor(private readonly options: GhostManagerOptions) {}

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
      const manifestPath = path.join(dir, GHOST_MANIFEST_FILE);
      let raw: unknown;
      try {
        // 已安装目录也可能被外部进程/同步盘改动,且 list() 每次市场快照都会
        // 执行:单句柄限量闸(拒链接),不让无界字节进 main。
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
      const trust = this.readInstalledTrust(dir);
      result.push({
        manifest: localizedManifest,
        dir,
        enabled: !fs.existsSync(path.join(dir, DISABLED_MARKER_FILE)),
        ...(trust ? { trust } : {}),
        ...(iconDataUrl !== null ? { iconDataUrl } : {}),
      });
    }
    result.sort((a, b) => a.manifest.id.localeCompare(b.manifest.id));
    return result;
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
        const absPath = path.join(dir, ...candidatePath.split('/'));
        // lstat 判完再按路径 readFileSync 是三次独立打开,期间可被换成超大
        // 文件或根外链接。单句柄限量闸 + containWithin 一次完成全部校验。
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
   * 启用 / 停用一张意识。停用不删任何东西,只在安装目录里放一个 `.disabled`
   * 标记文件(目录即事实:打开文件夹一眼可见);启用即删掉标记。幂等。
   */
  async setEnabled(id: string, enabled: boolean): Promise<{ ok: true } | { rejection: UninstallRejection }> {
    if (!isValidGhostId(id)) {
      return { rejection: { code: 'invalid-id', reason: '非法意识 id' } };
    }
    const dir = path.join(this.options.getRootDir(), id);
    if (!(await pathExists(dir))) {
      return { rejection: { code: 'not-installed', reason: `意识 ${id} 未装入` } };
    }
    const marker = path.join(dir, DISABLED_MARKER_FILE);
    try {
      if (enabled) {
        await fs.promises.rm(marker, { force: true });
      } else {
        await fs.promises.writeFile(marker, '');
      }
    } catch (err) {
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
    const iconPath = path.join(dir, ...manifest.icon.split('/'));
    try {
      // statSync 后再 readFileSync 是两次独立打开:并发方可在其间把 icon 换成
      // 指向宿主任意文件的链接,字节会被包成 dataURL 经 IPC 送进 Renderer。
      // 单句柄限量闸拒链接、限大小;containWithin 堵中间目录链接。
      const bytes = readBoundedFileNoFollowSync(iconPath, GHOST_ICON_MAX_BYTES, {
        containWithin: fs.realpathSync(dir),
      });
      if (bytes === null) {
        this.options.log?.warn('ghost icon skipped: missing or oversize', { dir, icon: manifest.icon });
        return null;
      }
      return buildIconDataUrl(manifest.icon, bytes);
    } catch {
      this.options.log?.warn('ghost icon skipped: unreadable', { dir, icon: manifest.icon });
      return null;
    }
  }

  /** 读取主机安装时写下的签名验证快照；坏文件只降级未显示，不信作者自报。 */
  private readInstalledTrust(dir: string): GhostTrustInfo | null {
    try {
      const bytes = readBoundedFileNoFollowSync(path.join(dir, TRUST_METADATA_FILE), 64 * 1024);
      if (bytes === null) return null;
      const raw = JSON.parse(bytes.toString('utf8')) as GhostTrustInfo;
      if (
        !raw ||
        typeof raw !== 'object' ||
        !['cindy-official', 'reviewed', 'verified-publisher', 'unverified'].includes(raw.level) ||
        typeof raw.publisherSigned !== 'boolean' ||
        typeof raw.publisherVerified !== 'boolean' ||
        typeof raw.reviewed !== 'boolean'
      ) return null;
      return raw;
    } catch {
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
      const bytes = await readBoundedFileFollowLinks(lizFilePath, MAX_NODE_CINDY_FILE_BYTES);
      if (bytes === null) {
        return {
          rejection: {
            code: 'file-invalid',
            reason: `不是普通文件或超过体积上限(${MAX_NODE_CINDY_FILE_BYTES} 字节)`,
          },
        };
      }
      buf = bytes;
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
          GHOST_ICON_MAX_BYTES,
          'icon',
        );
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
    const { manifest, trust, iconDataUrl, allEntries, prefix } = parsed;

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
    } catch (err) {
      await fs.promises.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
      if (err instanceof InstallExtractError) {
        return { rejection: { code: 'file-invalid', reason: err.message } };
      }
      return { rejection: { code: 'io', reason: err instanceof Error ? err.message : String(err) } };
    }

    const ghost: InstalledGhost = {
      manifest,
      dir: finalDir,
      enabled: initiallyEnabled,
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
    opts?: { expectedPackageSha256?: string },
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
    const { manifest, trust, iconDataUrl, allEntries, prefix } = parsed;

    const root = this.options.getRootDir();
    const finalDir = path.join(root, manifest.id);
    if (!(await pathExists(finalDir))) {
      return { rejection: { code: 'not-installed', reason: `意识 ${manifest.id} 未装入,无从更新` } };
    }
    // 延续当前唤醒/沉睡状态。
    const enabled = !fs.existsSync(path.join(finalDir, DISABLED_MARKER_FILE));

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
    await fs.promises.rm(backupDir, { recursive: true, force: true }).catch(() => {});

    const ghost: InstalledGhost = {
      manifest,
      dir: finalDir,
      enabled,
      trust,
      ...(iconDataUrl !== undefined ? { iconDataUrl } : {}),
    };
    this.options.log?.info('ghost updated', { id: manifest.id, version: manifest.version });
    this.options.onChanged?.(this.list());
    return { ghost };
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
    this.options.log?.info('ghost uninstalled', { id });
    if (options.notify !== false) this.options.onChanged?.(this.list());
    return { ok: true };
  }
}

/** staging 期的"内容不合格"错误(与环境 IO 错误区分,映射 file-invalid)。 */
class InstallExtractError extends Error {}

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
