import fs from 'node:fs/promises';
import path from 'node:path';

import * as tar from 'tar';

import {
  BOT_BUNDLE_MAX_FILES,
  BOT_BUNDLE_MAX_FILE_BYTES,
  BOT_BUNDLE_MAX_TOTAL_BYTES,
} from '../../shared/botPortability.js';

export interface BotBundleArchiveEntry {
  path: string;
  type: string;
  size: number;
}

const WINDOWS_DRIVE = /^[a-zA-Z]:[\\/]/;
const ALLOWED_TYPES = new Set(['File', 'Directory']);

export function normalizeBotBundleEntryPath(rawPath: string): string[] {
  const portable = rawPath.replaceAll('\\', '/');
  if (!portable || portable.startsWith('/') || WINDOWS_DRIVE.test(rawPath)) {
    throw new Error('Bot 配置包包含绝对路径');
  }
  const parts = portable.split('/').filter(Boolean);
  if (parts.length === 0 || parts.some((part) => part === '.' || part === '..')) {
    throw new Error('Bot 配置包包含不安全路径');
  }
  return parts;
}

export function inspectBotBundleEntries(entries: BotBundleArchiveEntry[]): string {
  if (entries.length === 0) throw new Error('Bot 配置包为空');
  if (entries.length > BOT_BUNDLE_MAX_FILES) throw new Error('Bot 配置包文件数量超过上限');
  let totalBytes = 0;
  let root: string | null = null;
  for (const entry of entries) {
    if (!ALLOWED_TYPES.has(entry.type)) {
      throw new Error(`Bot 配置包包含不支持的文件类型: ${entry.type}`);
    }
    const parts = normalizeBotBundleEntryPath(entry.path);
    root ??= parts[0];
    if (parts[0] !== root) throw new Error('Bot 配置包必须只有一个顶层目录');
    if (!Number.isSafeInteger(entry.size) || entry.size < 0) {
      throw new Error('Bot 配置包包含无效文件大小');
    }
    if (entry.size > BOT_BUNDLE_MAX_FILE_BYTES) {
      throw new Error('Bot 配置包单个文件超过大小上限');
    }
    totalBytes += entry.size;
    if (totalBytes > BOT_BUNDLE_MAX_TOTAL_BYTES) {
      throw new Error('Bot 配置包总大小超过上限');
    }
  }
  if (!root) throw new Error('Bot 配置包为空');
  return root;
}

export async function inspectBotBundleArchive(archivePath: string): Promise<{
  root: string;
  entries: BotBundleArchiveEntry[];
}> {
  const entries: BotBundleArchiveEntry[] = [];
  await tar.t({
    file: archivePath,
    strict: true,
    onentry: (entry) => {
      entries.push({ path: entry.path, type: entry.type, size: entry.size });
    },
  });
  return { root: inspectBotBundleEntries(entries), entries };
}

export async function safelyExtractBotBundle(archivePath: string, targetDir: string): Promise<string> {
  const { root } = await inspectBotBundleArchive(archivePath);
  await fs.mkdir(targetDir, { recursive: true, mode: 0o700 });
  await tar.x({
    file: archivePath,
    cwd: targetDir,
    strict: true,
    preservePaths: false,
    noChmod: true,
    filter: (_entryPath, entry) => 'type' in entry && ALLOWED_TYPES.has(entry.type),
  });
  const extractedRoot = path.join(targetDir, root);
  const resolvedTarget = path.resolve(targetDir);
  const resolvedRoot = path.resolve(extractedRoot);
  if (resolvedRoot === resolvedTarget || !resolvedRoot.startsWith(`${resolvedTarget}${path.sep}`)) {
    throw new Error('Bot 配置包解压目录越界');
  }
  const stat = await fs.lstat(extractedRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('Bot 配置包顶层必须是普通目录');
  }
  return extractedRoot;
}
