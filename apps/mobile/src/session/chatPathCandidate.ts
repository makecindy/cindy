/**
 * chatPathCandidate — 聊天正文里文件/目录路径引用的纯字符串识别与换算。
 * ---------------------------------------------------------------------------
 * 手机版「文件 chip 点亮」的候选判定层,与桌面端保持同一套识别语义
 * (apps/desktop/src/renderer/lib/{localPathResolver,markdownTarget}.ts 与
 * shared/workdirPath.ts 的移植子集;两端判定规则如需调整应同步):
 *
 *   - 识别宽松、点亮严格:这里只判「形状像不像路径」,误报由远端 stat 验证
 *     (remotePathVerdict)过滤——不存在的路径永远保持纯文本。
 *   - 行号后缀(`foo.ts:42`、`foo.ts:42:7`、`foo.ts:10-20`)拆出 line/column;
 *   - 目录尾斜杠形态(`src/components/`)去尾杠后按 candidate 处理;
 *   - workdir 相对换算兼容 Windows 被控端(反斜杠、大小写不敏感、`.` 段归一、
 *     `..` 逃逸拒绝),输出统一 POSIX 分隔(file-browser 全链路 relPath 约定);
 *   - workdir 外的绝对路径不再一票否决:文件按 absPath 走被控端媒体取件 /
 *     文本预览通道打开(对齐桌面缓存副本语义),目录仍保持纯文本
 *     (canOpenChatPathChip)。
 *
 * 全部纯函数,无 IO、无 RN 依赖,可单测。
 */

