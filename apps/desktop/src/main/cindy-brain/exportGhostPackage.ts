/**
 * exportGhostPackage
 * ---------------------------------------------------------------------------
 * 插件详情页「导出 .cindy」的打包业务体:把已装插件的安装目录重新打成
 * .cindy zip 包(与 forge.ts packGhostDir 同一份内容契约——ghost.json 在
 * zip 根部、不套外层文件夹),供 main IPC handler 经系统保存对话框落盘。
 *
 * 与 forge 打包的三点差异(导出 ≠ 制作,见插件规则文档):
 * - 源是安装目录(装入时的 zip 解包内容),不重新校验清单——装入侧已验过;
 * - 跳过装入后由主机写入的根部保留文件(.disabled / .cindy-trust.json),
 *   嵌套条目全保留、根部 .DS_Store 按签名 statement 决定去留,
 *   导出包可原样过装入校验;
 * - 产物不写回源目录,由保存对话框写到用户选定的位置。
 *
 * 打包是一致性快照(见 snapshotTree):读完用纯元数据第二遍校验,与
 * 更新/卸载并发时不会产出混合版本的坏包。整个包先在内存里打完再弹
 * 保存对话框:用户挑选位置期间插件被更新/卸载都不影响已抓到的内容。
 * Electron 对话框、安装目录解析与落盘全部注入,便于内存 harness 测试。
 */

import fs from 'node:fs';
import path from 'node:path';

import JSZip from 'jszip';

import { isValidGhostId, type InstalledGhost } from '../../shared/ghost.js';

/**
 * 遍历时跳过的只有根部主机保留文件(.disabled / .cindy-trust.json)——
 * 它们是装入后由主机写入的,签名 statement 不可能覆盖;其余条目一律
 * 进入快照(签名 statement 覆盖全部原始条目,跳任何一个都会让导出包
 * 装回时完整性校验失败)。
 *
 * .DS_Store 不在这里过滤,统一在快照校验通过后按快照内 statement 去留
 * (见 filterResidueDSStore):statement 必须从与目录一致的同一份快照
 * 里解析,预读磁盘会让过滤依据与归档内容错位。
 */
const EXPORT_HOST_ROOT_FILES = new Set(['.disabled', '.cindy-trust.json']);
function shouldSkipExportEntry(name: string, relBase: string): boolean {
  return relBase === '' && EXPORT_HOST_ROOT_FILES.has(name);
}

/** 解析 statement 覆盖的相对路径;解析失败返回 null(视为未签名)。 */
function parseSignedPaths(signatureBytes: Buffer): Set<string> | null {
  try {
    const doc = JSON.parse(signatureBytes.toString('utf8')) as {
      statement?: { files?: Array<{ path?: unknown }> };
    };
    const files = doc?.statement?.files;
    if (!Array.isArray(files)) return null;
    return new Set(
      files.map((item) => item?.path).filter((p): p is string => typeof p === 'string'),
    );
  } catch {
    return null;
  }
}

/**
 * 快照校验通过后的 .DS_Store 去留(任意深度统一口径):
 * - 签名包:buildStatement 打包时哈希除 __MACOSX 与签名文件外的所有
 *   条目——statement 覆盖的 .DS_Store 必须保留(跳过会缺文件),未覆盖
 *   的必须丢弃(装入后 Finder 浏览生成的残渣,保留会多出 statement 外
 *   文件),两种错位都会让重装校验失败;
 * - 未签名包:只丢根部残渣,嵌套 .DS_Store 可能是作者包内容,保留。
 */
function filterResidueDSStore(files: TreeFile[]): TreeFile[] {
  const signature = files.find((file) => file.rel === 'cindy-signatures.json');
  const signedPaths = signature ? parseSignedPaths(signature.data) : null;
  return files.filter((file) => {
    if (file.rel.split('/').pop() !== '.DS_Store') return true;
    if (signedPaths) return signedPaths.has(file.rel);
    return file.rel.includes('/');
  });
}

