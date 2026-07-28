/**
 * chatQuotes — 聊天/文件选中文字引用(chat-text-quote)的纯函数层。
 *
 * 数据契约:引用以 markdown blockquote 形态存在于消息 content。新 composer
 * 把引用作为正文 block atom,因此可按「引用 A → 回复 A → 引用 B → 回复 B」
 * 交错序列化;`parseChatQuoteSegments` 按原顺序还原。`formatQuotesForSend` /
 * `parseLeadingBlockquotes` 继续服务旧的「引用列表前置」调用方与历史消息。
 *
 * 来源文件(file-quote):从文件浏览器选中的引用带 `sourcePath`(workdir
 * 相对路径),编码为条目内最后一行 `> — source: <path>`;能拿到选区行号时
 * 再附 `#Lx-Ly`。模型对引注体例天然理解,可据此 Read 完整上下文 / 精准编辑。
 * 新写入的引用块首行带不可见 Markdown comment marker,用于把产品 quote
 * atom 与正文中用户手写的 blockquote 无歧义地区分；历史前置引用仍兼容。
 *
 * 为什么选 blockquote 而不是结构化字段:引用是模型的母语格式(零 wire /
 * 持久化 schema 改动),手机端 / 远端 / 导出的纯文本视图天然可读;渲染美化
 * 只是本端的展示层解析。解析只对持久化了 `quotesEncoded` 标志的消息启用,
 * 用户普通手打的 markdown 引用保持原样。
 *
 * apps/desktop 的 `renderer/lib/chatQuotes.ts` re-export 本模块,避免 wire format
 * 双实现漂移。
 */

/** 一条选中文字引用。sourcePath 仅文件浏览器来源有(workdir 相对路径)。 */
export interface ChatQuote {
  text: string;
  sourcePath?: string;
  startLine?: number;
  endLine?: number;
}

/** 按消息正文顺序排列的引用 / 用户文字段。 */
export type ChatQuoteSegment =
  | { kind: 'text'; text: string }
  | { kind: 'quote'; quote: ChatQuote };

/** 来源行前缀(条目内最后一行)。 */
const SOURCE_LINE_PREFIX = '— source: ';

/**
 * 新版产品引用块的显式标记。Markdown comment 在普通文本视图中不可见，
 * 同时让解析器能把正文里的用户手写 `> ...` 与 composer quote atom 区分开。
 * 未带标记的历史 quotesEncoded 消息仍只按「消息开头的引用区」兼容解析。
 */
const QUOTE_BLOCK_MARKER = '<!-- cindy-composer-quote -->';
const QUOTE_BLOCK_MARKER_LINE = `> ${QUOTE_BLOCK_MARKER}`;

/**
 * Remove the private product marker from user-facing plain text while keeping
 * the readable Markdown blockquote, source line, and every other line intact.
 * Callers must gate this to messages whose persisted `quotesEncoded` flag is
 * true so an identical line typed by the user is never rewritten.
 */
export function stripChatQuoteMarkerLines(content: string): string {
  return content
    .split('\n')
    .filter((line) => line.trimStart() !== QUOTE_BLOCK_MARKER_LINE)
    .join('\n');
}

function isValidLine(line: number | undefined): line is number {
  return typeof line === 'number' && Number.isInteger(line) && line > 0;
}

function formatSourceLine(q: ChatQuote): string | null {
  if (!q.sourcePath) return null;
  if (!isValidLine(q.startLine)) return q.sourcePath;
  const endLine = isValidLine(q.endLine) && q.endLine >= q.startLine ? q.endLine : q.startLine;
  return endLine === q.startLine
    ? `${q.sourcePath}#L${q.startLine}`
    : `${q.sourcePath}#L${q.startLine}-L${endLine}`;
}

