/**
 * 自定义插件市场来源解析。
 *
 * 把用户输入（GitHub shorthand / Git URL / 本地路径）归一成 MarketSource。
 * 纯函数、无副作用：本地路径只做形状判断，存在性检查由 SourceManager 在
 * 添加时执行（parse 阶段不碰文件系统，便于单测与 Renderer 即时校验复用）。
 */
import path from 'node:path';

import type { MarketSource } from '../../../shared/pluginMarket.js';

export type MarketSourceParseError =
  | 'EMPTY_SOURCE'
  | 'REF_NOT_ALLOWED_FOR_LOCAL'
  | 'SPARSE_NOT_ALLOWED_FOR_LOCAL'
  | 'INVALID_SOURCE_FORMAT'
  | 'INVALID_REF'
  | 'INVALID_SPARSE_PATH';

export type MarketSourceParseResult =
  | { ok: true; source: MarketSource }
  | { ok: false; code: MarketSourceParseError };

/** Git 引用（branch / tag / commit）允许的字符集；拒绝选项注入（- 开头）与路径穿越。 */
const REF_PATTERN = /^(?!-)[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
/** GitHub shorthand：owner/repo，各段为常见 GitHub 命名字符。 */
const GITHUB_SHORTHAND_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const GIT_URL_PATTERN = /^(https:\/\/|ssh:\/\/|git:\/\/|git@)[^\s]+$/i;

function looksLikeLocalPath(input: string): boolean {
  if (input.startsWith('~')) return true;
  if (path.isAbsolute(input)) return true;
  // Windows 盘符路径（C:\... / C:/...）。
  if (/^[A-Za-z]:[\\/]/.test(input)) return true;
  // 显式相对路径（./plugins、../shared）按本地路径对待。
  if (input.startsWith('./') || input.startsWith('../') || input.startsWith('.\\') || input.startsWith('..\\')) {
    return true;
  }
  return false;
}

/** 展开 ~ 并归一化；不解析符号链接（归属判断由安装管道负责）。 */
export function resolveLocalSourcePath(input: string, homeDir: string): string {
  const expanded = input.startsWith('~')
    ? path.join(homeDir, input.slice(1).replace(/^[/\\]/, ''))
    : input;
  return path.resolve(expanded);
}

function validSparsePaths(paths: readonly string[]): boolean {
  return paths.every((entry) => {
    const trimmed = entry.trim();
    if (!trimmed || trimmed.length > 256) return false;
    if (trimmed.startsWith('/') || trimmed.startsWith('\\')) return false;
    if (/^[A-Za-z]:/.test(trimmed)) return false;
    // 拒绝路径穿越；sparse-checkout 只允许仓库内相对目录。
    return !trimmed.split(/[/\\]/).includes('..');
  });
}

/**
 * 解析用户输入的市场来源。`homeDir` 由调用方注入（Main 取 os.homedir()，
 * 测试注入固定值），保持本模块不直接读进程环境。
 */
export function parseMarketSource(
  input: { source: string; ref?: string; sparsePaths?: string[] },
  homeDir: string,
): MarketSourceParseResult {
  const trimmed = input.source.trim();
  const ref = input.ref?.trim() || undefined;
  const sparsePaths = (input.sparsePaths ?? [])
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  if (!trimmed) return { ok: false, code: 'EMPTY_SOURCE' };
  if (ref && !REF_PATTERN.test(ref)) return { ok: false, code: 'INVALID_REF' };
  if (!validSparsePaths(sparsePaths)) return { ok: false, code: 'INVALID_SPARSE_PATH' };

  if (looksLikeLocalPath(trimmed)) {
    if (ref) return { ok: false, code: 'REF_NOT_ALLOWED_FOR_LOCAL' };
    if (sparsePaths.length > 0) return { ok: false, code: 'SPARSE_NOT_ALLOWED_FOR_LOCAL' };
    return { ok: true, source: { type: 'local', path: resolveLocalSourcePath(trimmed, homeDir) } };
  }

  if (GIT_URL_PATTERN.test(trimmed)) {
    return { ok: true, source: { type: 'git', url: trimmed, ...(ref ? { ref } : {}), sparsePaths } };
  }

  if (GITHUB_SHORTHAND_PATTERN.test(trimmed)) {
    return {
      ok: true,
      source: {
        type: 'git',
        url: `https://github.com/${trimmed}.git`,
        ...(ref ? { ref } : {}),
        sparsePaths,
      },
    };
  }

  return { ok: false, code: 'INVALID_SOURCE_FORMAT' };
}
