import { normalizeMathDelimiters } from '@cindy/maker-shared/math-markdown';
import {
  BARE_HTTP_URL_RE_SOURCE,
  clipBareHttpAutolinkText,
  markdownWrapMarkerFromPrefix,
} from '@cindy/maker-shared/url-text-boundary';
import {
  classifyChatPathLinkTarget,
  findBareFilePathMatch,
  resolveChatAbsPath,
} from '@/session/chatPathCandidate';
import { DEEP_LINK_SCHEME_GROUP } from '@/session/sessionLinks';
import { i18n } from '@/i18n';

export type MobileMarkdownInline =
  | { type: 'text'; text: string }
  // bare:这条 link 是从正文纯文本里切出来的裸路径(matchBareFilePathLink),不是作者
  // 手写的 `[label](url)`。渲染层据此决定点亮后是否套等宽 chip —— 裸路径的未点亮态是
  // 普通正文,套等宽会让同一句里点亮/未点亮的路径在字体、底色、下划线三处齐变;作者
  // 手写且 label 像文件名的仍保留 chip(那是作者的排版意图)。见 DESIGN.md §14.5。
  // 与桌面 remarkLocalPathLinks 打的 data-bare-path 标记是同一件事的两端实现。
  | { type: 'link'; text: string; url: string; bare?: true }
  | { type: 'strong'; text: string }
  | { type: 'emphasis'; text: string }
  | { type: 'code'; text: string }
  | { type: 'strikethrough'; text: string }
  // inline LaTeX 公式($...$ / $$...$$,text 为去定界符后的 LaTeX 源码)。
  // 原生 Text 流渲染时经 latexToUnicodeApproximation 近似;WebView 面(文件
  // 阅读器)可用 KaTeX 精确渲染。
  | { type: 'math'; text: string }
  | MobileMarkdownImageInline;

// 正文图片:来自 ![alt](url) 或模型常用的 raw HTML <img src="..." width="150">(见桌面端 remarkHtmlImages)。
// Markdown 图片还可保留桌面本地/相对路径;会话渲染时再结合被控端 workdir
// 转成 xdt-file 取件 URL。width/height 是可选的展示提示(像素)。
export interface MobileMarkdownImageInline {
  type: 'image';
  alt: string;
  url: string;
  width?: number;
  height?: number;
}

export interface MobileMarkdownTableRow {
  key: string;
  cells: MobileMarkdownInline[][];
}

export type MobileMarkdownBlock =
  | { type: 'paragraph'; key: string; srcLine?: number; inlines: MobileMarkdownInline[] }
  | { type: 'heading'; key: string; srcLine?: number; level: number; inlines: MobileMarkdownInline[] }
  | { type: 'blockquote'; key: string; srcLine?: number; inlines: MobileMarkdownInline[] }
  | { type: 'list_item'; key: string; srcLine?: number; ordered: boolean; marker: string; checked?: boolean; inlines: MobileMarkdownInline[] }
  | { type: 'table'; key: string; srcLine?: number; header: MobileMarkdownInline[][]; rows: MobileMarkdownTableRow[] }
  | { type: 'mermaid'; key: string; srcLine?: number; text: string }
  // display LaTeX 公式块($$ 围栏,text 为 LaTeX 源码)。渲染走 WebView KaTeX
  // (仿 mermaid 块的形态),失败/离线降级显示源码。
  | { type: 'math'; key: string; srcLine?: number; text: string }
  | { type: 'code'; key: string; srcLine?: number; language?: string; text: string };

export interface ParseMobileMarkdownOptions {
  /**
   * 给每个块附上源码起始行 srcLine(0-based)。供文件阅读器「渲染态定位到源码行」
   * 使用(块 key 里的行号语义不一:段落 key 用的是 flush 行 = 末行+1,不能当起始行用)。
   * 默认关闭:聊天气泡路径不需要,且既有消费方/测试按无此字段的形状断言。
   */
  srcLines?: boolean;
}

interface ParsedTableBlock {
  header: string[];
  rows: Array<{ lineIndex: number; cells: string[] }>;
  endIndex: number;
}

interface CodeFenceState {
  language?: string;
  lines: string[];
  start: number;
  marker: '`' | '~';
  markerLength: number;
  indent: string;
}

interface ParsedOpeningCodeFence {
  language?: string;
  marker: '`' | '~';
  markerLength: number;
  indent: string;
}

export function parseMobileMarkdown(
  input: string,
  options?: ParseMobileMarkdownOptions,
): MobileMarkdownBlock[] {
  const withSrc = options?.srcLines === true;
  // LaTeX 定界符归一化(\(...\) / \[...\] → $...$ / $$...$$,desktop/mobile 共用
  // 实现)。srcLines 模式走保行数变体:单行 inline 照常转换(同行替换,不破坏
  // 「块 srcLine ↔ 源码行」映射),会插行的 display 保持源码——与桌面端
  // emitSourceLines 门控同一原则。
  const source = input.replace(/\r\n/g, '\n');
  const normalized = normalizeMathDelimiters(source, { preserveLineCount: withSrc });
  const lines = normalized.split('\n');
  const blocks: MobileMarkdownBlock[] = [];
  let paragraph: string[] = [];
  let code: CodeFenceState | null = null;
  // display math 围栏状态($$ 与 $$ 之间;与 code fence 一样跨行收集)。
  let math: { lines: string[]; start: number } | null = null;
  // 跨块 HTML 注释状态:<!-- 与 --> 之间隔空行时会被拆成多个块,后续块自身没有注释标记,
  // 必须把"仍在注释内"的状态带给 inline 解析,否则注释里的图片标记会被当正常图渲染(review 实捉)。
  // 代码围栏内是字面代码,不参与注释状态推进。
  let inHtmlComment = false;
  let paragraphStartsInComment = false;
  let paragraphStart = 0;

  const flushParagraph = (lineIndex: number) => {
    const text = paragraph.join('\n').trim();
    paragraph = [];
    if (!text) return;
    blocks.push({
      type: 'paragraph',
      key: `p:${lineIndex}:${blocks.length}`,
      ...(withSrc ? { srcLine: paragraphStart } : {}),
      inlines: parseMobileMarkdownInlines(text, paragraphStartsInComment),
    });
  };

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (code) {
      if (isClosingCodeFence(line, code)) {
        blocks.push(buildCodeBlock(code, blocks.length, withSrc));
        code = null;
      } else {
        code.lines.push(stripCodeFenceIndent(line, code.indent));
      }
      continue;
    }

    if (math) {
      if (line.trim() === '$$') {
        const mathText = math.lines.join('\n').trim();
        if (mathText) {
          blocks.push(buildMathBlock(mathText, math.start, blocks.length, withSrc));
        } else {
          // 空围栏($$ 与 $$ 之间无内容):没有可渲染的公式,保持原文段落。
          // 渲染层(math WebView)因此永远不需要「空公式」占位文案,规避
          // 硬编码 UI 文案的 i18n 问题(规则 18,review 实捉)。
          paragraphStart = math.start;
          paragraphStartsInComment = false;
          paragraph = ['$$', ...math.lines, '$$'];
          flushParagraph(index + 1);
        }
        math = null;
      } else {
        math.lines.push(line);
      }
      continue;
    }

    const fence = parseOpeningCodeFence(line);
    if (fence) {
      flushParagraph(index);
      code = {
        language: fence.language,
        lines: [],
        start: index,
        marker: fence.marker,
        markerLength: fence.markerLength,
        indent: fence.indent,
      };
      continue;
    }

    // display math 块:$$ 围栏(normalizeMathDelimiters 已把 \[...\] 归一成此
    // 形态;模型也会原生输出)。单行 $$x$$ 直接成块;裸 $$ 行开围栏跨行收集。
    const mathTrimmed = line.trim();
    const singleLineMath = mathTrimmed.match(/^\$\$(.+)\$\$$/);
    if (singleLineMath && singleLineMath[1].trim()) {
      flushParagraph(index);
      blocks.push(buildMathBlock(singleLineMath[1], index, blocks.length, withSrc));
      continue;
    }
    if (mathTrimmed === '$$') {
      flushParagraph(index);
      math = { lines: [], start: index };
      continue;
    }

    if (!line.trim()) {
      flushParagraph(index);
      continue;
    }

    const lineStartsInComment = inHtmlComment;
    inHtmlComment = advanceHtmlCommentState(line, inHtmlComment);

    const heading = line.match(/^(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/);
    if (heading) {
      flushParagraph(index);
      blocks.push({
        type: 'heading',
        key: `h:${index}:${blocks.length}`,
        ...(withSrc ? { srcLine: index } : {}),
        level: heading[1].length,
        inlines: parseMobileMarkdownInlines(heading[2].trim(), lineStartsInComment),
      });
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      flushParagraph(index);
      const quoteStart = index;
      const quoteLines: string[] = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
        if (index > quoteStart) inHtmlComment = advanceHtmlCommentState(lines[index], inHtmlComment);
        quoteLines.push(lines[index].replace(/^\s*>\s?/, ''));
        index += 1;
      }
      index -= 1;
      blocks.push({
        type: 'blockquote',
        key: `quote:${quoteStart}:${blocks.length}`,
        ...(withSrc ? { srcLine: quoteStart } : {}),
        inlines: parseMobileMarkdownInlines(quoteLines.join('\n').trim(), lineStartsInComment),
      });
      continue;
    }

    const table = parseTableBlock(lines, index);
    if (table) {
      flushParagraph(index);
      const tableStart = index;
      // 注释状态按行推进:注释可能在表格中途开启/闭合(如某行含 <!--、后续行才有 -->),
      // 每个数据行的单元格用该行行首的注释状态解析,不再沿用表头行状态近似(review 实捉)。
      // 同一行内注释也可能跨单元格(| start <!-- | ![hidden] | --> |):每个 cell 以
      // "行首状态 + 前序 cell 逐个推进"后的状态解析,不再整行共用行首状态(review 实捉)。
      const parseCellsWithCommentState = (cells: readonly string[], rowState: boolean) => {
        let cellState = rowState;
        return cells.map((cell) => {
          const parsed = parseMobileMarkdownInlines(cell, cellState);
          cellState = advanceHtmlCommentState(cell, cellState);
          return parsed;
        });
      };
      const rowStartsInComment = new Map<number, boolean>();
      for (let consumed = index + 1; consumed <= table.endIndex; consumed += 1) {
        rowStartsInComment.set(consumed, inHtmlComment);
        inHtmlComment = advanceHtmlCommentState(lines[consumed], inHtmlComment);
      }
      const header = parseCellsWithCommentState(table.header, lineStartsInComment);
      const rows = table.rows.map((row, rowIndex): MobileMarkdownTableRow => ({
        key: `tr:${row.lineIndex}:${rowIndex}`,
        cells: parseCellsWithCommentState(row.cells, rowStartsInComment.get(row.lineIndex) ?? lineStartsInComment),
      }));
      index = table.endIndex;
      blocks.push({
        type: 'table',
        key: `table:${tableStart}:${blocks.length}`,
        ...(withSrc ? { srcLine: tableStart } : {}),
        header,
        rows,
      });
      continue;
    }

    const list = line.match(/^(\s*)([-*]|\d+[.)])\s+(.+)$/);
    if (list) {
      flushParagraph(index);
      const marker = list[2];
      const task = list[3].match(/^\[([ xX])\]\s+(.+)$/);
      blocks.push({
        type: 'list_item',
        key: `li:${index}:${blocks.length}`,
        ...(withSrc ? { srcLine: index } : {}),
        ordered: /^\d/.test(marker),
        marker,
        checked: task ? task[1].toLowerCase() === 'x' : undefined,
        inlines: parseMobileMarkdownInlines(task ? task[2] : list[3], lineStartsInComment),
      });
      continue;
    }

    if (paragraph.length === 0) {
      paragraphStartsInComment = lineStartsInComment;
      paragraphStart = index;
    }
    paragraph.push(line);
  }

  if (code) {
    blocks.push(buildCodeBlock(code, blocks.length, withSrc));
  }
  if (math) {
    // 未闭合的 $$ 围栏(streaming 中途):不升级成 math 块——math 块渲染在
    // WebView 里,source 随流式每 tick 变化会触发整页 reload,滚动/性能上
    // 不可接受。按原文段落展示(含开围栏的 $$ 行),闭合后下一轮重解析自然
    // 升级成 math 块——与 mermaid「fence 未闭合先当 code、闭合才进 WebView」
    // 的口径一致。
    paragraphStart = math.start;
    paragraphStartsInComment = false;
    paragraph = ['$$', ...math.lines];
  }
  flushParagraph(lines.length);
  return blocks;
}

