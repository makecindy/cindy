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
