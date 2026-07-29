/**
 * exportGhostPackage
 * ---------------------------------------------------------------------------
 * 插件详情页「导出 .cindy」的打包业务体：把已装插件的安装目录重新打成
 * .cindy zip 包(与 forge.ts packGhostDir 同一份内容契约——ghost.json 在
 * zip 根部、不套外层文件夹),供 main IPC handler 经系统保存对话框落盘。
 *
 * 与 forge 打包的三点差异(导出 ≠ 制作,见插件规则文档):
 * - 源是安装目录(装入时的 zip 解包内容),不重新校验清单——装入侧已验过;
 * - 跳过所有 `.` 开头条目,天然排除主机保留文件(.disabled /
 *   .cindy-trust.json),导出包可原样过装入校验;
 * - 产物不写回源目录,由调用方经保存对话框写到用户选定的位置。
 *
 * Electron 对话框、安装目录解析与落盘全部注入,便于内存 harness 测试。
 */

import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';

import JSZip from 'jszip';

import { isValidGhostId, type InstalledGhost } from '../../shared/ghost.js';

/**
 * 导出过滤口径(评审 P1):只跳过 zip 根部两个主机保留文件与纯系统残渣。
 * 嵌套点文件、node_modules 都可能是包内容——签名包的 statement 覆盖全部
 * 原始条目,多跳一个都会让导出包装回时完整性校验失败。
 */
const EXPORT_SKIP_ROOT_FILES = new Set(['.disabled', '.cindy-trust.json', '.DS_Store']);
function shouldSkipExportEntry(name: string, relBase: string): boolean {
  if (relBase === '') return EXPORT_SKIP_ROOT_FILES.has(name);
  return name === '.DS_Store';
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
  writeFile(filePath: string, data: Buffer): Promise<void>;
}

/** 插件名清洗成文件名片段:空白折叠、剥掉文件系统非法字符,截断防爆长度。 */
export function sanitizeExportFileNamePart(name: string): string {
  const cleaned = name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 80)
    .trim();
  return cleaned;
}

export type GhostPackageSnapshot =
  | { ok: true; buf: Buffer; defaultFileName: string }
  | { ok: false; result: ExportGhostPackageResult };

/**
 * 第一阶段(调用方在变更租约内调用):枚举安装目录、逐文件读入内存并压缩
 * 成 zip buffer。返回后安装目录再被更新/卸载/对账替换都不影响已抓内容
 * ——第二阶段的对话框等待与落盘不再需要任何目录一致性。
 */
export async function snapshotGhostPackage(
  id: unknown,
  deps: Pick<ExportGhostPackageDeps, 'listInstalled' | 'getDownloadsDir'>,
): Promise<GhostPackageSnapshot> {
  if (typeof id !== 'string' || !isValidGhostId(id)) {
    return { ok: false, result: { status: 'invalid_id' } };
  }
  // 先快照字节再弹保存对话框(评审 P1):更新会整体换目录、卸载会删目录,
  // 若在用户挑选位置期间发生,旧文件清单会配新字节,产出混合版本的坏包。
  // 快照在内存中完成,对话框等待期间插件怎么变都不影响已抓到的内容。
  const ghost = deps.listInstalled().find((candidate) => candidate.manifest.id === id);
  if (!ghost) return { ok: false, result: { status: 'not_installed' } };

  // 双保险:dir 来自 GhostManager 扫描,这里再确认它是真实目录,避免把
  // 被外部篡改的注册项当成打包源。
  let dirStat: fs.Stats;
  try {
    dirStat = await fs.promises.stat(ghost.dir);
  } catch {
    return { ok: false, result: { status: 'error', code: 'read_failed' } };
  }
  if (!dirStat.isDirectory()) {
    return { ok: false, result: { status: 'error', code: 'read_failed' } };
  }

  // 收集文件并立即读入内存:递归,只跳过根部主机保留文件与 .DS_Store
  // (口径见 shouldSkipExportEntry 头注释)。
  // 安装目录内容来自装入侧已校验的 zip,此处只做如实归档,不设内容上限
  // (装入侧已卡过解压总量)。
  const files: Array<{ rel: string; data: Buffer }> = [];
  const walk = async (cur: string, relBase: string): Promise<void> => {
    const entries = await fs.promises.readdir(cur, { withFileTypes: true });
    for (const entry of entries) {
      if (shouldSkipExportEntry(entry.name, relBase)) continue;
      const abs = path.join(cur, entry.name);
      const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(abs, rel);
      } else if (entry.isFile()) {
        files.push({ rel, data: await fs.promises.readFile(abs) });
      }
    }
  };
  try {
    await walk(ghost.dir, '');
  } catch {
    return { ok: false, result: { status: 'error', code: 'read_failed' } };
  }

  const zip = new JSZip();
  try {
    for (const file of files) {
      zip.file(file.rel, file.data);
    }
  } catch {
    return { ok: false, result: { status: 'error', code: 'read_failed' } };
  }
  let buf: Buffer;
  try {
    buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  } catch {
    // 压缩失败(zlib 等)如实落到结构化结果,不冒成未捕获的 IPC 异常。
    return { ok: false, result: { status: 'error', code: 'compress_failed' } };
  }

  const baseName =
    sanitizeExportFileNamePart(ghost.manifest.name) || ghost.manifest.id;
  // 版本同样来自作者清单,可能与名字一样含路径分隔符/控制字符,
  // 必须走同一道清洗再拼进默认文件名(评审 P1)。
  const versionPart = sanitizeExportFileNamePart(ghost.manifest.version);
  const defaultFileName = versionPart
    ? `${baseName}-${versionPart}.cindy`
    : `${baseName}.cindy`;
  return { ok: true, buf, defaultFileName };
}

