/**
 * normalizeDisplayMathFences — 把非规范的 `$$...$$` display math 块归一化成
 * micromark-extension-math (remark-math) 可稳定解析的标准围栏形态。
 *
 * 背景:
 * micromark-extension-math 的 `mathFlow` 语法要求:
 * 1. 开围栏 `$$` 行首后不能跟公式正文——同行的内容会被当成 `mathFlowFenceMeta`
 *    (类似 ```lang)而从公式 AST 里静默丢弃;若同行含 `$` 则整块拒绝成 `mathFlow`。
 * 2. 闭围栏 `$$` 必须独占一行(前后只能有空白)——写成 `\end{cases}$$` 时永远
 *    无法闭合,导致从该行起直到消息末尾的全部 Markdown / LaTeX 被吞进一个巨型
 *    `mathFlow` 节点并触发 KaTeX `ParseError`,整段退化成裸源码文本。
 * 3. 单行独立 `$$x$$` 被 `mathFlow` 拒绝后退化成段落内的 `inlineMath`(含首尾
 *    空格时还会被 `remarkStrictInlineMath` 进一步降级成纯文本)。
 *
 * 本预处理在 parse 前把以下形态归一为 `$$\n...\n$$`(保留 `>` / 列表缩进前缀):
 * - 开/闭围栏与正文同行的多行块(`$$I_n = \begin{cases}\n...\n\end{cases}$$`)
 * - 行内紧接多行公式块(`有:$$I_n = \begin{cases}\n...\n\end{cases}$$ 特例`)
 * - 独占一行的单行公式(`$$x = 1$$`)
 *
 * 保护边界:
 * - fenced code block(` ``` ` / `~~~`,含引用块与列表项内部)与 inline code span
 *   (`` `...` ``)内原样保留。
 * - 行内双 dollar(`说明 $$a+b$$ 结束` / `$$a=1$$ + $$b=2$$`)保持原样。
 * - 3 个及以上连续 `$`(`$$$` / `$$$$`)不拆分。
 * - 转义 `\$` 不计入定界符,成对 `\\$$` 正常识别为公式定界符。
 * - 跨越引用块或列表项边界时不向后误配对。
 * - 仅用于不要求 source-line 行号保真的渲染路径(emitSourceLines=false)。
 * - 全部扫描均为严格 O(n) 线性复杂度(无回溯正则、无长度枚举重扫)。
 */

const QUOTE_PREFIX_RE = /^((?: {0,3}> ?)*)/;
const CONTAINER_PREFIX_RE = /^((?: {0,3}> ?)*[ \t]*)/;
const LIST_PREFIX_RE = /^([-+*]|\d{1,9}[.)])([ \t]+)/;
const FENCE_RE = /^(`{3,}|~{3,})(.*)$/;
const PARAGRAPH_BREAK_RE = /^ {0,3}(?:#{1,6}(?:[ \t]|$)|(?:`{3,}|~{3,}))/;

function countQuoteMarkers(prefix: string): number {
  let count = 0;
  for (let i = 0; i < prefix.length; i += 1) {
    if (prefix[i] === '>') count += 1;
  }
  return count;
}

function getLineQuoteDepth(line: string): number {
  const m = QUOTE_PREFIX_RE.exec(line);
  return m ? countQuoteMarkers(m[1]) : 0;
}

function getLeadingSpacesCount(line: string): number {
  let count = 0;
  while (count < line.length && line[count] === ' ') count += 1;
  return count;
}

function stripContainerPrefixForFence(line: string): { quoteDepth: number; rest: string } {
  const quoteMatch = QUOTE_PREFIX_RE.exec(line);
  const quotePrefix = quoteMatch ? quoteMatch[1] : '';
  const quoteDepth = countQuoteMarkers(quotePrefix);
  let rest = line.slice(quotePrefix.length).replace(/^[ \t]+/, '');
  const listMatch = LIST_PREFIX_RE.exec(rest);
  if (listMatch) {
    rest = rest.slice(listMatch[0].length).replace(/^[ \t]+/, '');
  }
  return { quoteDepth, rest };
}

