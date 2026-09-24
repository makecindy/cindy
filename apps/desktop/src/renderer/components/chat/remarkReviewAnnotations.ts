/**
 * remarkReviewAnnotations — 审查页 Markdown 富文本预览的「修订标记」语法。
 *
 * 语法（CriticMarkup 风格，标记内含 `{` / `}` 时视为普通文本，避免嵌套歧义）：
 *   {++新增文本++}  → <ins>（下划线 + diff 新增色）
 *   {--删除文本--}  → <del>（删除线 + diff 删除色）
 *
 * 只在 MarkdownRenderer 显式打开 `reviewAnnotations` 时进入解析链；chat 消息、
 * doc 预览等既有调用方不传该开关，解析链与 DOM 输出都保持原样。
 *
 * 匹配范围：
 *  - 标记可以跨越**同一个 inline 容器内**的多个子节点（例如
 *    `{--Run ` + inlineCode(old) + ` now--}` 会整体包成一个 <del>），
 *    这样行内代码 / 加粗 / 链接穿插的改动也能做词级修订；
 *  - 不允许跨块级节点包裹（<ins>/<del> 里塞 <p>/<li> 会破坏结构）：collapse
 *    只发生在 INLINE_CONTAINER_TYPES 的容器上；跨块标记会留下残留，由
 *    markdownRevision 的校验拦下并回退整块装饰。
 *
 * 语法事实源：正则、collect、collapse 与残留检测只在这里维护；注入侧的校验
 * 直接复用同一套函数，避免「注入时认为合法、插件消费不到」的漂移。
 */

import type { Root, RootContent } from 'mdast';

export type ReviewMarkKind = 'insert' | 'delete';

export interface ReviewMark {
  kind: ReviewMarkKind;
  /** 标记包裹的内容（不含标记本身）。 */
  inner: string;
  start: number;
  end: number;
}

const REVIEW_MARK_PATTERN = /\{\+\+([^{}]+?)\+\+\}|\{--([^{}]+?)--\}/gu;
/** 标记残缺检测：出现任一标记片段就说明有未被消费的标记。 */
const MARK_RESIDUE_PATTERN = /\{\+\+|\+\+\}|\{--|--\}/;
const MARK_OPEN_LENGTH = 3;
const MARK_CLOSE_LENGTH = 3;

/**
 * 新增（插入）文本的修订样式：下划线 + diff 新增色。
 * `cindy-md-diff-ins` 是专属标识类：让样式/上色能精确命中「修订标记」，不会误伤
 * 正文里用户自己写的 `<ins>`（同理删除侧要与 GFM 的 `~~xx~~` 区分）。
 */
export const REVIEW_INSERT_CLASS =
  'cindy-md-diff-ins underline decoration-1 underline-offset-2 text-[var(--diff-add-fg)]';
/** 删除文本的修订样式：删除线 + diff 删除色（`cindy-md-diff-del` 为专属标识类）。 */
export const REVIEW_DELETE_CLASS = 'cindy-md-diff-del line-through text-[var(--diff-del-fg)]';

/**
 * mdast 的 inline 节点白名单。用于判断一条标记的区间是否只跨越 inline 兄弟：
 * 跨越块级节点（listItem / paragraph / tableCell …）时不能包裹，否则会产出
 * <ins><p>…</p></ins> 之类破坏结构的输出。
 */
const INLINE_TYPES = new Set([
  'text',
  'emphasis',
  'strong',
  'link',
  'linkReference',
  'image',
  'imageReference',
  'inlineCode',
  'break',
  'delete',
  'footnote',
  'footnoteReference',
  'html',
  'inlineMath',
  'math',
]);

