/**
 * markdownMathRendering.test.ts
 * ---------------------------------------------------------------------------
 * LaTeX 数学公式渲染的两层回归:
 *
 * 1. 管线级真实渲染:normalizeMathDelimiters → ReactMarkdown(remark-math +
 *    rehype-katex),用 renderToStaticMarkup 验证四种定界符
 *    (`$...$` / `$$...$$` / `\(...\)` / `\[...\]`)都产出 KaTeX HTML,
 *    且 code block 内的定界符不被渲染。插件组合与 MarkdownRenderer 中
 *    REMARK/REHYPE_PLUGINS 的 math 相关部分一致(完整组件依赖 Electron
 *    上下文,无法在 node env 挂载,故此处只镜像 math 链路)。
 *
 * 2. source-contract 锚定:grep MarkdownRenderer 源码,确保 remarkMath /
 *    rehypeKatex / normalizeMathDelimiters / katex CSS 四个接线点不被
 *    静默移除(任一缺失都是 silent regression:公式退回原文显示)。
 */

import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';

import { normalizeMathDelimiters } from '@cindy/maker-shared/math-markdown';
import remarkStrictInlineMath from '../components/chat/remarkStrictInlineMath';

function renderMath(markdown: string): string {
  return renderToStaticMarkup(
    createElement(ReactMarkdown, {
      remarkPlugins: [remarkGfm, remarkMath, remarkStrictInlineMath],
      rehypePlugins: [[rehypeKatex, { strict: 'ignore', errorColor: 'inherit' }]],
      children: normalizeMathDelimiters(markdown),
    }),
  );
}

describe('math rendering pipeline (remark-math + rehype-katex)', () => {
  it('$...$ → inline KaTeX', () => {
    const html = renderMath('爱因斯坦说 $E=mc^2$。');
    expect(html).toContain('class="katex"');
    expect(html).not.toContain('katex-display');
    expect(html).not.toContain('katex-error');
  });

  it('$$ block → display KaTeX', () => {
    const html = renderMath('$$\n\\int_0^1 x\\,dx = \\frac{1}{2}\n$$');
    expect(html).toContain('katex-display');
    expect(html).not.toContain('katex-error');
  });

  it('\\(...\\) → inline KaTeX(经 normalizeMathDelimiters)', () => {
    const html = renderMath('圆面积 \\(A = \\pi r^2\\) 公式');
    expect(html).toContain('class="katex"');
    expect(html).not.toContain('katex-error');
  });

  it('\\[...\\] → display KaTeX(经 normalizeMathDelimiters)', () => {
    const html = renderMath('推导:\n\\[\nx = \\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}\n\\]');
    expect(html).toContain('katex-display');
    expect(html).not.toContain('katex-error');
  });

  it('code block 内的定界符不渲染成公式', () => {
    const html = renderMath('```\n$E=mc^2$ \\(x\\)\n```');
    expect(html).not.toContain('class="katex"');
  });

  it('inline code 内的 $ 不渲染成公式', () => {
    const html = renderMath('用 `$HOME` 环境变量');
    expect(html).not.toContain('class="katex"');
  });

  it('松散配对降级:货币文本「$5 和 $10」不渲染成公式(与 mobile 规则对齐)', () => {
    const html = renderMath('价格在 $5 和 $10 之间;环境变量 `$HOME`;结束');
    expect(html).not.toContain('class="katex"');
    expect(html).toContain('$5');
    expect(html).toContain('$HOME');
  });

  it('松散配对降级:内容首尾带空白的 $ 对不渲染', () => {
    const html = renderMath('这句 $ 不是公式 $ 对吧');
    expect(html).not.toContain('class="katex"');
  });

  it('跨行 inline math 降级为正文,不触发 KaTeX', () => {
    const html = renderMath('说明 $第一行\n第二行$ 结束');
    expect(html).not.toContain('class="katex"');
    expect(html).not.toContain('katex-error');
    expect(html).toContain('第一行');
    expect(html).toContain('第二行');
  });

  it('截图同形的非法 display LaTeX 保持正文色', () => {
    const html = renderMath(String.raw`$$
\boxed{\begin{array}{l}
(\psi^{(0)},x_0) \xrightarrow{\text{流出}} \text{背景} \\
\underset{\displaystyle \rotatebox[origin=c]{-90}{$\rightsquigarrow$}}{R_1}
\end{array}}
$$`);

    expect(html).toContain('katex-error');
    expect(html).toContain('\\rotatebox');
    expect(html).toContain('style="color:inherit"');
    expect(html).not.toContain('var(--error-fg)');
  });

  it('非法单行 LaTeX 保持正文色,不使用错误红 token', () => {
    const html = renderMath('$\\frac{$');
    expect(html).toContain('katex-error');
    expect(html).toContain('style="color:inherit"');
    expect(html).not.toContain('var(--error-fg)');
  });
});

describe('MarkdownRenderer — math 接线 source contract', () => {
  const source = readFileSync(
    resolve(__dirname, '..', 'components', 'chat', 'MarkdownRenderer.tsx'),
    'utf8',
  );

  it('remarkMath 注册进两条 remark 插件链', () => {
    const pluginArrays = source.match(/const REMARK_PLUGINS\b[^=]*= \[[\s\S]*?\];/)?.[0] ?? '';
    const privilegedArrays = source.match(/const REMARK_PLUGINS_PRIVILEGED\b[^=]*= \[[\s\S]*?\];/)?.[0] ?? '';
    expect(pluginArrays).toContain('remarkMath');
    expect(privilegedArrays).toContain('remarkMath');
  });

  it('remarkStrictInlineMath 注册且排在 remarkMath 之后(松散配对降级)', () => {
    const pluginArrays = source.match(/const REMARK_PLUGINS\b[^=]*= \[[\s\S]*?\];/)?.[0] ?? '';
    expect(pluginArrays.indexOf('remarkStrictInlineMath')).toBeGreaterThan(pluginArrays.indexOf('remarkMath'));
    const privileged = source.match(/const REMARK_PLUGINS_PRIVILEGED\b[^=]*= \[[\s\S]*?\];/)?.[0] ?? '';
    expect(privileged).toContain('remarkStrictInlineMath');
  });

  it('rehypeKatex 注册且排在 rehypeHighlight 之前', () => {
    const rehypeArray = source.match(/const REHYPE_PLUGINS[\s\S]*?\];/)?.[0] ?? '';
    const katexIdx = rehypeArray.indexOf('rehypeKatex');
    const highlightIdx = rehypeArray.indexOf('rehypeHighlight');
    expect(katexIdx).toBeGreaterThan(-1);
    expect(highlightIdx).toBeGreaterThan(katexIdx);
  });

  it('normalizeMathDelimiters 在渲染前调用且 emitSourceLines 走保行数模式', () => {
    // 输入是流式修复层的输出(repairStreamingMarkdown,跟随 streamFade 总开关:
    // 关闭动效 / reduced-motion / 非流式时 repairedContent === throttledContent
    // 原引用,与动效引入前的渲染路径逐位一致)。
    expect(source).toContain('normalizeMarkdownRendererContent(repairedContent, emitSourceLines)');
    expect(source).toContain('normalizeMathDelimiters(content, { preserveLineCount })');
    expect(source).toContain(
      'streamFade ? repairStreamingMarkdown(throttledContent) : throttledContent',
    );
  });

  it('katex CSS 已引入(缺失时公式布局完全错乱)', () => {
    expect(source).toContain("import 'katex/dist/katex.min.css'");
  });
});
