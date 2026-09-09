/**
 * exportGhostPackage
 * ---------------------------------------------------------------------------
 * 插件详情页「导出 .cindy」的打包业务体:把已装插件的安装目录重新打成
 * .cindy zip 包,供 main IPC handler 经系统保存对话框落盘。
 *
 * 设计(第一性原理:导出包必须可原样通过装入校验):
 *
 * 1) 签名包 —— 包内容由 statement 定义,不由目录枚举定义。
 *    装入校验 = 对 zip 重建 statement 并逐条等于 cindy-signatures.json
 *    里的 statement。因此导出 = statement 闭包 + 签名文件本身:逐文件
 *    读盘、重算 sha256 与 statement 比对,全部命中则导出包可证可重装。
 *    statement 之外的任何内容(主机保留文件、Finder 残渣、任意深度的
 *    .DS_Store、symlink 目标)天然不进入导出包,无需启发式过滤;任何
 *    文件缺失/哈希不符 = 目录被并发更新或篡改,整体重读后仍不符则
 *    如实报错。一致性、签名口径、竞争防护在这一步坍缩为同一件事。
 *
 * 2) 未签名包 —— 没有 statement 可锚定,退回目录归档:跳过根部主机
 *    保留文件与根部 .DS_Store(装入后残渣),symlink 不跟随,逐文件
 *    读字节并自算 sha256;校验遍重读重哈希逐位比对——内容级一致性,
 *    与路径/尺寸/mtime 等元数据碰撞彻底无关。任何文件在读窗口内被
 *    增删改都会哈希不符或条目错位,整体重读。
 *
 * 两路共用:包先在内存里打完再弹保存对话框——用户挑选位置期间插件被
 * 更新/卸载都不影响已抓内容。产物落盘前后过装入同口径的闸:体积在
 * 快照阶段增量限流(与 GhostManager 同一组常量,Node 插件运行期可能
 * 把目录写大;签名包先用 statement 声明口径短路);写盘后、上报成功
 * 前过装入校验本尊 GhostManager.inspect(带真实 trust registry,
 * statement/review 签名被篡改、manifest/node.entry 被改坏等「成功却
 * 装不回」的情形都拦在这里,不过闸删掉已写文件如实报错)。
 * Electron 对话框、安装目录解析与落盘全部注入,便于内存 harness 测试。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import JSZip from 'jszip';

import { isValidGhostId, type InstalledGhost } from '../../shared/ghost.js';
import {
  MAX_BASIC_CINDY_FILE_BYTES,
  MAX_BASIC_UNCOMPRESSED_BYTES,
  MAX_BASIC_ZIP_ENTRIES,
  MAX_NODE_CINDY_FILE_BYTES,
  MAX_NODE_UNCOMPRESSED_BYTES,
  MAX_NODE_ZIP_ENTRIES,
} from './GhostManager.js';
import { sameStableFileState } from './ghostContentTree.js';
import { GHOST_SIGNATURE_FILE, MAX_SIGNATURE_FILE_BYTES } from './ghostSignature.js';
import { unixRegularFilePermissionsForArchive } from './ghostZipPermissions.js';

export type ExportGhostPackageResult =
  | { status: 'saved'; savedPath: string }
  | { status: 'canceled' }
  | { status: 'invalid_id' }
  | { status: 'not_installed' }
  | {
      status: 'error';
      code:
        | 'read_failed'
        | 'compress_failed'
        | 'dialog_failed'
        | 'write_failed'
        | 'too_large'
        | 'verify_failed';
    };

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
  /**
   * 装入校验本尊(GhostManager.inspect + 装入侧不变量):临时产物写盘后、
   * 发布到目标前调用,返回是否通过。签名/未签名都过这道闸——statement
   * 被篡改成自洽、review 签名损坏、manifest/node.entry 被改坏、指令与
   * 其他已装插件撞名等「导出成功却装不回」的情形都由它拦下。
   */
  inspectPackage(filePath: string): Promise<boolean>;
}

/** 插件名清洗成文件名片段:空白折叠、剥掉文件系统非法字符,截断防爆长度。 */
const WINDOWS_RESERVED_BASENAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

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

/**
 * 按 UTF-8 字节数截断(评审 P1):文件系统按字节卡 255,按 UTF-16 码元
 * slice 管不住多字节字符(64 个中文名 + 32 个中文版本号会超)。
 * 按码点累加,不在多字节字符中间切断。
 */