/** display math 块构造:text 存去围栏后的 LaTeX 源码(trim 掉围栏内缘空白)。 */
function buildMathBlock(
  text: string,
  startLine: number,
  blockIndex: number,
  withSrc: boolean,
): MobileMarkdownBlock {
  return {
    type: 'math',
    key: `math:${startLine}:${blockIndex}`,
    ...(withSrc ? { srcLine: startLine } : {}),
    text: text.trim(),
  };
}

// 收集正文里的全部图片 inline(段落/标题/引用/列表 + 表格单元格),供会话图集(全屏查看器横滑翻页)使用。
// 先用廉价正则短路:绝大多数消息不含图片,不为它们付整段 Markdown 解析的开销(gallery 收集跑在列表 useMemo 热路径)。
const MARKDOWN_IMAGE_HINT_RE = /!\[|<img/i;

export function collectMobileMarkdownImages(input: string): MobileMarkdownImageInline[] {
  if (!MARKDOWN_IMAGE_HINT_RE.test(input)) return [];
  const images: MobileMarkdownImageInline[] = [];
  const visitInlines = (inlines: readonly MobileMarkdownInline[]) => {
    for (const inline of inlines) {
      if (inline.type === 'image') images.push(inline);
    }
  };
  for (const block of parseMobileMarkdown(input)) {
    switch (block.type) {
      case 'paragraph':
      case 'heading':
      case 'blockquote':
      case 'list_item':
        visitInlines(block.inlines);
        break;
      case 'table':
        block.header.forEach(visitInlines);
        block.rows.forEach((row) => row.cells.forEach(visitInlines));
        break;
      case 'mermaid':
      case 'code':
        break;
    }
  }
  return images;
}

/**
 * Markdown 图片地址 → 手机可消费地址。本地相对路径必须在消费点结合被控端
 * workdir 解析,再复用既有 xdt-file/media:fetch 链路;不让手机尝试读取 file://。
 * 原始路径只在这里解包一次,避免空格、%20 与字面百分号被二次编码。cacheKey
 * 用消息身份区分同一路径的后续引用,让手机端按 URL 缓存的 resolver 不复用旧图。
 * SSH 会话额外携带 sessionId + remoteHostId + workdir；被控端必须按 sessionId
 * 反查可信 SSH 上下文后再走 file-service，绝不能只信 Markdown URL 里的路径边界。
 */
export function mobileMarkdownImageUrlForWorkdir(
  url: string,
  workdir?: string,
  cacheKey?: string,
  remoteHostId?: string,
  sessionId?: string,
): string | null {
  if (SAFE_IMAGE_SRC_RE.test(url)) {
    const normalized = normalizeImageUrlScheme(url);
    if (!normalized.startsWith('xdt-file://')) return normalized;
    try {
      const parsed = new URL(normalized);
      if (!parsed.searchParams.get('path')) return null;
      // 旧 cache key 同样来自 Markdown，不得影响当前消息的资源身份；统一在上下文后重建。
      parsed.searchParams.delete('v');
      if (remoteHostId) {
        if (!workdir || !sessionId) return null;
        // 必须覆盖而非 append：Markdown 来源不可信，旧参数不得选择其它 SSH 会话/host/workdir。
        parsed.searchParams.delete('sessionId');
        parsed.searchParams.delete('remoteHostId');
        parsed.searchParams.delete('workdir');
        parsed.searchParams.set('sessionId', sessionId);
        parsed.searchParams.set('remoteHostId', remoteHostId);
        parsed.searchParams.set('workdir', workdir);
      } else {
        // 本地会话同样不能信任 Markdown 自带的 SSH context，否则会把本机取件导向任意 SSH host。
        parsed.searchParams.delete('sessionId');
        parsed.searchParams.delete('remoteHostId');
        parsed.searchParams.delete('workdir');
      }
      if (cacheKey) parsed.searchParams.set('v', cacheKey);
      return parsed.toString();
    } catch {
      return null;
    }
  }
  if (!workdir || !classifyChatPathLinkTarget(url)) return null;
  const absPath = resolveChatAbsPath(url, workdir);
  const base = `xdt-file://open?path=${encodeURIComponent(absPath)}`;
  if (remoteHostId && !sessionId) return null;
  const sshContext = remoteHostId && sessionId
    ? `&sessionId=${encodeURIComponent(sessionId)}&remoteHostId=${encodeURIComponent(remoteHostId)}&workdir=${encodeURIComponent(workdir)}`
    : '';
  const version = cacheKey ? `&v=${encodeURIComponent(cacheKey)}` : '';
  return `${base}${sshContext}${version}`;
}

// 流式(native)路径下正文图片的缩略图尺寸:默认宽 150,宽高都封顶 220。有声明宽高时按比例
// 换算,但换算结果同样封顶——width/height 只过了「1-4 位纯数字」白名单,height="9999" 这类
// 极端比例若不封顶会在流式阶段渲染出近万像素高的图,撑爆气泡(review P2)。
/**
 * 可跨段选择的「文本运行组」分组:把连续的纯文本块(段落 / 标题 / 列表项,且不含直连内联图)
 * 合并为一个 text_run —— 渲染层将整个 run 塞进同一个原生文本视图(iOS UITextView / Android Text),
 * 原生选择即可横跨这些块。代码块 / 表格 / mermaid / 引用 / 含直连图的块保持独立(single),
 * 它们承载非文本结构(横向滚动 / 边框 / 内嵌 View),不能进原生文本树,选择也天然止步于此。
 */
export type MobileMarkdownTextRunBlock =
  Extract<MobileMarkdownBlock, { type: 'paragraph' | 'heading' | 'list_item' }>
  & { textRunContinuation?: boolean };

export type MobileMarkdownBlockGroup =
  | { type: 'text_run'; key: string; blocks: MobileMarkdownTextRunBlock[]; textRunContinuation?: boolean }
  | { type: 'single'; key: string; block: MobileMarkdownBlock };

export interface MobileMarkdownTextRunGroupingOptions {
  /**
   * Upper bound for one selectable native text view. Undefined keeps the
   * historical "merge until a non-text block" behavior.
   */
  maxTextRunBlocks?: number;
  /** Same guard by rendered inline text length, measured in JS UTF-16 units. */
  maxTextRunUtf16Length?: number;
}

const MOBILE_MARKDOWN_TEXT_RUN_BLOCK_SEPARATOR_UTF16_LENGTH = 2;
export const MOBILE_MARKDOWN_IMAGE_ALT_CHIP_MAX_UTF16_LENGTH = 256;

export function groupMobileMarkdownSelectableBlocks(
  blocks: readonly MobileMarkdownBlock[],
  options?: MobileMarkdownTextRunGroupingOptions,
): MobileMarkdownBlockGroup[] {
  const groups: MobileMarkdownBlockGroup[] = [];
  let run: MobileMarkdownTextRunBlock[] = [];
  let runTextLength = 0;
  const maxTextRunBlocks = normalizePositiveLimit(options?.maxTextRunBlocks);
  const maxTextRunUtf16Length = normalizePositiveLimit(options?.maxTextRunUtf16Length);
  const flushRun = () => {
    if (run.length === 0) return;
    groups.push({
      type: 'text_run',
      key: `run:${run[0].key}`,
      blocks: run,
      ...(run[0].textRunContinuation ? { textRunContinuation: true } : {}),
    });
    run = [];
    runTextLength = 0;
  };
  for (const block of blocks) {
    if (isTextRunBlock(block)) {
      for (const chunk of splitOversizedTextRunBlock(block, maxTextRunUtf16Length)) {
        const blockTextLength = mobileMarkdownTextRunBlockLength(chunk);
        const separatorLength = run.length > 0 && !chunk.textRunContinuation
          ? MOBILE_MARKDOWN_TEXT_RUN_BLOCK_SEPARATOR_UTF16_LENGTH
          : 0;
        if (
          run.length > 0
          && (
            run.length >= maxTextRunBlocks
            || runTextLength + separatorLength + blockTextLength > maxTextRunUtf16Length
          )
        ) {
          flushRun();
        }
        const pushedSeparatorLength = run.length > 0 && !chunk.textRunContinuation
          ? MOBILE_MARKDOWN_TEXT_RUN_BLOCK_SEPARATOR_UTF16_LENGTH
          : 0;
        run.push(chunk);
        runTextLength += pushedSeparatorLength + blockTextLength;
      }
    } else {
      flushRun();
      groups.push({ type: 'single', key: block.key, block });
    }
  }
  flushRun();
  return groups;
}

function isTextRunBlock(block: MobileMarkdownBlock): block is MobileMarkdownTextRunBlock {
  if (block.type !== 'paragraph' && block.type !== 'heading' && block.type !== 'list_item') {
    return false;
  }
  // 直连内联图渲染为 Text 内嵌 View,不能进合并文本树(Android selectable+内嵌 View 行为未定义)。
  return !block.inlines.some(
    (inline) => inline.type === 'image' && isMobileMarkdownImageDirectUrl(inline.url),
  );
}

function normalizePositiveLimit(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return Number.POSITIVE_INFINITY;
  }
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : Number.POSITIVE_INFINITY;
}

