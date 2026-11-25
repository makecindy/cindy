export interface StreamingMarkdownChunk {
  /** 原文中的稳定起点，可直接作为 React key 与淡入状态分片 key。 */
  start: number;
  content: string;
  /**
   * 本分片之前所有标题的显示文本（JSON 字符串数组）。分片各自跑 rehype-slug 时
   * 用它预置去重计数，标题 id 与整篇解析一致；没有前序标题时省略。字符串形式
   * 让 React.memo 能按值比较。
   */
  headingSeed?: string;
}

function isTopLevelContinuation(line: string): boolean {
  return (
    /^[\t ]/.test(line) ||
    /^[-+*][\t ]+/.test(line) ||
    /^\d{1,9}[.)][\t ]+/.test(line) ||
    line.startsWith('>')
  );
}

interface FenceState {
  marker: '`' | '~';
  length: number;
}

function readFenceRun(line: string): { marker: '`' | '~'; length: number; rest: string } | null {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  if (!match) return null;
  return {
    marker: match[1][0] as '`' | '~',
    length: match[1].length,
    rest: match[2],
  };
}

function isDirectiveOpen(trimmedLine: string): boolean {
  return /^:::[a-zA-Z]/.test(trimmedLine);
}

function isDirectiveClose(trimmedLine: string): boolean {
  return /^:::[\t ]*$/.test(trimmedLine);
}

function hasGlobalMarkdownDefinitions(markdown: string): boolean {
  // 引用式链接定义会反向影响前面的 block；一旦出现就保留整篇解析，避免稳定前缀
  // 被拆开后失去定义上下文。围栏里的误命中只会少做一次优化，不影响正确性。
  return /^ {0,3}\[(?:\\[^\r\n]|[^\]\\\r\n])+\]:/m.test(markdown);
}

interface HeadingLine {
  /** 标题所在行在原文中的起点。 */
  offset: number;
  /** 与渲染后 hast 文本等价的标题文本；无法从源码可靠还原时为 null。 */
  text: string | null;
}

/**
 * 标题源码里只含这些「渲染后只删掉符号」的语法时，源码去掉符号即等于渲染文本：
 * 强调 `*`、行内 code、删除线 `~`。github-slugger 本来就会删掉这些符号，所以
 * 预置去重计数与整篇解析完全一致。链接、转义、HTML、实体、公式、下划线强调、
 * 裸 URL（会被截断/改写）都可能改变显示文本，遇到就回退整篇解析。
 */
const UNSAFE_HEADING_SOURCE = /[[\]<>&\\$_!]|:\/\//;