function parseSourceLine(raw: string): Omit<ChatQuote, 'text'> {
  const match = raw.match(/^(.*)#L(\d+)(?:-L(\d+))?$/);
  if (!match) return { sourcePath: raw };
  const sourcePath = match[1];
  const startLine = Number(match[2]);
  const endLine = match[3] ? Number(match[3]) : startLine;
  if (!sourcePath || !isValidLine(startLine) || !isValidLine(endLine)) return { sourcePath: raw };
  return { sourcePath, startLine, endLine: Math.max(startLine, endLine) };
}

/**
 * 引用列表 → 发送文本。编码严格贴合 markdown 标准语义:
 * - 条目内容行 → `> <line>`;条目**内部空行** → 裸 `>`(无尾随空格,免疫
 *   传输层 trailing-space trim);
 * - 条目**首尾空行**在编码前归一化剔除:采集侧选区常吃进段落边界的空行,
 *   它们不携带信息,却会让编码块以裸 `>` 开头——而 parseLeadingBlockquotes
 *   的早退守卫只认 `"> "` 开头(保护用户手打的裸 `>`),开头裸 `>` 的消息
 *   会整段退化为原文渲染,破坏 roundtrip 契约;
 * - 条目之间以**真空行**分隔(markdown 中即两个独立 blockquote);
 * - 带来源的条目末尾追加 `> — source: <path>` 行;正文与引用块空行相接。
 * 注:首尾空行归一化是对 #793 桌面版原实现的修复(桌面同样受益于后续迁移
 * 到本共享模块)。
 */
/** 剥掉字符串首尾的连续换行(线性扫描,不用正则——`/\n+$/` 会被 CodeQL
 *  以多项式回溯告警;引用文本来自用户选区,属不可控输入)。 */
function stripOuterNewlines(text: string): string {
  let start = 0;
  while (start < text.length && text[start] === '\n') start += 1;
  let end = text.length;
  while (end > start && text[end - 1] === '\n') end -= 1;
  return text.slice(start, end);
}

/** 单条引用 → 可独立插入正文任意位置的 Markdown blockquote。 */
export function formatQuoteForSend(quote: ChatQuote): string {
  const lines = stripOuterNewlines(quote.text).split('\n');
  const sourceLine = formatSourceLine(quote);
  if (sourceLine) lines.push(`${SOURCE_LINE_PREFIX}${sourceLine}`);
  return [
    QUOTE_BLOCK_MARKER_LINE,
    ...lines.map((line) => (line ? `> ${line}` : '>')),
  ].join('\n');
}

export function formatQuotesForSend(quotes: readonly ChatQuote[], body: string): string {
  if (quotes.length === 0) return body;
  const block = quotes.map(formatQuoteForSend).join('\n\n');
  return `${block}\n\n${body}`.trimEnd();
}

function quoteFromLines(lines: string[]): ChatQuote {
  const last = lines[lines.length - 1];
  if (last?.startsWith(SOURCE_LINE_PREFIX) && lines.length > 1) {
    return {
      text: lines.slice(0, -1).join('\n'),
      ...parseSourceLine(last.slice(SOURCE_LINE_PREFIX.length)),
    };
  }
  return { text: lines.join('\n') };
}

/**
 * 解析 quotesEncoded 消息里的全部引用块,同时保留它们与用户文字的顺序。
 * 调用方必须先用持久化标志门控,避免把普通手写 markdown 当成产品引用。
 */
export function parseChatQuoteSegments(
  content: string,
): ChatQuoteSegment[] {
  if (!content.includes('> ')) {
    return content ? [{ kind: 'text', text: content }] : [];
  }

  const lines = content.split('\n');
  const segments: ChatQuoteSegment[] = [];
  let textLines: string[] = [];

  const flushText = ({ beforeQuote }: { beforeQuote: boolean }) => {
    const followsQuote = segments[segments.length - 1]?.kind === 'quote';
    const pending = textLines;
    textLines = [];
    if (pending.length === 0) return;

    // 序列化会在 quote / text 块之间固定放一个 Markdown 空行。只消费这个
    // 结构分隔，额外空行都是用户真实输入的回车，必须留给渲染层。两个引用
    // 之间只有空行时要单独计数，因为 `[''].join('\n')` 无法表达一个换行。
    if (pending.every((line) => line === '')) {
      const structuralEmptyLineCount = followsQuote || beforeQuote ? 1 : 0;
      const preservedLineBreakCount = Math.max(0, pending.length - structuralEmptyLineCount);
      if (preservedLineBreakCount > 0) {
        segments.push({ kind: 'text', text: '\n'.repeat(preservedLineBreakCount) });
      }
      return;
    }

    let start = 0;
    let end = pending.length;
    if (followsQuote && pending[start] === '') start += 1;
    if (beforeQuote && end > start && pending[end - 1] === '') end -= 1;
    const text = pending.slice(start, end).join('\n');
    if (text) {
      segments.push({ kind: 'text', text });
    }
  };

  // 历史稳定格式没有显式 marker，只允许在消息开头解析。PR 开发期曾短暂
  // 写出 markerless 交错块，但它与正文里的用户 Markdown blockquote 无法
  // 从 wire text 区分；不能拿 quotesEncoded 当版本号放宽整条消息，否则旧
  // 消息正文里的 `> ...` 会被误还原成产品引用。新版 marker 才允许交错解析。
  const hasExplicitMarkers = content.includes(QUOTE_BLOCK_MARKER_LINE);
  // 只要同条消息出现新版 marker，整条内容就按无歧义的新格式解析。否则正文
  // 开头的用户手写 Markdown blockquote 会被旧版兼容分支误认成产品引用。
  let allowLegacyLeadingQuotes = !hasExplicitMarkers;
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    const markerIndent =
      line.trimStart() === QUOTE_BLOCK_MARKER_LINE
        ? line.slice(0, line.length - line.trimStart().length)
        : null;
    const marked = markerIndent !== null;
    const legacyLeading = allowLegacyLeadingQuotes && line.startsWith('> ');
    if (!marked && !legacyLeading) {
      textLines.push(line);
      if (line !== '') allowLegacyLeadingQuotes = false;
      index += 1;
      continue;
    }

    flushText({ beforeQuote: true });
    if (marked) {
      allowLegacyLeadingQuotes = false;
      index += 1;
    }
    const quoteLines: string[] = [];
    while (index < lines.length) {
      const quoteLine = lines[index];
      const quotePrefix = `${markerIndent ?? ''}>`;
      if (quoteLine.startsWith(`${quotePrefix} `)) {
        quoteLines.push(quoteLine.slice(quotePrefix.length + 1));
        index += 1;
        continue;
      }
      if (quoteLine === quotePrefix) {
        quoteLines.push('');
        index += 1;
        continue;
      }
      break;
    }
    segments.push({ kind: 'quote', quote: quoteFromLines(quoteLines) });
  }

  flushText({ beforeQuote: false });
  return segments;
}