export type ExportGhostPackageResult =
  | { status: 'saved'; savedPath: string }
  | { status: 'canceled' }
  | { status: 'invalid_id' }
  | { status: 'not_installed' }
  | { status: 'error'; code: 'read_failed' | 'compress_failed' | 'dialog_failed' | 'write_failed' };

export interface ExportGhostPackageDeps {
  /** 已装插件清单(GhostManager.list 的事实源)。 */
  listInstalled: () => InstalledGhost[];
  showSaveDialog(opts: {
    defaultPath: string;
    filters: Array<{ name: string; extensions: string[] }>;
  }): Promise<{ canceled: boolean; filePath?: string }>;
  /** 保存对话框 defaultPath 的目录部分(下载目录)。 */
  getDownloadsDir(): string;
  /** 保存对话框文件类型标签(调用方按当前 locale 本地化)。 */
  fileTypeLabel: string;
  writeFile(filePath: string, data: Buffer): Promise<void>;
}

/** Windows 保留设备名(不分大小写),直接作文件名会被系统拒绝。 */
const WINDOWS_RESERVED_BASENAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** 插件名清洗成文件名片段:空白折叠、剥掉文件系统非法字符,截断防爆长度。 */
export function sanitizeExportFileNamePart(name: string): string {
  let cleaned = name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 80)
    .trim()
    // Windows 禁止尾随点/空格(截断后可能新产生,最后再剥一次)。
    .replace(/[. ]+$/, '');
  // Windows 保留设备名(含带扩展名形式,如 CON.txt 同样非法):
  // 按首个点前的词干判断,命中加前缀避让。
  const stem = cleaned.split('.', 1)[0] ?? cleaned;
  if (WINDOWS_RESERVED_BASENAME.test(stem)) cleaned = `_${cleaned}`;
  return cleaned;
}

/** 目录内一个文件的字节与元数据(一致性快照用)。 */
interface TreeFile {
  rel: string;
  data: Buffer;
  size: number;
  mtimeMs: number;
}

type TreeMeta = Omit<TreeFile, 'data'>;

/**
 * 递归枚举安装目录。withData=true 时先 stat 再读字节(评审 P1:顺序不能
 * 反——先读后 stat 会在文件两步间被改写时产出「旧字节+新元数据」,校验
 * 遍误判一致;先 stat 后读,改写必然落在读之后,校验遍一定能捕获并触发
 * 重读);否则只取元数据(校验遍,不重复读内容)。symlink/junction 不
 * 跟随:只归档安装目录自身的真实内容,防止借链接把目录外文件打进导出包。
 * 结果按 rel 排序,供两遍逐位比对。
 */
async function walkTree(dir: string, withData: true): Promise<TreeFile[]>;
async function walkTree(dir: string, withData: false): Promise<TreeMeta[]>;
async function walkTree(
  dir: string,
  withData: boolean,
): Promise<Array<TreeFile | TreeMeta>> {
  const out: Array<TreeFile | TreeMeta> = [];
  const walk = async (cur: string, relBase: string): Promise<void> => {
    const entries = await fs.promises.readdir(cur, { withFileTypes: true });
    for (const entry of entries) {
      if (shouldSkipExportEntry(entry.name, relBase)) continue;
      if (entry.isSymbolicLink()) continue;
      const abs = path.join(cur, entry.name);
      const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(abs, rel);
      } else if (entry.isFile()) {
        if (withData) {
          const stat = await fs.promises.stat(abs);
          const data = await fs.promises.readFile(abs);
          out.push({ rel, data, size: stat.size, mtimeMs: stat.mtimeMs });
        } else {
          const stat = await fs.promises.stat(abs);
          out.push({ rel, size: stat.size, mtimeMs: stat.mtimeMs });
        }
      }
    }
  };
  await walk(dir, '');
  out.sort((a, b) => a.rel.localeCompare(b.rel));
  return out;
}