function mobileMarkdownTextRunBlockLength(block: MobileMarkdownTextRunBlock): number {
  const inlineLength = block.inlines.reduce((total, inline) => total + mobileMarkdownInlineTextLength(inline), 0);
  if (block.type === 'list_item' && !block.textRunContinuation) {
    return inlineLength + mobileMarkdownListMarkerText(block).length;
  }
  return inlineLength;
}

function mobileMarkdownInlineTextLength(inline: MobileMarkdownInline): number {
  if (inline.type === 'image') {
    return mobileMarkdownImageAltChipText(inline.alt).length;
  }
  return inline.text.length;
}

export function mobileMarkdownImageAltChipText(alt: string): string {
  if (alt.length <= MOBILE_MARKDOWN_IMAGE_ALT_CHIP_MAX_UTF16_LENGTH) return alt;
  const end = safeUtf16SliceEnd(alt, 0, MOBILE_MARKDOWN_IMAGE_ALT_CHIP_MAX_UTF16_LENGTH - 1);
  return `${alt.slice(0, end)}…`;
}

function splitOversizedTextRunBlock(
  block: MobileMarkdownTextRunBlock,
  maxTextRunUtf16Length: number,
): MobileMarkdownTextRunBlock[] {
  if (
    !Number.isFinite(maxTextRunUtf16Length)
    || mobileMarkdownTextRunBlockLength(block) <= maxTextRunUtf16Length
  ) {
    return [block];
  }

  const chunks: MobileMarkdownInline[][] = [];
  let current: MobileMarkdownInline[] = [];
  let currentTextLength = 0;
  const currentLimit = () => Math.max(
    1,
    maxTextRunUtf16Length - (chunks.length === 0 ? mobileMarkdownTextRunBlockPrefixLength(block) : 0),
  );
  const flushCurrent = () => {
    if (current.length === 0) return;
    chunks.push(current);
    current = [];
    currentTextLength = 0;
  };
  const appendInlineTextChunks = (
    text: string,
    buildInline: (text: string) => MobileMarkdownInline,
  ) => {
    let start = 0;
    while (start < text.length) {
      if (currentTextLength >= currentLimit()) flushCurrent();
      const capacity = currentLimit() - currentTextLength;
      if (
        currentTextLength > 0
        && capacity === 1
        && startsWithSurrogatePair(text, start)
      ) {
        flushCurrent();
        continue;
      }
      const end = safeUtf16SliceEnd(text, start, capacity);
      current.push(buildInline(text.slice(start, end)));
      currentTextLength += end - start;
      start = end;
    }
  };

  for (const inline of block.inlines) {
    if (inline.type === 'image') {
      const inlineLength = mobileMarkdownInlineTextLength(inline);
      if (current.length > 0 && currentTextLength + inlineLength > currentLimit()) {
        flushCurrent();
      }
      current.push(inline);
      currentTextLength += inlineLength;
      if (currentTextLength >= currentLimit()) flushCurrent();
      continue;
    }

    appendInlineTextChunks(inline.text, (text) => ({ ...inline, text }));
  }
  flushCurrent();

  if (chunks.length <= 1) return [block];
  return chunks.map((inlines, index) => cloneTextRunBlockChunk(block, inlines, index));
}

function mobileMarkdownTextRunBlockPrefixLength(block: MobileMarkdownTextRunBlock): number {
  if (block.type !== 'list_item' || block.textRunContinuation) return 0;
  return mobileMarkdownListMarkerText(block).length;
}

function mobileMarkdownListMarkerText(block: Extract<MobileMarkdownTextRunBlock, { type: 'list_item' }>): string {
  if (typeof block.checked === 'boolean') return block.checked ? '☑ ' : '☐ ';
  return block.ordered ? `${block.marker} ` : '• ';
}

