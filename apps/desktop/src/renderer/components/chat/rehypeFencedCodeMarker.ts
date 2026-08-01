/**
 * rehypeFencedCodeMarker — 给代码块内的 `<code>` 打上结构标记。
 *
 * 「这个 `<code>` 是行内 code 还是代码块的一部分」在 hast 里只能由父节点回答:
 * mdast 的 `inlineCode` / `code` 两类节点转成 hast 后都是 `<code>`,区别只剩
 * 「外面是否包着 `<pre>`」。react-markdown 的 components 映射按 tagName 分派、
 * 拿不到父节点,于是历史实现退而用「有没有 className」近似判断——而 className
 * 来自 rehype-highlight,它只给**带语言标注**的围栏加 `hljs language-xxx`。
 * 结果 ```(无语言)围栏与 4 空格缩进代码块的 `<code>` 没有 className,被误判成
 * 行内 code:套上行内底色 + 内距(inline 元素逐行画底,整块代码变成一行一个灰
 * 条),内容还会被送进文件路径检测。
 *
 * 本插件排在 rehype 链最后(rehype-katex 已把 `$$…$$` 的 `<pre><code>` 消费掉,
 * rehype-highlight 也已注入 hljs span),遍历 `<pre>` 给其 `<code>` 子节点加
 * `data-fenced-code`,让 MarkdownRenderer 按结构而不是按语言标注分派。
 * 这与 GitHub 的 `pre code { background: transparent; padding: 0 }` 是同一条
 * 判据(祖先关系),也与移动端 WebView 面的 `pre code` 复位规则一致。
 *
 * 标记刻意用 data 属性而不是往 className 里塞值:className 是 highlight.js 的
 * 地盘,且 `isDiffCodeChild` / `isMermaidCodeChild` 用正则匹配它来分流
 * ```diff / ```mermaid,混入结构信息会互相干扰。属性留在 DOM 上,devtools 与
 * 回归测试都能直接看到这个分派依据。
 */

import type { Plugin } from 'unified';
import type { Element, Root } from 'hast';
import { visit } from 'unist-util-visit';

/** hast property 名(camelCase);序列化到 DOM 即 `data-fenced-code`。 */
export const FENCED_CODE_PROP = 'dataFencedCode';

/** DOM / JSX 上的属性名,供渲染层与测试断言复用。 */
export const FENCED_CODE_ATTR = 'data-fenced-code';

export const rehypeFencedCodeMarker: Plugin<[], Root> = () => {
  return (tree) => {
    visit(tree, 'element', (node: Element) => {
      if (node.tagName !== 'pre') return;
      for (const child of node.children) {
        // 只认 `<pre>` 的直接 `<code>` 子节点——这正是 mdast `code` 节点转出来的
        // 形状。更深层的 `<code>`(如 pre 里手写的嵌套 HTML)不在此语义内。
        if (child.type !== 'element' || child.tagName !== 'code') continue;
        child.properties = { ...child.properties, [FENCED_CODE_PROP]: '' };
      }
    });
  };
};
