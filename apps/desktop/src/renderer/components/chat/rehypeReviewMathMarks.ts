/**
 * rehypeReviewMathMarks — 把审查页公式里的修订片段包成 `<del>` / `<ins>`。
 *
 * 背景（2026-09-21 修）：`markdownMathRevision` 的公式（行内与块级同理）只能用 KaTeX
 * 内建命令表达差异：`\textcolor{currentColor}{\sout{旧}}` + `\textcolor{inherit}{\underline{新}}`。
 * KaTeX 会把它渲染成带内联 `style="color:..."` 的元素，而内联色的值不是什么主题 token。
 * 曾试图用
 * `.katex [style*='color:red'] { color: var(--diff-del-fg) !important }` 覆盖：
 * 规则确实进了产物（在 dev 的编译 CSS 里能 grep 到）、token 也有值、普通字词用同一
 * 个 token 正常上色，但这条属性选择器在审查页始终不生效（排查过变量、加载顺序、
 * `!important` 与内联样式的优先级、选择器命中范围，均无法复现为 css 侧问题）。
 *
 * 现在的做法是**不依赖任何 CSS 覆盖**：在 rehype 阶段（`rehype-katex` 之后）把这些
 * 带色元素直接替换为带修订类的 `<del>` / `<ins>`，颜色来自与普通字词**同一个**
 * Tailwind 类（`text-[var(--diff-del-fg)]` / `text-[var(--diff-add-fg)]`）。
 * 顺带把内联色删掉 —— 否则内联样式仍会盖过继承色；KaTeX 自己的 `\sout` / `\underline`
 * 线用 `currentColor`，会跟着一起变成 token 色。
 *
 * 只在审查页（`reviewAnnotations`）启用，普通聊天完全不受影响。
 */

import { REVIEW_DELETE_CLASS, REVIEW_INSERT_CLASS } from './remarkReviewAnnotations';

/**
 * 注入标记的识别条件（与 markdownMathRevision 的 MATH_DEL_COLOR / MATH_ADD_COLOR 一致）：
 * **关键字色 + 结构命令**两者同时成立。
 *
 * 为什么不用字面色值当哨兵：`#c0ffee` / `#facade` 这类“单词形十六进制”作者完全可能
 * 在自己公式里写（讲颜色的文档尤其现实），一旦碰上就会把作者内容误标成修订；而且字面
 * 色值会触发「新增硬编码色」审计 —— 而哨兵值本来就不是设计色，不该占豁免表名额。
 *
 * 为什么关键字还要配结构命令：`\textcolor{currentColor}{x}` 单写是合法的（虽然罕见），
 * 单看关键字会把作者的无操作颜色当成修订标记。实测（KaTeX 0.16.47）：
 *  - 作者只写 `\sout{x}` / `\underline{y}`：**不产生任何 color 内联样式**；
 *  - 作者只写 `\textcolor{currentColor}{x}` / `\textcolor{inherit}{y}`：有 color 样式，
 *    但**不包含** `.sout` / `.underline` 线元素。
 * 所以“关键字 + 线”叠合后不可能自然出现（同值碰撞时仍保守不标，见 markdownBlockDiff 中 `mathMarksOf` 的注释）。
 *
 * `(?<![-\w])` 前缀是为了避开 `background-color:` —— 否则作者用 `\colorbox{...}`
 * 也会被当成修订标记，而且重写时会把 `background-` 截断。
 */
const MATH_MARK_STYLE_PATTERN = /(?<![-\w])color:\s*(currentColor|inherit)\s*;?/i;

/** 结构命令的类名：删除 = 删除线，新增 = 下划线。 */
const DELETE_LINE_CLASS = 'sout';
const INSERT_LINE_CLASS = 'underline';

interface HastElementLike {
  type: 'element';
  tagName: string;
  properties?: Record<string, unknown>;
  children?: unknown[];
}

interface HastParentLike {
  type: string;
  children?: unknown[];
}

/** 插件选项：本片段内哪些数学节点是注入的（按内容顺序，与 `.katex` 一一对应）。 */
export interface RehypeReviewMathMarksOptions {
  injectedMathFlags?: readonly boolean[];
}

function isElement(node: unknown): node is HastElementLike {
  return (
    typeof node === 'object' &&
    node !== null &&
    (node as { type?: unknown }).type === 'element' &&
    typeof (node as { tagName?: unknown }).tagName === 'string'
  );
}

function hasChildren(node: unknown): node is HastParentLike & { children: unknown[] } {
  return (
    typeof node === 'object' &&
    node !== null &&
    Array.isArray((node as { children?: unknown }).children)
  );
}