/**
 * 单遍索引所有 backtick 运行并按长度建表,再用单调游标线性配对,避免 k 种不同
 * 未闭合反引号长度导致 Θ(k³) 重复扫描。
 */
function findInlineCodeRanges(segment: string): Array<[number, number]> {
  if (!segment.includes('`')) return [];
  const runs: Array<{ start: number; end: number; len: number }> = [];
  const runIndicesByLen = new Map<number, number[]>();
  let pos = 0;
  while (pos < segment.length) {
    const tick = segment.indexOf('`', pos);
    if (tick === -1) break;
    let end = tick + 1;
    while (end < segment.length && segment[end] === '`') end += 1;
    const len = end - tick;
    const runIdx = runs.length;
    runs.push({ start: tick, end, len });
    let list = runIndicesByLen.get(len);
    if (!list) {
      list = [];
      runIndicesByLen.set(len, list);
    }
    list.push(runIdx);
    pos = end;
  }

  const ranges: Array<[number, number]> = [];
  const headByLen = new Map<number, number>();
  let r = 0;
  while (r < runs.length) {
    const run = runs[r];
    const list = runIndicesByLen.get(run.len)!;
    let head = headByLen.get(run.len) ?? 0;
    while (head < list.length && list[head] <= r) head += 1;
    headByLen.set(run.len, head);
    if (head >= list.length) {
      r += 1;
      continue;
    }
    const closeIdx = list[head];
    headByLen.set(run.len, head + 1);
    ranges.push([run.start, runs[closeIdx].end]);
    r = closeIdx + 1;
  }

  return ranges;
}

/**
 * 扫描区间 `[from, to)` 内所有未被转义且不在 `codeRanges` 内的 `$$` 列偏移(相对 `lineStart`)。
 * 连续 ≥3 个 `$` 整体跳过;`\$$` 视作转义 `\$` + 单个 `$`;`\\$$` 视作 `\\` + `$$`。
 */
function findDoubleDollarCols(
  text: string,
  lineStart: number,
  fromCol: number,
  toCol: number,
  codeRanges: ReadonlyArray<[number, number]>,
  rangeCursorStart: number,
): { cols: number[]; nextRangeCursor: number } {
  const cols: number[] = [];
  let rIdx = rangeCursorStart;
  let pos = lineStart + fromCol;
  const end = lineStart + toCol;

  while (pos < end) {
    while (rIdx < codeRanges.length && codeRanges[rIdx][1] <= pos) rIdx += 1;
    if (rIdx < codeRanges.length && pos >= codeRanges[rIdx][0] && pos < codeRanges[rIdx][1]) {
      pos = Math.min(end, codeRanges[rIdx][1]);
      continue;
    }
    const ch = text[pos];
    if (ch === '\\') {
      pos += 2;
      continue;
    }
    if (ch === '$') {
      let runEnd = pos + 1;
      while (runEnd < end && text[runEnd] === '$') runEnd += 1;
      if (runEnd - pos === 2) cols.push(pos - lineStart);
      pos = runEnd;
      continue;
    }
    pos += 1;
  }

  return { cols, nextRangeCursor: rIdx };
}

/** 在已进入 `$$` 数学块内部时扫描闭合 `$$`(LaTeX 内不按 Markdown 反引号切 code span)。 */
function findDoubleDollarColsInMath(line: string): number[] {
  const cols: number[] = [];
  let pos = 0;
  while (pos < line.length) {
    const ch = line[pos];
    if (ch === '\\') {
      pos += 2;
      continue;
    }
    if (ch === '$') {
      let runEnd = pos + 1;
      while (runEnd < line.length && line[runEnd] === '$') runEnd += 1;
      if (runEnd - pos === 2) cols.push(pos);
      pos = runEnd;
      continue;
    }
    pos += 1;
  }
  return cols;
}

