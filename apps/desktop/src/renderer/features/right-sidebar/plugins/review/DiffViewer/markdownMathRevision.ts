/**
 * markdownMathRevision — 含公式块的「分段修订」注入。
 *
 * 通用词级注入（整块 `diffWordsWithSpace` + CriticMarkup）在含 `$...$` 的块上会失效：
 * 标记一旦落进公式就会被 remarkMath 吃成 math 节点，校验必然失败 → 整块退回块级
 * 装饰（整块删除线 + 整块下划线），用户看不到「公式里到底改了哪个符号」。
 *
 * 这里按「文本段 / 公式段」把源码切开分别处理：
 *  - 文本段：沿用 CriticMarkup 词级标记；
 *  - 公式段：配对的两版公式做源码级 diff，删除 / 新增片段用 KaTeX 自己画的线表达
 *    （`\sout{...}` / `\underline{...}`），颜色走 `\htmlClass{...}` + CSS token，
 *    这样 light / dark 都跟着主题走；
 *  - 公式内注入必须通过 KaTeX 渲染校验（结构被 diff 切断时会渲染失败），失败则
 *    降级为「整公式标记」（标记在公式外，插件能折叠），再失败保留新版本原文。
 *
 * 片段边界来自 mdast 的 `position.offset`（`inlineMath` / `math` 节点），不是正则
 * 猜 `$` —— 行内代码、`$$` 块、`价 $5 到 $10` 这类文本都不会被误切。
 */

import { diffArrays, diffWordsWithSpace } from 'diff';
import katex from 'katex';
import type { Root, RootContent } from 'mdast';
import remarkParse from 'remark-parse';
import { unified } from 'unified';

import { normalizeMathDelimiters } from '@cindy/maker-shared/math-markdown';
import { MARKDOWN_REMARK_PLUGINS } from '@/components/chat/markdownPluginPipeline';
import {
  hasUnconsumedReviewMarks,
  remarkReviewAnnotations,
} from '@/components/chat/remarkReviewAnnotations';

import {
  parseRevisionTree,
  REVISION_MAX_SOURCE_CHARS,
  taskMarkers,
  topLevelSignature,
} from './markdownRevision';

/**
 * 公式内的修订标记用 KaTeX **内建**命令表达：
 *  - 删除 → `\textcolor{#c0ffee}{\sout{...}}`（删除线，颜色由 rehype 插件换成 `--diff-del-fg`）
 *  - 新增 → `\textcolor{#facade}{\underline{...}}`（下划线，同理换成 `--diff-add-fg`）
 *
 * 修定粒度（用户裁决）：**公式级**——公式内部无论改了多少，都只标记整个公式：
 * 旧公式整体标删除、新公式整体标新增；既不做整块（段落级）装饰，也不深入到公式内部的
 * 单字符 diff。公式没变则完全不动。
 *
 * 上色方式（颜色必须与普通字词、已有 git diff 完全一致）：公式内用 KaTeX 内建命令写一个
 * **哨兵色**（见下），再由 rehype 插件 rehypeReviewMathMarks 把它换成 `<del>` / `<ins>`
 * 的 diff token 类；globals.css 里还保留一层属性选择器作兜底。
 *
 * ⚠️ 改动前先读的三条：
 *  1. 不要用 `\htmlClass{...}{...}`：它需要 KaTeX 的 `trust`，而 rehype-katex 既不透传
 *     trust（即使传了白名单也不生效），默认下会直接渲染成字面文本。
 *  2. 颜色不能用 `var(--diff-del-fg)`：KaTeX 会直接报 `Invalid color`。
 *  3. 注入的标记**不能用 `red` / `green` 这类通用颜色**：审查文档里作者自己写的
 *     `\textcolor{red}{...}` 是合法 LaTeX，插件分不清「我注入的修订」和「作者原本的
 *     颜色」，会把没改动的红色内容凭空标成删除。只能用下面这种任何真实文档都
 *     不可能出现的哨兵值。
 */
