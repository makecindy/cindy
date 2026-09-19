/**
 * rehypeReviewMathMarks — 把审查页公式里的修订片段包成 `<del>` / `<ins>`。
 *
 * 背景（2026-09-20 修）：`markdownMathRevision` 的公式（行内与块级同理）只能用 KaTeX
 * 内建命令表达差异：`\textcolor{<哨兵色>}{\sout{旧}}` + `\textcolor{<哨兵色>}{\underline{新}}`。
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
 * 注入标记的**哨兵色**（与 markdownMathRevision 的 MATH_DEL_COLOR / MATH_ADD_COLOR 一字不差）。
 *
 * 不能用 `red` / `green` 这类通用颜色：审查文档里作者自己写的 `\textcolor{red}{...}` 会
 * 渲染出同样的内联色，本插件分不清「注入的修订标记」和「作者原本的颜色」，会把没改动的
 * 红色内容凭空标成删除。哨兵值在真实文档里不可能出现，锚点与语义才能一一对应。
 *
 * `(?<![-\w])` 前缀是为了避开 `background-color:` —— 否则作者用 `\colorbox{red}{...}`
 * 也会被当成修订标记，而且重写时会把 `background-` 截断。
 */
const MATH_MARK_STYLE_PATTERN = /(?<![-\w])color:\s*(#c0ffee|#facade)\s*;?/i;

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

function isElement(node: unknown): node is HastElementLike {
  return (
    typeof node === 'object' &&
    node !== null &&
    (node as { type?: unknown }).type === 'element' &&
    typeof (node as { tagName?: unknown }).tagName === 'string'
  );
}

function hasChildren(node: unknown): node is HastParentLike {
  return (
    typeof node === 'object' &&
    node !== null &&
    Array.isArray((node as { children?: unknown }).children)
  );
}

/**
 * 深度优先遍历，把带修订内联色的元素换掉：
 *  - 处在修订包裹【外面】的（最外层）：换成 `<del>` / `<ins>` 包裹，并删除内联色；
 *  - 已经在修订包裹【里面】的：只删除内联色，交给外层容器（颜色继承，与普通字词同源）。
 *
 * 为什么必须递归：`\textcolor{#c0ffee}{\frac{1}{2}}` 这类结构里，KaTeX 会给**多层**
 * 元素都写上同样的内联色；只包最外层的话，内部残留的 `color:red` 依然会盖过
 * 继承色，等于没改。
 */
function rewriteColorMarks(node: HastParentLike, insideMark: boolean): void {
  const children = node.children;
  if (!children) return;
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index];
    if (!isElement(child)) {
      if (hasChildren(child)) rewriteColorMarks(child, insideMark);
      continue;
    }
    const style = typeof child.properties?.style === 'string' ? child.properties.style : '';
    const match = style.match(MATH_MARK_STYLE_PATTERN);
    if (!match) {
      rewriteColorMarks(child, insideMark);
      continue;
    }
    const isDelete = match[1]?.toLowerCase() === '#c0ffee';
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
      rewriteColorMarks(inner, true);
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
    rewriteColorMarks(inner, true);
  }
}

/** rehype 插件：把公式内的修订配色换成与正文同源的 `<del>` / `<ins>` 类。 */
export default function rehypeReviewMathMarks() {
  return (tree: unknown): void => {
    if (hasChildren(tree)) rewriteColorMarks(tree, false);
  };
}