/**
 * 第二阶段(调用方在变更租约外调用):弹系统保存对话框并落盘。入参快照
 * 与安装目录已无关联,此阶段任意时长都不影响插件目录一致性。
 */
export async function writeGhostPackageSnapshot(
  snapshot: Extract<GhostPackageSnapshot, { ok: true }>,
  deps: Pick<ExportGhostPackageDeps, 'showSaveDialog' | 'getDownloadsDir' | 'writeFile'>,
): Promise<ExportGhostPackageResult> {
  const defaultPath = path.join(deps.getDownloadsDir(), snapshot.defaultFileName);
  let picked: { canceled: boolean; filePath?: string };
  try {
    picked = await deps.showSaveDialog({
      defaultPath,
      filters: [{ name: 'Cindy Plugin', extensions: ['cindy'] }],
    });
  } catch {
    return { status: 'error', code: 'dialog_failed' };
  }
  if (picked.canceled || !picked.filePath) return { status: 'canceled' };

  // 原子落盘(评审 P1):先写目标目录里的临时文件,再发布到目标。
  // 直接 writeFile 会先截断旧文件——中途失败(磁盘满/断连/退出)会毁掉
  // 用户原有的包。临时名带随机段 + 调用方 'wx' 独占创建(对齐
  // blobStore 的 tmp 口径),防同目录预置同名文件/symlink 劫持。
  // 发布优先 rename(POSIX 原子覆盖);Windows rename 不覆盖已存在目标,
  // 仅在 EPERM/EEXIST 且目标确实存在时退化为 unlink+rename(该路径只在
  // 用户显式选择覆盖时到达,窗口期失败保留 tmp 供排查,不静默两空)。
  const targetPath = picked.filePath;
  const tempPath = path.join(
    path.dirname(targetPath),
    `.cindy-export-${process.pid}-${crypto.randomBytes(6).toString('hex')}.tmp`,
  );
  try {
    await deps.writeFile(tempPath, snapshot.buf);
    try {
      await fs.promises.rename(tempPath, targetPath);
    } catch (renameErr) {
      const code = (renameErr as NodeJS.ErrnoException)?.code;
      if (code !== 'EPERM' && code !== 'EEXIST' && code !== 'EACCES') throw renameErr;
      const targetExists = await fs.promises
        .access(targetPath)
        .then(() => true, () => false);
      if (!targetExists) throw renameErr;
      await fs.promises.rm(targetPath, { force: true });
      await fs.promises.rename(tempPath, targetPath);
    }
  } catch {
    await fs.promises.rm(tempPath, { force: true }).catch(() => {});
    return { status: 'error', code: 'write_failed' };
  }
  return { status: 'saved', savedPath: targetPath };
}

/**
 * 一步式组合入口(快照 + 对话框 + 落盘)。需要把快照段纳入变更租约的
 * 调用方应拆用 snapshotGhostPackage / writeGhostPackageSnapshot。
 */
export async function exportGhostPackage(
  id: unknown,
  deps: ExportGhostPackageDeps,
): Promise<ExportGhostPackageResult> {
  const snapshot = await snapshotGhostPackage(id, deps);
  if (!snapshot.ok) return snapshot.result;
  return writeGhostPackageSnapshot(snapshot, deps);
}