/**
 * 修订标记的**哨兵色**：不是给用户看的颜色，只是注入标记的锚点。
 * 真实颜色由 rehypeReviewMathMarks 换成 `--diff-del-fg` / `--diff-add-fg`；
 * 万一插件未生效，globals.css 里的同名兜底规则也会把它换成主题 token。
 * 选用词形 hex（coffee / facade）只是为了好认，不代表任何语义。
 */
const MATH_DEL_COLOR = '#c0ffee';
const MATH_ADD_COLOR = '#facade';
const BRACES = /[{}]/;

/** 只 parse 的解析器（transformer 不会被 runSync 触发），用来拿公式节点的源码位置。 */
const parser = unified().use(remarkParse).use(MARKDOWN_REMARK_PLUGINS);

interface SourcePiece {
  /** text = 普通文本；math = 公式；code = 行内代码跨度（两者都是**原子**，标记只能包在外面）。 */
  kind: 'text' | 'math' | 'code';
  value: string;
  /** 块级公式（`$$...$$`）：KaTeX 校验时要按 display 模式渲染。 */
  display: boolean;
}

interface SpanRange {
  start: number;
  end: number;
  kind: 'math' | 'code';
  display: boolean;
}

type PiecePair =
  | { kind: 'equal'; after: SourcePiece }
  | { kind: 'add'; after: SourcePiece }
  | { kind: 'remove'; before: SourcePiece }
  | { kind: 'revise'; before: SourcePiece; after: SourcePiece };

/**
 * 按公式节点把源码切成 text / math 片段。返回 null 表示解析失败或出现嵌套重叠
 * （异常输入），调用方回退。
 */
/**
 * 按**原子节点**（公式、行内代码）把源码切成 text / math / code 片段。
 * 返回 null 表示解析失败或出现嵌套重叠（异常输入），调用方回退。
 */
function splitAtomicPieces(source: string): SourcePiece[] | null {
  let tree: Root;
  try {
    tree = parser.parse(source) as Root;
  } catch {
    return null;
  }
  const ranges: SpanRange[] = [];
  collectSpanRanges(tree, ranges);
  ranges.sort((a, b) => a.start - b.start);

  const pieces: SourcePiece[] = [];
  let cursor = 0;
  for (const range of ranges) {
    if (range.start < cursor || range.end <= range.start) return null;
    if (range.start > cursor) {
      pieces.push({ kind: 'text', value: source.slice(cursor, range.start), display: false });
    }
    pieces.push({
      kind: range.kind,
      value: source.slice(range.start, range.end),
      display: range.display,
    });
    cursor = range.end;
  }
  if (cursor < source.length) {
    pieces.push({ kind: 'text', value: source.slice(cursor), display: false });
  }
  return pieces;
}

function collectSpanRanges(node: Root | RootContent, out: SpanRange[]): void {
  const type = (node as { type?: string }).type;
  if (type === 'inlineMath' || type === 'math' || type === 'inlineCode') {
    const position = (node as { position?: { start?: { offset?: number }; end?: { offset?: number } } })
      .position;
    const start = position?.start?.offset;
    const end = position?.end?.offset;
    if (typeof start === 'number' && typeof end === 'number' && end > start) {
      out.push({ start, end, kind: type === 'inlineCode' ? 'code' : 'math', display: type === 'math' });
    }
    return;
  }
  const children = (node as { children?: unknown[] }).children;
  if (!Array.isArray(children)) return;
  for (const child of children) collectSpanRanges(child as RootContent, out);
}

/** 原子片段（公式 / 行内代码）才是这条路径的服务对象；纯文本块交给通用词级。 */
const hasAtomicPiece = (pieces: readonly SourcePiece[]): boolean =>
  pieces.some((piece) => piece.kind !== 'text');