/**
 * 将解析后的文字岛拼成「引用胶囊之外」的可见正文。
 *
 * 引用块被收进独立胶囊后，相邻文字岛之间至少保留一个空行，避免首尾文字
 * 粘连；但片段自身已经带回车时只补不足的数量，不能用 join('\n\n') 再叠加
 * 两个换行，否则用户在引用前后保留的回车会被放大。
 */
export function joinChatQuoteTextSegments(segments: readonly ChatQuoteSegment[]): string {
  let body = '';
  let hasTextSegment = false;
  for (const segment of segments) {
    if (segment.kind !== 'text') continue;
    if (!hasTextSegment) {
      body = segment.text;
      hasTextSegment = true;
      continue;
    }

    let trailingNewlines = 0;
    for (let index = body.length - 1; index >= 0 && trailingNewlines < 2; index -= 1) {
      if (body[index] !== '\n') break;
      trailingNewlines += 1;
    }
    let leadingNewlines = 0;
    for (let index = 0; index < segment.text.length && leadingNewlines < 2; index += 1) {
      if (segment.text[index] !== '\n') break;
      leadingNewlines += 1;
    }
    body += '\n'.repeat(Math.max(0, 2 - trailingNewlines - leadingNewlines));
    body += segment.text;
  }
  return body;
}

/**
 * 逆解析(与 formatQuotesForSend 对偶):content 以 "> " 开头时,取出开头的
 * blockquote 区还原成引用列表,其余为正文。规则:
 * - `> x` 行是条目内容,裸 `>` 行是条目内部空行;
 * - 空行后紧跟 `> ` 行 → 条目分隔,继续;空行后不是 → 引用区结束,余下为正文;
 * - 条目最后一行是 `— source: <path>` 时抽为来源(选中文本自身以该前缀结尾的
 *   极端情况会被误判,可接受);
 * - 早退守卫只认 `"> "` 开头:首行是裸 `>` 的用户手打内容原样返回,不吞字符。
 * 正文首行恰以 `> ` 开头会被并入引用块——这是 markdown 引用语义的固有歧义,
 * 视觉化后仍以引用样式呈现,可接受。
 */
export function parseLeadingBlockquotes(content: string): {
  quotes: ChatQuote[];
  body: string;
} {
  if (!content.startsWith('> ')) {
    return { quotes: [], body: content };
  }
  const lines = content.split('\n');
  const quotes: ChatQuote[] = [];
  let current: string[] = [];
  let markerConsumedForCurrent = false;

  const flush = () => {
    if (current.length === 0) return;
    quotes.push(quoteFromLines(current));
    current = [];
    markerConsumedForCurrent = false;
  };

  let i = 0;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (
      line === QUOTE_BLOCK_MARKER_LINE &&
      current.length === 0 &&
      !markerConsumedForCurrent
    ) {
      markerConsumedForCurrent = true;
      continue;
    }
    if (line.startsWith('> ')) {
      current.push(line.slice(2));
      continue;
    }
    if (line === '>') {
      // 条目内部空行(markdown:同一 blockquote 里的空行)。
      current.push('');
      continue;
    }
    if (line === '' && current.length > 0 && lines[i + 1]?.startsWith('> ')) {
      // 空行 + 下一行仍是引用 → 条目分隔,继续吃下一条。
      flush();
      continue;
    }
    break; // 引用区结束(空行后接正文,或直接非引用行)。
  }
  flush();
  const body = lines.slice(i).join('\n').replace(/^\n+/, '');
  return { quotes, body };
}

/** 来源路径 → UI 展示用文件名(basename)。 */
export function quoteSourceBasename(sourcePath: string): string {
  return sourcePath.split(/[\\/]/).filter(Boolean).pop() ?? sourcePath;
}

export function quoteSourceLineRangeLabel(quote: ChatQuote): string | null {
  if (!isValidLine(quote.startLine)) return null;
  const endLine =
    isValidLine(quote.endLine) && quote.endLine >= quote.startLine
      ? quote.endLine
      : quote.startLine;
  return endLine === quote.startLine ? `L${quote.startLine}` : `L${quote.startLine}-L${endLine}`;
}

/** UI 展示用来源标签：basename + 可选 source 行号。 */
export function quoteSourceDisplayLabel(quote: ChatQuote): string | null {
  if (!quote.sourcePath) return null;
  const lineLabel = quoteSourceLineRangeLabel(quote);
  return `${quoteSourceBasename(quote.sourcePath)}${lineLabel ? `:${lineLabel}` : ''}`;
}
