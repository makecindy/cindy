import { describe, expect, it } from 'vitest';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkMath from 'remark-math';
import remarkRehype from 'remark-rehype';
import rehypeKatex from 'rehype-katex';
import { visit } from 'unist-util-visit';

import rehypeReviewMathMarks from '../rehypeReviewMathMarks';

/** 两个**同形**公式（作者完全可能自己这么写）：只有来源（白名单）能区分。 */
const SOURCE =
  '$\\textcolor{currentColor}{\\sout{a}}$ 与 $\\textcolor{currentColor}{\\sout{b}}$';

function render(injectedMathFlags?: boolean[]) {
  const processor = unified()
    .use(remarkParse)
    .use(remarkMath)
    .use(remarkRehype)
    .use(rehypeKatex)
    .use(rehypeReviewMathMarks, injectedMathFlags ? { injectedMathFlags } : {});
  return processor.runSync(processor.parse(SOURCE)) as never;
}

function countByTag(tree: unknown, tagName: string): number {
  let count = 0;
  visit(tree as never, 'element', (node: { tagName?: string }) => {
    if (node.tagName === tagName) count += 1;
  });
  return count;
}

function inlineColorStyles(tree: unknown): string[] {
  const styles: string[] = [];
  visit(tree as never, 'element', (node: { properties?: Record<string, unknown> }) => {
    const style = node.properties?.style;
    if (typeof style === 'string' && style.includes('color:')) styles.push(style);
  });
  return styles;
}

describe('rehypeReviewMathMarks — 注入白名单', () => {
  it('only rewrites the math nodes the plan marked as injected', () => {
    const tree = render([false, true]);
    // 作者的第一个公式保持原样（仍是关键字内联色，没有 del），第二个被换成 <del>。
    expect(countByTag(tree, 'del')).toBe(1);
    expect(countByTag(tree, 'ins')).toBe(0);
    expect(inlineColorStyles(tree).some((style) => style.includes('color:currentColor'))).toBe(
      true,
    );
  });

  it('rewrites every node when the plan marked all of them as injected', () => {
    const tree = render([true, true]);
    expect(countByTag(tree, 'del')).toBe(2);
  });

  it('fails closed when the flag count does not match the rendered math nodes', () => {
    // 白名单与真实节点数对不上（渲染与计划不一致）就整个不改写：错标作者内容更糟。
    const tree = render([true]);
    expect(countByTag(tree, 'del')).toBe(0);
    expect(countByTag(tree, 'ins')).toBe(0);
  });

  it('keeps the legacy behaviour when no flags are passed (未接线的调用点)', () => {
    expect(countByTag(render(), 'del')).toBe(2);
  });
});