/** 配对：先按位置逐段（kind 序列一致时最精确），否则用 diff 对齐片段序列。 */
function alignPieces(
  before: readonly SourcePiece[],
  after: readonly SourcePiece[],
): PiecePair[] {
  if (
    before.length === after.length &&
    before.every((piece, index) => piece.kind === after[index].kind)
  ) {
    return before.map((piece, index) => {
      const next = after[index];
      return piece.value === next.value
        ? { kind: 'equal', after: next }
        : { kind: 'revise', before: piece, after: next };
    });
  }
  return alignPiecesByDiff(before, after);
}

function alignPiecesByDiff(
  before: readonly SourcePiece[],
  after: readonly SourcePiece[],
): PiecePair[] {
  const key = (piece: SourcePiece) => `${piece.kind}\u0000${piece.value}`;
  const parts = diffArrays(before.map(key), after.map(key));
  const pairs: PiecePair[] = [];
  const pendingRemoved: SourcePiece[] = [];
  let beforeIndex = 0;
  let afterIndex = 0;

  const flushRemoved = () => {
    for (const piece of pendingRemoved) pairs.push({ kind: 'remove', before: piece });
    pendingRemoved.length = 0;
  };

  for (const part of parts) {
    if (part.removed) {
      for (let i = 0; i < part.count; i += 1) pendingRemoved.push(before[beforeIndex + i]);
      beforeIndex += part.count;
      continue;
    }
    if (part.added) {
      const added = after.slice(afterIndex, afterIndex + part.count);
      // 同 kind 的相邻 removed / added 按顺序配对（公式改了内容仍算同一段）。
      for (let i = 0; i < added.length; i += 1) {
        const previous = pendingRemoved.shift();
        if (previous && previous.kind === added[i].kind) {
          pairs.push({ kind: 'revise', before: previous, after: added[i] });
        } else {
          if (previous) pairs.push({ kind: 'remove', before: previous });
          pairs.push({ kind: 'add', after: added[i] });
        }
      }
      afterIndex += part.count;
      continue;
    }
    flushRemoved();
    for (let i = 0; i < part.count; i += 1) {
      pairs.push({ kind: 'equal', after: after[afterIndex + i] });
    }
    afterIndex += part.count;
    beforeIndex += part.count;
  }
  flushRemoved();
  return pairs;
}

/** 文本段的词级标记（与通用路径同规则：含花括号的片段放弃标记）。 */
function reviseTextPiece(before: string, after: string): string | null {
  // 含花括号时标记无法安全放置（与 CriticMarkup 定界符自由混排会破坏折叠/结构）。
  // 这里**必须失败**而不是返回 after：校验只比 after 侧签名，直接返回 after 会让删除侧
  // 内容凭空消失、改动在预览里完全不可见。失败后调用方回退整块装饰，改动仍然可见。
  if (BRACES.test(before) || BRACES.test(after)) return null;
  let out = '';
  let marked = false;
  for (const part of diffWordsWithSpace(before, after)) {
    if (!part.added && !part.removed) {
      out += part.value;
      continue;
    }
    if (part.value.trim() === '') {
      out += part.value;
      continue;
    }
    out += part.added ? `{++${part.value}++}` : `{--${part.value}--}`;
    marked = true;
  }
  return marked ? out : after;
}

/**
 * 公式源码（含分隔符）→ 内部 LaTeX；形状不认识时返回 null。
 */
function mathInner(piece: SourcePiece): string | null {
  const display = /^\$\$([\s\S]*)\$\$$/.exec(piece.value);
  if (display) return display[1];
  const bracket = /^\\\[([\s\S]*)\\\]$/.exec(piece.value);
  if (bracket) return bracket[1];
  const inline = /^\$([\s\S]*)\$$/.exec(piece.value);
  if (inline) return inline[1];
  const paren = /^\\\(([\s\S]*)\\\)$/.exec(piece.value);
  if (paren) return paren[1];
  return null;
}

/**
 * 用原公式的分隔符形态把新内容包回去。
 *
 * 块级公式要特别处理：remark-math 要求 `$$` 独占行（后面紧跟内容就不成块级公式了，
 * 渲染时会变成错位的 katex-error），所以包装时必须保留原文 `$$` 与内容之间的换行 / 空白。
 */
