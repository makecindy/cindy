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
 * 更新/卸载都不影响已抓内容。Electron 对话框、安装目录解析与落盘全部
 * 注入,便于内存 harness 测试。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import JSZip from 'jszip';

import { isValidGhostId, type InstalledGhost } from '../../shared/ghost.js';
import { GHOST_SIGNATURE_FILE } from './ghostSignature.js';

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

/** 导出包的一个条目。 */
interface PackageEntry {
  rel: string;
  data: Buffer;
}

// ---------------------------------------------------------------------------
// 签名包:statement 闭包
// ---------------------------------------------------------------------------

interface SignedDoc {
  /** 签名文件原始字节(原样进入导出包)。 */
  raw: Buffer;
  files: Array<{ path: string; sha256: string; bytes: number }>;
}

/**
 * 读取并解析签名文件。返回 null 表示插件未签名(文件不存在);文件存在
 * 但结构非法时抛错——静默降级成未签名导出会让重装后信任等级失真,
 * 不如如实报错。
 */
async function readSignedDoc(dir: string): Promise<SignedDoc | null> {
  let raw: Buffer;
  try {
    raw = await fs.promises.readFile(path.join(dir, GHOST_SIGNATURE_FILE));
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    throw err;
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
  return { raw, files: parsed };
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
  const out: PackageEntry[] = [{ rel: GHOST_SIGNATURE_FILE, data: doc.raw }];
  for (const item of doc.files) {
    if (!isSafeStatementPath(item.path)) return null;
    let data: Buffer;
    try {
      data = await fs.promises.readFile(path.join(dir, ...item.path.split('/')));
    } catch {
      return null;
    }
    if (data.byteLength !== item.bytes) return null;
    if (crypto.createHash('sha256').update(data).digest('hex') !== item.sha256) return null;
    out.push({ rel: item.path, data });
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
 * (第一遍);否则只留哈希(校验遍)。两遍都读内容而不是 stat——一致性
 * 判定锚定在字节上,路径/尺寸/mtime 相同的并发替换也会哈希不符被捕获。
 * symlink/junction 不跟随:只归档安装目录自身的真实内容。结果按 rel
 * 排序供逐位比对。
 */
async function walkTree(dir: string, withData: true): Promise<TreeFile[]>;
async function walkTree(dir: string, withData: false): Promise<TreeMeta[]>;
async function walkTree(dir: string, withData: boolean): Promise<Array<TreeFile | TreeMeta>> {
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
        const data = await fs.promises.readFile(abs);
        if (withData) {
          out.push({ rel, data, sha256: sha256hex(data) });
        } else {
          out.push({ rel, sha256: sha256hex(data) });
        }
      }
    }
  };
  await walk(dir, '');
  out.sort((a, b) => a.rel.localeCompare(b.rel));
  return out;
}

/**
 * 未签名包的一致性快照:更新会整体换目录、卸载会删目录,单遍逐文件读
 * 可能跨越两个文件系统状态。读完后第二遍重读重哈希——任何文件在读窗口
 * 内被增删改都会哈希不符或条目错位;通过校验的包逐字节等于校验遍时刻
 * 的单一目录状态。
 */
async function snapshotUnsignedTree(dir: string): Promise<TreeFile[] | null> {
  const first = await walkTree(dir, true);
  const verify = await walkTree(dir, false);
  const consistent =
    first.length === verify.length &&
    first.every((file, i) => file.rel === verify[i]!.rel && file.sha256 === verify[i]!.sha256);
  return consistent ? first : null;
}

// ---------------------------------------------------------------------------
// 共用:带重试的快照 + 打包 + 对话框落盘
// ---------------------------------------------------------------------------

/**
 * 快照入口:签名包走 statement 闭包,未签名包走目录归档。任一路在并发
 * 变更下拿不到一致结果(含更新/卸载途中的瞬时 IO 失败)就整体重试,
 * 上限 SNAPSHOT_MAX_ATTEMPTS 次;持续冲突返回 null,由调用方如实报错
 * 请用户重试。
 */
const SNAPSHOT_MAX_ATTEMPTS = 3;

async function snapshotPackage(dir: string): Promise<PackageEntry[] | null> {
  for (let attempt = 0; attempt < SNAPSHOT_MAX_ATTEMPTS; attempt++) {
    try {
      const doc = await readSignedDoc(dir);
      if (doc) {
        const entries = await readSignedEntries(dir, doc);
        if (entries) return entries;
      } else {
        const tree = await snapshotUnsignedTree(dir);
        if (tree) return tree.map(({ rel, data }) => ({ rel, data }));
      }
    } catch {
      // 并发更新/卸载途中的瞬时失败(目录短暂缺失、半写文件等):重试。
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

  // 一致性快照(口径见文件头):安装目录内容来自装入侧已校验的 zip,
  // 此处只做如实归档,不设内容上限(装入侧已卡过解压总量)。
  // snapshotPackage 内部已把瞬时失败纳入重试,返回 null = 持续冲突。
  const files = await snapshotPackage(ghost.dir);
  if (!files) return { status: 'error', code: 'read_failed' };

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
