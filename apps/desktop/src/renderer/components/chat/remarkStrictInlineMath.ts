/**
 * remarkStrictInlineMath — 把 remark-math 松散配对的 inlineMath 降级回原文。
 *
 * 背景:remark-math 的单 dollar 规则沿用 code-span 语义,内容允许首尾空白、
 * 允许横跨反引号,导致「价格在 $5 和 $10 之间」被配成公式「5 和」、
 * 「$10 …;`$HOME`」可能跨 code span 配对(模拟器实测误伤后收敛的结构性
 * 修复)。本插件在 parse 后用 Pandoc 风格紧贴规则复核每个 inlineMath,
 * 不满足的整体还原成原文 text 节点。**规则与 mobile parser 的 inline math
 * matcher 保持一致**(apps/mobile messageMarkdown.ts),两端语义对齐:
 *
 * - 内容首/尾是空白 → 降级(「$5 和 $」这类货币配对)。
 * - 内容含换行 → 降级。mobile 的 inline matcher 只接受单行公式,跨行内容
 *   是正文边界误配,不能交给 KaTeX 变成跨行排版或错误色文本。
 * - 内容含反引号 → 降级(合法 LaTeX 无 backtick,必是跨 code span 误判)。
 * - 闭合 $ 后紧跟数字 → 降级(「$5和$10」CJK 无空格形态)。
 *
 * 只处理 inlineMath;display math($$ 块)语义无歧义,不动。
 */

import type { Plugin } from 'unified';
import type { Root, Text } from 'mdast';
import { visit } from 'unist-util-visit';

interface InlineMathNode {
  type: 'inlineMath';
  value: string;
  position?: {
    start: { offset?: number };
    end: { offset?: number };
  };
}

const remarkStrictInlineMath: Plugin<[], Root> = () => {
  return (tree, file) => {
    const source = String(file);
    visit(tree, 'inlineMath', (node: InlineMathNode, index, parent) => {
      if (!parent || index == null) return;
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start == null || end == null) return;
      const raw = source.slice(start, end);
      // raw 形如 "$...$" / "$$...$$";剥定界符取内側原文(node.value 已被
      // remark-math strip 过 padding,判首尾空白必须用原文)。
      const inner = raw.replace(/^\$+/, '').replace(/\$+$/, '');
      const nextChar = source[end] ?? '';
      const loose =
        /^\s|\s$/.test(inner) || inner.includes('\n') || inner.includes('`') || /^\d/.test(nextChar);
      if (!loose) return;
      const text: Text = { type: 'text', value: raw };
      parent.children[index] = text;
    });
  };
};

export default remarkStrictInlineMath;