function wrapMath(marked: string, piece: SourcePiece): string | null {
  const display = /^(\$\$)([\s\S]*)(\$\$)$/.exec(piece.value);
  if (display) {
    const leading = /^\s*/.exec(display[2])?.[0] ?? '';
    const trailing = /\s*$/.exec(display[2])?.[0] ?? '';
    return `${display[1]}${leading}${marked}${trailing}${display[3]}`;
  }
  const bracket = /^(\\\[)([\s\S]*)(\\\])$/.exec(piece.value);
  if (bracket) {
    const leading = /^\s*/.exec(bracket[2])?.[0] ?? '';
    const trailing = /\s*$/.exec(bracket[2])?.[0] ?? '';
    return `${bracket[1]}${leading}${marked}${trailing}${bracket[3]}`;
  }
  const inline = /^(\$)([\s\S]*)(\$)$/.exec(piece.value);
  if (inline) return `${inline[1]}${marked}${inline[3]}`;
  const paren = /^(\\\()([\s\S]*)(\\\))$/.exec(piece.value);
  if (paren) return `${paren[1]}${marked}${paren[3]}`;
  return null;
}

function isRenderableMath(inner: string, display: boolean): boolean {
  try {
    katex.renderToString(inner, { throwOnError: true, strict: 'ignore', displayMode: display });
    return true;
  } catch {
    return false;
  }
}

/**
 * 未被配对的公式（整公式新增 / 删除）：在公式**内部**包裹。
 *
 * 线由 KaTeX 自己画（`\sout` / `\underline`）——`text-decoration` 传不过 KaTeX 的
 * 原子内联盒，靠外层 <del>/<ins> 的 CSS 画不出线，只在整块装饰里才看得见。
 * 上色则交给 rehype 插件（它会把这些内联关键字色换成 diff token 类）。
 */
function markWholeMath(piece: SourcePiece, kind: 'insert' | 'delete'): string {
  const inner = mathInner(piece);
  if (inner !== null) {
    const wrapped =
      kind === 'insert'
        ? `\\textcolor{${MATH_ADD_COLOR}}{\\underline{${inner}}}`
        : `\\textcolor{${MATH_DEL_COLOR}}{\\sout{${inner}}}`;
    if (isRenderableMath(wrapped, piece.display)) {
      const out = wrapMath(wrapped, piece);
      if (out !== null) return out;
    }
  }
  // 内包裹不成立且含花括号（用不了 CriticMarkup）时一律保留原文：宁可不标注，
  // 也不能让删除侧内容凭空消失（文本段的校验只比 after 侧，删掉是查不出来的）。
  if (BRACES.test(piece.value)) return piece.value;
  return kind === 'insert' ? `{++${piece.value}++}` : `{--${piece.value}--}`;
}

/**
 * 配对公式的公式级修订：把「旧公式（删除线）+ 新公式（下划线）」放进**同一个公式**内。
 *
 * 行内与块级走同一条路：
 *  - 线：KaTeX 内建 `\sout` / `\underline` —— 它靠 inline-table 原子盒渲染，
 *    `text-decoration` 传不进去，靠外层 <del>/<ins> 的 CSS 行内公式是看不到线的；
 *  - 色：rehypeReviewMathMarks 把 `\textcolor` 写下的哨兵色换成 diff token 类，
 *    与普通字词、行内标记完全同源。
 *
 * 合并成一个公式也避开了 `$a$$b$` 这类定界符歧义（会被 remark-math 当成 $$ 块级定界符，
 * 实测直接变 katex-error），块结构也保持不变。
 *
 * 返回 null = 「这处公式无法安全标记」：调用方必须整块放弃公式路径、回退到块级装饰。
 * 不能退化成「旧公式一段 + 新公式一段」——两个相邻行内公式拼起来就是 `$A$$B$`，
 * 正是上面那个会渲染报错的形态。
 */
