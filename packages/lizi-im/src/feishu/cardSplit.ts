/**
 * feishu/cardSplit.ts
 * ---------------------------------------------------------------------------
 * 把一段 markdown 切成若干段, 每段都能装进一张飞书卡片(纯函数, 不做 IO)。
 *
 * 飞书单张卡片有两条硬上限: 请求体 30 KB, 以及单个富文本组件最多 4 个表格
 * (超出整卡被拒)。以前超限的终稿被截断并提示去桌面端看全文; 现在按内容边界
 * 切开, 逐条完整送达。「装不装得下」由调用方的 `fits` 判定(它知道卡片外壳、
 * 图片与附注占多少), 这里只负责找切点:
 *
 *   1. 优先切在段落之间(代码块外的空行);
 *   2. 一个段落自己就超限时切在行之间 —— 切在代码块里就先补上收尾围栏, 下一段
 *      重新开围栏; 切在表格里就给下一段补上表头, 两段都仍是完整的 markdown;
 *   3. 单行就超限时按字符切(不拆代理对)。
 *
 * 每一刀都必须让剩余内容变短, 否则停止并把剩余内容整段交回(由调用方兜底),
 * 保证不会死循环。
 */

/** 飞书: 单个富文本(markdown)组件最多放 4 个表格。 */
export const FEISHU_MARKDOWN_MAX_TABLES = 4;

/** 段落切点至少要用掉行切点这么大比例的空间, 否则宁可切在行间(避免一段只有一两行)。 */
const BLOCK_CUT_MIN_RATIO = 0.5;

/**
 * 围栏行。缩进不设上限: 模型常把代码块写在列表项里(缩进 4 格以上), 按 CommonMark
 * 的 3 格上限会认不出来, 切在里面就留下不闭合的代码块。
 */
const FENCE_RE = /^(\s*)(`{3,}|~{3,})([\s\S]*)$/;
const TABLE_SEPARATOR_CELL_RE = /^:?-+:?$/;

interface OpenFence {
  /** 围栏符号串(``` 或 ~~~, 可更长), 带上开围栏行的缩进。 */
  marker: string;
  /** 开围栏那一整行(含语言标注), 续段原样重开。 */
  opener: string;
}

interface TableHead {
  header: string;
  separator: string;
}

interface LineInfo {
  /** 本行在全文中的起始偏移。 */
  start: number;
  text: string;
  /** 进入本行之前所处的代码块(不在代码块里为 null)。 */
  fenceBefore: OpenFence | null;
  /** 本行是某个表格的数据行时, 该表格的表头(续段补表头用)。 */
  tableHead: TableHead | null;
  /** 本行是表格的分隔行(表头与分隔行之间不能下刀)。 */
  isTableSeparator: boolean;
}

/** 开围栏行; 反引号围栏的语言标注里不能再有反引号(那是行内代码, 不是围栏)。 */
function matchOpeningFence(line: string): RegExpExecArray | null {
  const match = FENCE_RE.exec(line);
  if (!match) return null;
  return match[2][0] === '`' && match[3].includes('`') ? null : match;
}

function isClosingFence(line: string, open: OpenFence): boolean {
  const match = FENCE_RE.exec(line);
  if (!match) return false;
  const marker = open.marker.trimStart();
  return match[2][0] === marker[0] && match[2].length >= marker.length && match[3].trim() === '';
}

/** `| --- | :-: |` 这类分隔行。逐格判断, 不用整行正则(长空白串上会回溯)。 */
function isTableSeparator(line: string): boolean {
  if (!line.includes('|')) return false;
  const cells = line.trim().split('|');
  if (cells[0].trim() === '') cells.shift();
  if (cells.length > 0 && cells[cells.length - 1].trim() === '') cells.pop();
  return cells.length > 0 && cells.every((cell) => TABLE_SEPARATOR_CELL_RE.test(cell.trim()));
}