function advancePastLeadingSpaces(line: string, col: number): number {
  let c = col;
  while (c < line.length && (line[c] === ' ' || line[c] === '\t')) c += 1;
  return c;
}

function normalizeNonFenceLines(lines: readonly string[]): { lines: string[]; changed: boolean } {
  const segment = lines.join('\n');
  if (!segment.includes('$$')) return { lines: lines as string[], changed: false };

  const codeRanges = findInlineCodeRanges(segment);
  const lineOffsets: number[] = new Array(lines.length);
  let offset = 0;
  for (let i = 0; i < lines.length; i += 1) {
    lineOffsets[i] = offset;
    offset += lines[i].length + 1;
  }

  const out: string[] = [];
  let changed = false;
  let rangeCursor = 0;
  let idx = 0;
  let pendingCol = 0;
  let pendingPrefix = '';

  const emitCloseSegment = (
    closeLineIdx: number,
    closeCol: number,
    contPrefix: string,
  ): { nextIdx: number; nextPendingCol: number; nextPendingPrefix: string } => {
    const closeLine = lines[closeLineIdx];
    const closePrefixMatch = closeLine.match(CONTAINER_PREFIX_RE);
    const closePrefix = closePrefixMatch ? closePrefixMatch[1] : '';
    const beforeClose =
      closeCol >= closePrefix.length
        ? closeLine.slice(closePrefix.length, closeCol)
        : closeLine.slice(0, closeCol);
    const afterClose = closeLine.slice(closeCol + 2);
    const fencePrefix = contPrefix || closePrefix;

    if (beforeClose.trim() !== '') {
      out.push(`${closePrefix}${beforeClose.trimEnd()}`);
    }
    out.push(`${fencePrefix}$$`);

    if (afterClose.trim() !== '') {
      return {
        nextIdx: closeLineIdx,
        nextPendingCol: advancePastLeadingSpaces(closeLine, closeCol + 2),
        nextPendingPrefix: fencePrefix,
      };
    }
    return { nextIdx: closeLineIdx + 1, nextPendingCol: 0, nextPendingPrefix: '' };
  };

  while (idx < lines.length) {
    const line = lines[idx];
    const lineStart = lineOffsets[idx];
    const effectiveLine = pendingCol > 0 ? line.slice(pendingCol) : line;

    const containerMatch = pendingCol > 0 ? null : line.match(CONTAINER_PREFIX_RE);
    const basePrefix = pendingCol > 0 ? pendingPrefix : (containerMatch ? containerMatch[1] : '');
    const afterBase = pendingCol > 0 ? effectiveLine : line.slice(basePrefix.length);
    const listMatch = pendingCol > 0 ? null : afterBase.match(LIST_PREFIX_RE);
    const listStartsMath = listMatch !== null && afterBase.slice(listMatch[0].length).startsWith('$$');
    const openPrefix = listStartsMath ? basePrefix + listMatch[1] + listMatch[2] : basePrefix;
    const contPrefix = listMatch
      ? basePrefix + ' '.repeat(listMatch[1].length + listMatch[2].length)
      : basePrefix;
    const contentStartCol = pendingCol > 0 ? pendingCol : openPrefix.length;
    const openQuoteDepth = countQuoteMarkers(basePrefix);
    const requiredListIndent =
      openQuoteDepth === 0 && (listMatch !== null || basePrefix.length > 0)
        ? contPrefix.length
        : 0;

    const { cols, nextRangeCursor } = findDoubleDollarCols(
      segment,
      lineStart,
      pendingCol,
      line.length,
      codeRanges,
      rangeCursor,
    );
    rangeCursor = nextRangeCursor;

    if (cols.length === 0) {
      out.push(pendingCol > 0 ? `${pendingPrefix}${effectiveLine}` : line);
      pendingCol = 0;
      pendingPrefix = '';
      idx += 1;
      continue;
    }

    // 情况 1: 行(含容器前缀后)以 `$$` 开头
    if (cols[0] === contentStartCol) {
      // 1a. 单行独立 `$$...$$`(同行无多余 `$$`,闭合 `$$` 后仅空白)
      if (cols.length === 2 && line.slice(cols[1] + 2).trim() === '') {
        const inner = line.slice(cols[0] + 2, cols[1]).trim();
        if (inner.length > 0) {
          out.push(`${openPrefix}$$`, `${contPrefix}${inner}`, `${contPrefix}$$`);
          changed = true;
          pendingCol = 0;
          pendingPrefix = '';
          idx += 1;
          continue;
        }
        out.push(pendingCol > 0 ? `${pendingPrefix}${effectiveLine}` : line);
        pendingCol = 0;
        pendingPrefix = '';
        idx += 1;
        continue;
      }

      // 1b. 同行只有开 `$$`,在同级容器内向后跨行找闭合 `$$`
      if (cols.length === 1) {
        const openBody = line.slice(cols[0] + 2);
        let closeIdx = -1;
        let closeCol = -1;
        let sawBlankLine = false;
        for (let j = idx + 1; j < lines.length; j += 1) {
          const candidate = lines[j];
          if (openQuoteDepth > 0 && getLineQuoteDepth(candidate) < openQuoteDepth) {
            break;
          }
          if (openQuoteDepth === 0 && requiredListIndent > 0) {
            if (candidate.trim() === '') {
              sawBlankLine = true;
              continue;
            }
            const indent = getLeadingSpacesCount(candidate);
            if (indent < requiredListIndent) {
              if (sawBlankLine || LIST_PREFIX_RE.test(candidate.trimStart())) break;
            }
          }
          const closeCols = findDoubleDollarColsInMath(candidate);
          if (closeCols.length > 0) {
            closeIdx = j;
            closeCol = closeCols[0];
            break;
          }
        }

        if (closeIdx === -1) {
          // 未闭合(如流式中途或断尾):仅当开行同行有正文时把开围栏拆行,避免
          // openBody 被 mathFlow 当成 fence meta 吞掉。
          if (openBody.trim() !== '') {
            out.push(`${openPrefix}$$`, `${contPrefix}${openBody.trimStart()}`);
            changed = true;
          } else {
            out.push(pendingCol > 0 ? `${pendingPrefix}${effectiveLine}` : line);
          }
          pendingCol = 0;
          pendingPrefix = '';
          idx += 1;
          continue;
        }

        const closeLine = lines[closeIdx];
        const closePrefixMatch = closeLine.match(CONTAINER_PREFIX_RE);
        const closePrefix = closePrefixMatch ? closePrefixMatch[1] : '';
        const beforeClose =
          closeCol >= closePrefix.length
            ? closeLine.slice(closePrefix.length, closeCol)
            : closeLine.slice(0, closeCol);
        const afterClose = closeLine.slice(closeCol + 2);

        if (
          pendingCol === 0 &&
          openBody.trim() === '' &&
          beforeClose.trim() === '' &&
          afterClose.trim() === ''
        ) {
          for (let k = idx; k <= closeIdx; k += 1) out.push(lines[k]);
          pendingCol = 0;
          pendingPrefix = '';
          idx = closeIdx + 1;
          continue;
        }

        out.push(`${openPrefix}$$`);
        if (openBody.trim() !== '') {
          out.push(`${contPrefix}${openBody.trimStart()}`);
        }
        for (let k = idx + 1; k < closeIdx; k += 1) {
          out.push(lines[k]);
        }
        changed = true;
        const next = emitCloseSegment(closeIdx, closeCol, contPrefix);
        idx = next.nextIdx;
        pendingCol = next.nextPendingCol;
        pendingPrefix = next.nextPendingPrefix;
        continue;
      }
    }

    // 情况 2: 偶数个 `$$` 在同一行配对(行内 `$$a$$` / `$$a$$ + $$b$$`),原样保留
    if (cols.length % 2 === 0) {
      out.push(pendingCol > 0 ? `${pendingPrefix}${effectiveLine}` : line);
      pendingCol = 0;
      pendingPrefix = '';
      idx += 1;
      continue;
    }

    // 情况 3: 行内尾部悬垂奇数个 `$$`(如 `对正整数 $n$,有:$$I_n = \begin{cases}`),
    // 仅在同一容器同一段落内(空行 / 标题 / 容器退出前)找到闭合 `$$` 时才拆成 display 块。
    const openCol = cols[cols.length - 1];
    let closeIdx = -1;
    let closeCol = -1;
    for (let j = idx + 1; j < lines.length; j += 1) {
      const candidate = lines[j];
      if (openQuoteDepth > 0 && getLineQuoteDepth(candidate) < openQuoteDepth) break;
      if (candidate.trim() === '' || PARAGRAPH_BREAK_RE.test(candidate)) break;
      const closeCols = findDoubleDollarColsInMath(candidate);
      if (closeCols.length > 0) {
        closeIdx = j;
        closeCol = closeCols[0];
        break;
      }
    }

    if (closeIdx === -1) {
      out.push(pendingCol > 0 ? `${pendingPrefix}${effectiveLine}` : line);
      pendingCol = 0;
      pendingPrefix = '';
      idx += 1;
      continue;
    }

    const beforeOpen = line.slice(pendingCol, openCol).trimEnd();
    const openBody = line.slice(openCol + 2);
    if (beforeOpen.trim() !== '') {
      out.push(pendingCol > 0 ? `${pendingPrefix}${beforeOpen}` : beforeOpen);
    }
    out.push(`${contPrefix}$$`);
    if (openBody.trim() !== '') {
      out.push(`${contPrefix}${openBody.trimStart()}`);
    }
    for (let k = idx + 1; k < closeIdx; k += 1) {
      out.push(lines[k]);
    }
    changed = true;
    const next = emitCloseSegment(closeIdx, closeCol, contPrefix);
    idx = next.nextIdx;
    pendingCol = next.nextPendingCol;
    pendingPrefix = next.nextPendingPrefix;
  }

  return { lines: out, changed };
}

