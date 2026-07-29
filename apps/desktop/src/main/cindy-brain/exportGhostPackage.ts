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
import path from 'node:path';

import JSZip from 'jszip';

import { isValidGhostId, type InstalledGhost } from '../../shared/ghost';

/** 与 forge.ts shouldSkip 同口径:点开头条目不属于插件本体。 */
function shouldSkipExportEntry(name: string): boolean {
  return name.startsWith('.');
}

export type ExportGhostPackageResult =
  | { status: 'saved'; savedPath: string }
  | { status: 'canceled' }
  | { status: 'invalid_id' }
  | { status: 'not_installed' }
  | { status: 'error'; code: 'read_failed' | 'dialog_failed' | 'write_failed' };

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

export async function exportGhostPackage(
  id: unknown,
  deps: ExportGhostPackageDeps,
): Promise<ExportGhostPackageResult> {
  if (typeof id !== 'string' || !isValidGhostId(id)) {
    return { status: 'invalid_id' };
  }
  const ghost = deps.listInstalled().find((candidate) => candidate.manifest.id === id);
  if (!ghost) return { status: 'not_installed' };

  // 双保险:dir 来自 GhostManager 扫描,这里再确认它是真实目录,避免把
  // 被外部篡改的注册项当成打包源。
  let dirStat: fs.Stats;
  try {
    dirStat = await fs.promises.stat(ghost.dir);
  } catch {
    return { status: 'error', code: 'read_failed' };
  }
  if (!dirStat.isDirectory()) return { status: 'error', code: 'read_failed' };

  // 收集文件:递归、跳过点开头条目(主机保留文件、.DS_Store 等)。
  // 安装目录内容来自装入侧已校验的 zip,此处只做如实归档,不设内容上限
  // (装入侧已卡过解压总量)。
  const files: Array<{ rel: string; abs: string }> = [];
  const walk = async (cur: string, relBase: string): Promise<void> => {
    const entries = await fs.promises.readdir(cur, { withFileTypes: true });
    for (const entry of entries) {
      if (shouldSkipExportEntry(entry.name)) continue;
      const abs = path.join(cur, entry.name);
      const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(abs, rel);
      } else if (entry.isFile()) {
        files.push({ rel, abs });
      }
    }
  };
  try {
    await walk(ghost.dir, '');
  } catch {
    return { status: 'error', code: 'read_failed' };
  }

  const zip = new JSZip();
  try {
    for (const file of files) {
      zip.file(file.rel, await fs.promises.readFile(file.abs));
    }
  } catch {
    return { status: 'error', code: 'read_failed' };
  }
  const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });

  const baseName =
    sanitizeExportFileNamePart(ghost.manifest.name) || ghost.manifest.id;
  const defaultPath = path.join(
    deps.getDownloadsDir(),
    `${baseName}-${ghost.manifest.version}.cindy`,
  );
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

  try {
    await deps.writeFile(picked.filePath, buf);
  } catch {
    return { status: 'error', code: 'write_failed' };
  }
  return { status: 'saved', savedPath: picked.filePath };
}