function reviseMathPiece(before: SourcePiece, after: SourcePiece): string | null {
  const beforeInner = mathInner(before);
  const afterInner = mathInner(after);
  if (beforeInner === null || afterInner === null) return null;
  const marked =
    `\\textcolor{${MATH_DEL_COLOR}}{\\sout{${beforeInner}}}` +
    `\\textcolor{${MATH_ADD_COLOR}}{\\underline{${afterInner}}}`;
  if (!isRenderableMath(marked, after.display)) return null;
  return wrapMath(marked, after) ?? null;
}

/** CriticMarkup 定界符：片段内容里出现它们会让折叠器错乱，碰到就放弃标记。 */
const MARK_DELIMITER_PATTERN = /\{\+\+|\+\+\}|\{--|--\}/;

/**
 * 行内代码跨度（原子）：标记只能包在**整段外面**。
 *
 * 插进反引号里面会让标记变成代码字面量、代码格式也跟着消失；所以粒度到
 * 「整个代码跨度」为止（与公式级同一纪律：旧跨度整段删除线 + 新跨度整段下划线）。
 * 内容里出现 CriticMarkup 定界符时放弃标记（宁可不标也不让折叠器错乱）。
 */
function markCodePiece(piece: SourcePiece, kind: 'insert' | 'delete'): string {
  if (MARK_DELIMITER_PATTERN.test(piece.value)) return piece.value;
  return kind === 'insert' ? `{++${piece.value}++}` : `{--${piece.value}--}`;
}

/** 配对的代码跨度：旧跨度整段删除 + 新跨度整段新增（不做跨度内字符级 diff）。 */
function reviseCodePiece(before: SourcePiece, after: SourcePiece): string | null {
  if (MARK_DELIMITER_PATTERN.test(before.value) || MARK_DELIMITER_PATTERN.test(after.value)) {
    return null;
  }
  return `{--${before.value}--}{++${after.value}++}`;
}

/**
 * 未被配对的文本片段（整段新增 / 删除）。纯空白不标记：公式块前后的换行属于
 * 结构分隔，包上标记会跟邻块粘连、触发跨块残留。
 *
 * ⚠️ 但**绝不能丢掉字符**（删除侧曾是 `''`）：两个公式之间只隔一个换行时，丢掉
 * 换行会让 `$$…$$` 的闭合 `$$` 与下一个公式的开 `$` 粘成 `$$$`，整段被 remark-math
 * 当成一个坏公式 → 退化成字面文本、哨兵 LaTeX 直接显示给用户，而校验看不出问题。
 */
function markTextPiece(piece: SourcePiece, kind: 'insert' | 'delete'): string {
  if (piece.value.trim() === '') return piece.value;
  // 内包裹不成立且含花括号（用不了 CriticMarkup）时一律保留原文：宁可不标注，
  // 也不能让删除侧内容凭空消失（文本段的校验只比 after 侧，删掉是查不出来的）。
  if (BRACES.test(piece.value)) return piece.value;
  return kind === 'insert' ? `{++${piece.value}++}` : `{--${piece.value}--}`;
}

function markPiece(piece: SourcePiece, kind: 'insert' | 'delete'): string | null {
  if (piece.kind === 'math') return markWholeMath(piece, kind);
  if (piece.kind === 'code') return markCodePiece(piece, kind);
  return markTextPiece(piece, kind);
}

/**
 * 两个**行内公式输出**之间的接缝合并。
 *
 * `$A$$B$`（两个行内公式直接相接）会被 remark-math 当成 `$$` 块级定界符，内容里残留的
 * `$` 让 KaTeX 直接报错（渲染成错误占位）。拼接不同来源的片段时会撞上，例如
 * 「旧公式配对改写 + 相邻的另一个旧公式整块删除」。合并成一个公式即可。
 *
 * 只在**确知两侧都是公式输出**的接缝上做（由调用方保证），不扫全串：早期的全局正则
 * 会把源码自带的 `$$` 相邻（货币文本、转义美元）一并改写，静默篡改未改动内容。
 * 条件也排除了 `$$`（块级定界符）：那类接缝不能靠去定界符合并。
 */
