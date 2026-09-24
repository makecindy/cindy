/**
 * markdownRevision — 审查页 Markdown 富文本预览的「词级修订」生成器。
 *
 * 对 1:1 配对的修改块（或纯新增 / 纯删除块）做词级 diff，把改动注入成
 * `{++新增++}` / `{--删除--}` 标记，产出单块修订源码；MarkdownRenderer 打开
 * `reviewAnnotations` 后渲染为 <ins>/<del>，观感对齐 Word 修订模式。
 *
 * 安全边界（任何一条不满足就返回 null，由调用方回退整块装饰）：
 *  - 源码体积超过 REVISION_MAX_SOURCE_CHARS；
 *  - 改动片段含 `{` / `}`（标记语法吃不了花括号）；
 *  - 两版保留文本占比低于 REVISION_MIN_UNCHANGED_RATIO（整块改写没有词级价值）；
 *  - 注入后校验失败：按**与渲染同源**的解析链跑完插件后仍有未消费的标记
 *    残留（跨块标记不包裹；`$...$` / `$$...$$` 里的标记会被 remarkMath 吃成
 *    math 节点；链接地址 / 图片 alt 等属性里的标记折叠器看不见，同样按残留算），
 *    或修订版的顶层块结构与参照版本不一致。
 *
 * 注入分两次尝试（2026-09-22 补，用户实机反馈）：
 *  1. **词级**：逐 diff 片段注入标记，最精确，绝大多数块在这里完成；
 *  2. **区域级**：词级失败时把整段改动合成一对「旧文本删除 + 新文本新增」，并
 *     对齐到完整的行内结构跨度（`buildRegionRevision`）。词级失败最常见的形态是
 *     改动片段只拿到行内定界符的一半（典型：新版给关键词加粗，diff 把 `**` 的
 *     开符 / 闭符切成两个片段）——逐片段注入后 CommonMark 会把半对定界符配对到
 *     标记外的文本上，开闭标记被拆进不同容器，折叠器消费不到。区域注入让标记
 *     内容覆盖完整结构，定界符不会再落进标记内部。公式跨度是例外：外层
 *     <del>/<ins> 画不出线（KaTeX 原子盒），碰到就放弃，交回块级装饰。
 *
 * 校验链必须与 MarkdownRenderer 一致（共享 markdownPluginPipeline，并且要跑完
 * transformer 而不只是 parse），否则会出现「校验认为能消费、渲染时变成字面量」
 * （KaTeX 乱码事故的根因），或「校验看到的结构与折叠时不同、行内节点被丢掉」
 * （裸路径在渲染链里会变成 link）。
 */

import { normalizeMathDelimiters } from '@cindy/maker-shared/math-markdown';
import { diffWordsWithSpace } from 'diff';
import type { Root } from 'mdast';
import remarkParse from 'remark-parse';
import { unified } from 'unified';

import { MARKDOWN_REMARK_PLUGINS } from '@/components/chat/markdownPluginPipeline';
import {
  hasUnconsumedReviewMarks,
  remarkReviewAnnotations,
} from '@/components/chat/remarkReviewAnnotations';

/** 参与词级修订的单块源码上限（两版合计）。 */
export const REVISION_MAX_SOURCE_CHARS = 200_000;
/** 两版保留文本占比低于该值时视为整块改写，词级标记没有阅读价值。 */
export const REVISION_MIN_UNCHANGED_RATIO = 0.3;

/**
 * 任务列表标记（`- [ ]` / `- [x]`）。勾选态变化不能词级：标记落在方括号里会把
 * `- [x]` 拆成 `- [ {++x++}]`，remark-gfm 就不再把它当任务清单——复选框消失、
 * 退化成字面文字。这类变化回退整块装饰（两版各自完整渲染，复选框正常）。
 */
const TASK_MARKER_PATTERN = /^[\t ]*[-*+] +\[([ xX])\]/gm;

/**
 * 任务标记序列（无任务列表时返回 null）。序列不一致就放弃词级。
 *
 * ⚠️ 按**原始字符**比较，不做大小写归一：`- [x]` → `- [X]` 也是勾选态写法变化，
 * 归一后会误判成「标记未变」放行，词级标记同样会把复选框拆掉（`- [{--x--} ]`）。
 */