export function normalizeDisplayMathFences(markdown: string): string {
  if (!markdown.includes('$$')) return markdown;

  const lines = markdown.split('\n');
  const out: string[] = [];
  let textBuf: string[] = [];
  let fence: { marker: string; quoteDepth: number } | null = null;
  let anyChanged = false;

  const flushText = () => {
    if (textBuf.length === 0) return;
    const normalized = normalizeNonFenceLines(textBuf);
    if (normalized.changed) anyChanged = true;
    for (const l of normalized.lines) out.push(l);
    textBuf = [];
  };

  for (const line of lines) {
    const { quoteDepth, rest } = stripContainerPrefixForFence(line);

    if (fence != null && fence.quoteDepth > 0 && quoteDepth < fence.quoteDepth) {
      // 引用块提前结束,容器内的未闭合围栏随引用块一同关闭,当前行回归正常扫描
      fence = null;
    }

    if (fence == null) {
      const open = rest.match(FENCE_RE);
      // CommonMark: backtick fence info string cannot contain backticks (otherwise inline code).
      if (open && !(open[1][0] === '`' && open[2].includes('`'))) {
        flushText();
        fence = { marker: open[1], quoteDepth };
        out.push(line);
        continue;
      }
      textBuf.push(line);
    } else {
      out.push(line);
      const close = rest.match(FENCE_RE);
      if (
        close &&
        close[1][0] === fence.marker[0] &&
        close[1].length >= fence.marker.length &&
        close[2].trim() === ''
      ) {
        fence = null;
      }
    }
  }
  flushText();

  return anyChanged ? out.join('\n') : markdown;
}
