export interface StreamingMarkdownChunk {
  /** 原文中的稳定起点，可直接作为 React key 与淡入状态分片 key。 */
  start: number;
  content: string;
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

function needsWholeDocumentContext(markdown: string): boolean {
  return (
    hasGlobalMarkdownDefinitions(markdown) ||
    hasMultipleHeadings(markdown) ||
    hasPotentialHtmlBlock(markdown)
  );
}

/**
 * 把流式 Markdown 切成已经封口的顶层前缀块与仍在增长的尾块。
 *
 * 分界只落在代码围栏 / directive 外的空行，并且下一条非空行必须是新的顶层块；
 * 缩进、列表和引用的续行不会被拆开。这样已封口块可由 React.memo 永久复用，
 * 后续 token 只会让最后一个块重新走 Markdown 解析。
 */
export function splitStreamingMarkdownChunks(markdown: string): StreamingMarkdownChunk[] {
  if (
    (!markdown.includes('\n\n') && !markdown.includes('\r\n\r\n')) ||
    needsWholeDocumentContext(markdown)
  ) {
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
  let start = 0;
  for (const boundary of boundaries) {
    if (boundary <= start || boundary > markdown.length) continue;
    chunks.push({ start, content: markdown.slice(start, boundary) });
    start = boundary;
  }
  chunks.push({ start, content: markdown.slice(start) });
  return chunks;
}
