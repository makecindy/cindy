// Pure lexical normalization shared by chat rendering and Host file references.
// This does not grant file access; each caller must validate its own scope.
/**
 * `sandbox:` 前缀 + 斜杠若干 + 绝对路径(Windows 盘符或 POSIX)。LLM 受
 * ChatGPT 代码沙箱习惯影响,会把本地生成文件写成 `sandbox:/C:/…/报告.xlsx`
 * 或 `sandbox:/mnt/data/a.csv`(Issue #1811 实例)。捕获组 1 = 盘符路径,
 * 捕获组 2 = POSIX 路径(含前导 `/`)。只认这两种绝对路径形态——`sandbox:foo`
 * 之类的相对形态没有可靠语义,维持 unsupported-scheme 纯文本。
 */
const SANDBOX_HREF_RE = /^sandbox:\/*(?:([a-z]:[\\/][^\n]*)|(\/[^\n]*))$/i;
const URL_WITH_DOUBLE_SLASH_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
const POSITIVE_LINE_NUMBER_RE = /^[1-9]\d{0,6}$/;
const LINE_RANGE_SUFFIX_RE = /^([1-9]\d{0,6})-([1-9]\d{0,6})$/;

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

/**
 * 把 `sandbox:/C:/…` / `sandbox:///mnt/…` 形态的链接剥成裸绝对路径,其余输入
 * 原样返回。剥完后走与直写路径完全相同的 candidate → 存在性/workdir 解析链路,
 * 所以这里**只做词法转换,不做任何信任判断**——不存在或越界的路径仍会在解析层
 * 落回纯文本(Issue #1811;非特权 Markdown 面由 stripPrivilegedMarkdownTarget
 * 继续兜底降级,不受影响)。
 */
export function normalizeSandboxHref(raw: string): string {
  const m = raw.match(SANDBOX_HREF_RE);
  if (!m) return raw;
  return m[1] ?? m[2] ?? raw;
}