function scanLines(text: string): LineInfo[] {
  const lines: LineInfo[] = [];
  let fence: OpenFence | null = null;
  let table: TableHead | null = null;
  let offset = 0;
  const rawLines = text.split('\n');
  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];
    const info: LineInfo = {
      start: offset,
      text: line,
      fenceBefore: fence,
      tableHead: null,
      isTableSeparator: false,
    };
    if (fence) {
      if (isClosingFence(line, fence)) fence = null;
    } else {
      const open = matchOpeningFence(line);
      if (open) {
        fence = { marker: `${open[1]}${open[2]}`, opener: line };
        table = null;
      } else if (table) {
        // 表格延续到第一行不含 `|` 的内容为止。
        if (line.includes('|') && line.trim() !== '') info.tableHead = table;
        else table = null;
      } else if (i > 0 && isTableSeparator(line)) {
        const previous = lines[i - 1];
        if (previous.fenceBefore === null && previous.text.includes('|') && previous.text.trim() !== '') {
          table = { header: previous.text, separator: line };
          info.isTableSeparator = true;
        }
      }
    }
    lines.push(info);
    offset += line.length + 1;
  }
  return lines;
}

/** 代码块外的 markdown 表格个数。 */
export function countMarkdownTables(text: string): number {
  let count = 0;
  for (const line of scanLines(text)) if (line.isTableSeparator) count += 1;
  return count;
}

interface Cut {
  chunk: string;
  rest: string;
}

/** 在第 k 行行首下刀(k ≥ 1): 前 k 行成段, 其余留给下一段。 */
function cutAtLine(text: string, lines: readonly LineInfo[], k: number): Cut {
  const line = lines[k];
  const before = text.slice(0, line.start);
  let rest = text.slice(line.start);
  if (line.fenceBefore) {
    // 代码块里的空白是内容(Python 三引号、heredoc、文本样例的行尾空格与空行都要原样保留):
    // 只去掉分隔上一行与本行的那个换行, 再接上收尾围栏。
    const head = before.endsWith('\n') ? before.slice(0, -1) : before;
    return {
      chunk: `${head}\n${line.fenceBefore.marker}`,
      rest: `${line.fenceBefore.opener}\n${rest}`,
    };
  }
  const chunk = before.replace(/\s+$/, '');
  if (line.tableHead) {
    rest = `${line.tableHead.header}\n${line.tableHead.separator}\n${rest}`;
  } else {
    rest = rest.replace(/^(?:[ \t]*\n)+/, '');
  }
  return { chunk, rest };
}

/** text[from, to) 里的竖线个数。 */
function countPipes(text: string, from: number, to: number): number {
  let count = 0;
  for (let i = from; i < to; i++) if (text.charCodeAt(i) === 0x7c) count += 1;
  return count;
}

/** 在字符偏移 p 处下刀(单行超限的兜底), 不拆代理对。 */
function cutAtChar(text: string, lines: readonly LineInfo[], p: number): Cut {
  let at = p;
  const code = text.charCodeAt(at);
  if (code >= 0xdc00 && code <= 0xdfff) at -= 1;
  let owner = lines[0];
  for (const line of lines) {
    if (line.start > at) break;
    owner = line;
  }
  const fence = owner.fenceBefore;
  if (fence) {
    const chunk = text.slice(0, at);
    // 落在行首时 chunk 已以换行结尾, 它就是收尾围栏前的行分隔, 不再多加一个(否则多出一行空行)。
    return {
      chunk: `${chunk}${chunk.endsWith('\n') ? '' : '\n'}${fence.marker}`,
      rest: `${fence.opener}\n${text.slice(at)}`,
    };
  }
  const table = owner.tableHead;
  if (table) {
    // 表格里的一行就超过一张卡: 后面的卡片带上表头, 不丢列结构; 能切在单元格边界就不切断单元格。
    if (at === owner.start) {
      return {
        chunk: text.slice(0, at).replace(/\s+$/, ''),
        rest: `${table.header}\n${table.separator}\n${text.slice(at)}`,
      };
    }
    const pipe = text.lastIndexOf('|', at - 1);
    const cellEnd = pipe > owner.start && countPipes(text, owner.start, pipe + 1) >= 2 ? pipe + 1 : at;
    return {
      chunk: text.slice(0, cellEnd),
      rest: `${table.header}\n${table.separator}\n|${text.slice(cellEnd)}`,
    };
  }
  return { chunk: text.slice(0, at), rest: text.slice(at) };
}