function capToByteLength(s: string, maxBytes: number): string {
  if (Buffer.byteLength(s, 'utf8') <= maxBytes) return s;
  let out = '';
  let bytes = 0;
  for (const ch of s) {
    const b = Buffer.byteLength(ch, 'utf8');
    if (bytes + b > maxBytes) break;
    out += ch;
    bytes += b;
  }
  return out;
}

/** 完整文件名(不含扩展名)的字节上限:255 分量上限 - '.cindy'。 */
const MAX_EXPORT_BASENAME_BYTES = 249;

/** 导出包的一个条目。 */
interface PackageEntry {
  rel: string;
  data: Buffer;
  unixPermissions: number;
}

// ---------------------------------------------------------------------------
// 签名包:statement 闭包
// ---------------------------------------------------------------------------

interface SignedDoc {
  /** 签名文件原始字节(原样进入导出包)。 */
  raw: Buffer;
  unixPermissions: number;
  files: Array<{ path: string; sha256: string; bytes: number }>;
}

/**
 * 读取并解析签名文件。返回 null 表示插件未签名(文件不存在);文件存在
 * 但超上限或结构非法时抛错——装入侧只认 64KB 内的签名文件,超限签名
 * 反正过不了装入;静默降级成未签名导出会让重装后信任等级失真,
 * 不如如实报错。
 */
async function readSignedDoc(dir: string): Promise<SignedDoc | null> {
  const sigPath = path.join(dir, GHOST_SIGNATURE_FILE);
  // 先 stat 再读(评审 P1):超上限的签名文件反正过不了装入,不把它
  // 完整读进内存;读后再查一次字节数,挡住 stat 后被改大的窗口。
  let fileHandle: fs.promises.FileHandle;
  try {
    fileHandle = await fs.promises.open(sigPath, 'r');
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    throw err;
  }
  try {
    const stat = await fileHandle.stat({ bigint: true });
    if (stat.size > BigInt(MAX_SIGNATURE_FILE_BYTES)) {
      throw new Error('signature file too large');
    }
    const raw = await fileHandle.readFile();
    if (raw.byteLength > MAX_SIGNATURE_FILE_BYTES) {
      throw new Error('signature file too large');
    }
    // 同一句柄只挡住 open 与 stat 之间的窗口:chmod 落在读取过程中,仍能造出
    // 「读前的 mode + 读后的字节」。读后复验身份与稳定态(含 ctime,故覆盖 chmod),
    // 变了就如实失败,不把不同时刻的权限和内容拼成一个条目。
    if (!sameStableFileState(stat, await fileHandle.stat({ bigint: true }))) {
      throw new Error('signature file changed while reading');
    }
    const doc = JSON.parse(raw.toString('utf8')) as {
      statement?: { files?: Array<{ path?: unknown; sha256?: unknown; bytes?: unknown }> };
    };
    const files = doc?.statement?.files;
    if (!Array.isArray(files)) throw new Error('invalid signature statement');
    const parsed: SignedDoc['files'] = [];
    for (const item of files) {
      if (
        typeof item?.path !== 'string' ||
        typeof item?.sha256 !== 'string' ||
        typeof item?.bytes !== 'number'
      ) {
        throw new Error('invalid signature statement entry');
      }
      parsed.push({ path: item.path, sha256: item.sha256, bytes: item.bytes });
    }
    return {
      raw,
      unixPermissions: unixRegularFilePermissionsForArchive(stat.mode),
      files: parsed,
    };
  } finally {
    await fileHandle.close();
  }
}

/** statement 路径必须相对且不逃逸——装入侧已校验,这里防一手目录被改。 */
function isSafeStatementPath(p: string): boolean {
  if (p.length === 0 || p.startsWith('/') || p.includes('\\')) return false;
  return !p.split('/').includes('..');
}

/**
 * 按 statement 闭包读包:逐文件读盘并重算 sha256 比对。任何文件缺失、
 * 长度或哈希不符都返回 null(目录被并发更新/篡改,调用方整体重试)。
 * 通过即导出包内容——不多不少,可证可重装。
 */