function cloneTextRunBlockChunk(
  block: MobileMarkdownTextRunBlock,
  inlines: MobileMarkdownInline[],
  index: number,
): MobileMarkdownTextRunBlock {
  const key = index === 0 ? block.key : `${block.key}:split:${index}`;
  const continuation = index > 0 ? { textRunContinuation: true } : {};
  if (block.type === 'paragraph') return { ...block, key, inlines, ...continuation };
  if (block.type === 'heading') return { ...block, key, inlines, ...continuation };
  return {
    ...block,
    key,
    inlines,
    ...continuation,
  };
}

function safeUtf16SliceEnd(text: string, start: number, maxLength: number): number {
  const length = Math.max(1, maxLength);
  if (length === 1 && startsWithSurrogatePair(text, start)) {
    return start + 2;
  }
  let end = Math.min(text.length, start + length);
  if (
    end < text.length
    && end > start
    && isHighSurrogate(text.charCodeAt(end - 1))
    && isLowSurrogate(text.charCodeAt(end))
  ) {
    end -= 1;
  }
  return end > start ? end : Math.min(text.length, start + 1);
}

function startsWithSurrogatePair(text: string, start: number): boolean {
  return (
    start + 1 < text.length
    && isHighSurrogate(text.charCodeAt(start))
    && isLowSurrogate(text.charCodeAt(start + 1))
  );
}

function isHighSurrogate(value: number): boolean {
  return value >= 0xD800 && value <= 0xDBFF;
}

function isLowSurrogate(value: number): boolean {
  return value >= 0xDC00 && value <= 0xDFFF;
}

const MARKDOWN_INLINE_IMAGE_DEFAULT_WIDTH = 150;
const MARKDOWN_INLINE_IMAGE_MAX_EDGE = 220;

export function mobileMarkdownInlineImageSize(inline: MobileMarkdownImageInline): {
  width: number;
  height: number;
} {
  const width = Math.min(inline.width ?? MARKDOWN_INLINE_IMAGE_DEFAULT_WIDTH, MARKDOWN_INLINE_IMAGE_MAX_EDGE);
  const rawHeight = inline.width && inline.height
    ? Math.round(width * (inline.height / inline.width))
    : inline.height ?? Math.round(width * 0.75);
  const height = Math.max(1, Math.min(rawHeight, MARKDOWN_INLINE_IMAGE_MAX_EDGE));
  return { width, height };
}

// 图片查看器标题:优先 alt,否则取 URL 文件名(尽量解码),兜底「图片」。
export function mobileMarkdownImageTitle(url: string, alt?: string): string {
  const trimmedAlt = alt?.trim();
  if (trimmedAlt) return trimmedAlt;
  const fileName = url.split('?')[0].split('#')[0].split('/').pop() ?? '';
  try {
    return decodeURIComponent(fileName) || i18n.t('message.renderer.imageFallbackTitle');
  } catch {
    return fileName || i18n.t('message.renderer.imageFallbackTitle');
  }
}

function buildCodeBlock(
  code: CodeFenceState,
  blockIndex: number,
  withSrc = false,
): MobileMarkdownBlock {
  const normalized = normalizeCodeFencePayload(code);
  const text = normalized.lines.join('\n');
  if (isMermaidLanguage(normalized.language)) {
    return {
      type: 'mermaid',
      key: `mermaid:${code.start}:${blockIndex}`,
      ...(withSrc ? { srcLine: code.start } : {}),
      text,
    };
  }
  return {
    type: 'code',
    key: `code:${code.start}:${blockIndex}`,
    ...(withSrc ? { srcLine: code.start } : {}),
    language: normalized.language,
    text,
  };
}

function normalizeCodeFencePayload(code: CodeFenceState): { language?: string; lines: string[] } {
  if (code.language || code.markerLength >= 3 || code.lines.length < 2) {
    return { language: code.language, lines: code.lines };
  }

  const firstLine = code.lines[0]?.trim();
  if (!firstLine || !isLikelyFenceLanguage(firstLine)) {
    return { language: code.language, lines: code.lines };
  }

  return {
    language: normalizeFenceLanguage(firstLine),
    lines: code.lines.slice(1),
  };
}

function isMermaidLanguage(language: string | undefined): boolean {
  const normalized = language?.trim().toLowerCase();
  return normalized === 'mermaid' || normalized === 'mmd';
}

