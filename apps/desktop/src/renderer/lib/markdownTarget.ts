import {
  classifyMarkdownHref,
  looksLikeDirectoryPath,
  looksLikeFilePath,
  resolveKnownLocalFileHref,
  type KnownLocalFileRef,
  type LocalHrefKind,
} from './localPathResolver';

const HTTP_URL_RE = /^https?:\/\//i;
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
const WINDOWS_ABSOLUTE_PATH_RE = /^[a-z]:[\\/]/i;
const URL_WITH_DOUBLE_SLASH_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
const BARE_FILE_REF_RE = /^[^\s:<>()[\]{}"'`]+?\.[a-z0-9]{1,10}$/i;
const POSITIVE_LINE_NUMBER_RE = /^[1-9]\d{0,6}$/;
const LINE_RANGE_SUFFIX_RE = /^([1-9]\d{0,6})-([1-9]\d{0,6})$/;

export type MarkdownLocalKind = 'image' | 'model' | 'text' | 'directory';

export type MarkdownTarget =
  | { kind: 'external'; href: string }
  | { kind: 'anchor'; id: string; href: string }
  | { kind: 'audio'; href: string }
  | { kind: 'local-image-url'; href: string }
  | {
      kind: 'resolved-local';
      href: string;
      absPath: string;
      localKind: MarkdownLocalKind;
      line?: number;
      column?: number;
    }
  | {
      kind: 'local-candidate';
      href: string;
      originalHref: string;
      localKind: MarkdownLocalKind;
      line?: number;
      column?: number;
    }
  | {
      kind: 'code-reference';
      href: string;
      reason: 'directory' | 'path-like-unsupported' | 'unsupported-scheme';
    }
  | {
      kind: 'plain-text';
      href: string;
      reason: 'empty' | 'unsupported-scheme' | 'not-a-target';
    };

export interface ParsedLineSuffix {
  href: string;
  line?: number;
  column?: number;
}

export function splitLocalLineSuffix(raw: string): ParsedLineSuffix {
  const href = raw.trim();
  if (!href) return { href };
  if (URL_WITH_DOUBLE_SLASH_RE.test(href) && !href.toLowerCase().startsWith('file://')) {
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

export function looksLikeBareFileReference(value: string): boolean {
  if (!value || value.includes('\n')) return false;
  if (hasUnsupportedScheme(value)) return false;
  if (looksLikeDirectoryPath(value)) return false;
  return BARE_FILE_REF_RE.test(value);
}

function hasUnsupportedScheme(value: string): boolean {
  if (WINDOWS_ABSOLUTE_PATH_RE.test(value)) return false;
  if (value.toLowerCase().startsWith('file://')) return false;
  return SCHEME_RE.test(value);
}

function decodeAnchorId(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function toMarkdownLocalKind(kind: LocalHrefKind): MarkdownLocalKind | null {
  if (kind === 'image-local') return 'image';
  if (kind === 'model-local') return 'model';
  if (kind === 'text-local') return 'text';
  return null;
}

function classifyLocalCandidate(
  originalHref: string,
  href: string,
  localKind: MarkdownLocalKind,
  files?: readonly KnownLocalFileRef[],
): MarkdownTarget {
  const knownPath = resolveKnownLocalFileHref(href, files);
  const lineInfo = splitLocalLineSuffix(originalHref);
  if (knownPath) {
    return {
      kind: 'resolved-local',
      href,
      absPath: knownPath,
      localKind,
      ...(lineInfo.line !== undefined ? { line: lineInfo.line } : {}),
      ...(lineInfo.column !== undefined ? { column: lineInfo.column } : {}),
    };
  }
  return {
    kind: 'local-candidate',
    href,
    originalHref,
    localKind,
    ...(lineInfo.line !== undefined ? { line: lineInfo.line } : {}),
    ...(lineInfo.column !== undefined ? { column: lineInfo.column } : {}),
  };
}

/**
 * 「形状上无法与普通代码 / 散文区分」的歧义路径引用(与移动端
 * chatPathCandidate 的 `ambiguousShape` 同一判据,两端需同步):
 *   - 无分隔符裸名:`package.json` 与 `array.map` / `Date.now` 结构完全同形
 *     (`.map` / `.log` / `.now` 既是真实扩展名也是方法名);
 *   - 有分隔符但无扩展名:`src/components` 与 `and/or` / `n/a` 结构完全同形。
 *
 * 用途:**远程会话**里 `fs:stat` 回 `unknown`(链路断 / 超时)时是否允许乐观点亮。
 * 形状明确是路径的(绝对路径 / 分隔符 + 扩展名,即 looksLikeFilePath)照旧乐观点亮,
 * 不因断链把整条消息的 chip 全灭;歧义形状必须等远端明确回 file / directory,否则
 * 链路一抖,`array.map`、`and/or` 这类普通行内 code 就会被展示成可点文件、点了必失败
 * (DESIGN.md §14.5 规则 5;PR #1144 review 实捉桌面侧漏了这道门槛)。
 *
 * 本机会话不需要这道门槛:那边走 resolveLocalPathSmart 的真实存在性检查,
 * 解析不到一律纯文本,没有「无法判定」这个中间态。
 */
export function isAmbiguousPathShape(href: string, originalHref?: string): boolean {
  const raw = originalHref ?? href;
  // 尾斜杠是作者显式给出的目录信号,形状明确 → **不歧义**(DESIGN.md §14.5 的表里
  // 「尾斜杠目录」与绝对路径同列)。但 classifyInlineCodeTarget /
  // classifyMarkdownLinkTarget 在产出 candidate 前就把尾斜杠剥掉了(href 全链路
  // 统一无尾杠形态),所以这里必须回看 originalHref,否则 `src/components/` 会被
  // 误判成歧义、在断链时退化成纯文本 —— 与移动端 candidate.directoryShape 等价
  // (PR #1144 review 实捉)。
  if (looksLikeDirectoryPath(raw)) return false;
  // `file://` 是显式写出的绝对路径 scheme,不可能与散文 / 属性访问同形 → 永不歧义。
  // 必须在这里单列:looksLikeFilePath 会被 URL_SCHEME_RE 挡掉而回 false(那条排除是
  // 为「别把 https:// 当本地路径」服务的),照抄它会把最明确的形态判成最可疑的
  // (2026-07-31 检查点自查发现,非 reviewer 提出)。
  if (/^file:\/\//i.test(raw)) return false;
  return !looksLikeFilePath(href);
}

export function classifyMarkdownLinkTarget(
  href: string | undefined,
  files?: readonly KnownLocalFileRef[],
): MarkdownTarget {
  const raw = href?.trim() ?? '';
  if (!raw) return { kind: 'plain-text', href: raw, reason: 'empty' };

  if (raw.startsWith('#')) return { kind: 'anchor', id: decodeAnchorId(raw.slice(1)), href: raw };
  if (raw.startsWith('xdt-audio://')) return { kind: 'audio', href: raw };
  if (raw.startsWith('xdt-image://') || raw.startsWith('xdt-file://')) {
    return { kind: 'local-image-url', href: raw };
  }
  if (HTTP_URL_RE.test(raw)) return { kind: 'external', href: raw };

  if (hasUnsupportedScheme(raw)) {
    return { kind: 'plain-text', href: raw, reason: 'unsupported-scheme' };
  }

  const lineInfo = splitLocalLineSuffix(raw);
  const localHref = lineInfo.href;
  const localKind = toMarkdownLocalKind(classifyMarkdownHref(localHref));
  if (localKind) {
    return classifyLocalCandidate(raw, localHref, localKind, files);
  }

  if (classifyMarkdownHref(localHref) === 'directory' || looksLikeDirectoryPath(localHref)) {
    // 目录形态(尾斜杠):按 candidate 走解析——真实存在的目录点击定位进
    // 侧边栏文件浏览器;不存在则保持纯文本(与文件同一套存在性判定)。
    // href 去尾斜杠,解析/join 全链路统一无尾杠形态。
    const stripped = localHref.replace(/[\\/]+$/, '');
    if (stripped) return classifyLocalCandidate(raw, stripped, 'text', files);
    return { kind: 'code-reference', href: localHref, reason: 'directory' };
  }

  if (looksLikeBareFileReference(localHref) || looksLikeFilePath(localHref)) {
    return { kind: 'code-reference', href: localHref, reason: 'path-like-unsupported' };
  }

  return { kind: 'plain-text', href: raw, reason: 'not-a-target' };
}

export function classifyInlineCodeTarget(text: string): MarkdownTarget | null {
  const raw = text.trim();
  if (!raw || raw !== text || raw.includes('\n')) return null;
  if (hasUnsupportedScheme(raw)) return null;

  const lineInfo = splitLocalLineSuffix(raw);
  const href = lineInfo.href;
  // 目录形态(尾斜杠)同 classifyMarkdownLinkTarget:candidate 化,存在才点亮。
  if (looksLikeDirectoryPath(href)) {
    const stripped = href.replace(/[\\/]+$/, '');
    if (!stripped) return null;
    return {
      kind: 'local-candidate',
      href: stripped,
      originalHref: raw,
      localKind: 'text',
    };
  }
  const localKind = toMarkdownLocalKind(classifyMarkdownHref(href));
  if (!looksLikeFilePath(href) && !looksLikeBareFileReference(href) && !localKind) return null;

  if (!localKind) return { kind: 'code-reference', href, reason: 'path-like-unsupported' };
  return {
    kind: 'local-candidate',
    href,
    originalHref: raw,
    localKind,
    ...(lineInfo.line !== undefined ? { line: lineInfo.line } : {}),
    ...(lineInfo.column !== undefined ? { column: lineInfo.column } : {}),
  };
}