/**
 * 在 `count` 个升序切点里二分出「装得下且有进展」的最大者; 没有则返回 null。
 * 装得下与否随切点右移单调变差(围栏收尾只差几个字节, 不影响结论)。
 */
function largestFitting(
  count: number,
  cutOf: (index: number) => Cut,
  text: string,
  fits: (chunk: string) => boolean,
): Cut | null {
  let low = 0;
  let high = count - 1;
  let best: Cut | null = null;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const cut = cutOf(middle);
    if (cut.chunk.trim() !== '' && fits(cut.chunk)) {
      // 续段要重开围栏 / 补表头, 可能和原文一样长: 那一刀没有进展, 不算数。
      if (cut.rest.length < text.length) best = cut;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best;
}

/** 这一行行首能不能下刀: 不留下空代码块, 也不留下只有表头的空表格。 */
function canCutBefore(lines: readonly LineInfo[], k: number): boolean {
  const line = lines[k];
  const previous = lines[k - 1];
  if (line.isTableSeparator || previous.isTableSeparator) return false;
  if (line.fenceBefore) {
    // 开围栏的下一行、收围栏那一行: 切在这里会多出一个空代码块。
    if (previous.fenceBefore === null) return false;
    if (isClosingFence(line.text, line.fenceBefore)) return false;
  }
  return true;
}

/** 从 `text` 开头切下装得下的最大一段; 切不动(任何前缀都装不下)时返回 null。 */
export function cutMarkdownPrefix(text: string, fits: (chunk: string) => boolean): Cut | null {
  const lines = scanLines(text);
  const lineCuts: number[] = [];
  const blockCuts: number[] = [];
  for (let k = 1; k < lines.length; k++) {
    if (!canCutBefore(lines, k)) continue;
    lineCuts.push(k);
    if (lines[k].fenceBefore === null && lines[k - 1].text.trim() === '') blockCuts.push(k);
  }
  const byLine = largestFitting(lineCuts.length, (i) => cutAtLine(text, lines, lineCuts[i]), text, fits);
  const byBlock = largestFitting(blockCuts.length, (i) => cutAtLine(text, lines, blockCuts[i]), text, fits);
  if (byBlock && (!byLine || byBlock.chunk.length >= byLine.chunk.length * BLOCK_CUT_MIN_RATIO)) {
    return byBlock;
  }
  if (byLine) return byLine;
  // 切点 i 对应字符偏移 i + 1。
  return largestFitting(text.length - 1, (i) => cutAtChar(text, lines, i + 1), text, fits);
}

/**
 * 把 `text` 切成每段都装得下的若干段。`fits(chunk, index)` 的 index 是该段的序号
 * (首段可能还要装过程记录, 可用空间不同)。整段装得下时原样返回单段。
 * 切不动时把剩余内容整段作为最后一段返回 —— 调用方须自行复核每段。
 */
export function splitMarkdownForCards(
  text: string,
  fits: (chunk: string, index: number) => boolean,
): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.trim() !== '') {
    const index = parts.length;
    if (fits(rest, index)) {
      parts.push(rest);
      break;
    }
    const cut = cutMarkdownPrefix(rest, (chunk) => fits(chunk, index));
    if (!cut) {
      parts.push(rest);
      break;
    }
    parts.push(cut.chunk);
    rest = cut.rest;
  }
  return parts.length > 0 ? parts : [text];
}
