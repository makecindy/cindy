/**
 * 从最近一轮消息里的文件编辑产物提取改动路径。
 *
 * 这是 renderer 已经拿到的会话产物，不需要额外扫描磁盘或给文件挂 watcher。
 * Review 的「最近一轮」过滤与本地 HTML 预览刷新共用同一套口径。
 */

import type { ChatMessage } from '@/lib/makerChatStore';

const EDIT_TOOL_NAMES = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

function slashPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+/g, '/');
}

function normalizeForCompare(p: string, platform: string): string {
  const normalized = slashPath(p);
  return platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function defaultPlatform(): string {
  return typeof window === 'undefined' ? '' : (window.electronAPI?.platform ?? '');
}

function isAbsoluteLikePath(filePath: string): boolean {
  return (
    filePath.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(filePath) || filePath.startsWith('\\\\')
  );
}

function normalizeWorkdirRelativePath(filePath: string): string | null {
  const rel = slashPath(filePath).replace(/^\.\//, '');
  return rel && rel !== '.' ? rel : null;
}

export function absoluteToWorkdirRelative(
  filePath: string,
  workdir: string,
  platform = defaultPlatform(),
): string | null {
  if (!filePath || !workdir) return null;
  const file = normalizeForCompare(filePath, platform);
  const root = normalizeForCompare(workdir, platform).replace(/\/$/, '');
  if (file === root) return '';
  if (!file.startsWith(`${root}/`)) return null;
  return slashPath(filePath).slice(slashPath(workdir).replace(/\/$/, '').length + 1);
}

function addPathLike(paths: string[], value: unknown): void {
  if (typeof value === 'string' && value.trim()) paths.push(value);
}

function collectCodexFileChangePaths(input: Record<string, unknown> | null): string[] {
  const paths: string[] = [];
  const changes = input?.changes;
  if (!Array.isArray(changes)) return paths;
  for (const change of changes) {
    if (!change || typeof change !== 'object') continue;
    const record = change as Record<string, unknown>;
    addPathLike(paths, record.path);
    const kind = record.kind;
    if (kind && typeof kind === 'object') {
      const kindRecord = kind as Record<string, unknown>;
      addPathLike(paths, kindRecord.move_path);
      addPathLike(paths, kindRecord.movePath);
    }
    addPathLike(paths, record.move_path);
    addPathLike(paths, record.movePath);
  }
  return paths;
}

function extractToolFilePaths(msg: ChatMessage): string[] {
  if (msg.role !== 'tool_use' || !msg.toolName) return [];
  const input = (msg.toolInput as Record<string, unknown> | null) ?? null;
  if (msg.toolName === 'file_change') return collectCodexFileChangePaths(input);
  if (!EDIT_TOOL_NAMES.has(msg.toolName)) return [];
  const filePath = input?.file_path;
  return typeof filePath === 'string' && filePath ? [filePath] : [];
}

function toolPathToWorkdirRelative(
  filePath: string,
  workdir: string,
  platform: string,
): string | null {
  if (isAbsoluteLikePath(filePath)) {
    return absoluteToWorkdirRelative(filePath, workdir, platform);
  }
  return normalizeWorkdirRelativePath(filePath);
}

export function collectLastTurnPaths(
  messages: readonly ChatMessage[],
  workdir: string | null,
  platform = defaultPlatform(),
): Set<string> {
  const paths = new Set<string>();
  if (!workdir) return paths;
  let start = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === 'user') {
      start = i;
      break;
    }
  }
  for (let i = start; i < messages.length; i += 1) {
    for (const filePath of extractToolFilePaths(messages[i])) {
      const rel = toolPathToWorkdirRelative(filePath, workdir, platform);
      if (rel) paths.add(rel);
    }
  }
  return paths;
}

export function wasFileChangedInLastTurn(
  messages: readonly ChatMessage[],
  workdir: string,
  absoluteFilePath: string,
  platform = defaultPlatform(),
): boolean {
  const target = absoluteToWorkdirRelative(absoluteFilePath, workdir, platform);
  if (!target) return false;
  const normalizedTarget = normalizeForCompare(target, platform);
  return [...collectLastTurnPaths(messages, workdir, platform)].some(
    (path) => normalizeForCompare(path, platform) === normalizedTarget,
  );
}