async function readSignedEntries(dir: string, doc: SignedDoc): Promise<PackageEntry[] | null> {
  const out: PackageEntry[] = [
    { rel: GHOST_SIGNATURE_FILE, data: doc.raw, unixPermissions: doc.unixPermissions },
  ];
  for (const item of doc.files) {
    if (!isSafeStatementPath(item.path)) return null;
    // 先 stat 对尺寸:与 statement 不符必然哈希也不符,不必把可能超限
    // 的文件读进内存(评审 P1:巨型缓存文件要先挡在分配之前)。
    let data: Buffer;
    let unixPermissions: number;
    try {
      const fileHandle = await fs.promises.open(path.join(dir, ...item.path.split('/')), 'r');
      try {
        const stat = await fileHandle.stat({ bigint: true });
        if (stat.size !== BigInt(item.bytes)) return null;
        data = await fileHandle.readFile();
        // 读后复验:同一句柄挡不住读取期间的 chmod,而 mode 与字节必须同时刻。
        // 稳定态判据含 ctime,权限变化也算失效;返回 null 交给调用方整体重试。
        if (!sameStableFileState(stat, await fileHandle.stat({ bigint: true }))) return null;
        unixPermissions = unixRegularFilePermissionsForArchive(stat.mode);
      } finally {
        await fileHandle.close();
      }
    } catch {
      return null;
    }
    if (data.byteLength !== item.bytes) return null;
    if (crypto.createHash('sha256').update(data).digest('hex') !== item.sha256) return null;
    out.push({
      rel: item.path,
      data,
      unixPermissions,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 未签名包:目录归档 + 元数据双遍一致性校验
// ---------------------------------------------------------------------------

/**
 * 未签名包的跳过口径:根部主机保留文件与根部系统残渣。
 * 嵌套条目一律保留——它们可能是作者包内容。
 */
const EXPORT_SKIP_ROOT_FILES = new Set(['.disabled', '.cindy-trust.json', '.DS_Store']);
function shouldSkipExportEntry(name: string, relBase: string): boolean {
  return relBase === '' && EXPORT_SKIP_ROOT_FILES.has(name);
}

interface TreeFile extends PackageEntry {
  sha256: string;
}

type TreeMeta = Omit<TreeFile, 'data'>;

function sha256hex(data: Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * 递归枚举安装目录,逐文件读字节并算 sha256。withData=true 时保留字节
 * (第一遍);否则只留哈希(校验遍)。两遍都锚定字节——一致性判定与
 * 路径/尺寸/mtime 等元数据碰撞彻底无关。symlink/junction 不跟随:只
 * 归档安装目录自身的真实内容。结果按 rel 排序供逐位比对。
 * 空目录(子树内不含保留文件)与文件一起记录、一起进两遍比对——目录
 * 结构也在一致性信封内。枚举走 opendir 流式迭代(评审 P1:readdir
 * 一次性物化 Dirent[],单目录海量条目会先分配再计数)。
 * 限流(评审 P1):
 * - 第一遍(budget):文件与目录都计条目;单文件先 stat,超剩余字节
 *   直接中止,不把巨型文件读进内存;
 * - 校验遍(expect):读取量被第一遍锚住——stat 尺寸与第一遍不符必然
 *   不一致,不读内容;第一遍没有的新文件同理(必然不一致)。
 */
interface TreePass<T> {
  items: T[];
  emptyDirs: string[];
}

async function walkTree(
  dir: string,
  withData: true,
  budget: { entriesLeft: number; bytesLeft: number },
): Promise<TreePass<TreeFile>>;
async function walkTree(
  dir: string,
  withData: false,
  expect: Map<string, number>,
): Promise<TreePass<TreeMeta>>;
async function walkTree(
  dir: string,
  withData: boolean,
  limit: { entriesLeft: number; bytesLeft: number } | Map<string, number>,
): Promise<TreePass<TreeFile | TreeMeta>> {
  const items: Array<TreeFile | TreeMeta> = [];
  const emptyDirs: string[] = [];
  const walk = async (cur: string, relBase: string): Promise<boolean> => {
    let hasContent = false;
    for await (const entry of await fs.promises.opendir(cur)) {
      if (shouldSkipExportEntry(entry.name, relBase)) continue;
      if (entry.isSymbolicLink()) continue;
      const abs = path.join(cur, entry.name);
      const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (withData) {
          const budget = limit as { entriesLeft: number; bytesLeft: number };
          budget.entriesLeft -= 1;
          if (budget.entriesLeft < 0) throw new ExportTooLargeError();
        }
        const subHas = await walk(abs, rel);
        if (!subHas) emptyDirs.push(rel);
        hasContent = hasContent || subHas;
      } else if (entry.isFile()) {
        if (withData) {
          const budget = limit as { entriesLeft: number; bytesLeft: number };
          const stat = await fs.promises.stat(abs);
          if (stat.size > budget.bytesLeft) throw new ExportTooLargeError();
          const data = await fs.promises.readFile(abs);
          budget.entriesLeft -= 1;
          budget.bytesLeft -= Math.max(stat.size, data.byteLength);
          if (budget.entriesLeft < 0 || budget.bytesLeft < 0) {
            throw new ExportTooLargeError();
          }
          items.push({
            rel,
            data,
            sha256: sha256hex(data),
            unixPermissions: unixRegularFilePermissionsForArchive(stat.mode),
          });
        } else {
          const expect = limit as Map<string, number>;
          const expectedSize = expect.get(rel);
          const stat =
            expectedSize !== undefined ? await fs.promises.stat(abs) : null;
          if (expectedSize === undefined || stat!.size !== expectedSize) {
            // 第一遍没有的新文件/尺寸被换:与第一遍必然不一致,
            // 不读内容(校验遍读取量由第一遍锚住)。空 sha256 已足够让一致性
            // 比对失败,mode 只需占位——0 在这里不代表"权限 0",不会入包。
            items.push({ rel, sha256: '', unixPermissions: 0 });
          } else {
            const data = await fs.promises.readFile(abs);
            items.push({
              rel,
              sha256: sha256hex(data),
              unixPermissions: unixRegularFilePermissionsForArchive(stat!.mode),
            });
          }
        }
        hasContent = true;
      }
    }
    return hasContent;
  };
  await walk(dir, '');
  items.sort((a, b) => a.rel.localeCompare(b.rel));
  emptyDirs.sort();
  return { items, emptyDirs };
}

/**
 * 未签名包的一致性快照:更新会整体换目录、卸载会删目录,单遍逐文件读
 * 可能跨越两个文件系统状态。读完后第二遍重读重哈希——任何文件或目录
 * 在读窗口内被增删改都会哈希不符或条目错位;通过校验的包(文件+空
 * 目录)等于校验遍时刻的单一目录状态。
 */
async function snapshotUnsignedTree(
  dir: string,
  budget: { entriesLeft: number; bytesLeft: number },
): Promise<{ files: TreeFile[]; emptyDirs: string[] } | null> {
  const first = await walkTree(dir, true, budget);
  const expect = new Map(first.items.map((file) => [file.rel, file.data.byteLength]));
  const verify = await walkTree(dir, false, expect);
  const filesConsistent =
    first.items.length === verify.items.length &&
    first.items.every(
      (file, i) =>
        file.rel === verify.items[i]!.rel &&
        file.sha256 === verify.items[i]!.sha256 &&
        file.unixPermissions === verify.items[i]!.unixPermissions,
    );
  const dirsConsistent =
    first.emptyDirs.length === verify.emptyDirs.length &&
    first.emptyDirs.every((rel, i) => rel === verify.emptyDirs[i]);
  return filesConsistent && dirsConsistent
    ? { files: first.items, emptyDirs: first.emptyDirs }
    : null;
}

// ---------------------------------------------------------------------------
// 共用:带重试的快照(增量限流) + 打包 + 对话框落盘
// ---------------------------------------------------------------------------

/**
 * 快照入口:签名包走 statement 闭包,未签名包走目录归档。任一路在并发
 * 变更下拿不到一致结果(含更新/卸载途中的瞬时 IO 失败)就整体重试,
 * 上限 SNAPSHOT_MAX_ATTEMPTS 次;持续冲突返回 null,由调用方如实报错
 * 请用户重试。
 *
 * 体积上限在读快照阶段增量执行(评审 P1):不等全部读进内存再判定——
 * 签名包先用 statement 声明的条目数/字节数短路,未签名包边遍历边累计,
 * 超限立刻中止返回 'too_large',不把超限内容读进内存。
 */
const SNAPSHOT_MAX_ATTEMPTS = 3;

/** 快照超限:与瞬时 IO 失败区分,不进重试。 */
class ExportTooLargeError extends Error {}

interface SnapshotLimits {
  maxEntries: number;
  maxUncompressed: number;
}

interface PackageSnapshot {
  entries: PackageEntry[];
  /**
   * 递归后不含任何包内文件的目录(显式空目录)。安装会保留包里的目录
   * 条目,导出丢掉会让重装后插件找不到随包的空输出/缓存/模板目录;
   * dir 条目不参与 statement 哈希,补回不影响验签。
   */
  emptyDirs: string[];
}

/**
 * 递归收集空目录(子树内没有计入包内容的文件)。keep 判定文件是否计入
 * 包内容:签名包为 statement 成员。symlink 不跟随,与 walkTree 同口径。
 * 遍历到的每个条目(含未被 statement 覆盖的文件)都扣额度(评审 P1:
 * 海量非覆盖文件不能只靠 empty 计数兜底),超限抛 ExportTooLargeError。
 */
async function collectEmptyDirs(
  dir: string,
  keep: (rel: string) => boolean,
  budget: { entriesLeft: number },
): Promise<string[]> {
  const empty: string[] = [];
  const walk = async (cur: string, relBase: string): Promise<boolean> => {
    let hasContent = false;
    for await (const entry of await fs.promises.opendir(cur)) {
      if (shouldSkipExportEntry(entry.name, relBase)) continue;
      if (entry.isSymbolicLink()) continue;
      budget.entriesLeft -= 1;
      if (budget.entriesLeft < 0) throw new ExportTooLargeError();
      const abs = path.join(cur, entry.name);
      const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        const subHas = await walk(abs, rel);
        if (!subHas) empty.push(rel);
        hasContent = hasContent || subHas;
      } else if (entry.isFile()) {
        if (keep(rel)) hasContent = true;
      }
    }
    return hasContent;
  };
  await walk(dir, '');
  return empty;
}

async function snapshotPackage(
  dir: string,
  limits: SnapshotLimits,
): Promise<PackageSnapshot | 'too_large' | null> {
  for (let attempt = 0; attempt < SNAPSHOT_MAX_ATTEMPTS; attempt++) {
    try {
      const doc = await readSignedDoc(dir);
      if (doc) {
        // 先用 statement 声明的口径短路,避免读取超限内容。
        const declaredBytes = doc.files.reduce((sum, file) => sum + file.bytes, 0);
        if (declaredBytes > limits.maxUncompressed || doc.files.length + 1 > limits.maxEntries) {
          return 'too_large';
        }
        // 目录结构信封(评审 P1):空目录不在 statement 哈希覆盖内,
        // 运行期 mkdir/rmdir 也不改签名文件字节——唯一可靠的锚是
        // 「窗口内稳定」:文件哈希校验前后各收集一遍,不一致即重试。
        const covered = new Set(doc.files.map((file) => file.path));
        const keep = (rel: string) => covered.has(rel);
        const dirsBefore = await collectEmptyDirs(dir, keep, { entriesLeft: limits.maxEntries });
        const entries = await readSignedEntries(dir, doc);
        if (!entries) continue;
        const dirsAfter = await collectEmptyDirs(dir, keep, { entriesLeft: limits.maxEntries });
        const dirsStable =
          dirsBefore.length === dirsAfter.length &&
          [...dirsBefore].sort().every((rel, i) => rel === [...dirsAfter].sort()[i]);
        if (!dirsStable) continue;
        return { entries, emptyDirs: dirsAfter };
      } else {
        const budget = {
          entriesLeft: limits.maxEntries,
          bytesLeft: limits.maxUncompressed,
        };
        const tree = await snapshotUnsignedTree(dir, budget);
        if (tree) {
          return {
            entries: tree.files.map(({ rel, data, unixPermissions }) => ({
              rel,
              data,
              unixPermissions,
            })),
            emptyDirs: tree.emptyDirs,
          };
        }
      }
    } catch (err) {
      // 超限是确定性结果,不重试;其余(并发更新/卸载途中的目录短暂
      // 缺失、半写文件等瞬时失败)整体重读。
      if (err instanceof ExportTooLargeError) return 'too_large';
    }
  }
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
  // 不跟随链接),避免把被替换成 symlink/junction 的注册项当成打包源。
  try {
    const dirStat = await fs.promises.lstat(ghost.dir);
    if (!dirStat.isDirectory()) throw new Error('not a directory');
  } catch {
    return { status: 'error', code: 'read_failed' };
  }

  // 一致性快照(口径见文件头),体积上限在快照阶段增量执行——
  // snapshotPackage 返回 null = 持续并发冲突,'too_large' = 超装入上限。
  const isNode = Boolean(ghost.manifest.node);
  const limits: SnapshotLimits = {
    maxEntries: isNode ? MAX_NODE_ZIP_ENTRIES : MAX_BASIC_ZIP_ENTRIES,
    maxUncompressed: isNode ? MAX_NODE_UNCOMPRESSED_BYTES : MAX_BASIC_UNCOMPRESSED_BYTES,
  };
  const maxArchive = isNode ? MAX_NODE_CINDY_FILE_BYTES : MAX_BASIC_CINDY_FILE_BYTES;
  const snapshot = await snapshotPackage(ghost.dir, limits);
  if (snapshot === 'too_large') return { status: 'error', code: 'too_large' };
  if (!snapshot) return { status: 'error', code: 'read_failed' };

  const zip = new JSZip();
  for (const rel of snapshot.emptyDirs) {
    zip.folder(rel);
  }
  for (const file of snapshot.entries) {
    zip.file(file.rel, file.data, { unixPermissions: file.unixPermissions });
  }
  if (Object.keys(zip.files).length > limits.maxEntries) {
    return { status: 'error', code: 'too_large' };
  }
  let buf: Buffer;
  try {
    buf = await zip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      platform: 'UNIX',
    });
  } catch {
    // 压缩失败(zlib 等)如实落到结构化结果,不冒成未捕获的 IPC 异常。
    return { status: 'error', code: 'compress_failed' };
  }
  if (buf.byteLength > maxArchive) return { status: 'error', code: 'too_large' };

  const baseName = sanitizeExportFileNamePart(ghost.manifest.name) || ghost.manifest.id;
  // 版本同样来自作者清单,可能与名字一样含路径分隔符/控制字符,
  // 必须走同一道清洗再拼进默认文件名。组合后按 UTF-8 字节数截断——
  // 文件系统按字节卡 255,多字节字符按码元 slice 管不住。
  const versionPart = sanitizeExportFileNamePart(ghost.manifest.version);
  const baseComposed = capToByteLength(
    versionPart ? `${baseName}-${versionPart}` : baseName,
    MAX_EXPORT_BASENAME_BYTES,
  );
  const defaultFileName = `${baseComposed}.cindy`;

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

  // 先写临时文件 → inspect 校验 → 过闸才发布到目标(评审 P1):
  // 不过闸只清临时文件——直接写目标再删会在「用户选择覆盖旧备份且
  // 校验失败」时毁掉用户原有文件;先写目标也会在写一半崩溃时留下
  // 坏包。临时名带随机段,发布优先 rename(POSIX 原子覆盖);Windows
  // 不覆盖已存在目标,仅在 EPERM/EEXIST/EACCES 且目标确实存在时退化
  // unlink+rename(该路径只在用户显式选择覆盖时到达)。
  const targetPath = picked.filePath;
  const tempPath = path.join(
    path.dirname(targetPath),
    `.cindy-export-${process.pid}-${crypto.randomBytes(6).toString('hex')}.tmp`,
  );
  try {
    await deps.writeFile(tempPath, buf);
  } catch {
    await fs.promises.rm(tempPath, { force: true }).catch(() => {});
    return { status: 'error', code: 'write_failed' };
  }

  // 装入校验终闸(评审 P1):产物必须能原样过 GhostManager.inspect——
  // 它带真实 trust registry 与全部装入校验(review 签名、manifest、
  // node.entry、指令查重、条目/体积),statement 篡改成自洽、目录被
  // 改坏等情形都拦在这里,不产出「成功却装不回」的包。
  let installable = false;
  try {
    installable = await deps.inspectPackage(tempPath);
  } catch {
    installable = false;
  }
  if (!installable) {
    await fs.promises.rm(tempPath, { force: true }).catch(() => {});
    return { status: 'error', code: 'verify_failed' };
  }

  try {
    await fs.promises.rename(tempPath, targetPath);
  } catch (renameErr) {
    const code = (renameErr as NodeJS.ErrnoException)?.code;
    const targetExists =
      code === 'EPERM' || code === 'EEXIST' || code === 'EACCES'
        ? await fs.promises.access(targetPath).then(() => true, () => false)
        : false;
    if (!targetExists) {
      await fs.promises.rm(tempPath, { force: true }).catch(() => {});
      return { status: 'error', code: 'write_failed' };
    }
    try {
      await fs.promises.rm(targetPath, { force: true });
      await fs.promises.rename(tempPath, targetPath);
    } catch {
      await fs.promises.rm(tempPath, { force: true }).catch(() => {});
      return { status: 'error', code: 'write_failed' };
    }
  }
  return { status: 'saved', savedPath: targetPath };
}