function mergeInlineMathSeam(left: string, right: string): string | null {
  if (!left.endsWith('$') || left.endsWith('$$')) return null;
  if (!right.startsWith('$') || right.startsWith('$$')) return null;
  return left.slice(0, -1) + right.slice(1);
}

/**
 * 一段输出是否是**行内公式**（`$…$`，不是 `$$…$$`）。用输出文本形态判定，因为
 * `markWholeMath` 等函数在包裹失败时会回退成 CriticMarkup（`{--$x$--}`），那种形态
 * 不触发下面的数字相邻降级。
 */
function isInlineFormulaOutput(text: string): boolean {
  return text.startsWith('$') && !text.startsWith('$$') && text.endsWith('$') && !text.endsWith('$$');
}

/**
 * 按段拼装注入源：记录「上一段是否公式输出」，只在公式接缝上做相邻合并，并拦截
 * 一个**渲染期才发作**的降级陷阱。
 *
 * ⚠️ 数字相邻陷阱：我方注入的行内公式若紧贴数字（`$…$10` / `5$…$`），渲染链的
 * `remarkStrictInlineMath`（规则：闭合 `$` 后紧跟数字）会把整条公式降级回字面文本，
 * 哨兵 LaTeX 直接展示给用户。mdast 里它仍是 `inlineMath` 节点，所以基于解析树的
 * 守卫（mathMarksAreIntact）看不见这个形态 —— 只能在拼装阶段按字符相邻直接拒绝，
 * 让调用方回退到通用词级路径。
 */
class InjectedSourceBuilder {
  private out = '';
  private previousIsMath = false;
  private previousInlineFormula = false;
  private unsafeAdjacency = false;

  append(text: string, isMath: boolean): void {
    const inlineFormula = isMath && isInlineFormulaOutput(text);
    if (inlineFormula && /\d$/.test(this.out)) this.unsafeAdjacency = true;
    if (this.previousInlineFormula && /^\d/.test(text)) this.unsafeAdjacency = true;
    if (isMath && this.previousIsMath) {
      const merged = mergeInlineMathSeam(this.out, text);
      if (merged !== null) {
        this.out = merged;
        this.previousIsMath = true;
        this.previousInlineFormula = true;
        return;
      }
    }
    this.out += text;
    this.previousIsMath = isMath;
    this.previousInlineFormula = inlineFormula;
  }

  hasUnsafeAdjacency(): boolean {
    return this.unsafeAdjacency;
  }

  toString(): string {
    return this.out;
  }
}

function buildInjectedSource(pairs: readonly PiecePair[]): string | null {
  const builder = new InjectedSourceBuilder();
  for (const pair of pairs) {
    if (pair.kind === 'equal') {
      builder.append(pair.after.value, false);
      continue;
    }
    if (pair.kind === 'add') {
      const marked = markPiece(pair.after, 'insert');
      if (marked === null) return null;
      builder.append(marked, pair.after.kind === 'math');
      continue;
    }
    if (pair.kind === 'remove') {
      const marked = markPiece(pair.before, 'delete');
      if (marked === null) return null;
      builder.append(marked, pair.before.kind === 'math');
      continue;
    }
    if (pair.before.kind === 'math' && pair.after.kind === 'math') {
      const revised = reviseMathPiece(pair.before, pair.after);
      if (revised === null) return null;
      builder.append(revised, true);
      continue;
    }
    if (pair.before.kind === 'code' && pair.after.kind === 'code') {
      const revised = reviseCodePiece(pair.before, pair.after);
      if (revised === null) return null;
      builder.append(revised, false);
      continue;
    }
    const revisedText = reviseTextPiece(pair.before.value, pair.after.value);
    if (revisedText === null) return null;
    builder.append(revisedText, false);
  }
  // 行内公式紧贴数字 → 渲染链会把它降级成字面文本（哨兵 LaTeX 泄漏），整块放弃公式路径。
  return builder.hasUnsafeAdjacency() ? null : builder.toString();
}

