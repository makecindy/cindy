/**
 * exportGhostPackage
 * ---------------------------------------------------------------------------
 * 插件详情页「导出 .cindy」的打包业务体:把已装插件的安装目录重新打成
 * .cindy zip 包(与 forge.ts packGhostDir 同一份内容契约——ghost.json 在
 * zip 根部、不套外层文件夹),供 main IPC handler 经系统保存对话框落盘。
 *
 * 与 forge 打包的三点差异(导出 ≠ 制作,见插件规则文档):
 * - 源是安装目录(装入时的 zip 解包内容),不重新校验清单——装入侧已验过;
 * - 跳过根部主机保留文件(.disabled / .cindy-trust.json)与 .DS_Store,
 *   导出包可原样过装入校验;
 * - 产物不写回源目录,由保存对话框写到用户选定的位置。
 *
 * 整个包先在内存里打完再弹保存对话框:用户挑选位置期间插件被更新/卸载
 * 都不影响已抓到的内容。Electron 对话框、安装目录解析与落盘全部注入,
 * 便于内存 harness 测试。
 */

import fs from 'node:fs';
import path from 'node:path';

import JSZip from 'jszip';

import { isValidGhostId, type InstalledGhost } from '../../shared/ghost.js';

/**
 * 导出过滤口径:只跳过 zip 根部的主机保留文件与根部系统残渣。
 * 嵌套条目(含嵌套 .DS_Store)一律保留——签名包的 statement 覆盖全部
 * 原始条目,跳任何一个都会让导出包装回时完整性校验失败。
 */
const EXPORT_SKIP_ROOT_FILES = new Set(['.disabled', '.cindy-trust.json', '.DS_Store']);
function shouldSkipExportEntry(name: string, relBase: string): boolean {
  return relBase === '' && EXPORT_SKIP_ROOT_FILES.has(name);
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
  // Windows 保留设备名:加前缀避让,不作为非法名交给保存对话框。
  if (WINDOWS_RESERVED_BASENAME.test(cleaned)) cleaned = `_${cleaned}`;
  return cleaned;
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

  // 收集文件并立即读入内存(口径见 shouldSkipExportEntry 头注释)。
  // 安装目录内容来自装入侧已校验的 zip,此处只做如实归档,不设内容上限
  // (装入侧已卡过解压总量)。
  const files: Array<{ rel: string; data: Buffer }> = [];
  const walk = async (cur: string, relBase: string): Promise<void> => {
    const entries = await fs.promises.readdir(cur, { withFileTypes: true });
    for (const entry of entries) {
      if (shouldSkipExportEntry(entry.name, relBase)) continue;
      // symlink/junction 不跟随:只归档安装目录自身的真实内容,
      // 防止借链接把目录外文件打进导出包。
      if (entry.isSymbolicLink()) continue;
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
    return { status: 'error', code: 'read_failed' };
  }

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
      filters: [{ name: 'Cindy Plugin', extensions: ['cindy'] }],
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