/** 收集一段文本里可完整匹配的修订标记，按出现顺序。 */
export function collectReviewMarks(value: string): ReviewMark[] {
  const marks: ReviewMark[] = [];
  for (const match of value.matchAll(REVIEW_MARK_PATTERN)) {
    const insert = match[1];
    marks.push({
      kind: insert === undefined ? 'delete' : 'insert',
      inner: insert ?? match[2],
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  return marks;
}

/**
 * 转换后是否还有未消费的标记残留。
 * 除了 text 节点，叶节点（inlineCode / code / html / yaml 等）的 value 也要
 * 检查：标记落在行内代码里时既不会被折叠，渲染出来就是字面量，必须当作残留。
 */
export function hasUnconsumedReviewMarks(node: Root | RootContent): boolean {
  const value = (node as { value?: unknown }).value;
  if (typeof value === 'string' && MARK_RESIDUE_PATTERN.test(value)) return true;
  const children = getChildren(node);
  if (!children) return false;
  for (const child of children) {
    if (hasUnconsumedReviewMarks(child)) return true;
  }
  return false;
}

/** remark 插件：把文本节点里的修订标记替换成 ins / del 节点。 */
export function remarkReviewAnnotations() {
  return (tree: Root): void => {
    transformContainer(tree);
  };
}

function transformContainer(node: Root | RootContent): void {
  const children = getChildren(node);
  if (!children || children.length === 0) return;
  // 深度优先：先把嵌套容器（emphasis / link / listItem / paragraph …）内部的
  // 标记消费掉，本层再做跨节点折叠。
  for (const child of children) {
    if (child.type !== 'text') transformContainer(child);
  }
  const collapsed = collapseReviewMarks(children);
  children.splice(0, children.length, ...collapsed);
}

interface TextSegment {
  childIndex: number;
  start: number;
  end: number;
}

/** 非文本兄弟节点在 flat 里的占位位置（见 collapseReviewMarks 的说明）。 */
interface HolePosition {
  flatPos: number;
  childIndex: number;
}

/**
 * flat 里给非文本子节点留的占位字符。私有区字符，真实 Markdown 文本里不会出现；
 * 它只活在本文件的定位计算里，不会进入任何输出节点。
 */
const HOLE_PLACEHOLDER = '\uE000';

interface ReviewRange {
  kind: ReviewMarkKind;
  /** 开标记的起点（flat 偏移，含）。 */
  start: number;
  /** 标记内容的起点（flat 偏移，含）。 */
  contentStart: number;
  /** 标记内容的终点（flat 偏移，不含）。 */
  contentEnd: number;
  /** 整个标记的终点（含闭合标记），游标必须跳过它。 */
  end: number;
}

/**
 * 把当前 children 里的标记（可跨子节点）折叠成 reviewInsert / delete 节点。
 * 边界情况无法安全切分时原样返回（调用侧的残留检测会兜底回退）。
 */
function collapseReviewMarks(children: RootContent[]): RootContent[] {
  const segments: TextSegment[] = [];
  const holes: HolePosition[] = [];
  let flat = '';
  for (let i = 0; i < children.length; i += 1) {
    const child = children[i];
    if (child.type !== 'text') {
      // 非文本兄弟（链接 / 图片 / 行内代码…）在 flat 里占一个不可见占位字符。
      // 少了它，「标记在洞前闭合」与「标记把洞包在内部」在 flat 上完全同形：
      // `{++部署见 [文档](u)++}` 的 flat 会退化成 `{++部署见 ++}`，折叠时只
      // 切出 `部署见 `，链接节点既不在 inner 也不在 tail，被静默丢弃。
      holes.push({ flatPos: flat.length, childIndex: i });
      flat += HOLE_PLACEHOLDER;
      continue;
    }
    const value = (child as { value: string }).value;
    if (value.length === 0) continue;
    segments.push({ childIndex: i, start: flat.length, end: flat.length + value.length });
    flat += value;
  }
  if (segments.length === 0) return children;

  const ranges: ReviewRange[] = collectReviewMarks(flat).map((mark) => ({
    kind: mark.kind,
    start: mark.start,
    contentStart: mark.start + MARK_OPEN_LENGTH,
    contentEnd: mark.end - MARK_CLOSE_LENGTH,
    end: mark.end,
  }));
  if (ranges.length === 0) return children;

  const rebuilt = rebuildWithRanges(children, segments, holes, ranges);
  return rebuilt ?? children;
}

function rebuildWithRanges(
  children: RootContent[],
  segments: TextSegment[],
  holes: HolePosition[],
  ranges: ReviewRange[],
): RootContent[] | null {
  const out: RootContent[] = [];
  let cursor: { child: number; offset: number } = { child: 0, offset: 0 };

  for (const range of ranges) {
    const open = locate(segments, holes, range.start, 'before');
    const contentStart = locate(segments, holes, range.contentStart, 'before');
    const contentEnd = locate(segments, holes, range.contentEnd, 'after');
    const after = locate(segments, holes, range.end, 'before');
    if (!open || !contentStart || !contentEnd || !after) return null;
    if (crossesBlockSibling(children, open.child, after.child)) return null;

    const prefix = sliceBetween(children, cursor, open);
    if (!prefix) return null;
    out.push(...prefix);

    const inner = sliceBetween(children, contentStart, contentEnd);
    if (!inner) return null;

    // 安全网：闭合分隔符必须原样连续（不得被洞或嵌套节点拆开）。拆分场景下
    // 上面的切分会静默丢内容或漏出游离字符，宁可放弃折叠交给残留检测回退。
    if (!isExactCloseDelimiter(children, contentEnd, after, range.kind)) return null;

    out.push(makeMarkerNode(range.kind, inner));
    cursor = after;
  }

  const tail = sliceBetween(children, cursor, { child: children.length, offset: 0 });
  if (!tail) return null;
  out.push(...tail);
  return out;
}

/** [from, to) 是否恰好就是字面的闭合分隔符（不允许夹非文本节点）。 */
function isExactCloseDelimiter(
  children: readonly RootContent[],
  from: { child: number; offset: number },
  to: { child: number; offset: number },
  kind: ReviewMarkKind,
): boolean {
  const nodes = sliceBetween(children, from, to);
  if (!nodes) return false;
  let text = '';
  for (const node of nodes) {
    if (node.type !== 'text') return false;
    text += (node as { value: string }).value;
  }
  return text === (kind === 'insert' ? '++}' : '--}');
}

/**
 * flat 偏移 → (文本子节点索引, 节点内偏移)；落在非文本区间时返回 null。
 *
 * 占位符位置（洞）按 bias 归属，这是跨节点标记能正确包含链接 / 图片的关键：
 *  - `before`：返回洞自身（洞算进该偏移之后的区间）——内容起点、游标终点用；
 *  - `after`：返回洞之后的节点（洞算进该偏移之前的区间）——内容终点用。
 * 例：`{++部署见 [文档](u)++}` 的内容终点落在 text 段末尾，`after` 让紧随的
 * 链接归 inner；`{++a++}[文档](u)` 的内容终点在段内，链接仍归 tail。
 */
function locate(
  segments: readonly TextSegment[],
  holes: readonly HolePosition[],
  offset: number,
  bias: 'before' | 'after',
): { child: number; offset: number } | null {
  // 洞优先于文本段边界：洞的 flatPos 与前一段的 end 重合时，归属由 bias 决定。
  for (const hole of holes) {
    if (hole.flatPos !== offset) continue;
    return bias === 'before'
      ? { child: hole.childIndex, offset: 0 }
      : { child: hole.childIndex + 1, offset: 0 };
  }
  for (const segment of segments) {
    if (offset >= segment.start && offset <= segment.end) {
      return { child: segment.childIndex, offset: offset - segment.start };
    }
  }
  return null;
}

/**
 * 区间内是否跨越了块级兄弟节点。块级节点不能被 <ins>/<del> 包裹，
 * 命中时调用方必须放弃这条标记（保留原样，交给残留检测回退）。
 */
function crossesBlockSibling(
  children: readonly RootContent[],
  fromChild: number,
  toChild: number,
): boolean {
  for (let i = fromChild; i <= toChild && i < children.length; i += 1) {
    const child = children[i];
    if (child.type !== 'text' && !INLINE_TYPES.has(child.type)) return true;
  }
  return false;
}

/**
 * 取 [from, to) 之间的内容：文本节点按偏移切分，非文本节点整体保留。
 * from 允许指向非文本节点且 offset=0（即 {0,0} 的起点语义，整段包含它）；
 * 其它落在非文本节点上的边界返回 null（调用方放弃折叠，保留原样）。
 */
function sliceBetween(
  children: readonly RootContent[],
  from: { child: number; offset: number },
  to: { child: number; offset: number },
): RootContent[] | null {
  if (from.child > to.child || (from.child === to.child && from.offset > to.offset)) return null;
  const out: RootContent[] = [];
  for (let i = from.child; i <= to.child && i < children.length; i += 1) {
    const child = children[i];
    const isFirst = i === from.child;
    const isLast = i === to.child;
    if (child.type === 'text') {
      const value = (child as { value: string }).value;
      const start = isFirst ? from.offset : 0;
      const end = isLast ? to.offset : value.length;
      if (end < start) return null;
      if (end > start) out.push({ type: 'text', value: value.slice(start, end) });
      continue;
    }
    if (isFirst) {
      // 起点位于非文本节点之前（{0,0}）：该节点属于区间。
      if (from.offset !== 0) return null;
      out.push(child);
      continue;
    }
    if (isLast) {
      // 终点停在非文本节点之前：不包含它，到此为止。
      if (to.offset !== 0) return null;
      return out;
    }
    out.push(child);
  }
  return out;
}

function makeMarkerNode(kind: ReviewMarkKind, children: RootContent[]): RootContent {
  if (kind === 'insert') {
    // 自定义节点类型在 @types/mdast 的 core 联合之外，断言是必要桥接；
    // 消费方只有 REVIEW_REHYPE_HANDLERS。
    return { type: 'reviewInsert', children } as unknown as RootContent;
  }
  return {
    type: 'delete',
    data: { hProperties: { className: [...REVIEW_DELETE_CLASS.split(' ')] } },
    children,
  } as unknown as RootContent;
}

function getChildren(node: Root | RootContent): RootContent[] | null {
  const children = (node as { children?: unknown }).children;
  return Array.isArray(children) ? (children as RootContent[]) : null;
}

/**
 * mdast → hast 的自定义 handler：`reviewInsert` 渲染为 <ins>（自带样式类）。
 * 形状对齐 remark-rehype 的 Handlers（该包是 react-markdown 的传递依赖，
 * 不能直接 import 类型；调用方 MarkdownRenderer 处做一次结构断言）。
 */
export const REVIEW_REHYPE_HANDLERS = {
  reviewInsert(
    state: { all: (node: { children?: unknown }) => unknown[] },
    node: { children?: unknown },
  ): { type: 'element'; tagName: 'ins'; properties: { className: string[] }; children: unknown[] } {
    return {
      type: 'element',
      tagName: 'ins',
      properties: { className: REVIEW_INSERT_CLASS.split(' ') },
      children: state.all(node),
    };
  },
};
