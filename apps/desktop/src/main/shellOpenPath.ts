/** Resolve user-openable local paths without exposing media-store paths to renderer. */

import path from 'node:path';

import * as cindyMediaBlobStore from './cindy-media/blobStore.desktop.js';
import { stripWindowsDriveUriSlash } from '../shared/pathText';

/**
 * Chat history persists managed media as a stable `cindy-media://` reference.
 * Resolve that reference inside main immediately before a user-initiated OS
 * open; ordinary callers retain the existing absolute-path contract.
 */
export function resolveShellOpenPathTarget(
  value: string,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (!value) return null;
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  // `/D:/x` 是 URI pathname 形态的盘符路径(模型常在 markdown 链接里这么写);
  // Windows 上剥掉前导斜杠还给盘符,否则 normalize 会产出当前盘下的非法
  // `\D:\x`。POSIX 的 `/D:` 是合法根目录名,不动。
  const target = platform === 'win32' ? stripWindowsDriveUriSlash(value) : value;
  // path.normalize 把正斜杠 Windows 路径(`C:/x/a.docx`,常见于模型输出与命令
  // 文本)折成本机分隔符:shell.openPath 对「正斜杠 + 仅用户层文件关联」的组合
  // 解析失败,showItemInFolder 对正斜杠更是静默无反应。POSIX 上是幂等操作。
  if (pathApi.isAbsolute(target)) return pathApi.normalize(target);
  if (target.startsWith('cindy-media://')) return cindyMediaBlobStore.resolveSafe(target).absPath;
  return null;
}

/**
 * 只有用户本机的原件才交给声明了 `fileOpener` 的插件打开。Cindy 媒体库里的文件和其它
 * 电脑文件的缓存副本(远程文件缓存、聊天附件缓存)照旧交给系统默认应用:插件改了副本,
 * 改动回不到原来那台电脑。
 */
export function isLocalOriginalForPluginOpen(
  input: string,
  resolvedPath: string,
  managedCopyRoots: readonly string[],
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (input.startsWith('cindy-media://')) return false;
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const fold = (value: string) => {
    const normalized = pathApi.resolve(value);
    return platform === 'win32' ? normalized.toLowerCase() : normalized;
  };
  const target = fold(resolvedPath);
  return !managedCopyRoots.some((root) => {
    if (!root) return false;
    const base = fold(root);
    return target === base || target.startsWith(base.endsWith(pathApi.sep) ? base : base + pathApi.sep);
  });
}