function headingTextFromSource(source: string): string | null {
  if (UNSAFE_HEADING_SOURCE.test(source)) return null;
  return source.replace(/[*`~]/g, '').trim();
}

function collectHeadings(markdown: string): HeadingLine[] {
  const headings: HeadingLine[] = [];
  let fence: FenceState | null = null;
  let offset = 0;
  const lines = markdown.split('\n');
  for (let index = 0; index < lines.length; index++) {
    const lineOffset = offset;
    const line = lines[index].replace(/\r$/, '');
    offset += lines[index].length + 1;
    const fenceRun = readFenceRun(line);
    if (fenceRun) {
      if (!fence) fence = { marker: fenceRun.marker, length: fenceRun.length };
      else if (
        fenceRun.marker === fence.marker &&
        fenceRun.length >= fence.length &&
        fenceRun.rest.trim().length === 0
      ) {
        fence = null;
      }
      continue;
    }
    if (fence) continue;
    const atx = /^ {0,3}#{1,6}(?:[\t ]+(.*?))?(?:[\t ]+#+)?[\t ]*$/.exec(line);
    if (atx) {
      headings.push({ offset: lineOffset, text: headingTextFromSource(atx[1] ?? '') });
      continue;
    }
    const next = lines[index + 1]?.replace(/\r$/, '');
    if (line.trim().length > 0 && next !== undefined && /^ {0,3}(?:=+|-+)[\t ]*$/.test(next)) {
      // Setext 标题的文本可以跨多行段落，源码无法逐行还原：保守地回退整篇。
      headings.push({ offset: lineOffset, text: null });
    }
  }
  return headings;
}

function hasMultipleHeadings(markdown: string): boolean {
  const lines = markdown.split(/\r?\n/);
  let headingCount = 0;
  let fence: FenceState | null = null;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const fenceRun = readFenceRun(line);
    if (fenceRun) {
      if (!fence) fence = { marker: fenceRun.marker, length: fenceRun.length };
      else if (
        fenceRun.marker === fence.marker &&
        fenceRun.length >= fence.length &&
        fenceRun.rest.trim().length === 0
      ) {
        fence = null;
      }
      continue;
    }
    if (fence) continue;

    const isAtx = /^ {0,3}#{1,6}(?:[\t ]+|$)/.test(line);
    const isSetext =
      line.trim().length > 0 &&
      index + 1 < lines.length &&
      /^ {0,3}(?:=+|-+)[\t ]*$/.test(lines[index + 1]);
    if ((isAtx || isSetext) && ++headingCount > 1) return true;
  }
  return false;
}

function hasPotentialHtmlBlock(markdown: string): boolean {
  return /^ {0,3}<(?:!--|\?|!\[CDATA\[|![A-Za-z]|\/?[A-Za-z][A-Za-z0-9-]*(?:[\t />]|$))/m.test(
    markdown,
  );
}

/**
 * 多个标题本身不再强制整篇解析：分片用 headingSeed 预置 slug 去重计数即可得到与
 * 整篇一致的 id。只有标题文本无法从源码可靠还原时才回退整篇（见 UNSAFE_HEADING_SOURCE）。
 */
function needsWholeDocumentContext(markdown: string, headings: HeadingLine[] | null): boolean {
  return (
    hasGlobalMarkdownDefinitions(markdown) ||
    (headings !== null && headings.some((heading) => heading.text === null)) ||
    hasPotentialHtmlBlock(markdown)
  );
}

export const STREAMING_MARKDOWN_THROTTLE_BASE_MS = 100;
export const STREAMING_MARKDOWN_THROTTLE_MAX_MS = 400;

/**
 * Choose a bounded stream update interval from the amount of Markdown work.
 *
 * Multi-heading documents intentionally stay one ReactMarkdown tree so heading
 * ids, reference definitions, and raw HTML keep their document-wide context.
 * Increasing the interval for those expensive trees reduces repeated parse /
 * highlight work without changing the rendered source or chunk boundaries.
 * The caller still flushes the latest value when streaming ends.
 */
export function getStreamingMarkdownThrottleInterval(markdown: string): number {
  const length = markdown.length;
  let interval = STREAMING_MARKDOWN_THROTTLE_BASE_MS;

  if (length > 12_000) interval = 125;
  if (length > 32_000) interval = 175;
  if (length > 80_000) interval = 250;
  if (length > 160_000) interval = 325;
  if (length > 320_000) interval = STREAMING_MARKDOWN_THROTTLE_MAX_MS;

  // Length is intentionally the only signal here. This function runs on
  // every incoming token before the throttle can coalesce it; scanning for
  // headings or HTML at that point would recreate the O(n) work we are trying
  // to avoid. The length buckets conservatively cover long multi-heading,
  // fenced-code, and HTML-heavy documents alike.
  return Math.min(interval, STREAMING_MARKDOWN_THROTTLE_MAX_MS);
}

/**
 * 把流式 Markdown 切成已经封口的顶层前缀块与仍在增长的尾块。
 *
 * 分界只落在代码围栏 / directive 外的空行，并且下一条非空行必须是新的顶层块；
 * 缩进、列表和引用的续行不会被拆开。这样已封口块可由 React.memo 永久复用，
 * 后续 token 只会让最后一个块重新走 Markdown 解析。
 */
export function splitStreamingMarkdownChunks(markdown: string): StreamingMarkdownChunk[] {
  if (!markdown.includes('\n\n') && !markdown.includes('\r\n\r\n')) {
    return [{ start: 0, content: markdown }];
  }
  const headings = hasMultipleHeadings(markdown) ? collectHeadings(markdown) : null;
  if (needsWholeDocumentContext(markdown, headings)) {
    return [{ start: 0, content: markdown }];
  }

  const boundaries: number[] = [];
  let pendingBoundary: number | null = null;
  let fence: FenceState | null = null;
  let mathBlock = false;
  let directiveDepth = 0;
  let lineStart = 0;

  while (lineStart <= markdown.length) {
    const newlineIndex = markdown.indexOf('\n', lineStart);
    const lineEnd = newlineIndex === -1 ? markdown.length : newlineIndex;
    const nextLineStart = newlineIndex === -1 ? markdown.length : newlineIndex + 1;
    const line = markdown.slice(lineStart, lineEnd).replace(/\r$/, '');
    const trimmedLine = line.trimStart();

    if (pendingBoundary !== null && trimmedLine.length > 0) {
      if (!isTopLevelContinuation(line)) boundaries.push(pendingBoundary);
      pendingBoundary = null;
    }

    const fenceRun = readFenceRun(line);
    if (fenceRun) {
      if (!fence) {
        fence = { marker: fenceRun.marker, length: fenceRun.length };
      } else if (
        fenceRun.marker === fence.marker &&
        fenceRun.length >= fence.length &&
        fenceRun.rest.trim().length === 0
      ) {
        fence = null;
      }
    } else if (!fence && directiveDepth === 0 && /^ {0,3}\$\$[\t ]*$/.test(line)) {
      mathBlock = !mathBlock;
    } else if (!fence && !mathBlock && isDirectiveOpen(trimmedLine)) {
      directiveDepth += 1;
    } else if (!fence && !mathBlock && directiveDepth > 0 && isDirectiveClose(trimmedLine)) {
      directiveDepth -= 1;
    }

    if (
      !fence &&
      !mathBlock &&
      directiveDepth === 0 &&
      trimmedLine.length === 0 &&
      newlineIndex !== -1
    ) {
      pendingBoundary = nextLineStart;
    }

    if (newlineIndex === -1) break;
    lineStart = nextLineStart;
  }

  if (boundaries.length === 0) return [{ start: 0, content: markdown }];

  const chunks: StreamingMarkdownChunk[] = [];
  const withSeed = (chunkStart: number, content: string): StreamingMarkdownChunk => {
    const seed = (headings ?? [])
      .filter((heading) => heading.offset < chunkStart)
      .map((heading) => heading.text);
    return seed.length > 0
      ? { start: chunkStart, content, headingSeed: JSON.stringify(seed) }
      : { start: chunkStart, content };
  };
  let start = 0;
  for (const boundary of boundaries) {
    if (boundary <= start || boundary > markdown.length) continue;
    chunks.push(withSeed(start, markdown.slice(start, boundary)));
    start = boundary;
  }
  chunks.push(withSeed(start, markdown.slice(start)));
  return chunks;
}
