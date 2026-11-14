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
import { normalizeDisplayMathFences } from '../components/chat/normalizeDisplayMath';
import remarkStrictInlineMath from '../components/chat/remarkStrictInlineMath';

function renderMath(markdown: string): string {
  return renderToStaticMarkup(
    createElement(ReactMarkdown, {
      remarkPlugins: [remarkGfm, remarkMath, remarkStrictInlineMath],
      rehypePlugins: [[rehypeKatex, { strict: 'ignore', errorColor: 'inherit' }]],
      children: normalizeDisplayMathFences(normalizeMathDelimiters(markdown)),
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

  it('截图同形回归:首尾行带正文的跨行 $$...$$ 块不丢失首行、不吞掉后续 Markdown', () => {
    const html = renderMath([
      '### 1. 公式内容',
      '对正整数 $n$，有：',
      '$$I_n = \\begin{cases}',
      '\\dfrac{n-1}{n} \\cdot \\dfrac{n-3}{n-2}, & n \\text{ 为正偶数} \\\\[10pt]',
      '\\dfrac{n-1}{n}, & n \\text{ 为大于 } 1 \\text{ 的正奇数}',
      '\\end{cases}$$ 特例：$n=0$ 时为 $\\dfrac{\\pi}{2}$。',
      '',
      '**记忆规律**：从头乘到尾。',
      '',
      '---',
      '',
      '### 2. 它为什么成立',
    ].join('\n'));

    expect(html).toContain('katex-display');
    expect(html).not.toContain('katex-error');
    expect(html).toContain('I_n = \\begin{cases}');
    expect(html).toContain('<strong>记忆规律</strong>');
    expect(html).toContain('<hr');
    expect(html).toContain('<h3>2. 它为什么成立</h3>');
  });

  it.each([
    ['开围栏同行带正文', '$$I_n = \\begin{cases}\na \\\\\nb\n\\end{cases}\n$$'],
    ['闭围栏同行带正文', '$$\nI_n = \\begin{cases}\na \\\\\nb\n\\end{cases}$$'],
    ['行内紧接多行公式块', '对正整数 $n$，有：$$I_n = \\begin{cases}\na \\\\\nb\n\\end{cases}$$ 后文'],
    ['单行独立 $$x$$ (无空白)', '前文\n$$I_n = \\frac{n-1}{n} I_{n-2}$$\n后文'],
    ['单行独立 $$ x $$ (含首尾空白)', '前文\n$$ x = 1 $$\n后文'],
    ['引用块内非规范 $$ 块', '> $$I_n = \\begin{cases}\n> a \\\\\n> b\n> \\end{cases}$$'],
    ['列表项内非规范 $$ 块', '- $$I_n = \\begin{cases}\n  a \\\\\n  b\n  \\end{cases}$$'],
    ['LaTeX 换行 \\\\ 后接闭合 $$', '$$a \\\\\nb\\\\$$'],
  ])('%s → 产出 display KaTeX 且无错误', (_label, md) => {
    const html = renderMath(md);
    expect(html).toContain('katex-display');
    expect(html).not.toContain('katex-error');
  });

  it('行内双 dollar ($$ a + b $$ 含空格 / 同行多个 $$a$$ + $$b$$) 渲染为 inline KaTeX', () => {
    const spaced = renderMath('令 $$ a + b $$ 成立');
    expect(spaced).toContain('class="katex"');
    expect(spaced).not.toContain('katex-display');

    const pair = renderMath('$$a = 1$$ + $$b = 2$$');
    expect(pair).toContain('class="katex"');
    expect(pair).not.toContain('katex-display');
  });

  it('normalizeDisplayMathFences 保护规范块引用、代码区、转义与未闭合段落', () => {
    const canonical = '$$\nx = 1\n$$';
    expect(normalizeDisplayMathFences(canonical)).toBe(canonical);

    const inCode = '```tex\n$$I_n = \\begin{cases}\na\n\\end{cases}$$\n```\n\n用 `$$a$$` 表示';
    expect(normalizeDisplayMathFences(inCode)).toBe(inCode);

    const unclosedMidline = '价格 $$50\n\n下一段 **正常**';
    expect(normalizeDisplayMathFences(unclosedMidline)).toBe(unclosedMidline);

    const escapedClose = '$$\na \\$$ b\n$$';
    expect(normalizeDisplayMathFences(escapedClose)).toBe(escapedClose);

    const extraDollars = '$$$$\n$$$x$$$';
    expect(normalizeDisplayMathFences(extraDollars)).toBe(extraDollars);

    // 流式未闭合行首 $$I_n = \begin{cases} 拆出开围栏，避免首行被 mathFlow 当 meta 吞掉
    expect(normalizeDisplayMathFences('$$I_n = \\begin{cases}\na')).toBe(
      '$$\nI_n = \\begin{cases}\na',
    );

    // 容器边界保护: 引用块 / 列表项内未闭合 $$ 不得跨越容器边界吞并外部公式
    const quoteBoundary = '> $$\n> x = 1\n\n正文 $$y$$';
    expect(normalizeDisplayMathFences(quoteBoundary)).toBe(quoteBoundary);
    const quoteHtml = renderMath(quoteBoundary);
    expect(quoteHtml).toContain('<blockquote>');
    expect(quoteHtml).toContain('<p>正文 <span class="katex">');

    const listBoundary = '- $$\n  x = 1\n\n正文 $$y$$';
    expect(normalizeDisplayMathFences(listBoundary)).toBe(listBoundary);

    // 容器内代码围栏保护: 引用块 / 列表内的 ~~~ 与 ``` 代码块保持原样
    const containerCode = '> ~~~tex\n> $$x$$\n> ~~~\n\n- ```tex\n  $$y$$\n  ```';
    expect(normalizeDisplayMathFences(containerCode)).toBe(containerCode);
    expect(renderMath(containerCode)).not.toContain('class="katex"');

    // 对抗性未闭合反引号长度序列(k 种长度各一次)必须保持 O(n) 线性完成
    const adversarialTicks = Array.from({ length: 400 }, (_, i) => '`'.repeat(i + 1)).join('a');
    const adversarial = `$$x$$\n${adversarialTicks}`;
    const started = Date.now();
    normalizeDisplayMathFences(adversarial);
    expect(Date.now() - started).toBeLessThan(500);
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
    expect(source).toContain('preserveLineCount ? normalized : normalizeDisplayMathFences(normalized)');
    expect(source).toContain(
      'streamFade ? repairStreamingMarkdown(throttledContent) : throttledContent',
    );
  });

  it('katex CSS 已引入(缺失时公式布局完全错乱)', () => {
    expect(source).toContain("import 'katex/dist/katex.min.css'");
  });
});