export function taskMarkers(source: string): string | null {
  const markers = [...source.matchAll(TASK_MARKER_PATTERN)].map((match) => match[1] ?? '');
  return markers.length > 0 ? markers.join('') : null;
}

/** CriticMarkup 定界符：作者原文里字面出现时与折叠器同形，碰到就整块回退。 */
const CRITIC_MARK_DELIMITER = /\{\+\+|\+\+\}|\{--|--\}/;

const parser = unified().use(remarkParse).use(MARKDOWN_REMARK_PLUGINS);

/**
 * 行内语法字符：用于挑出「可能只拿到定界符一半」的改动片段（区域注入的种子）。
 * 宁可多挑：多挑只是把区域放宽一点；少挑才会漏掉真正的定界符半片。
 */
const INLINE_SYNTAX_PATTERN = /[*_~`\[\]<>$\\]/;

/** 源码区间（[start, end)，字符偏移）。 */
interface SourceRange {
  start: number;
  end: number;
}

/** diff 片段 + 两侧源码偏移：区域注入与结构对齐按偏移计算，不能只看文本。 */
interface DiffSlice {
  value: string;
  added: boolean;
  removed: boolean;
  /** 该片段在旧版源码里的区间；纯新增片段为 null。 */
  before: SourceRange | null;
  /** 该片段在新版源码里的区间；纯删除片段为 null。 */
  after: SourceRange | null;
  /** 改动片段里出现行内语法字符：可能只拿到定界符的一半，逐片段注入会拆坏结构。 */
  dangerous: boolean;
}

/** 最外层行内结构跨度。 */
interface InlineSpan extends SourceRange {
  /** 公式（inlineMath / math）：外层 <del>/<ins> 画不出线，区域注入碰到必须放弃。 */
  math: boolean;
}

/** 参与结构对齐的行内节点类型；嵌套结构随最外层跨度一起被包含。 */
const ALIGNED_INLINE_TYPES = new Set([
  'emphasis',
  'strong',
  'delete',
  'link',
  'linkReference',
  'image',
  'imageReference',
  'inlineCode',
  'inlineMath',
  'math',
  'html',
  'footnote',
  'footnoteReference',
]);

/** 词级 diff + 两侧源码偏移。 */
function sliceDiff(before: string, after: string): DiffSlice[] {
  const slices: DiffSlice[] = [];
  let beforeOffset = 0;
  let afterOffset = 0;
  for (const part of diffWordsWithSpace(before, after)) {
    const added = part.added === true;
    const removed = part.removed === true;
    const length = part.value.length;
    slices.push({
      value: part.value,
      added,
      removed,
      before: added ? null : { start: beforeOffset, end: beforeOffset + length },
      after: removed ? null : { start: afterOffset, end: afterOffset + length },
      dangerous: (added || removed) && INLINE_SYNTAX_PATTERN.test(part.value),
    });
    if (!added) beforeOffset += length;
    if (!removed) afterOffset += length;
  }
  return slices;
}

/** 逐片段注入（词级路径）。未改片段原样保留；纯空白改动不挂标记（只会有空噪声）。 */
function injectSlices(
  slices: readonly DiffSlice[],
  from: number,
  to: number,
): { text: string; marks: number } {
  let text = '';
  let marks = 0;
  for (let index = Math.max(0, from); index <= to && index < slices.length; index += 1) {
    const slice = slices[index];
    if (!slice.added && !slice.removed) {
      text += slice.value;
      continue;
    }
    // 纯空白改动（换行 / 空格）不挂标记：标记只会产生空的下划线 / 删除线噪声，
    // 直连保留在输出里即可（渲染上等价于未改）。
    if (slice.value.trim() === '') {
      text += slice.value;
      continue;
    }
    text += slice.added ? `{++${slice.value}++}` : `{--${slice.value}--}`;
    marks += 1;
  }
  return { text, marks };
}

/**
 * 生成修订版源码。返回 null 表示该块对不适合词级修订。
 * `referenceSource` 由调用方决定：配对修改 / 纯新增用新版块，纯删除用旧版块。
 */
export function buildMarkdownRevision(before: string, after: string): string | null {
  const hasBefore = before.trim().length > 0;
  const hasAfter = after.trim().length > 0;
  if (!hasBefore && !hasAfter) return null;
  if (before === after) return null;
  if (before.length + after.length > REVISION_MAX_SOURCE_CHARS) return null;
  // 任务标记（勾选态或数量）有任何变化都回退：词级标记会拆掉 `- [x]` 语法。
  if (taskMarkers(before) !== taskMarkers(after)) return null;
  // 原文里字面的 CriticMarkup 定界符（如文档在讲解这套语法）也会被修订折叠器一并消费：
  // 在同一份预览里，含改动的块会把它渲染成删除线/下划线，未改动的块却按字面量渲染。
  // 保守回退整块（块级装饰不跑折叠器，两版都按字面渲染）。
  if (CRITIC_MARK_DELIMITER.test(before) || CRITIC_MARK_DELIMITER.test(after)) return null;

  if (!hasBefore || !hasAfter) {
    return buildWholeBlockRevision(
      hasAfter ? after : before,
      hasAfter ? after : before,
      hasAfter ? 'insert' : 'delete',
    );
  }

  const slices = sliceDiff(before, after);
  // 花括号在改动片段里时两种注入都救不了（标记内容不允许出现 `{` / `}`）：整块回退。
  if (slices.some((slice) => (slice.added || slice.removed) && /[{}]/.test(slice.value))) {
    return null;
  }
  let unchangedChars = 0;
  for (const slice of slices) {
    if (!slice.added && !slice.removed) unchangedChars += slice.value.length;
  }
  if (unchangedChars / Math.max(before.length, after.length) < REVISION_MIN_UNCHANGED_RATIO) {
    return null;
  }

  // 第一尝试：逐片段词级注入。绝大多数块在这里完成，输出最精确。
  const fine = injectSlices(slices, 0, slices.length - 1);
  if (fine.marks === 0) return null;
  if (validateRevision(fine.text, after)) return fine.text;

  // 第二尝试：结构感知的区域注入（词级只拿到行内定界符一半时的兜底）。
  const region = buildRegionRevision(slices, before, after);
  return region !== null && validateRevision(region, after) ? region : null;
}

function buildWholeBlockRevision(
  body: string,
  reference: string,
  kind: 'insert' | 'delete',
): string | null {
  if (/[{}]/.test(body)) return null;
  const injected = kind === 'insert' ? `{++${body}++}` : `{--${body}--}`;
  return validateRevision(injected, reference) ? injected : null;
}

/**
 * 区域注入：把**整段改动**折叠成一对「旧文本删除 + 新文本新增」。
 *
 * 为什么需要（2026-09-22 用户实机反馈）：新版把关键词加粗（`（**车辆 / 人员**）`）时，
 * 词级 diff 会把 `**` 的开符 / 闭符切成两个独立改动片段。逐片段注入后，CommonMark
 * 把这半对定界符配对到**标记外**的文本上，`{++**++}` 的开闭标记被拆进不同容器，
 * 折叠器消费不到 → 校验残留 → 整段回退成「整段删除线 + 整段下划线」，看不出到底
 * 改了什么。区域注入让标记内容覆盖完整结构，定界符不会再落进标记内部。
 *
 * 范围选择：以「含行内语法字符的改动片段」为种子（它们最可能只拿到定界符的一半），
 * 向外并入相邻改动片段；再把区域**对齐到完整的行内结构跨度**——跨度只覆盖一半时
 * 扩到整段，这保证标记不会塞进 `[文本](地址)` 的地址语法、`![alt](src)` 的 alt 等
 * 折叠器看不见的位置（标记落在属性里会以字面量漏进 href）。公式跨度是例外：
 * 外层 <del>/<ins> 画不出线，碰到直接放弃区域注入，交回块级装饰。
 */
function buildRegionRevision(
  slices: readonly DiffSlice[],
  before: string,
  after: string,
): string | null {
  const beforeSpans = collectInlineSpans(before);
  const afterSpans = collectInlineSpans(after);
  // 片段先按跨度边界切开：区域以整段跨度为对齐单位，片段不切开时，跨度边界落在
  // 片段内部就会把跨度外的未改文本一起卷进标记。
  const cuts = [
    ...(beforeSpans ?? []).flatMap((span) => [span.start, span.end]),
    ...(afterSpans ?? []).flatMap((span) => [span.start, span.end]),
  ];
  const parts = splitSlices(slices, cuts);

  const changed: number[] = [];
  const dangerous: number[] = [];
  parts.forEach((part, index) => {
    if (!part.added && !part.removed) return;
    changed.push(index);
    if (part.dangerous) dangerous.push(index);
  });
  if (changed.length === 0) return null;
  const seed = dangerous.length > 0 ? dangerous : changed;
  let start = seed[0];
  let end = seed[seed.length - 1];
  // 紧邻的改动片段一并并入：`{--a--}{--b--}` 这类相邻标记合成一个更干净。
  while (start > 0 && (parts[start - 1].added || parts[start - 1].removed)) start -= 1;
  while (end < parts.length - 1 && (parts[end + 1].added || parts[end + 1].removed)) end += 1;

  // 对齐到完整跨度：区域每碰到一个只覆盖一半的跨度就扩到整段；公式跨度直接放弃。
  const spanSides: Array<['before' | 'after', readonly InlineSpan[]]> = [
    ['before', beforeSpans ?? []],
    ['after', afterSpans ?? []],
  ];
  for (let guard = 0; guard <= parts.length; guard += 1) {
    let expanded = false;
    for (const [side, spans] of spanSides) {
      const coverage = sideCoverage(parts, start, end, side);
      if (!coverage) continue;
      const hit = spans.find(
        (span) =>
          span.start < coverage.end &&
          span.end > coverage.start &&
          (span.start < coverage.start || span.end > coverage.end),
      );
      if (!hit) continue;
      if (hit.math) return null;
      const first = partIndexAt(parts, side, hit.start);
      const last = partIndexAt(parts, side, hit.end - 1);
      if (first === null || last === null) return null;
      if (first < start) {
        start = first;
        expanded = true;
      }
      if (last > end) {
        end = last;
        expanded = true;
      }
    }
    if (!expanded) break;
  }

  const oldText = parts
    .slice(start, end + 1)
    .filter((part) => !part.added)
    .map((part) => part.value)
    .join('');
  const newText = parts
    .slice(start, end + 1)
    .filter((part) => !part.removed)
    .map((part) => part.value)
    .join('');
  if (oldText === '' && newText === '') return null;
  const head = injectSlices(parts, 0, start - 1).text;
  const tail = injectSlices(parts, end + 1, parts.length - 1).text;
  const removedPart = oldText === '' ? '' : `{--${oldText}--}`;
  const addedPart = newText === '' ? '' : `{++${newText}++}`;
  return `${head}${removedPart}${addedPart}${tail}`;
}

/**
 * 收集最外层行内结构跨度（源码偏移）。解析失败返回 null：不启用结构对齐，
 * 词级 / 区域注入照常跑——保守方向是少标，而不是标错。
 */
function collectInlineSpans(source: string): InlineSpan[] | null {
  let tree: Root;
  try {
    tree = parser.parse(source) as Root;
  } catch {
    return null;
  }
  const spans: InlineSpan[] = [];
  collectInlineSpansFrom(tree, spans);
  return spans;
}

function collectInlineSpansFrom(node: unknown, out: InlineSpan[]): void {
  const type = (node as { type?: unknown }).type;
  if (typeof type === 'string' && ALIGNED_INLINE_TYPES.has(type)) {
    const position = (node as {
      position?: { start?: { offset?: number }; end?: { offset?: number } };
    }).position;
    const start = position?.start?.offset;
    const end = position?.end?.offset;
    if (typeof start === 'number' && typeof end === 'number' && end > start) {
      out.push({ start, end, math: type === 'inlineMath' || type === 'math' });
    }
    return;
  }
  const children = (node as { children?: unknown[] }).children;
  if (Array.isArray(children)) {
    for (const child of children) collectInlineSpansFrom(child, out);
  }
}

/**
 * 按结构跨度边界切开片段（只切跨度边界的**内部**位置）。
 * 切点对两侧通用：未改片段的两侧偏移与 value 一一对应；改动片段只有一侧有偏移。
 */
function splitSlices(slices: readonly DiffSlice[], cuts: readonly number[]): DiffSlice[] {
  const sorted = [...new Set(cuts)].sort((left, right) => left - right);
  if (sorted.length === 0) return slices.slice();
  const out: DiffSlice[] = [];
  for (const slice of slices) {
    const points = new Set<number>();
    for (const side of ['before', 'after'] as const) {
      const range = slice[side];
      if (!range) continue;
      for (const cut of sorted) {
        if (cut > range.start && cut < range.end) points.add(cut - range.start);
      }
    }
    const ordered = [...points].sort((left, right) => left - right);
    let cursor = 0;
    for (const point of [...ordered, slice.value.length]) {
      const value = slice.value.slice(cursor, point);
      if (value.length > 0) {
        out.push({
          value,
          added: slice.added,
          removed: slice.removed,
          before: slice.before
            ? { start: slice.before.start + cursor, end: slice.before.start + point }
            : null,
          after: slice.after
            ? { start: slice.after.start + cursor, end: slice.after.start + point }
            : null,
          dangerous: slice.dangerous && INLINE_SYNTAX_PATTERN.test(value),
        });
      }
      cursor = point;
    }
  }
  return out;
}

/** 区域在一侧覆盖的源码范围；该侧没有任何片段时返回 null。 */
function sideCoverage(
  parts: readonly DiffSlice[],
  start: number,
  end: number,
  side: 'before' | 'after',
): SourceRange | null {
  let from = Number.POSITIVE_INFINITY;
  let to = Number.NEGATIVE_INFINITY;
  for (let index = start; index <= end && index < parts.length; index += 1) {
    const range = parts[index][side];
    if (!range) continue;
    from = Math.min(from, range.start);
    to = Math.max(to, range.end);
  }
  return from <= to ? { start: from, end: to } : null;
}

/** 该侧 offset 落在哪个片段里；找不到返回 null（调用方放弃区域注入）。 */
function partIndexAt(
  parts: readonly DiffSlice[],
  side: 'before' | 'after',
  offset: number,
): number | null {
  for (let index = 0; index < parts.length; index += 1) {
    const range = parts[index][side];
    if (range && range.start <= offset && offset < range.end) return index;
  }
  return null;
}

/**
 * 校验注入结果可被 MarkdownRenderer 的修订插件完整消费：
 *  - 插件跑完后没有未消费的标记残留（跨块边界不匹配的情况会留下残留）；
 *  - 修订版顶层块结构与参照版本一致（块前缀没被卷进标记）。
 * 校验直接跑与渲染同一个插件函数，避免两侧规则漂移。
 */
function validateRevision(injected: string, referenceSource: string): boolean {
  const injectedTree = parseRevisionTree(injected);
  const referenceTree = parseRevisionTree(referenceSource);
  if (!injectedTree || !referenceTree) return false;
  remarkReviewAnnotations()(injectedTree);
  if (hasUnconsumedReviewMarks(injectedTree)) return false;
  return topLevelSignature(injectedTree) === topLevelSignature(referenceTree);
}

/**
 * 按**与渲染同源**的解析链把源码解成 mdast（parse + 全量 transformer），
 * 供修订校验与表格结构级注入共用。任何异常都收敛为 null。
 */
export function parseRevisionTree(source: string): Root | null {
  try {
    // 输入归一化 + 插件链与 MarkdownRenderer 同源：`\(...\)` / `\[...\]` 会在
    // 渲染前被 normalizeMathDelimiters 转成 dollar 形式，remarkMath 再把整段
    // 文本吃成 inlineMath / math 节点。只按裸 remarkParse 校验会漏掉这类节点，
    // 标记会以 KaTeX 乱码形式泄漏给用户。
    const tree = parser.parse(
      normalizeMathDelimiters(source, { preserveLineCount: false }),
    ) as Root;
    // 再跑完整链的 transformer：渲染链在 parse 之后还会新建 / 改造行内节点
    // （remarkLocalPathLinks 把裸路径切成 link、remarkHtmlImages 把单 <img>
    // 转成 image…）。只比 parse 结果的话，校验看到的结构与折叠时看到的可能
    // 不同，这些「洞」会被静默丢弃。
    parser.runSync(tree);
    return tree;
  } catch {
    return null;
  }
}

/** 顶层块类型签名：用于比对修订版与参照版本的结构是否一致。 */
export function topLevelSignature(tree: Root): string {
  return tree.children.map((child) => child.type).join('|');
}