function collectionMathValues(node: unknown, out: Array<{ value: string; display: boolean }>): void {
  const type = (node as { type?: string }).type;
  if (type === 'inlineMath' || type === 'math') {
    out.push({
      value: (node as { value?: string }).value ?? '',
      display: type === 'math',
    });
    return;
  }
  const children = (node as { children?: unknown[] }).children;
  if (!Array.isArray(children)) return;
  for (const child of children) collectionMathValues(child, out);
}

/**
 * 我方注入的标记命令。哨兵检查只认这个**命令形态**：作者原文里裸写的 `#c0ffee`
 * （色值教程、设计文档很现实）不算标记，否则正常文档会被误判成泄漏而丢掉标注。
 */
const MATH_MARK_COMMAND_PATTERN = /\\textcolor\s*\{\s*#(?:c0ffee|facade)\s*\}/gi;

function countMathMarkers(node: unknown, inside: { math: number; other: number }): void {
  const type = (node as { type?: string }).type;
  const value = (node as { value?: unknown }).value;
  if (typeof value === 'string') {
    const hits = value.match(MATH_MARK_COMMAND_PATTERN)?.length ?? 0;
    if (hits > 0) {
      if (type === 'inlineMath' || type === 'math') inside.math += hits;
      else inside.other += hits;
    }
  }
  const children = (node as { children?: unknown[] }).children;
  if (Array.isArray(children)) {
    for (const child of children) countMathMarkers(child, inside);
  }
}

/**
 * 修订标记完好性：本次注入的每条 `\textcolor{<哨兵>}{...}` 都必须仍活在该块的**公式节点**里。
 *
 * 掉进文本 / 代码节点（或干脆没落到任何公式节点）意味着公式结构已被破坏：那些哨兵
 * LaTeX 会以字面文本直接显示给用户，而签名校验、标记残留检查都看不见。段落路径与
 * 表格路径共用这条守卫——表格单元格里 `$5和$10` 这种形态会被 remarkStrictInlineMath
 * 降级回字面文本，只有它能拦住。
 */
export function mathMarksAreIntact(injected: string, tree: Root): boolean {
  const expected = injected.match(MATH_MARK_COMMAND_PATTERN)?.length ?? 0;
  if (expected === 0) return true;
  const counts = { math: 0, other: 0 };
  countMathMarkers(tree, counts);
  if (counts.other > 0) return false;
  return counts.math >= expected;
}

/**
 * 注入后的每个公式节点都必须「结构完好且能渲染」。
 *
 * 光看 remark 层解析成功是不够的：相邻公式被 remark-math 吞成一个 `$$` 节点时，
 * 公式内容里会残留 `$`，KaTeX 在 rehype 阶段才报错 —— 那种坏源码会以「解析成功」
 * 的姿态骗过签名校验，最后以 katex-error 乱码的形式泄漏给用户。这里逐段做一次
 * KaTeX 渲染（与渲染链同一入口）把它提前拦下。
 */
function mathNodesAreRenderable(tree: Root, injected: string): boolean {
  if (!mathMarksAreIntact(injected, tree)) return false;
  const nodes: Array<{ value: string; display: boolean }> = [];
  collectionMathValues(tree, nodes);
  return nodes.every(
    (node) => !node.value.includes('$') && isRenderableMath(node.value, node.display),
  );
}

function validateMathRevision(injected: string, reference: string): boolean {
  const injectedTree = parseRevisionTree(injected);
  if (!injectedTree) return false;
  remarkReviewAnnotations()(injectedTree);
  if (hasUnconsumedReviewMarks(injectedTree)) return false;
  const referenceTree = parseRevisionTree(reference);
  if (!referenceTree) return false;
  if (topLevelSignature(injectedTree) !== topLevelSignature(referenceTree)) return false;
  return mathNodesAreRenderable(injectedTree, injected);
}

/**
 * 一段行内内容（文本 + 行内公式混排）的**配对改写**：文本段走 CriticMarkup、公式段走
 * 公式内标记。表格单元格也用它（整格改写时公式要能带线）。
 * 返回 null 表示无法安全标记，调用方应保留新版本原文。
 */
export function reviseInlineMixed(before: string, after: string): string | null {
  const normalizedBefore = normalizeMathDelimiters(before, { preserveLineCount: false });
  const normalizedAfter = normalizeMathDelimiters(after, { preserveLineCount: false });
  const beforePieces = splitAtomicPieces(normalizedBefore);
  const afterPieces = splitAtomicPieces(normalizedAfter);
  if (!beforePieces || !afterPieces) return null;
  return buildInjectedSource(alignPieces(beforePieces, afterPieces));
}

/**
 * 一段行内内容整体新增 / 删除（对应 Word 里的整行插入 / 删除）：文本段挂 CriticMarkup，
 * 公式段在公式内部加下划线 / 删除线 —— 表格里含公式的单元格靠它把线带到位。
 */
export function markInlineWhole(content: string, kind: 'insert' | 'delete'): string {
  const normalized = normalizeMathDelimiters(content, { preserveLineCount: false });
  const pieces = splitAtomicPieces(normalized);
  if (!pieces) return content;
  const builder = new InjectedSourceBuilder();
  for (const piece of pieces) {
    const value = markPiece(piece, kind);
    // 任何一段标记不出来（公式结构无法包裹）就整体放弃标记，保留原文。
    if (value === null) return content;
    builder.append(value, piece.kind === 'math');
  }
  // 同上：数字相邻会触发渲染期降级，宁可整格不标注也不泄漏哨兵 LaTeX。
  return builder.hasUnsafeAdjacency() ? content : builder.toString();
}

/**
 * 生成含公式块的修订源码。返回 null 表示「这个块不走公式路径」（不含公式、体积超限、
 * 解析失败或最终校验不过），调用方应回退到通用词级 / 块级装饰。
 */
export function buildMarkdownMathRevision(before: string, after: string): string | null {
  const hasBefore = before.trim().length > 0;
  const hasAfter = after.trim().length > 0;
  if (!hasBefore && !hasAfter) return null;
  if (before.length + after.length > REVISION_MAX_SOURCE_CHARS) return null;

  const normalizedBefore = normalizeMathDelimiters(before, { preserveLineCount: false });
  const normalizedAfter = normalizeMathDelimiters(after, { preserveLineCount: false });
  const beforePieces = splitAtomicPieces(normalizedBefore);
  const afterPieces = splitAtomicPieces(normalizedAfter);
  if (!beforePieces || !afterPieces) return null;
  // 两侧都没有原子片段：交给通用词级路径（行为零变化）。
  if (!hasAtomicPiece(beforePieces) && !hasAtomicPiece(afterPieces)) return null;
  // 任务标记（勾选态或数量）变化与通用路径同源：标记落在 `[x]` 里会把复选框拆坏，
  // 必须整块回退（原子路径在 tryRevisionSegment 里先于通用路径尝试，缺这条守卫就会
  // 把带行内代码 / 公式的任务项抢过来，渲染成 `- [{--x--} ]` 这种坏 checkbox）。
  if (taskMarkers(before) !== taskMarkers(after)) return null;
  // 原文里字面的 CriticMarkup 定界符也会被折叠器消费，与通用路径同源拦住（否则同一份
  // 预览里，含改动的块把作者的字面量渲染成删除线、未改动块却按字面渲染）。
  if (MARK_DELIMITER_PATTERN.test(before) || MARK_DELIMITER_PATTERN.test(after)) return null;

  const injected = buildInjectedSource(alignPieces(beforePieces, afterPieces));
  // 某处公式无法安全标记（结构被切断 / 相邻公式合并失败）→ 整块放弃公式路径。
  if (injected === null) return null;
  if (!hasAtomicPiece(afterPieces) && !/[$`]/.test(injected)) return null;

  const reference = hasAfter ? normalizedAfter : normalizedBefore;
  return validateMathRevision(injected, reference) ? injected : null;
}
