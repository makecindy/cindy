import { describe, it } from 'vitest';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkMath from 'remark-math';
import remarkRehype from 'remark-rehype';
import rehypeKatex from 'rehype-katex';
import { visit } from 'unist-util-visit';

function render(source: string) {
  const processor = unified().use(remarkParse).use(remarkMath).use(remarkRehype).use(rehypeKatex);
  return processor.runSync(processor.parse(source)) as any;
}

describe('probe — 真实注入形态', () => {
  it('旧+新同公式', () => {
    const source = '$\\textcolor{currentColor}{\\sout{old}}\\textcolor{inherit}{\\underline{new}}$';
    const lines: string[] = [];
    visit(render(source), 'element', (node: any) => {
      const style = node.properties?.style;
      if (typeof style !== 'string' || !style.includes('color:')) return;
      const inner: string[] = [];
      visit(node, 'element', (child: any) => {
        const c = child.properties?.className;
        if (Array.isArray(c)) inner.push(...c.filter((x: string) => x === 'sout' || x === 'underline'));
      });
      lines.push(`    <${node.tagName} class="${(node.properties?.className ?? []).join('.')}" style="${style}"> contains=[${[...new Set(inner)].join(',')}]`);
    });
    console.log('--- 同公式\n' + lines.join('\n'));
  });

  it('块级公式（display）', () => {
    const source = '$$\n\\textcolor{currentColor}{\\sout{old}}\\textcolor{inherit}{\\underline{new}}\n$$';
    const lines: string[] = [];
    visit(render(source), 'element', (node: any) => {
      const style = node.properties?.style;
      if (typeof style !== 'string' || !style.includes('color:')) return;
      const inner: string[] = [];
      visit(node, 'element', (child: any) => {
        const c = child.properties?.className;
        if (Array.isArray(c)) inner.push(...c.filter((x: string) => x === 'sout' || x === 'underline'));
      });
      lines.push(`    <${node.tagName} class="${(node.properties?.className ?? []).join('.')}" style="${style}"> contains=[${[...new Set(inner)].join(',')}]`);
    });
    console.log('--- 块级\n' + lines.join('\n'));
  });
});