/** 子树里是否含指定的 KaTeX 线元素（`.sout` / `.underline`）。 */
function containsLineClass(node: unknown, lineClass: string): boolean {
  if (isElement(node)) {
    const classes = node.properties?.className;
    if (Array.isArray(classes) && classes.includes(lineClass)) return true;
  }
  if (!hasChildren(node)) return false;
  const children = node.children;
  return children.some((child) => containsLineClass(child, lineClass));
}

/** 带 `katex` 类的元素 = 一个数学节点的渲染根（顺序与计划里的公式顺序一致）。 */
function isMathRoot(node: HastElementLike): boolean {
  const classes = node.properties?.className;
  return Array.isArray(classes) && classes.includes('katex');
}

/**
 * 深度优先遍历，把带修订内联色的元素换掉：
 *  - 处在修订包裹【外面】的（最外层）：换成 `<del>` / `<ins>` 包裹，并删除内联色；
 *  - 已经在修订包裹【里面】的：只删除内联色，交给外层容器（颜色继承，与普通字词同源）。
 *
 * 为什么必须递归：`\textcolor{currentColor}{\frac{1}{2}}` 这类结构里，KaTeX 会给**多层**
 * 元素都写上同样的内联色；只包最外层的话，内部残留的 `color:currentColor` 虽不会盖过
 * 继承色，但白送一堆无法解释的内联样式。
 *
 * 白名单门（关键）：只在本片段里**由我们注入**的数学节点内做改写。形态（关键字 +
 * 画线命令）永远分不出“谁写的”，而注入与否在计划阶段就能逐节点断定；不传白名单
 * （旧调用点 / 测试）时保持原行为，数量对不上则整个不改写（宁可不标，不能误标）。
 */
function rewriteColorMarks(
  node: HastParentLike,
  insideMark: boolean,
  gate: { flags: readonly boolean[] | null; index: number },
): void {
  const children = node.children;
  if (!children) return;
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index];
    if (!isElement(child)) {
      if (hasChildren(child)) rewriteColorMarks(child, insideMark, gate);
      continue;
    }
    if (isMathRoot(child)) {
      gate.index += 1;
      // 白名单门：不是我们注入的数学节点，整棵子树一律不改写（作者的公式原样保留）。
      if (gate.flags !== null && gate.flags[gate.index] !== true) continue;
    }
    const style = typeof child.properties?.style === 'string' ? child.properties.style : '';
    const match = style.match(MATH_MARK_STYLE_PATTERN);
    // 关键字色必须和对应的线元素同时出现才算我们的标记。
    const isDeleteLine = match ? containsLineClass(child, DELETE_LINE_CLASS) : false;
    const isInsertLine = match && !isDeleteLine ? containsLineClass(child, INSERT_LINE_CLASS) : false;
    if (!match || (!isDeleteLine && !isInsertLine)) {
      rewriteColorMarks(child, insideMark, gate);
      continue;
    }
    const isDelete = isDeleteLine;
    const nextStyle = style.replace(MATH_MARK_STYLE_PATTERN, '').trim();
    const inner: HastElementLike = {
      ...child,
      properties: { ...child.properties },
    };
    if (nextStyle) {
      inner.properties = { ...inner.properties, style: nextStyle };
    } else if (inner.properties) {
      delete inner.properties.style;
    }
    if (insideMark) {
      // 已在外层修订容器里：去色即可，颜色继承自容器的 diff token。
      children[index] = inner;
      rewriteColorMarks(inner, true, gate);
      continue;
    }
    children[index] = {
      type: 'element',
      tagName: isDelete ? 'del' : 'ins',
      properties: {
        className: (isDelete ? REVIEW_DELETE_CLASS : REVIEW_INSERT_CLASS).split(/\s+/),
      },
      children: [inner],
    };
    rewriteColorMarks(inner, true, gate);
  }
}

/** 数一遍片段里有几个数学节点（用于校验白名单长度是否一一对应）。 */
function countMathRoots(node: HastParentLike): number {
  let count = 0;
  for (const child of node.children ?? []) {
    if (isElement(child)) {
      if (isMathRoot(child)) count += 1;
      if (hasChildren(child)) count += countMathRoots(child);
    } else if (hasChildren(child)) {
      count += countMathRoots(child);
    }
  }
  return count;
}

/** rehype 插件：把公式内的修订配色换成与正文同源的 `<del>` / `<ins>` 类。 */
export default function rehypeReviewMathMarks(options: RehypeReviewMathMarksOptions = {}) {
  const flags = options.injectedMathFlags ?? null;
  return (tree: unknown): void => {
    if (!hasChildren(tree)) return;
    // 白名单长度与真实数学节点数对不上（渲染与计划不一致）就整个不改写：
    // 错标作者内容比少标严重得多。
    if (flags !== null && countMathRoots(tree) !== flags.length) return;
    rewriteColorMarks(tree, false, { flags, index: -1 });
  };
}
