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
  /**
   * 标记不能包住的片段（列表项符号 `- ` / `1. `）：原样输出。标记插在行首会把符号
   * 变成普通文本（项结构消失 / 变成上一项的懒续行），折叠器消费不到标记 → 校验残留。
   */
  bare?: boolean;
}

/** 最外层行内结构跨度。 */
interface InlineSpan extends SourceRange {
  /** 公式（inlineMath / math）：外层 <del>/<ins> 画不出线，区域注入碰到必须放弃。 */
  math: boolean;
  /**
   * 跨度里属于语法（定界符 / 地址 / 标记）的源码区间：节点位置去掉全部子节点位置。
   * 例：strong `**无 HP**` 的语法是首尾两个 `**`；link 的语法是 `[` 与 `](url)`；
   * inlineCode 这种叶节点整个跨度都是语法。标记不能落进这些区间。
   */
  syntax: SourceRange[];
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

/** diff 片段 / part 的最小形状：算保留占比只需要这三个字段。 */
interface DiffLikePart {
  value: string;
  added?: boolean;
  removed?: boolean;
}

/**
 * 保留文本占比（0~1）：两版 diff 里未改字符数 ÷ 两版较长者。
 *
 * 「整块改写」判定的**单一事实源** —— 段落 / 列表（本文件的通用注入）与表格单元格
 * （markdownTableRevision）共用同一条纪律：占比低于 REVISION_MIN_UNCHANGED_RATIO
 * 时逐词标记只剩碎片（中文尤其容易被切在词中间），不如整块「旧删除 + 新新增」。
 * 公式 / 行内代码所在的块不套用（外层 <del>/<ins> 画不到 KaTeX 原子盒上，
 * 整块替换会让公式改动不可见，见 markdownTableRevision.reviseCell）。
 */
function unchangedRatioOf(
  parts: readonly DiffLikePart[],
  beforeLength: number,
  afterLength: number,
): number {
  let unchanged = 0;
  for (const part of parts) {
    if (!part.added && !part.removed) unchanged += part.value.length;
  }
  const total = Math.max(beforeLength, afterLength);
  return total === 0 ? 0 : unchanged / total;
}

/** 同上，按两版原文现算（表格单元格等只有字符串、没有现成 diff 片段的调用方用）。 */
export function unchangedTextRatio(before: string, after: string): number {
  return unchangedRatioOf(diffWordsWithSpace(before, after), before.length, after.length);
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
    // 列表项符号等「不能包」的片段原样输出（见 splitListMarkers）。
    if (slice.bare) {
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

/** 行首的列表项符号（`- ` / `1. `）：标记不能把它包进去，见 splitListMarkers。 */
const LIST_MARKER_PATTERN = /^(?: {0,3})(?:[-*+]|\d{1,9}[.)])[ \t]+/;

/** 把片段按「值 + 在原侧源码里的偏移」拆出一个新片段。 */
function slicePiece(
  slice: DiffSlice,
  value: string,
  offset: number,
  bare: boolean,
): DiffSlice {
  const shift = (range: SourceRange | null): SourceRange | null =>
    range
      ? { start: range.start + offset, end: range.start + offset + value.length }
      : null;
  return {
    value,
    added: slice.added,
    removed: slice.removed,
    before: shift(slice.before),
    after: shift(slice.after),
    dangerous: slice.dangerous && INLINE_SYNTAX_PATTERN.test(value),
    bare,
  };
}

/**
 * 把改动片段里的**行首列表项符号**拆成原样输出的片段。
 *
 * 标记插在行首会把符号变成普通文本（`{++- 项…++}` 里的项不再是列表项 / 变成上一项的
 * 懒续行），折叠器消费不到标记 → 校验残留 → 整块回退（实机 `docs/progress.md`：整份
 * 进度日志是一个 loose list，加一行就被整块标成修订）。列表路径
 * （buildMarkdownListRevision）只接手 tight list，loose list 会落回通用路径，
 * 所以这里兜住：符号原样输出，标记只包住项正文（`- {++项正文++}`）。
 */
function splitListMarkers(
  slices: readonly DiffSlice[],
  before: string,
  after: string,
): DiffSlice[] {
  const out: DiffSlice[] = [];
  for (const slice of slices) {
    const source = slice.added ? after : before;
    const range = slice.added ? slice.after : slice.before;
    if ((!slice.added && !slice.removed) || !range) {
      out.push(slice);
      continue;
    }
    let cursor = 0;
    while (cursor < slice.value.length) {
      const rest = slice.value.slice(cursor);
      const atLineStart =
        cursor === 0
          ? range.start === 0 || source[range.start - 1] === '\n'
          : slice.value[cursor - 1] === '\n';
      const marker = atLineStart ? LIST_MARKER_PATTERN.exec(rest) : null;
      if (marker) {
        out.push(slicePiece(slice, marker[0], cursor, true));
        cursor += marker[0].length;
        continue;
      }
      const newline = rest.indexOf('\n');
      const end = newline === -1 ? slice.value.length : cursor + newline + 1;
      out.push(slicePiece(slice, slice.value.slice(cursor, end), cursor, false));
      cursor = end;
    }
  }
  return out;
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

  const slices = splitListMarkers(sliceDiff(before, after), before, after);
  // 花括号在改动片段里时两种注入都救不了（标记内容不允许出现 `{` / `}`）：整块回退。
  if (slices.some((slice) => (slice.added || slice.removed) && /[{}]/.test(slice.value))) {
    return null;
  }
  if (unchangedRatioOf(slices, before.length, after.length) < REVISION_MIN_UNCHANGED_RATIO) {
    return null;
  }

  // 第一尝试：逐片段词级注入。绝大多数块在这里完成，输出最精确。
  const fine = injectSlices(slices, 0, slices.length - 1);
  if (fine.marks === 0) return null;
  if (validateRevision(fine.text, after)) return fine.text;

  // 第二尝试：结构感知的区域注入（词级只拿到行内定界符一半时的兜底）。
  // 候选按精确度排序（逐簇 → 合并整段），逐个校验，第一个通过的就是结果。
  for (const candidate of buildStructuralRevisions(slices, before, after)) {
    if (validateRevision(candidate, after)) return candidate;
  }
  return null;
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

/** 片段下标闭区间（区域 = 一段连续的 diff 片段）。 */
interface PartRange {
  start: number;
  end: number;
}

/** 改动片段聚簇：相邻的改动片段（中间没有未改片段）属于同一簇。 */
function changedClusters(parts: readonly DiffSlice[]): PartRange[] {
  const clusters: PartRange[] = [];
  let start = -1;
  parts.forEach((part, index) => {
    if (part.added || part.removed) {
      if (start === -1) start = index;
      return;
    }
    if (start !== -1) {
      clusters.push({ start, end: index - 1 });
      start = -1;
    }
  });
  if (start !== -1) clusters.push({ start, end: parts.length - 1 });
  return clusters;
}

/**
 * 把一个区域扩到完整行内结构跨度：区域只覆盖一半的跨度全部纳入 —— 标记不能塞进
 * 定界符或属性语法里（`[文本](地址)` 的地址、`![alt](src)` 的 alt 折叠器看不见，
 * 落进去会以字面量漏进 href）。公式跨度是例外：外层 <del>/<ins> 画不出线
 * （KaTeX 原子盒），碰到返回 null，由调用方放弃区域注入。
 */
function snapRange(
  parts: readonly DiffSlice[],
  range: PartRange,
  beforeSpans: readonly InlineSpan[],
  afterSpans: readonly InlineSpan[],
): PartRange | null {
  let { start, end } = range;
  const spanSides: Array<['before' | 'after', readonly InlineSpan[]]> = [
    ['before', beforeSpans],
    ['after', afterSpans],
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
  return { start, end };
}

/** 合并重叠 / 相邻区域：相邻区域各自成对标记没有意义，合成一个更干净。 */
function mergeRanges(ranges: readonly PartRange[]): PartRange[] {
  const sorted = [...ranges].sort((left, right) => left.start - right.start);
  const merged: PartRange[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end + 1) {
      last.end = Math.max(last.end, range.end);
      continue;
    }
    merged.push({ ...range });
  }
  return merged;
}

/** 按区域列表拼装注入源：区域之间的片段仍走词级注入（区域外不受影响）。 */
function assembleRegions(parts: readonly DiffSlice[], ranges: readonly PartRange[]): string {
  let text = '';
  let cursor = 0;
  for (const range of ranges) {
    text += injectSlices(parts, cursor, range.start - 1).text;
    const oldText = parts
      .slice(range.start, range.end + 1)
      .filter((part) => !part.added)
      .map((part) => part.value)
      .join('');
    const newText = parts
      .slice(range.start, range.end + 1)
      .filter((part) => !part.removed)
      .map((part) => part.value)
      .join('');
    if (oldText !== '') text += `{--${oldText}--}`;
    if (newText !== '') text += `{++${newText}++}`;
    cursor = range.end + 1;
  }
  text += injectSlices(parts, cursor, parts.length - 1).text;
  return text;
}

/**
 * 区域注入候选（按精确度排序）：把**整段改动**折叠成「旧文本删除 + 新文本新增」。
 *
 * 为什么需要（2026-09-22 用户实机反馈）：新版把关键词加粗（`（**车辆 / 人员**）`）时，
 * 词级 diff 会把 `**` 的开符 / 闭符切成两个独立改动片段。逐片段注入后，CommonMark
 * 把这半对定界符配对到**标记外**的文本上，`{++**++}` 的开闭标记被拆进不同容器，
 * 折叠器消费不到 → 校验残留 → 整段回退成「整段删除线 + 整段下划线」，看不出到底
 * 改了什么。区域注入让标记内容覆盖完整结构，定界符不会再落进标记内部。
 *
 * 范围选择：以「含行内语法字符的改动片段」所在簇为种子（它们最可能只拿到定界符的
 * 一半）；没有这样的簇时退到全部改动簇。两个候选（调用方逐个校验，先精确后回退）：
 *  1. **逐簇区域**：每个种子簇各自成区，簇之间的未改正文保持原样 —— 同一段落里
 *     两处相距较远的结构改动（两个链接、两处加粗）不会把中间正文卷进标记；
 *  2. **首..末簇合成一个大区域**：定界符配对跨簇时（两个簇各自都不平衡），只有
 *     合并后的标记内容才包含完整结构。
 * 两个候选都会先把区域**对齐到完整的行内结构跨度**（见 snapRange）。
 */
/** 跨度去掉语法区间后的内容区间（区域对齐、是否已有结构都按内容判定）。 */
function contentRanges(span: InlineSpan): SourceRange[] {
  const sorted = [...span.syntax].sort((left, right) => left.start - right.start);
  const out: SourceRange[] = [];
  let cursor = span.start;
  for (const range of sorted) {
    if (range.start > cursor) out.push({ start: cursor, end: range.start });
    cursor = Math.max(cursor, range.end);
  }
  if (cursor < span.end) out.push({ start: cursor, end: span.end });
  return out;
}

/** 把新版侧的区间映射回旧版侧（只有对齐片段映射得出；纯新增片段没有旧版对应）。 */
function mapToBefore(parts: readonly DiffSlice[], range: SourceRange): SourceRange[] {
  const out: SourceRange[] = [];
  let cursor = 0;
  for (const part of parts) {
    if (part.after) {
      const start = Math.max(part.after.start, range.start);
      const end = Math.min(part.after.end, range.end);
      if (end > start && part.before) {
        const offset = start - part.after.start;
        out.push({
          start: part.before.start + offset,
          end: part.before.start + offset + (end - start),
        });
      }
      cursor = part.after.end;
    } else if (part.before && cursor >= range.start && cursor <= range.end) {
      out.push({ start: part.before.start, end: part.before.end });
    }
  }
  return out;
}

/**
 * 新版侧「新增格式」的跨度：内容是纯定界符（`**` / `~~` / `_` 连写），定界符片段是
 * **新增**的（旧版本来就有同样格式时不需要标记），且旧版同一段内容上没有别的行内结构
 * （`[link](u)` → `**link**` 属于结构变化，交给区域注入整体替换）。
 */
function contextFormatSpans(
  parts: readonly DiffSlice[],
  source: string,
  beforeSpans: readonly InlineSpan[],
  afterSpans: readonly InlineSpan[],
): Array<{ span: InlineSpan; delimiters: SourceRange[] }> {
  const out: Array<{ span: InlineSpan; delimiters: SourceRange[] }> = [];
  for (const span of afterSpans) {
    const delimiters = span.syntax.filter((range) =>
      /^[*_~]+$/.test(source.slice(range.start, range.end)),
    );
    if (delimiters.length === 0) continue;
    const added = delimiters.every((range) =>
      parts.some(
        (part) =>
          part.added &&
          part.after &&
          part.after.start >= range.start &&
          part.after.end <= range.end,
      ),
    );
    if (!added) continue;
    const beforeRanges = contentRanges(span).flatMap((range) => mapToBefore(parts, range));
    const structuredBefore = beforeSpans.some((other) =>
      beforeRanges.some((range) => other.start < range.end && other.end > range.start),
    );
    if (structuredBefore) continue;
    out.push({ span, delimiters });
  }
  return out;
}

/**
 * 跨度语法感知注入：逐片段标记，但**新增**的纯格式定界符片段原样输出 —— 它本来就
 * 是新版源码的一部分（新版本来就带这个格式），把它裹进 `{++…++}` 只会逼着标记去覆盖
 * 完整定界符对，从而把中间未改的正文也卷进来（用户实机反馈：`车辆 / 人` 没动却被标）。
 *
 * 每个「新增格式」跨度分两种写法：
 *  - 跨度里本来就有内容改动 → 定界符留白，只标内容改动（实机：`（{--建筑 / --}**车辆 / 人{--物--}{++员++}**）`）；
 *  - 跨度是纯格式新增（里面没有别的改动）→ 折成一对「旧内容删除 + 新跨度新增」，
 *    保证格式变化本身看得见（Greptile P2：`见 甲乙 … 尾部旧` → `见 **甲乙** … 尾部新`）。
 * 跨度由内向外判定：内层跨度先定写法，外层就能看见它带来的标记。
 */
function assembleSpanAware(
  parts: readonly DiffSlice[],
  after: string,
  formats: ReadonlyArray<{ span: InlineSpan; delimiters: readonly SourceRange[] }>,
): { text: string; marks: number } {
  // 片段在新版源码里的锚点：删除片段没有新版区间，挂在当前光标位置。
  const anchors: number[] = [];
  let cursor = 0;
  for (const part of parts) {
    anchors.push(part.after ? part.after.start : cursor);
    if (part.after) cursor = part.after.end;
  }
  const insideSpan = (index: number, span: InlineSpan): boolean => {
    const range = parts[index].after;
    if (range) return range.start >= span.start && range.end <= span.end;
    const anchor = anchors[index];
    return anchor > span.start && anchor < span.end;
  };
  const insideRange = (index: number, range: SourceRange): boolean => {
    const own = parts[index].after;
    if (own) return own.start >= range.start && own.end <= range.end;
    const anchor = anchors[index];
    return anchor > range.start && anchor <= range.end;
  };

  const regionSpans: InlineSpan[] = [];
  let delimiters = formats.flatMap((format) => [...format.delimiters]);
  for (const { span, delimiters: own } of [...formats].sort(
    (left, right) =>
      left.span.end - left.span.start - (right.span.end - right.span.start),
  )) {
    const hasContentChange = parts.some(
      (part, index) =>
        (part.added || part.removed) &&
        part.value.trim() !== '' &&
        insideSpan(index, span) &&
        !delimiters.some((range) => insideRange(index, range)),
    );
    if (hasContentChange) continue;
    regionSpans.push(span);
    delimiters = delimiters.filter((range) => !own.includes(range));
  }

  const regions = [...regionSpans].sort((left, right) => left.start - right.start);
  let text = '';
  let marks = 0;
  let index = 0;
  while (index < parts.length) {
    const region = regions.find((span) => insideSpan(index, span));
    if (region) {
      // 区域开头若是列表项符号等「不能包」的片段，先原样输出（标记不能包住 `- `）。
      let prefix = '';
      if (parts[index].bare) {
        prefix = parts[index].value;
        index += 1;
      }
      let oldText = '';
      let stop = index;
      while (stop < parts.length && insideSpan(stop, region)) {
        if (parts[stop].before && !parts[stop].added && !parts[stop].bare) {
          oldText += parts[stop].value;
        }
        stop += 1;
      }
      const start = parts[index]?.after?.start ?? region.start;
      text += `${prefix}{--${oldText}--}{++${after.slice(start, region.end)}++}`;
      marks += 2;
      index = stop;
      continue;
    }
    const part = parts[index];
    if (!part.added && !part.removed) {
      text += part.value;
      index += 1;
      continue;
    }
    // 列表项符号等「不能包」的片段原样输出（见 splitListMarkers）。
    if (part.bare) {
      text += part.value;
      index += 1;
      continue;
    }
    if (part.added && delimiters.some((range) => insideRange(index, range))) {
      text += part.value;
      index += 1;
      continue;
    }
    if (part.value.trim() === '') {
      text += part.value;
      index += 1;
      continue;
    }
    text += part.added ? `{++${part.value}++}` : `{--${part.value}--}`;
    marks += 1;
    index += 1;
  }
  return { text, marks };
}

/**
 * 结构性注入候选（按精确度排序）：词级失败后逐级尝试，由调用方逐个校验。
 *
 * 为什么需要（2026-09-22 用户实机反馈）：新版把关键词加粗（`（**车辆 / 人员**）`）时，
 * 词级 diff 会把 `**` 的开符 / 闭符切成两个独立改动片段。逐片段注入后，CommonMark
 * 把这半对定界符配对到**标记外**的文本上，`{++**++}` 的开闭标记被拆进不同容器，
 * 折叠器消费不到 → 校验残留 → 整段回退成「整段删除线 + 整段下划线」，看不出到底
 * 改了什么。
 *
 * 候选顺序：
 *  1. **跨度语法感知**：新增的纯格式定界符保留在标记外，只标真正变动的文本；
 *  2. **逐簇区域**：每个「含行内语法字符的改动簇」各自成区（整段旧 / 新文本），
 *     簇之间的未改正文保持原样 —— 两处相距较远的结构改动不会互相牵连；
 *  3. **首..末簇合并区域**：定界符配对跨簇时（两个簇各自都不平衡），只有合并后的
 *     标记内容才包含完整结构。
 * 区域候选都会先把区域**对齐到完整的行内结构跨度**（见 snapRange）。
 */
function buildStructuralRevisions(
  slices: readonly DiffSlice[],
  before: string,
  after: string,
): string[] {
  const beforeSpans = collectInlineSpans(before) ?? [];
  const afterSpans = collectInlineSpans(after) ?? [];
  // 片段按「跨度边界 + 语法边界」切开：语法边界切开后纯 `**` 这类定界符片段才能
  // 单独保留为上下文；区域以整段跨度为对齐单位，不切开就会把跨度外的文本卷进标记。
  const spanCuts = (spans: readonly InlineSpan[]): number[] =>
    spans.flatMap((span) => [
      span.start,
      span.end,
      ...span.syntax.flatMap((range) => [range.start, range.end]),
    ]);
  const parts = splitSlices(slices, spanCuts(beforeSpans), spanCuts(afterSpans));
  const candidates: string[] = [];

  const spanAware = assembleSpanAware(
    parts,
    after,
    contextFormatSpans(parts, after, beforeSpans, afterSpans),
  );
  // 一个标记都没有时不采纳（纯空白改动等），交给后面的块级口径。
  if (spanAware.marks > 0) candidates.push(spanAware.text);

  const clusters = changedClusters(parts);
  if (clusters.length > 0) {
    const dangerousClusters = clusters.filter((cluster) =>
      parts.slice(cluster.start, cluster.end + 1).some((part) => part.dangerous),
    );
    const seeds = dangerousClusters.length > 0 ? dangerousClusters : clusters;

    const snapped: PartRange[] = [];
    for (const seed of seeds) {
      const range = snapRange(parts, seed, beforeSpans, afterSpans);
      if (range === null) {
        snapped.length = 0;
        break;
      }
      snapped.push(range);
    }
    if (snapped.length > 0) candidates.push(assembleRegions(parts, mergeRanges(snapped)));

    const mergedSeed: PartRange = { start: seeds[0].start, end: seeds[seeds.length - 1].end };
    const merged = snapRange(parts, mergedSeed, beforeSpans, afterSpans);
    if (merged !== null) candidates.push(assembleRegions(parts, [merged]));
  }

  return [...new Set(candidates)];
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

/**
 * 节点位置去掉全部子节点位置 = 该跨度的语法区间（定界符 / 地址 / 标记）。
 * 子节点位置缺失时整段当语法（保守：宁可少标）。
 */
function syntaxRangesOf(node: unknown, start: number, end: number): SourceRange[] {
  const children = (node as { children?: unknown[] }).children;
  if (!Array.isArray(children) || children.length === 0) return [{ start, end }];
  const ranges: SourceRange[] = [];
  let cursor = start;
  for (const child of children) {
    const position = (child as {
      position?: { start?: { offset?: number }; end?: { offset?: number } };
    }).position;
    const childStart = position?.start?.offset;
    const childEnd = position?.end?.offset;
    if (typeof childStart !== 'number' || typeof childEnd !== 'number' || childEnd <= childStart) {
      continue;
    }
    if (childStart > cursor) ranges.push({ start: cursor, end: childStart });
    cursor = Math.max(cursor, childEnd);
  }
  if (cursor < end) ranges.push({ start: cursor, end });
  return ranges;
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
      out.push({
        start,
        end,
        math: type === 'inlineMath' || type === 'math',
        syntax: syntaxRangesOf(node, start, end),
      });
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
function splitSlices(
  slices: readonly DiffSlice[],
  beforeCuts: readonly number[],
  afterCuts: readonly number[],
): DiffSlice[] {
  const beforeSorted = [...new Set(beforeCuts)].sort((left, right) => left - right);
  const afterSorted = [...new Set(afterCuts)].sort((left, right) => left - right);
  if (beforeSorted.length === 0 && afterSorted.length === 0) return slices.slice();
  const out: DiffSlice[] = [];
  for (const slice of slices) {
    const points = new Set<number>();
    // 切点分侧使用：before / after 是两套源码坐标，不能混用（混用会在无关位置切出碎片）。
    const sides: Array<[SourceRange | null, readonly number[]]> = [
      [slice.before, beforeSorted],
      [slice.after, afterSorted],
    ];
    for (const [range, cuts] of sides) {
      if (!range) continue;
      for (const cut of cuts) {
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
  return topLevelStructureMatches(injectedTree, referenceTree);
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

/** 顶层 list 的 loose 标记（按出现顺序）。 */
function listSpreadOf(tree: Root): boolean[] {
  return tree.children
    .filter((child) => child.type === 'list')
    .map((child) => (child as { spread?: boolean }).spread === true);
}

/**
 * 顶层结构一致：块类型序列相同，且修订版没有把 loose list **静默收紧**。
 *
 * 反向（参照侧 tight、修订侧 loose）允许：删除项时修订版保留的是旧版结构（含项间空行），
 * 本来就比新版松；只有「参照是 loose 而修订变 tight」才是标记把空行吃掉的结构变化。
 */
export function topLevelStructureMatches(injectedTree: Root, referenceTree: Root): boolean {
  if (topLevelSignature(injectedTree) !== topLevelSignature(referenceTree)) return false;
  const injected = listSpreadOf(injectedTree);
  return listSpreadOf(referenceTree).every((loose, index) => !loose || injected[index] !== false);
}