const WIN_ABS_RE = /^[A-Za-z]:[\\/]/;
/** POSIX 绝对路径且带扩展名(裸 `/etc` 不算)。 */
const POSIX_ABS_PATH_RE = /^\/[^/\s][^\s]*\.[a-z0-9]{1,10}(\?[^\s]*)?$/i;
/** 相对路径:至少一个分隔符 + 扩展名 + 无空白无冒号。 */
const REL_PATH_WITH_SEP_AND_EXT_RE = /^[^\s:]*[\\/][^\s:]+\.[a-z0-9]{1,10}(\?[^\s]*)?$/i;
/** 任意 URL scheme(http://、file://、git+ssh:// …)。 */
const URL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
/** 广义 scheme 前缀(`foo:`),用于剔除 mailto: 等非路径形态。 */
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
/** 尾部路径分隔符 → 目录形态。 */
const TRAILING_SEP_RE = /[\\/]$/;
/** 裸文件名引用(`package.json`):无分隔符但有 1-10 位扩展名。 */
const BARE_FILE_REF_RE = /^[^\s:<>()[\]{}"'`]+?\.[a-z0-9]{1,10}$/i;
/** 有任意扩展名(byExt 兜底判定用)。 */
const HAS_EXT_RE = /\.[a-z0-9]{1,10}(\?.*)?$/i;
const POSITIVE_LINE_NUMBER_RE = /^[1-9]\d{0,6}$/;
const LINE_RANGE_SUFFIX_RE = /^([1-9]\d{0,6})-([1-9]\d{0,6})$/;

export interface ChatPathLineSuffix {
  href: string;
  line?: number;
  column?: number;
}

/** 拆 `path:line[:column]` / `path:start-end` 后缀(与桌面 splitLocalLineSuffix 同语义)。 */
export function splitChatPathLineSuffix(raw: string): ChatPathLineSuffix {
  const href = raw.trim();
  if (!href) return { href };
  if (URL_SCHEME_RE.test(href) && !href.toLowerCase().startsWith('file://')) {
    return { href };
  }

  const lastColon = href.lastIndexOf(':');
  if (lastColon <= 0) return { href };

  const lastPart = href.slice(lastColon + 1);
  const beforeLastPart = href.slice(0, lastColon);

  const rangeMatch = lastPart.match(LINE_RANGE_SUFFIX_RE);
  if (rangeMatch) {
    const line = Number(rangeMatch[1]);
    const endLine = Number(rangeMatch[2]);
    if (!Number.isSafeInteger(line) || !Number.isSafeInteger(endLine) || endLine < line) {
      return { href };
    }
    return { href: beforeLastPart, line };
  }

  if (!POSITIVE_LINE_NUMBER_RE.test(lastPart)) return { href };

  const previousColon = beforeLastPart.lastIndexOf(':');
  const previousPart = previousColon >= 0 ? beforeLastPart.slice(previousColon + 1) : '';
  const hasColumn = POSITIVE_LINE_NUMBER_RE.test(previousPart);
  const base = hasColumn ? beforeLastPart.slice(0, previousColon) : beforeLastPart;
  if (!base) return { href };

  const line = Number(hasColumn ? previousPart : lastPart);
  const column = hasColumn ? Number(lastPart) : undefined;
  if (!Number.isSafeInteger(line) || line <= 0) return { href };
  if (column !== undefined && (!Number.isSafeInteger(column) || column <= 0)) return { href };

  return {
    href: base,
    line,
    ...(column !== undefined ? { column } : {}),
  };
}

/** 尾斜杠 → 目录形态(renderer 无法 stat,尾杠是唯一可靠信号)。 */
export function looksLikeDirectoryPath(text: string): boolean {
  if (!text) return false;
  return TRAILING_SEP_RE.test(text);
}

/** Windows 盘符前缀(`C:\x`)不算 scheme;file:// 允许;其余 `foo:` 前缀一律拒绝。 */
function hasUnsupportedScheme(value: string): boolean {
  if (WIN_ABS_RE.test(value)) return false;
  if (value.toLowerCase().startsWith('file://')) return false;
  return SCHEME_RE.test(value);
}

/**
 * 「形状像文件路径」严判(inline code 常见标识符/命令,宽了全是误点击目标):
 * Windows 绝对 / POSIX 绝对带扩展 / 相对带分隔符带扩展,三者任一。
 */
export function looksLikeFilePath(text: string): boolean {
  if (!text) return false;
  if (text.includes('\n')) return false;
  if (URL_SCHEME_RE.test(text)) return false;
  if (looksLikeDirectoryPath(text)) return false;
  if (WIN_ABS_RE.test(text)) return true;
  if (POSIX_ABS_PATH_RE.test(text)) return true;
  if (REL_PATH_WITH_SEP_AND_EXT_RE.test(text)) return true;
  return false;
}

/** 裸文件名引用(`package.json`),存在性由远端 stat 决定。 */
export function looksLikeBareFileReference(value: string): boolean {
  if (!value || value.includes('\n')) return false;
  if (hasUnsupportedScheme(value)) return false;
  if (looksLikeDirectoryPath(value)) return false;
  return BARE_FILE_REF_RE.test(value);
}

/**
 * classifyMarkdownHref 的 local 判定子集(不区分 image/text/model——手机预览页
 * 自己按扩展名分派):绝对路径 / 含分隔符 / 带扩展名任一即视作本地路径形态。
 */
function looksLikeLocalHref(href: string): boolean {
  if (!href) return false;
  if (/^https?:\/\//i.test(href)) return false;
  if (href.startsWith('#')) return false;
  if (URL_SCHEME_RE.test(href) && !href.startsWith('file://')) return false;
  let probe = href;
  if (probe.startsWith('file://')) probe = probe.slice(7);
  return (
    probe.startsWith('/')
    || WIN_ABS_RE.test(probe)
    || probe.includes('/')
    || probe.includes('\\')
    || HAS_EXT_RE.test(probe)
  );
}

export interface ChatPathCandidate {
  /** 去掉行号后缀与目录尾斜杠后的路径文本(拿去 join workdir)。 */
  href: string;
  line?: number;
  column?: number;
  /** 尾斜杠目录形态:verdict 为 unknown(乐观点亮)时按目录处理。 */
  directoryShape: boolean;
}

/**
 * inline code 文本 → 路径候选(与桌面 classifyInlineCodeTarget 同语义)。
 * 首尾空白 / 多行 / scheme 前缀(`mailto:`、`git+ssh://`)一律不候选;
 * 候选 ≠ 点亮,存在性由 remotePathVerdict 远端 stat 决定。
 */
export function classifyInlineCodePathCandidate(text: string): ChatPathCandidate | null {
  const raw = text.trim();
  if (!raw || raw !== text || raw.includes('\n')) return null;
  if (hasUnsupportedScheme(raw)) return null;

  const lineInfo = splitChatPathLineSuffix(raw);
  const href = lineInfo.href;
  if (looksLikeDirectoryPath(href)) {
    const stripped = href.replace(/[\\/]+$/, '');
    if (!stripped) return null;
    return { href: stripped, directoryShape: true };
  }
  if (!looksLikeFilePath(href) && !looksLikeBareFileReference(href) && !looksLikeLocalHref(href)) {
    return null;
  }
  return {
    href,
    directoryShape: false,
    ...(lineInfo.line !== undefined ? { line: lineInfo.line } : {}),
    ...(lineInfo.column !== undefined ? { column: lineInfo.column } : {}),
  };
}

/**
 * markdown 链接目标 → 路径候选(与桌面 classifyMarkdownLinkTarget 的 local 分支
 * 同语义):`[README.md](/abs/path/README.md:17)` 这类模型高频输出的本地路径链接。
 * http(s) / 锚点 / 非 file 的 scheme 一律不候选(那些走原有 link 渲染分支);
 * 与 inline code 版的差异:不要求原文无首尾空白(URL 在括号里,天然精确)。
 */
export function classifyChatPathLinkTarget(url: string): ChatPathCandidate | null {
  const raw = url.trim();
  if (!raw || raw.includes('\n')) return null;
  if (/^https?:\/\//i.test(raw)) return null;
  if (raw.startsWith('#')) return null;
  if (hasUnsupportedScheme(raw)) return null;

  const lineInfo = splitChatPathLineSuffix(raw);
  const href = lineInfo.href;
  if (looksLikeDirectoryPath(href)) {
    const stripped = href.replace(/[\\/]+$/, '');
    if (!stripped) return null;
    return { href: stripped, directoryShape: true };
  }
  if (!looksLikeLocalHref(href)) return null;
  return {
    href,
    directoryShape: false,
    ...(lineInfo.line !== undefined ? { line: lineInfo.line } : {}),
    ...(lineInfo.column !== undefined ? { column: lineInfo.column } : {}),
  };
}

/**
 * href → 被控端绝对路径(与桌面 resolveLocalPath 同语义):
 * file:// 解包;绝对路径原样;相对路径按 workdir 分隔符风格 join
 * (workdir 含 `\` → Windows join 并把 href 的 `/` 归一为 `\`)。
 * 不做存在性检查——那是 remotePathVerdict 的事。
 */
export function resolveChatAbsPath(href: string, workdir: string): string {
  if (href.startsWith('file://')) {
    // 非法百分号序列(`50%off.md` 的 `%of`)会让 decodeURIComponent 抛 URIError,
    // 而本函数在 chip 组件 useMemo 里同步跑,异常会崩整条消息渲染——解码失败
    // 回退原文(bot review 实捉);路径若真不存在由远端 stat 判 nonfile 兜底。
    let p: string;
    try {
      p = decodeURIComponent(href.slice(7));
    } catch {
      p = href.slice(7);
    }
    if (/^\/[A-Za-z]:[\\/]/.test(p)) p = p.slice(1);
    return p;
  }
  if (href.startsWith('/')) return href;
  if (WIN_ABS_RE.test(href)) return href;

  const isWin = workdir.includes('\\');
  const sep = isWin ? '\\' : '/';
  // 去尾部分隔符,但保住根形态(`/`、`C:\`)。
  const trimmed = workdir.replace(/[\\/]+$/, '');
  const base = trimmed || (workdir.startsWith('/') ? '/' : workdir);
  const normalizedHref = isWin ? href.replace(/\//g, '\\') : href;
  return base === '/' ? `/${normalizedHref}` : `${base}${sep}${normalizedHref}`;
}

/** 去掉路径里的 `.` 段(`/w/./a` → `/w/a`),避免同路径两形态。 */
export function dropDotSegments(p: string): string {
  const isAbs = p.startsWith('/');
  const segs = p.split('/').filter((s) => s !== '.' && s !== '');
  return (isAbs ? '/' : '') + segs.join('/');
}

function toWorkdirRelPosix(workdir: string, absPath: string): string | null {
  if (!workdir.startsWith('/') || !absPath.startsWith('/')) return null;
  if (absPath.split('/').includes('..')) return null;
  const base = workdir.replace(/\/+$/, '');
  if (!absPath.startsWith(`${base}/`)) return null;
  const rel = absPath.slice(base.length + 1);
  return rel.length > 0 ? rel : null;
}

/**
 * 绝对路径 → workdir 相对路径(POSIX 分隔;与桌面 shared/workdirPath.ts 同语义)。
 * 不在 workdir 内(含 workdir 自身)/ `..` 逃逸 / 风格不匹配 → null。
 * Windows 被控端按大小写不敏感前缀比较,输出仍统一 POSIX 分隔。
 */
export function toWorkdirRel(workdir: string, absPath: string): string | null {
  if (!workdir || !absPath) return null;
  if (workdir.startsWith('/')) {
    return toWorkdirRelPosix(workdir, dropDotSegments(absPath));
  }
  if (!WIN_ABS_RE.test(workdir) || !WIN_ABS_RE.test(absPath)) return null;
  const w = workdir.replace(/\\/g, '/').replace(/\/+$/, '');
  const a = dropDotSegments(absPath.replace(/\\/g, '/'));
  if (a.split('/').includes('..')) return null;
  if (!a.toLowerCase().startsWith(`${w.toLowerCase()}/`)) return null;
  const rel = a.slice(w.length + 1);
  return rel.length > 0 ? rel : null;
}

/** 绝对路径形态(POSIX `/x` 或 Windows 盘符 `C:\x`),与相对路径二分。 */
export function isAbsolutePathShape(p: string): boolean {
  return p.startsWith('/') || WIN_ABS_RE.test(p);
}

/** 路径显示名:最后一段(POSIX / Windows 分隔符均可,尾分隔符忽略)。 */
export function pathDisplayName(p: string): string {
  const last = p.split(/[\\/]/).filter(Boolean).pop();
  return last ?? p;
}

/**
 * chip 是否可打开(点亮的后置条件):workdir 外(relPath 为 null)只有文件可开
 * ——文件走被控端绝对路径取件通道(fs:stat-path 已验存在);目录只能靠
 * 文件浏览器定位,而文件浏览器以 workdir 为根,workdir 外目录保持纯文本。
 * 与桌面对齐:桌面对 workdir 外目录同样只报「不在工作目录内」,无可用动作。
 */
export function canOpenChatPathChip(kind: 'file' | 'directory', relPath: string | null): boolean {
  return kind === 'file' || relPath !== null;
}
