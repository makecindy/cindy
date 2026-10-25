import path from 'node:path';
import { promises as fsp } from 'node:fs';

/**
 * maker-host 隔离 home(codex-home / claude-home)与用户全局目录(~/.codex、~/.agents 等)
 * 之间"受管目录链接"的共享原语。受管链接 = 由 xdt-maker 创建的 symlink(Windows 上是
 * junction),xdt-maker 只增删自己创建的链接,永不删除用户/agent CLI 自建的真实目录。
 * codex-global-skills / codex-global-plugins 都基于这组原语实现各自的桥接策略。
 */

export type ManagedLinkStatus = 'linked' | 'kept' | 'missing' | 'conflict' | 'skipped' | 'error';

export interface ManagedLinkResult {
  status: ManagedLinkStatus;
  changed: boolean;
  reason?: string;
}

/** 路径归一化用于比较:Windows 大小写不敏感,统一转小写。 */
export function normalizeForCompare(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** realpath 解析失败(不存在 / 悬空链接)返回 null。 */
export async function realPathOrNull(value: string): Promise<string | null> {
  try {
    return normalizeForCompare(await fsp.realpath(value));
  } catch {
    return null;
  }
}

export async function isDirectory(value: string): Promise<boolean> {
  try {
    return (await fsp.stat(value)).isDirectory();
  } catch {
    return false;
  }
}

/** child 与 parent 相同、或位于 parent 之内(用于 scan 环 / 归属判断)。 */
export function isSameOrInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * 仅当 linkPath 是 symlink(受管形态)时删除;真实目录 / 文件一律不动。
 * 返回是否发生了删除。
 */
export async function removeManagedLink(linkPath: string): Promise<boolean> {
  try {
    const stat = await fsp.lstat(linkPath);
    if (!stat.isSymbolicLink()) return false;
    await fsp.rm(linkPath, { recursive: true, force: true });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

/**
 * 确保 linkPath 是指向 targetPath 的目录链接(Windows junction / POSIX dir symlink):
 *   - 已指向同一 realpath → kept
 *   - 位置被真实目录 / 文件占用 → conflict(绝不覆盖非受管内容)
 *   - 是指向别处的受管链接 → 原子替换为新目标 → linked
 */
export async function ensureDirectoryLink(
  linkPath: string,
  targetPath: string,
): Promise<ManagedLinkResult> {
  const existingReal = await realPathOrNull(linkPath);
  const targetReal = await realPathOrNull(targetPath);
  if (existingReal && targetReal && existingReal === targetReal) {
    return { status: 'kept', changed: false };
  }

  try {
    const stat = await fsp.lstat(linkPath);
    if (!stat.isSymbolicLink()) {
      return {
        status: 'conflict',
        changed: false,
        reason: 'path exists and is not a managed symlink/junction',
      };
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      return { status: 'error', changed: false, reason: (err as Error).message };
    }
  }

  try {
    await removeManagedLink(linkPath);
    await fsp.symlink(targetPath, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
    return { status: 'linked', changed: true };
  } catch (err) {
    return { status: 'error', changed: false, reason: (err as Error).message };
  }
}