function parseOpeningCodeFence(line: string): ParsedOpeningCodeFence | null {
  const match = line.match(/^([ \t]*)(`{2,}|~{2,})(.*)$/);
  if (!match) return null;
  const markerRun = match[2];
  const marker = markerRun[0] as '`' | '~';
  const info = match[3].trim();
  if (marker === '`' && info.includes('`')) return null;
  const language = normalizeFenceLanguage(info);
  return {
    language,
    marker,
    markerLength: markerRun.length,
    indent: match[1],
  };
}

function isClosingCodeFence(line: string, code: CodeFenceState): boolean {
  const trimmed = line.trim();
  if (trimmed.length < code.markerLength) return false;
  for (let index = 0; index < trimmed.length; index += 1) {
    if (trimmed[index] !== code.marker) return false;
  }
  return true;
}

function normalizeFenceLanguage(info: string): string | undefined {
  const language = info.split(/\s+/)[0]?.trim();
  return language || undefined;
}

function isLikelyFenceLanguage(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return [
    'bash',
    'cmd',
    'css',
    'diff',
    'html',
    'javascript',
    'js',
    'json',
    'jsx',
    'mermaid',
    'mmd',
    'powershell',
    'ps1',
    'python',
    'sh',
    'shell',
    'sql',
    'tsx',
    'ts',
    'typescript',
    'yaml',
    'yml',
    'zsh',
  ].includes(normalized);
}

function stripCodeFenceIndent(line: string, indent: string): string {
  if (!indent || !line.startsWith(indent)) return line;
  return line.slice(indent.length);
}

export function parseMobileMarkdownInlines(
  input: string,
  startsInsideHtmlComment = false,
): MobileMarkdownInline[] {
  const out: MobileMarkdownInline[] = [];
  let cursor = 0;
  while (cursor < input.length) {
    const token = findNextInlineToken(input, cursor, startsInsideHtmlComment);
    if (!token) {
      pushText(out, input.slice(cursor));
      break;
    }
    if (token.index > cursor) pushText(out, input.slice(cursor, token.index));
    out.push(token.inline);
    cursor = token.end;
  }
  return out.length > 0 ? out : [{ type: 'text', text: input }];
}

/** Mobile 只把 `~~` 当删除线，单个 `~` 是普通字符，不能当 URL 包裹标记。 */
function mobileMarkdownWrapMarker(prefix: string): string | null {
  const marker = markdownWrapMarkerFromPrefix(prefix);
  return marker === '~' ? null : marker;
}

function findNextInlineToken(
  input: string,
  from: number,
  startsInsideHtmlComment: boolean,
): { index: number; end: number; inline: MobileMarkdownInline } | null {
  const candidates = [
    // 图片要放在 link / 裸 URL 之前:![alt](url) 的 "[alt](url)" 子串会被 link 规则命中,
    // 靠 image 的起点(`!`)更靠前在排序里胜出,这里的顺序只是可读性上的强调。
    matchMarkdownImage(input, from, startsInsideHtmlComment),
    matchHtmlImage(input, from, startsInsideHtmlComment),
    // 链接语法:http(s) 之外放行 Cindy 深链(双 scheme:cindy 主 + xdt-maker
    // 兼容存量消息)session|project/(session 渲染成会话 chip;project 在
    // renderInline 里显示 label 纯文本,不落 Linking.openURL——桌面端粘贴
    // chip 化后会按 [标题](深链) 发送,不 tokenize 会把整段渲染成原始
    // markdown 源码,review P1)。
    matchRegex(
      input,
      from,
      new RegExp(
        `\\[([^\\]]+)\\]\\(((?:https?://|(?:${DEEP_LINK_SCHEME_GROUP})://(?:session|project)/)[^)\\s]+)\\)`,
        'g',
      ),
      (match) => ({
        type: 'link' as const,
        text: match[1],
        url: trimUrlPunctuation(match[2]),
      }),
    ),
    // 本地路径链接:[README.md](/abs/path/README.md:17) 这类模型高频输出形态。
    // URL 经 classifyChatPathLinkTarget 判形状(http/session 之外的路径形态才收),
    // 渲染层再经被控端 stat 决定点亮 chip 还是保持纯文本标签。
    matchLocalPathLink(input, from),
    // 正文纯文本里裸写的本地路径(`见 src/App.tsx 第 20 行`、`改的是 C:\proj\a.ts`):
    // 模型高频形态,桌面端由 remarkLocalPathLinks 切成 link 节点,这里补齐同一入口。
    // 产出 link inline 后与 `[label](path)` 形态共用 LinkPathChipSpan → 远端 stat →
    // 点亮 chip / 保持纯文本。
    matchBareFilePathLink(input, from, startsInsideHtmlComment),
    matchRegex(input, from, /`([^`]+)`/g, (match) => ({ type: 'code' as const, text: match[1] })),
    // inline math:$$x$$(双 dollar 行内形态)与 $x$。候选按起点排序,公式起点
    // 的 $ 早于公式体内的 * / _,强调规则不会拆走公式内容。单 dollar 采用
    // Pandoc 风格紧贴规则:内容首尾必须非空白、闭合 $ 后不能紧跟数字——
    // 「$5 和 $10」这类货币文本不会误判成公式。`\$` 转义与 $$ 的首个 $ 由
    // 前缀组排除(prefixGroupIndex 语义同 emphasis matcher)。内容里排除反
    // 引号:合法 LaTeX 不含 backtick,而放行它会让「$10 …;`$HOME`」这类
    // 货币 + code span 文本被跨 code 边界配对成公式(模拟器实测误伤)。
    matchRegex(input, from, /\$\$([^$`\n]+?)\$\$/g, (match) => ({
      type: 'math' as const,
      text: match[1].trim(),
    })),
    matchRegex(input, from, /(^|[^\\$])\$([^$`\n\s](?:[^$`\n]*[^$`\n\s])?)\$(?!\d)/g, (match) => ({
      type: 'math' as const,
      text: match[2],
    }), 1),
    matchRegex(input, from, /\*\*([^*\n]+)\*\*/g, (match) => ({ type: 'strong' as const, text: match[1] })),
    matchRegex(input, from, /__([^_\n]+)__/g, (match) => ({ type: 'strong' as const, text: match[1] })),
    matchRegex(input, from, /~~([^~\n]+)~~/g, (match) => ({ type: 'strikethrough' as const, text: match[1] })),
    matchRegex(input, from, /(^|[^\w*])\*([^*\n]+)\*/g, (match) => ({
      type: 'emphasis' as const,
      text: match[2],
    }), 1),
    matchRegex(input, from, /(^|[^\w_])_([^_\n]+)_/g, (match) => ({
      type: 'emphasis' as const,
      text: match[2],
    }), 1),
    // 裸链接:http(s) 走共享 BARE_HTTP_URL_RE_SOURCE + clipBareHttpAutolink
    // （CJK/全角标点/包裹括号/尾部句读同一套）；会话/项目深链仍是。project
    // 白名单与桌面 PROJECT_DEEP_LINK_RE_SOURCE 同口径,含尾部负向前瞻
    // (白名单 ∪ `'(`):旧编码产出的链接可能含裸 `'` `(`,白名单在此截断
    // 会得到指错项目的前缀匹配——匹配终止处紧跟 `'` / `(` 时整段拒绝;
    // 前瞻并入白名单字符本身,回溯出的短前缀必败,等效原子组(与桌面注释
    // 同一推导,review P2)。
    (() => {
      const raw = matchRegex(
        input,
        from,
        new RegExp(
          `(?:${BARE_HTTP_URL_RE_SOURCE}|(?:${DEEP_LINK_SCHEME_GROUP})://session/[A-Za-z0-9%~_-]+(?:\\?[A-Za-z0-9%&=~._-]*[A-Za-z0-9%~_-])?|(?:${DEEP_LINK_SCHEME_GROUP})://project/[A-Za-z0-9%~._!*-]+(?![A-Za-z0-9%~._!*('-]))`,
          'g',
        ),
        (match) => {
          const rawHref = match[0];
          const href = /^https?:\/\//i.test(rawHref)
            ? clipBareHttpAutolinkText(rawHref, {
                prefix: input.slice(0, match.index),
                markdownWrapMarker: mobileMarkdownWrapMarker(
                  input.slice(0, match.index),
                ),
                cutPathBrackets: false,
              })
            : trimUrlPunctuation(rawHref);
          return { type: 'link' as const, text: href, url: href };
        },
      );
      // 剥掉的尾部句读要留在正文里:matchRegex 的 end 按未剥原文推进,而
      // project 白名单含 `.`(`!` 同理),`…%2Frepo.` 的句号会被吞掉不再
      // 渲染(review P2;session / http 形态靠正则末字符排除句读,此处
      // 天然 no-op)。end 收缩到剥后长度,句读作为 text 回流。
      if (raw && raw.inline.type === 'link') {
        return { ...raw, end: raw.index + raw.inline.url.length };
      }
      return raw;
    })(),
  ].filter((item): item is { index: number; end: number; inline: MobileMarkdownInline } => !!item);
  if (candidates.length === 0) return null;
  return candidates.sort((a, b) => a.index - b.index || a.end - b.end)[0];
}

// 本地路径链接 matcher:通用 [text](url) 形态逐个 exec,URL 过
// classifyChatPathLinkTarget 形状门(http(s) / 会话深链 / mailto 等 scheme 不收,
// 那些归原有 matcher);`![alt](url)` 是图片语法,前置 `!` 时跳过——图片 matcher
// 不收本地路径 URL(MARKDOWN_IMAGE_RE 只认 http/xdt 系),该形态维持字面文本现状。
//
// destination 与本地图片同一套口径(LOCAL_MARKDOWN_IMAGE_RE + parseLocalMarkdownDestination):
// 允许裸空格路径、`<...>` 包裹、以及 CommonMark 的**可选 title**(`[源码](src/a.ts "实现")`)。
// 原先 destination 卡在 `[^)\s]+`,带 title 的链接整段不匹配 → 退回字面文本;而裸路径
// matcher 会从括号里命中 `src/a.ts`,把它切成「字面 `[源码](` + 可点路径 + 字面 ` "实现")`」
// 三段(PR #1144 review 实捉)。补上 title 支持后整段正常成链,裸路径 matcher 因起点
// index 更靠后而天然让位。
function matchLocalPathLink(
  input: string,
  from: number,
): { index: number; end: number; inline: MobileMarkdownInline } | null {
  if (!input.includes('](')) return null;
  // 正则每次调用新建:g 标志的 lastIndex 是可变状态,模块级共享在提前 return /
  // 未过重置路径时会漏匹配(bot review 实捉);同文件其它 matcher 也是每调用新建字面量。
  const re = /\[([^\]]+)\]\((<[^>\n]+>|(?:[^()\n]|\([^()\n]*\))+)\)/g;
  re.lastIndex = from;
  let match: RegExpExecArray | null;
  while ((match = re.exec(input)) !== null) {
    if (match.index > 0 && input[match.index - 1] === '!') continue;
    const url = parseLocalMarkdownDestination(match[2]);
    if (!url || !classifyChatPathLinkTarget(url)) continue;
    return {
      index: match.index,
      end: match.index + match[0].length,
      inline: { type: 'link', text: match[1], url },
    };
  }
  return null;
}

// 正文纯文本裸路径 matcher(桌面 remarkLocalPathLinks 的分词层对等物)。词法判定在
// chatPathCandidate.findBareFilePathMatch 里(含「必须带分隔符」的严判与廉价短路),
// 这里只负责两件事:注释内压制、包装成 link inline。
//
// **不需要为「别抢走包裹语法」做特判**:`[图](/a.png)` / `![图](/a.png)` /
// `` `src/a.ts` `` / `https://x.com/a/b.png` 这些形态里,包裹语法候选的起点 index 都
// 严格小于其内部路径的 index,findNextInlineToken 既有的 index 升序排序天然让它们胜出。
// 反过来,未闭合的反引号(`` `src/a.ts `` 流式中途)不构成 code span,此时裸路径照常
// 命中——与桌面 remark 同口径(remark 也不会把它当 inlineCode)。
function matchBareFilePathLink(
  input: string,
  from: number,
  startsInsideHtmlComment = false,
): { index: number; end: number; inline: MobileMarkdownInline } | null {
  // 廉价短路:绝大多数消息段既不含 `<!--`、也不在跨块注释里,不为它们付
  // blankCodeSpans + blankEscapedAngles 两趟整串拷贝的开销(本函数在渲染热路径上
  // 逐 token 调用;同 HTML_IMG_HINT_RE / MARKDOWN_IMAGE_HINT_RE 的套路)。
  const needsCommentCheck = startsInsideHtmlComment || input.includes('<!--');
  let cursor = from;
  // 注释 span 定位与 matchHtmlImage / matchMarkdownImage 同口径:在 code-span 与转义
  // `<` 空白填充(偏移保持)的副本上判定,行内代码里的字面 `<!--` 不把后文毒化成
  // 「注释内」。命中在注释里的跳过(桌面侧注释是 html 节点、插件根本看不到,压制
  // 才是同口径),注释外的照常识别。
  let commentProbe: string | null = null;
  for (;;) {
    const match = findBareFilePathMatch(input, cursor);
    if (!match) return null;
    if (needsCommentCheck) {
      if (commentProbe === null) commentProbe = blankEscapedAngles(blankCodeSpans(input));
      if (isInsideHtmlComment(commentProbe, match.index, startsInsideHtmlComment)) {
        cursor = match.end;
        continue;
      }
    }
    // 标签标记内部(属性值等)跳过:命中会拆坏标签结构。元素内容不挡 —— 与既有
    // strong / inlineCode / 裸 URL matcher 同口径(见 isInsideHtmlTagMarkup 的说明)。
    if (isInsideHtmlTagMarkup(input, match.index)) {
      cursor = match.end;
      continue;
    }
    return {
      index: match.index,
      end: match.end,
      // 裸形态没有独立 label,显示文本就是路径原文(桌面切出的 link 节点同样以
      // 路径原文作 children)。bare 标记供渲染层区分来源(见 MobileMarkdownInline)。
      inline: { type: 'link', text: match.value, url: match.value, bare: true },
    };
  }
}

function matchRegex(
  input: string,
  from: number,
  regex: RegExp,
  build: (match: RegExpExecArray) => MobileMarkdownInline,
  prefixGroupIndex?: number,
): { index: number; end: number; inline: MobileMarkdownInline } | null {
  regex.lastIndex = from;
  const match = regex.exec(input);
  if (!match || match.index < from) return null;
  const prefixLength = prefixGroupIndex === undefined ? 0 : (match[prefixGroupIndex]?.length ?? 0);
  return {
    index: match.index + prefixLength,
    end: match.index + match[0].length,
    inline: build(match),
  };
}

// raw HTML <img> → image inline 的安全转换(对齐桌面端 remarkHtmlImages 的口径):
// 只识别单个自闭合/未闭合的 <img> 标签,src 必须是 http(s),width/height 只接受 1-4 位纯数字。
// 其它任意 HTML(嵌套标签、事件属性、非 http src)不转换,保持现状按纯文本展示。
// img 标签名必须"恰好是 img":后面紧跟空白、"/" 或 ">"。\b 会把 -/./: 当边界,
// <img-wrapper src=...> 这类自定义元素会被误当 img 解析出 src(review 实捉)。
const HTML_IMG_TAG_RE = /<img(?=[\s/>])[^<>]*\/?>/gi;
const HTML_IMG_ATTR_RE = /([A-Za-z_:][A-Za-z0-9:._-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
const SAFE_IMAGE_DIMENSION_RE = /^\d{1,4}$/;
// 安全图片协议:http(s) + xdt-image/xdt-file(MCP Jira/Confluence 等合同会在 Markdown 里内嵌
// ![](xdt-image://...);xdt 系经 remote-media resolver 取图,非直连预览)+ cindy-media
// (媒体总仓迁移后生成图的新地址形态,同走 resolver)。⚠️ 不含桌面端的
// cindy-remote-media://:它不在手机 resolver 门(isPayloadDesktopLocalMediaUrl)内,点开必失败,
// 收进来只会产出死图(review 实捉),留作字面文本更诚实。
const SAFE_IMAGE_SRC_RE = /^(?:https?|xdt-image|xdt-file|cindy-media):\/\//i;

// 图片 URL 是否可直连预览(WebView/RN Image 直接加载):http(s) 可以;xdt 系 scheme 需要经
// device-link resolver 换成可下载地址,渲染层按占位 chip 展示、点开后由查看器完成解析。
export function isMobileMarkdownImageDirectUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

// 「只转独立单个 img」:整个 inline 段(段落/表格单元格/列表项)里只要出现任何非 img 的
// HTML 标签(<div>...</div> / <a>...</a> / </span> 等,含有文字夹在中间的包裹形态),该段的
// <img> 一律不转换,整段保持纯文本——对齐桌面端「嵌套/任意 HTML 留字面」的口径。
// 标签名字符集放宽到 \w 与 "."(<foo_bar> / <x.y> 这类 tag-like 包裹同样拒转,review 实捉绕过),
// 并支持命名空间段(<svg:svg>);标签名后必须紧跟空白、"/>" 或 ">",而 <https://example.com>
// 尖括号 URL 的 ":" 后是 "/",各分支都不命中,不会误判。
const NON_IMG_HTML_TAG_RE = /<\/?(?!img[\s/>])[A-Za-z][\w.-]*(?::[A-Za-z][\w.-]*)*(?:\s[^<>]*)?\/?>/i;
// 廉价短路:findNextInlineToken 对每个 token 都会调本函数,绝大多数消息段不含 <img,
// 不为它们付整串 replace 拷贝 + 两个拒转正则的开销(与 collectMobileMarkdownImages 的 hint 同套路)。
const HTML_IMG_HINT_RE = /<img/i;

// 跨块注释状态推进:按 <!-- / --> 出现顺序逐行配对(供 parseMobileMarkdown 携带跨段落状态)。
// 与 inline matcher 同口径,标记检测在 code-span 空白填充的副本上做:文档文本里的字面 `<!--`
// 不能把状态卡在"注释内"、吞掉后续段落的图片(review 实捉)。取舍:注释内部文本里的反引号
// 本无 code-span 语义,填充可能漏掉恰好被反引号夹住的 -->,该形态远罕于字面 `<!--` 的文档场景。
function advanceHtmlCommentState(line: string, inComment: boolean): boolean {
  const scan = blankCodeSpans(line);
  let pos = 0;
  let state = inComment;
  while (pos < scan.length) {
    if (state) {
      const close = scan.indexOf('-->', pos);
      if (close === -1) return true;
      state = false;
      pos = close + 3;
    } else {
      const open = scan.indexOf('<!--', pos);
      if (open === -1) return false;
      state = true;
      pos = open + 4;
    }
  }
  return state;
}

// code span 以等长空白填充(偏移保持):`<div>` / `<!--` 这类行内代码里的字面标记是代码文本、
// 不是任意 HTML,不参与拒转判定;等长填充让注释 span 的位置与原串上的匹配位置对齐。
function blankCodeSpans(input: string): string {
  return input.replace(/`[^`]*`/g, (span) => ' '.repeat(span.length));
}

// 无害行内标签白名单:<br> / <b> / <sub> 等格式类 void/inline 元素常被模型夹在正文里,
// 桌面端 skipHtml 逐节点丢弃它们、同段并列的 ![]() 仍独立渲染;移动端若因此整段拒转会把
// 本该显示的图误杀(review 实捉)。拒转判定前把它们等长空白填充(偏移保持)。
// 不含 <a>(可包裹语义)与 <span>/<div> 等容器标签——包裹形态仍按「任意 HTML」整段拒转。
// 标签名后必须紧跟空白、"/" 或 ">":\b 会让 <b-card> / <br-wrapper> 这类自定义包裹蒙混过关(review 实捉)。
const BENIGN_INLINE_TAG_RE = /<\/?(?:br|hr|b|i|em|strong|u|s|del|ins|sub|sup|small|mark|abbr|wbr)(?=[\s/>])[^<>]*\/?>/gi;

function blankBenignInlineTags(input: string): string {
  return input.replace(BENIGN_INLINE_TAG_RE, (tag) => ' '.repeat(tag.length));
}

// CommonMark 反斜杠转义:标记(![ 或 <)前有奇数个连续反斜杠即为字面转义,不作图片解析;
// 偶数个转义的是反斜杠本身,照常解析。
function isBackslashEscaped(input: string, index: number): boolean {
  let backslashes = 0;
  for (let probe = index - 1; probe >= 0 && input[probe] === '\\'; probe -= 1) backslashes += 1;
  return backslashes % 2 === 1;
}

// 守卫副本里把反斜杠转义的 "<" 空白化(偏移保持):\<div> 是 CommonMark 字面文本,
// 不是 raw HTML,不应触发整段拒转或开启注释 span(review 实捉)。
function blankEscapedAngles(input: string): string {
  let out = '';
  for (let cursor = 0; cursor < input.length; cursor += 1) {
    out += input[cursor] === '<' && isBackslashEscaped(input, cursor) ? ' ' : input[cursor];
  }
  return out;
}

// 注释 span 以等长空白填充(偏移保持):注释里的内容(含 <div> 等标签)只影响注释内的匹配,
// 不能触发整段拒转把注释外的合法图片一起隐藏(review 实捉);未闭合注释延伸到段尾。
function blankHtmlComments(input: string, startsInsideHtmlComment = false): string {
  let out = '';
  let cursor = 0;
  if (startsInsideHtmlComment) {
    // 段起点仍在上一块开启的注释里:开头到首个 -->(不存在则整段)都是注释内容。
    const close = input.indexOf('-->');
    const end = close === -1 ? input.length : close + 3;
    out += ' '.repeat(end);
    cursor = end;
  }
  while (cursor < input.length) {
    const open = input.indexOf('<!--', cursor);
    if (open === -1) {
      out += input.slice(cursor);
      break;
    }
    const close = input.indexOf('-->', open + 4);
    const end = close === -1 ? input.length : close + 3;
    out += input.slice(cursor, open) + ' '.repeat(end - open);
    cursor = end;
  }
  return out;
}

// doctype(<!DOCTYPE)/处理指令(<?xml)等非注释、非元素标记:出现即整段拒转(同「任意 HTML」)。
// 注释(<!--)单独按 span 处理(拒转判定前已被 blankHtmlComments 填充,不落入本正则)。
const NON_COMMENT_MARKUP_RE = /<!(?!--)|<\?/;

function matchHtmlImage(
  input: string,
  from: number,
  startsInsideHtmlComment = false,
): { index: number; end: number; inline: MobileMarkdownInline } | null {
  if (!HTML_IMG_HINT_RE.test(input)) return null;
  // codeBlanked 保留注释原文供 span 定位;guarded 再把注释也填充掉,拒转判定只看注释外的标记。
  // startsInsideHtmlComment: 段起点仍在上一块开启的注释里(<!-- 与 --> 之间隔空行被拆块),
  // 开头到首个 --> 同样按注释处理。
  const codeBlanked = blankEscapedAngles(blankCodeSpans(input));
  const guarded = blankBenignInlineTags(blankHtmlComments(codeBlanked, startsInsideHtmlComment));
  if (NON_IMG_HTML_TAG_RE.test(guarded) || NON_COMMENT_MARKUP_RE.test(guarded)) return null;
  HTML_IMG_TAG_RE.lastIndex = from;
  let match: RegExpExecArray | null;
  while ((match = HTML_IMG_TAG_RE.exec(input)) !== null) {
    // 注释里的 <img> 是被注释掉的内容,跳过;注释外的照常转换。
    if (isInsideHtmlComment(codeBlanked, match.index, startsInsideHtmlComment)) continue;
    // \<img ...> 转义的 < 使标签保持字面(与 Markdown 图片路径同口径,review 实捉)。
    if (isBackslashEscaped(input, match.index)) continue;
    const inline = parseHtmlImgTag(match[0]);
    if (inline) {
      return { index: match.index, end: match.index + match[0].length, inline };
    }
  }
  return null;
}

function parseHtmlImgTag(tag: string): MobileMarkdownImageInline | null {
  const inner = tag.replace(/^<img/i, '').replace(/\/?>$/, '');
  const attrs = new Map<string, string>();
  HTML_IMG_ATTR_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = HTML_IMG_ATTR_RE.exec(inner)) !== null) {
    attrs.set(match[1].toLowerCase(), decodeHtmlAttribute(match[2] ?? match[3] ?? match[4] ?? ''));
  }
  const src = attrs.get('src')?.trim();
  if (!src || !SAFE_IMAGE_SRC_RE.test(src)) return null;
  const inline: MobileMarkdownImageInline = {
    type: 'image',
    alt: attrs.get('alt') ?? '',
    url: normalizeImageUrlScheme(src),
  };
  const width = attrs.get('width');
  if (width && SAFE_IMAGE_DIMENSION_RE.test(width)) inline.width = Number(width);
  const height = attrs.get('height');
  if (height && SAFE_IMAGE_DIMENSION_RE.test(height)) inline.height = Number(height);
  return inline;
}

// 协议归一为小写(RFC 3986 scheme 大小写不敏感):下游 bridge 校验、图集匹配、
// 共享的 previewable 判断(isPayloadDirectPreviewableUrl 大小写敏感 startsWith)都按小写协议工作。
function normalizeImageUrlScheme(url: string): string {
  return url.replace(/^(https?|xdt-image|xdt-file|cindy-media):\/\//i, (matched) => matched.toLowerCase());
}

// Markdown 图片 ![alt](url):协议白名单与 HTML <img> 同一口径(SAFE_IMAGE_SRC_RE),大小写不敏感。
// URL 由 ")" 定界,支持一层平衡括号(![x](https://e.com/shot(1).png),CommonMark 语义);
// 不做尾部标点裁剪——那是裸 URL 场景的规则,这里边界已由定界符明确。
const MARKDOWN_IMAGE_RE = /!\[([^\]]*)\]\(((?:https?|xdt-image|xdt-file|cindy-media):\/\/(?:[^()\s]|\([^()\s]*\))+)\)/gi;
// 本地图片目标允许空格(模型常直接输出 `![图](docs/a b.png)`),但只在路径
// classifier 通过时接纳,不会把 javascript/mailto 等任意 scheme 变成图片。
// 尖括号是 CommonMark 对含空格 destination 的无歧义写法,产出的 url 去掉括号。
const LOCAL_MARKDOWN_IMAGE_RE = /!\[([^\]]*)\]\((<[^>\n]+>|(?:[^()\n]|\([^()\n]*\))+)\)/g;

/**
 * 本地 Markdown destination → 路径。保留模型常输出的裸空格路径，
 * 只剥离由空白分隔、位于末尾的标准可选 title（双引号 / 单引号 / 括号）。
 *
 * 图片（`![alt](dest "title")`）与链接（`[label](dest "title")`）共用这一套口径，
 * 两处的 destination 语法在 CommonMark 里本就相同；分开实现过一次，结果链接侧漏了
 * title 支持（PR #1144 review 实捉）。
 */
function parseLocalMarkdownDestination(raw: string): string {
  let destination = raw.trim();
  // ⚠️ 引号内的字符类**必须排除反斜杠**(`[^\n\\]` 而不是 `[^\n]`)。写成 `[^\n]` 时它与
  // `\\.` 两个分支在反斜杠上重叠 —— 一个 `\` 既能被 `[^\n]` 当 1 个字符吃、也能作为
  // `\\.` 的开头吃 2 个,于是一串反斜杠有 Fib(n) 种切法;引号未闭合时末尾的 `\2$` 必然
  // 失配,回溯会把所有切法枚举一遍,时间指数增长(实测:26 个反斜杠 8ms、34 个 75ms、
  // 38 个 518ms、42 个 3575ms,每 +4 慢约 7 倍)。触发面就是聊天正文里一条
  // `[x](a "\\\\…`,而本函数在渲染热路径上(图片与链接共用),手机端会冻住整个 JS 线程。
  // 两个分支互斥后即为线性(实测同样输入恒 0ms)。回归用例见 messageMarkdown.test.ts
  // 「title 剥离不得灾难性回溯」。(PR #1144 review 实捉;本 PR 把链接 destination 也接进
  // 本函数,阅读器 buildSelectableMarkdownHtml 同样走这条,所以接触面比原来的图片更广。)
  const quotedTitle = destination.match(/^(.*\S)[ \t]+(["'])(?:[^\n\\]|\\.)*\2$/);
  const parenthesizedTitle = destination.match(/^(.*\S)[ \t]+\([^()\n]*\)$/);
  destination = (quotedTitle?.[1] ?? parenthesizedTitle?.[1] ?? destination).trim();
  if (destination.startsWith('<') && destination.endsWith('>')) {
    return destination.slice(1, -1).trim();
  }
  return destination;
}

// HTML 注释里的 Markdown 图片是被注释掉的内容,不渲染(桌面端 skipHtml 同样留字面/丢弃);
// 只压制落在注释 span 内的匹配,注释之外的合法图片不受影响(与 matchHtmlImage 的整段拒转不同,
// 因为 remark 语义下注释不会"包裹"住整段的独立 Markdown 图片)。未闭合注释视为延伸到段尾。
// 标签标记(`<span title="…">`、`</div>`)的字符区间。用于把裸路径 matcher 挡在标签
// **标记内部**之外:命中属性值会把整段拆成 `<span title="` + 链接 + `">x</span>`,那是在
// 破坏标签结构,而不是给正文加链接(PR #1144 review 实捉)。
//
// 只挡标记内部,**不挡元素内容**:`<div>src/App.tsx</div>` 里的路径与既有的
// strong / inlineCode / 裸 URL matcher 行为一致(它们同样会在字面 HTML 的内容里解析,
// 实测过),单独把裸路径排除反而会造成本文件内部不一致。
// 只认真正像标签的形态,`a < b` 这类散文里的 `<` 不构成区间。
//
// 属性段是**引号感知**的:带引号的属性值里出现 `>` 完全合法(`<span title="a > b">`),
// 若按 `[^<>]*` 扫,区间会在属性内的 `>` 提前收尾,后面的路径重新暴露给裸路径 matcher,
// 于是这道守卫在它声称保护的一部分属性值上失效(PR #1144 review 实捉:守卫的覆盖面
// 小于它声称的范围)。故属性段按「双引号串 | 单引号串 | 非引号非尖括号字符」逐段吃。
// 未闭合引号(`<span title="a > b`)整体不成立区间 —— 那已是坏 HTML,退化为不识别,
// 与本条守卫加入前的行为一致,不额外造新语义。
const HTML_TAG_SPAN_RE =
  /<\/?[A-Za-z][\w.-]*(?::[A-Za-z][\w.-]*)*(?:\s(?:"[^"]*"|'[^']*'|[^<>"'])*)?\/?>/g;

function isInsideHtmlTagMarkup(input: string, index: number): boolean {
  if (!input.includes('<')) return false;
  HTML_TAG_SPAN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = HTML_TAG_SPAN_RE.exec(input)) !== null) {
    if (index >= m.index && index < m.index + m[0].length) return true;
    if (m.index > index) return false;
  }
  return false;
}

function isInsideHtmlComment(input: string, index: number, startsInsideHtmlComment = false): boolean {
  let cursor = 0;
  if (startsInsideHtmlComment) {
    const close = input.indexOf('-->');
    const end = close === -1 ? input.length : close + 3;
    if (index < end) return true;
    cursor = end;
  }
  while (cursor < input.length) {
    const open = input.indexOf('<!--', cursor);
    if (open === -1 || open > index) return false;
    const close = input.indexOf('-->', open + 4);
    const end = close === -1 ? input.length : close + 3;
    if (index < end) return true;
    cursor = end;
  }
  return false;
}

function matchMarkdownImage(
  input: string,
  from: number,
  startsInsideHtmlComment = false,
): { index: number; end: number; inline: MobileMarkdownInline } | null {
  if (!input.includes('![')) return null;
  // 拒转判定统一在 code-span 空白填充(偏移保持)的副本上做,行内代码里的字面 <div> / <!--
  // 不参与判定(review 实捉:字面 <!-- 会把段尾全部毒化成"注释内"、误杀合法图片)。
  const guarded = blankEscapedAngles(blankCodeSpans(input));
  // 与 raw <img> 同口径:段内出现任何非 img HTML 标签(<div>...![图]...</div> 的块级包裹)
  // 或 doctype / 处理指令,Markdown 图片同样整段拒转——桌面端 skipHtml 会把这类 raw HTML
  // 块整体丢弃,其中的图片不该在移动端被渲染出来。注释按 span 压制(其内容先空白填充再喂给
  // 标签守卫,注释里的 <div> 不触发整段拒转),注释外合法图不受影响。
  const guardedNoComments = blankBenignInlineTags(blankHtmlComments(guarded, startsInsideHtmlComment));
  if (NON_IMG_HTML_TAG_RE.test(guardedNoComments) || NON_COMMENT_MARKUP_RE.test(guardedNoComments)) return null;
  const matchers: Array<{ re: RegExp; local: boolean }> = [
    { re: MARKDOWN_IMAGE_RE, local: false },
    { re: LOCAL_MARKDOWN_IMAGE_RE, local: true },
  ];
  const matches: Array<{ match: RegExpExecArray; url: string }> = [];
  for (const matcher of matchers) {
    matcher.re.lastIndex = from;
    let candidate: RegExpExecArray | null;
    while ((candidate = matcher.re.exec(input)) !== null) {
      const rawUrl = matcher.local ? parseLocalMarkdownDestination(candidate[2]) : candidate[2];
      if (matcher.local && !classifyChatPathLinkTarget(rawUrl)) continue;
      // 当前 matcher 的第一个正则命中可能只是注释/转义里的示例;必须继续 exec,
      // 否则同段后面的合法图片会被丢掉(review P2)。
      if (isInsideHtmlComment(guarded, candidate.index, startsInsideHtmlComment)) continue;
      if (isBackslashEscaped(input, candidate.index)) continue;
      matches.push({ match: candidate, url: rawUrl });
      break;
    }
  }
  matches.sort((a, b) => a.match.index - b.match.index || a.match[0].length - b.match[0].length);
  for (const { match, url } of matches) {
    return {
      index: match.index,
      end: match.index + match[0].length,
      inline: {
        type: 'image',
        alt: match[1],
        url: SAFE_IMAGE_SRC_RE.test(url) ? normalizeImageUrlScheme(url) : url,
      },
    };
  }
  return null;
}

function decodeHtmlAttribute(value: string): string {
  return value.replace(/&(amp|quot|#39|apos|lt|gt);/g, (entity, name: string) => {
    switch (name) {
      case 'amp':
        return '&';
      case 'quot':
        return '"';
      case '#39':
      case 'apos':
        return "'";
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      default:
        return entity;
    }
  });
}

function pushText(out: MobileMarkdownInline[], text: string): void {
  if (!text) return;
  const last = out[out.length - 1];
  if (last?.type === 'text') {
    last.text += text;
  } else {
    out.push({ type: 'text', text });
  }
}

function trimUrlPunctuation(url: string): string {
  return url.replace(/[),.;:!?]+$/g, '');
}

function parseTableBlock(lines: readonly string[], index: number): ParsedTableBlock | null {
  const header = parseTableRow(lines[index]);
  if (!isTableDataRow(lines[index]) || header.length < 2) return null;

  if (isTableSeparator(lines[index + 1] ?? '')) {
    const rows: ParsedTableBlock['rows'] = [];
    let rowIndex = index + 2;
    while (rowIndex < lines.length && isTableDataRow(lines[rowIndex])) {
      rows.push({
        lineIndex: rowIndex,
        cells: parseTableRow(lines[rowIndex]),
      });
      rowIndex += 1;
    }
    return {
      header,
      rows,
      endIndex: rowIndex - 1,
    };
  }

  return parseLooseTableBlock(lines, index, header);
}

function parseLooseTableBlock(
  lines: readonly string[],
  index: number,
  header: string[],
): ParsedTableBlock | null {
  if (!isLooseTableDataRow(lines[index])) return null;
  const columnCount = header.length;
  const rows: ParsedTableBlock['rows'] = [];
  let rowIndex = index + 1;
  while (rowIndex < lines.length && isLooseTableDataRow(lines[rowIndex])) {
    const cells = parseTableRow(lines[rowIndex]);
    if (cells.length !== columnCount) break;
    rows.push({
      lineIndex: rowIndex,
      cells,
    });
    rowIndex += 1;
  }
  if (rows.length === 0) return null;
  return {
    header,
    rows,
    endIndex: rowIndex - 1,
  };
}

function isTableDataRow(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.includes('|') && !isTableSeparator(trimmed);
}

function isLooseTableDataRow(line: string): boolean {
  const cells = parseTableRow(line);
  return isTableDataRow(line) && cells.length >= 2 && cells.every((cell) => cell.length > 0);
}

function isTableSeparator(line: string): boolean {
  const cells = parseTableRow(line);
  if (cells.length < 2) return false;
  return cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()));
}

function parseTableRow(line: string): string[] {
  let trimmed = line.trim();
  if (trimmed.startsWith('|')) trimmed = trimmed.slice(1);
  if (endsWithUnescapedPipe(trimmed)) trimmed = trimmed.slice(0, -1);
  const cells: string[] = [];
  let cell = '';
  for (let index = 0; index < trimmed.length; index++) {
    const char = trimmed[index];
    if (char === '\\' && trimmed[index + 1] === '|') {
      cell += '|';
      index += 1;
      continue;
    }
    if (char === '|') {
      cells.push(cell.trim());
      cell = '';
      continue;
    }
    cell += char;
  }
  cells.push(cell.trim());
  return cells;
}

function endsWithUnescapedPipe(value: string): boolean {
  if (!value.endsWith('|')) return false;
  let backslashCount = 0;
  for (let index = value.length - 2; index >= 0 && value[index] === '\\'; index--) {
    backslashCount += 1;
  }
  return backslashCount % 2 === 0;
}
