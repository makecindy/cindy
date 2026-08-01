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
  | 'INVALID_SPARSE_PATH'
  | 'CREDENTIALS_NOT_ALLOWED';

export type MarketSourceParseResult =
  | { ok: true; source: MarketSource }
  | { ok: false; code: MarketSourceParseError };

/** Git 引用（branch / tag / commit）允许的字符集；拒绝选项注入（- 开头）与路径穿越。 */
const REF_PATTERN = /^(?!-)[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
/**
 * 控制字符与双向文本控制符:URL / sparsePaths 里出现即拒。U+202E 等可让来源
 * 在 UI 单行里显示成另一个域名(视觉欺骗),控制字符则可注入日志与终端。
 * 与 discover 的市场名闸(FORBIDDEN_NAME_CHARS)同一口径。
 */
// eslint-disable-next-line no-control-regex
const FORBIDDEN_SOURCE_CHARS = /[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/;
/** GitHub shorthand：owner/repo，各段为常见 GitHub 命名字符。 */
const GITHUB_SHORTHAND_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
// 仅允许经认证的传输:https(服务端证书)、ssh/git@(SSH agent)。
// 明文 git:// 无服务端认证与传输加密,链路可被中间人篡改插件代码,拒绝。
const GIT_URL_PATTERN = /^(https:\/\/|ssh:\/\/|git@)[^\s]+$/i;

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

function hasEmbeddedCredentials(input: string): boolean {
  // https:// 明文 URL 的凭证会随 source 持久化并回传 Renderer，必须拒绝。
  // ssh:// 的 username 是认证主体（git@ 是标准形式），由 SSH agent 持有私钥，不算内嵌凭证。
  if (/^https?:\/\//i.test(input)) {
    try {
      const parsed = new URL(input);
      if (parsed.username.length > 0 || parsed.password.length > 0) return true;
      // 查询参数同样可携带签名/令牌(?access_token=SECRET),市场仓库 URL
      // 不需要 query,一律拒绝,引导走 credential helper / SSH,而非白名单剥离。
      if (parsed.search.length > 0 || parsed.hash.length > 0) return true;
    } catch {
      // 解析不了的串无从判定 userinfo,按"可能带凭证"拒绝(fail closed)。
      return true;
    }
  }
  // ssh:// 的 username 是认证主体,但 password 位是明文凭证;query / fragment
  // 同样能塞令牌或签名并随 source 持久化、在 UI 摘要里露出,一并拒绝。
  if (/^ssh:\/\//i.test(input)) {
    try {
      const parsed = new URL(input);
      return parsed.password.length > 0 || parsed.search.length > 0 || parsed.hash.length > 0;
    } catch {
      return true;
    }
  }
  // scp 形态(git@host:owner/repo.git)不是合法 URL,new URL 解析不了。它同样不该
  // 带 query / fragment —— `git@host:repo.git?token=...` 会被 GIT_URL_PATTERN 接受,
  // 然后把令牌一路持久化下去。
  if (/^[^\s/@]+@[^\s:/]+:/.test(input)) {
    return input.includes('?') || input.includes('#');
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
    if (FORBIDDEN_SOURCE_CHARS.test(trimmed)) return false;
    if (trimmed.startsWith('/') || trimmed.startsWith('\\')) return false;
    if (/^[A-Za-z]:/.test(trimmed)) return false;
    // 拒绝 Git 选项注入(--stdin 会让 sparse-checkout 读 stdin 直至超时)。
    if (trimmed.startsWith('-')) return false;
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
  if (FORBIDDEN_SOURCE_CHARS.test(trimmed)) return { ok: false, code: 'INVALID_SOURCE_FORMAT' };
  if (ref && !REF_PATTERN.test(ref)) return { ok: false, code: 'INVALID_REF' };
  if (!validSparsePaths(sparsePaths)) return { ok: false, code: 'INVALID_SPARSE_PATH' };

  if (looksLikeLocalPath(trimmed)) {
    if (ref) return { ok: false, code: 'REF_NOT_ALLOWED_FOR_LOCAL' };
    if (sparsePaths.length > 0) return { ok: false, code: 'SPARSE_NOT_ALLOWED_FOR_LOCAL' };
    return { ok: true, source: { type: 'local', path: resolveLocalSourcePath(trimmed, homeDir) } };
  }

  if (GIT_URL_PATTERN.test(trimmed)) {
    // WHATWG URL 把 `\` 当 `/` 归一,git 却按原样解析 authority:
    // `https://TOKEN\@host/...` 在 new URL 里看不到 userinfo(凭证闸失明),
    // git 实际连的 host 也与校验层认定的不一致(供应链/视觉欺骗)。一律拒。
    if (trimmed.includes('\\')) return { ok: false, code: 'INVALID_SOURCE_FORMAT' };
    if (hasEmbeddedCredentials(trimmed)) {
      return { ok: false, code: 'CREDENTIALS_NOT_ALLOWED' };
    }
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