/**
 * 一致性快照(评审 P1):更新会整体换目录、卸载会删目录,单遍逐文件读
 * 可能跨越两个文件系统状态,产出混合版本的坏包。这里读完后用纯元数据
 * 第二遍校验——任何文件在读窗口内被增删改都会被尺寸/mtime 比对捕获,
 * 不一致就整体重读;通过校验的包对应校验遍时刻的单一目录状态。
 */
const SNAPSHOT_MAX_ATTEMPTS = 3;
async function snapshotTree(dir: string): Promise<TreeFile[] | null> {
  for (let attempt = 0; attempt < SNAPSHOT_MAX_ATTEMPTS; attempt++) {
    const first = await walkTree(dir, true);
    const verify = await walkTree(dir, false);
    const consistent =
      first.length === verify.length &&
      first.every(
        (file, i) =>
          file.rel === verify[i]!.rel &&
          file.size === verify[i]!.size &&
          file.mtimeMs === verify[i]!.mtimeMs,
      );
    if (consistent) return first;
  }
  // 持续并发变更(反复更新/卸载中):放弃,让调用方如实报错由用户重试。
  return null;
}

export async function exportGhostPackage(
  id: unknown,
  deps: ExportGhostPackageDeps,
): Promise<ExportGhostPackageResult> {
  if (typeof id !== 'string' || !isValidGhostId(id)) {
    return { status: 'invalid_id' };
  }
  const ghost = deps.listInstalled().find((candidate) => candidate.manifest.id === id);
  if (!ghost) return { status: 'not_installed' };

  // 双保险:dir 来自 GhostManager 扫描,这里再确认它是真实目录(lstat
  // 不跟随链接),避免把被替换成 symlink/junction 的注册项当成打包源,
  // 将链接目标的内容打进导出包。
  try {
    const dirStat = await fs.promises.lstat(ghost.dir);
    if (!dirStat.isDirectory()) throw new Error('not a directory');
  } catch {
    return { status: 'error', code: 'read_failed' };
  }

  // 一致性快照(口径见 snapshotTree 头注释):安装目录内容来自装入侧
  // 已校验的 zip,此处只做如实归档,不设内容上限(装入侧已卡过解压总量)。
  let files: TreeFile[] | null;
  try {
    files = await snapshotTree(ghost.dir);
  } catch {
    return { status: 'error', code: 'read_failed' };
  }
  if (!files) {
    // 连续多次校验都不一致:目录正在被反复改写,如实报错由用户重试。
    return { status: 'error', code: 'read_failed' };
  }
  // .DS_Store 去留按快照内的 statement 决定(口径见 filterResidueDSStore)。
  files = filterResidueDSStore(files);

  const zip = new JSZip();
  for (const file of files) {
    zip.file(file.rel, file.data);
  }
  let buf: Buffer;
  try {
    buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  } catch {
    // 压缩失败(zlib 等)如实落到结构化结果,不冒成未捕获的 IPC 异常。
    return { status: 'error', code: 'compress_failed' };
  }

  const baseName = sanitizeExportFileNamePart(ghost.manifest.name) || ghost.manifest.id;
  // 版本同样来自作者清单,可能与名字一样含路径分隔符/控制字符,
  // 必须走同一道清洗再拼进默认文件名。
  const versionPart = sanitizeExportFileNamePart(ghost.manifest.version);
  const defaultFileName = versionPart
    ? `${baseName}-${versionPart}.cindy`
    : `${baseName}.cindy`;

  let picked: { canceled: boolean; filePath?: string };
  try {
    picked = await deps.showSaveDialog({
      defaultPath: path.join(deps.getDownloadsDir(), defaultFileName),
      filters: [{ name: deps.fileTypeLabel, extensions: ['cindy'] }],
    });
  } catch {
    return { status: 'error', code: 'dialog_failed' };
  }
  if (picked.canceled || !picked.filePath) return { status: 'canceled' };

  try {
    await deps.writeFile(picked.filePath, buf);
  } catch {
    return { status: 'error', code: 'write_failed' };
  }
  return { status: 'saved', savedPath: picked.filePath };
}
