import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import katex from 'katex';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import type { Options as MarkdownOptions } from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import { describe, expect, it } from 'vitest';

import { MARKDOWN_REMARK_PLUGINS } from '@/components/chat/markdownPluginPipeline';
import rehypeReviewMathMarks from '@/components/chat/rehypeReviewMathMarks';
import {
  REVIEW_REHYPE_HANDLERS,
  remarkReviewAnnotations,
} from '@/components/chat/remarkReviewAnnotations';

import { buildMarkdownMathRevision } from '../markdownMathRevision';

/**
 * 与审查预览相同的渲染链（remark + remarkMath + KaTeX + 修订插件 + 修订上色）。
 * 公式的结构错误（例如 `$$` 后面紧跟内容、被 remarkMath 判成非块级公式）只有走这条链
 * 才会变成 katex-error —— 单跑 KaTeX 是发现不了的。
 * `rehypeReviewMathMarks` 必须与 MarkdownRenderer 的审查链同序（紧跟 rehypeKatex）。
 */
function renderLikePreview(content: string): string {
  return renderToStaticMarkup(
    createElement(ReactMarkdown, {
      remarkPlugins: [...MARKDOWN_REMARK_PLUGINS, remarkReviewAnnotations],
      remarkRehypeOptions: {
        handlers: REVIEW_REHYPE_HANDLERS,
      } as unknown as NonNullable<MarkdownOptions['remarkRehypeOptions']>,
      rehypePlugins: [
        [rehypeKatex, { strict: 'ignore', errorColor: 'inherit' }],
        rehypeReviewMathMarks,
      ],
      children: content,
    }),
  );
}

/** 注入结果里每一段公式都必须仍是合法 LaTeX（否则渲染时会变成错误占位）。 */
function expectRenderableMath(revised: string): void {
  const bodies = [...revised.matchAll(/\$\$([\s\S]*?)\$\$|\$([^$\n]+)\$/g)];
  expect(bodies.length).toBeGreaterThan(0);
  for (const match of bodies) {
    const inner = match[1] ?? match[2];
    expect(() =>
      katex.renderToString(inner, { throwOnError: true, strict: 'ignore' }),
    ).not.toThrow();
  }
}

describe('buildMarkdownMathRevision — 行内公式', () => {
  it('marks the whole formula when any part of it changes', () => {
    const revised = buildMarkdownMathRevision(
      '质量约束 $m \\le 30$ 长期有效',
      '质量约束 $m \\le 40$ 长期有效',
    );
    expect(revised).not.toBeNull();
    // 公式级粒度（用户裁决）：整条旧公式删除 + 整条新公式新增，不再标到公式内部符号。
    expect(revised).toContain(
      '$\\textcolor{#c0ffee}{\\sout{m \\le 30}}\\textcolor{#facade}{\\underline{m \\le 40}}$',
    );
    expect(revised).not.toContain('\\sout{30}');
    expect(revised).not.toContain('htmlClass');
    // 公式外的未改动文本原样保留，且没有整块标记。
    expect(revised).toContain('质量约束 ');
    expect(revised).toContain(' 长期有效');
    expect(revised).not.toContain('{--质量约束');
    expectRenderableMath(revised as string);
  });

  it('combines text-level marks outside with a whole-formula mark inside', () => {
    const revised = buildMarkdownMathRevision(
      '上限 $m \\le 30$ 保持',
      '阈值 $m \\le 40$ 保持',
    );
    expect(revised).not.toBeNull();
    expect(revised).toContain('{--上限--}');
    expect(revised).toContain('{++阈值++}');
    expect(revised).toContain(
      '$\\textcolor{#c0ffee}{\\sout{m \\le 30}}\\textcolor{#facade}{\\underline{m \\le 40}}$',
    );
    expectRenderableMath(revised as string);
  });

  it('keeps an untouched formula untouched', () => {
    const revised = buildMarkdownMathRevision(
      '定义 $\\alpha = 0.05$ 下界',
      '定义 $\\alpha = 0.05$ 上界',
    );
    expect(revised).not.toBeNull();
    expect(revised).toContain('$\\alpha = 0.05$');
    expect(revised).not.toContain('\\sout{\\alpha');
    // 中文按字符粒度切分，与通用词级路径用的是同一套 diffWordsWithSpace 行为。
    expect(revised).toContain('{--下--}');
    expect(revised).toContain('{++上++}');
  });

  it('marks a whole inline formula when it is added', () => {
    const revised = buildMarkdownMathRevision('只说结论。', '只说结论，见 $m \\le 3$ 的推导。');
    expect(revised).not.toBeNull();
    // 整公式新增：标记落在公式内部（公式外的 CriticMarkup 对块级公式会跨块）。
    expect(revised).toContain('$\\textcolor{#facade}{\\underline{m \\le 3}}$');
    expect(revised).toContain('{++，见 ++}');
    expectRenderableMath(revised as string);
  });

  it('marks a whole inline formula when it is removed', () => {
    const revised = buildMarkdownMathRevision('只说结论，见 $m \\le 3$ 的推导。', '只说结论。');
    expect(revised).not.toBeNull();
    expect(revised).toContain('$\\textcolor{#c0ffee}{\\sout{m \\le 3}}$');
    expectRenderableMath(revised as string);
  });

  it('does not mistake currency-like text for math', () => {
    const revised = buildMarkdownMathRevision('价格 $5 到 $10 之间', '价格 $5 到 $12 之间');
    expect(revised).not.toBeNull();
    expect(revised).toContain('{--10--}');
    expect(revised).toContain('{++12++}');
    expect(revised).not.toContain('\\sout');
  });

  it('returns null for blocks without math (generic path takes over)', () => {
    expect(buildMarkdownMathRevision('Beta old', 'Beta new')).toBeNull();
    expect(buildMarkdownMathRevision('', 'Beta new')).toBeNull();
  });
});

describe('buildMarkdownMathRevision — 块级公式', () => {
  it('marks the whole display formula when it changes', () => {
    const revised = buildMarkdownMathRevision(
      '$$\nJ = \\frac{1}{2m} \\sum x\n$$',
      '$$\nJ = \\frac{1}{m} \\sum x\n$$',
    );
    expect(revised).not.toBeNull();
    // 公式级：同一公式内「旧公式删除线 + 新公式下划线」，块数保持不变。
    expect(revised).toContain('\\textcolor{#c0ffee}{\\sout{');
    expect(revised).toContain('\\textcolor{#facade}{\\underline{');
    expect((revised?.match(/\$\$/g) ?? []).length).toBe(2);
    expect(revised).not.toMatch(/\\sout\{\s*2\s*\}/);
    expectRenderableMath(revised as string);
  });

  it('marks the whole long formula when one coefficient changes', () => {
    const revised = buildMarkdownMathRevision(
      '$$\nf(x) = a_0 + \\sum a_n \\cos\\frac{5n\\pi x}{L}\n$$',
      '$$\nf(x) = a_0 + \\sum a_n \\cos\\frac{7n\\pi x}{L}\n$$',
    );
    expect(revised).not.toBeNull();
    // 公式级粒度：整条公式一起上色，不再只圈出 5 / 7。
    expect(revised).toContain('\\textcolor{#c0ffee}{\\sout{');
    expect(revised).toContain('\\textcolor{#facade}{\\underline{');
    expect(revised).not.toMatch(/\\sout\{\s*5\s*\}/);
    expectRenderableMath(revised as string);
  });

  it('marks a whole display formula inside the math (no cross-block mark)', () => {
    const revised = buildMarkdownMathRevision('前面一段\n', '前面一段\n\n$$\nx = 1\n$$\n');
    expect(revised).not.toBeNull();
    // 块级公式不能吃 CriticMarkup（跨块无法折叠），标记必须落在公式内部。
    expect(revised).toMatch(/\$\$\s*\\textcolor\{#facade\}\{\\underline\{\s*x = 1\s*\}\}\s*\$\$/);
    // `$$` 必须独占行，否则 remark-math 不会把它当块级公式（渲染成 katex-error）。
    expect(revised).toMatch(/\$\$\s*\\textcolor\{#facade\}\{\\underline/);
    expectRenderableMath(revised as string);
  });
});

describe('buildMarkdownMathRevision — 渲染链回归', () => {
  it('renders every scenario through the real pipeline without katex-error', () => {
    const cases: [string, string][] = [
      ['质量约束 $m \\le 30$ 长期有效', '质量约束 $m \\le 40$ 长期有效'],
      ['上限 $m \\le 30$ 保持', '阈值 $m \\le 40$ 保持'],
      ['$$\nJ = \\frac{1}{2m} \\sum x\n$$', '$$\nJ = \\frac{1}{m} \\sum x\n$$'],
      ['只说结论。', '只说结论，见 $m \\le 3$ 的推导。'],
      ['前面一段\n', '前面一段\n\n$$\nx = 1\n$$\n'],
    ];
    for (const [before, after] of cases) {
      const revised = buildMarkdownMathRevision(before, after);
      expect(revised).not.toBeNull();
      const html = renderLikePreview(revised as string);
      expect(html).not.toContain('katex-error');
      // KaTeX 只认内建命令：一旦有人再引入 \htmlClass 这类需要 trust 的命令，
      // 这里会以字面文本形式出现在渲染结果里。
      expect(html).not.toContain('htmlClass');
    }
  });

  it('renders inline formula marks through <del>/<ins> so colors match ordinary words', () => {
    const revised = buildMarkdownMathRevision(
      '质量约束 $m \\le 30$ 长期有效',
      '质量约束 $m \\le 40$ 长期有效',
    ) as string;
    const html = renderLikePreview(revised);
    // 行内公式：颜色完全来自 del / ins（与普通字词、已有 git diff 同一套 token），
    // 公式本身仍由 KaTeX 渲染。
    expect(html).toMatch(/<del class="cindy-md-diff-del[^"]*">[\s\S]*?<\/del>/);
    expect(html).toMatch(/<ins class="cindy-md-diff-ins[^"]*">[\s\S]*?<\/ins>/);
    expect(html).not.toContain('color:red');
    // 哨兵色必须被插件消费掉：残留说明 rehype 链路没生效（会以咖啡色/淡褐色显示）。
    expect(html).not.toContain('color:#c0ffee');
    expect(html).not.toContain('color:#facade');
    expect(html).not.toContain('katex-error');
  });

  it('does not mark the author’s own red/green formulas as revisions (sentinel only)', () => {
    // 哨兵色之外的颜色不参与修订：作者原文里的 \textcolor{red} / green / 自写 hex 红
    // 都必须原样保留。旧实现按关键字匹配（color:red）会把它们误标成假删除线。
    const html = renderLikePreview(
      '作者自己的 $\\textcolor{red}{a}$、$\\textcolor{green}{b}$ 与 $\\textcolor{#ff0000}{c}$',
    );
    expect(html).toContain('color:red');
    expect(html).toContain('color:green');
    expect(html).toContain('color:#ff0000');
    expect(html).not.toContain('cindy-md-diff-del');
    expect(html).not.toContain('cindy-md-diff-ins');
    expect(html).not.toContain('katex-error');
  });

  it('merges adjacent inline formulas instead of emitting $A$$B$ (regression)', () => {
    // 旧路径会把「配对的 $a$→$c$」与「被删掉的 $b$」拼成 $A$$B$，remark-math 会当成
    // `$$` 块级定界符，KaTeX 直接报错——正是这套校验链本该拦住的事故。
    const revised = buildMarkdownMathRevision('$a$ $b$', '$c$');
    expect(revised).not.toBeNull();
    expect(revised as string).not.toMatch(/\$[^$\n]*\$\$/);
    const html = renderLikePreview(revised as string);
    expect(html).not.toContain('katex-error');
    expect(html).toContain('cindy-md-diff-del');
    expect(html).toContain('cindy-md-diff-ins');
  });

  it('does not rewrite the author’s own adjacent dollars (regression)', () => {
    // 早期实现对拼接结果跑全局正则，会把源码自带的 `$a$$5 到 $` 静默改成 `$a5 到 $`
    // （未改动内容被篡改且无标记提示）。现在只在确知两侧都是公式输出的接缝上合并，
    // 这类源码自带的相邻 `$$` 保持原样，改不动就整块回退。
    const revised = buildMarkdownMathRevision('总价 $a$$5 到 $10 万', '总价 $a$$5 到 $12 万');
    expect(revised ?? '').not.toContain('$a5 到 $');
    if (revised !== null) {
      expect(revised).toContain('$a$$5 到 $');
    }
  });

  it('keeps the newline between two deleted formulas (regression: no $$$ gluing)', () => {
    // 删除侧把纯空白文本段丢成 '' 时，`$$…$$` 的闭合 `$$` 会与下一个公式的开 `$`
    // 粘成 `$$$` → 整段退化成字面文本，哨兵 LaTeX 直接给用户看到，而校验全绿。
    const revised = buildMarkdownMathRevision('$$a$$\n$b$', '');
    expect(revised).not.toBeNull();
    expect(revised as string).not.toContain('$$$');
    const html = renderLikePreview(revised as string);
    expect(html).not.toContain('katex-error');
    expect(html).toContain('class="katex"');
    expect(html).toContain('cindy-md-diff-del');
  });

  it('rejects formula marks when the injected formula would sit next to a digit (regression)', () => {
    // `$\textcolor{…}$10` 会被渲染链的 remarkStrictInlineMath（闭合 $ 后紧跟数字）降级回
    // 字面文本 —— 哨兵 LaTeX 直接展示给用户；而 mdast 里它仍是 inlineMath 节点，
    // 基于解析树的守卫看不见这个形态。只能在拼装阶段按字符相邻拒绝。
    const revised = buildMarkdownMathRevision('价格 $5和$10', '价格 $6和$10');
    expect(revised).toBeNull();
  });

  it('colors the whole formula through <del>/<ins> (same tokens as plain words)', () => {
    // 用户裁决：公式级粒度。整条公式统一上色，不再区分分子 / 分母。
    const revised = buildMarkdownMathRevision(
      '$$\nJ = \\frac{1}{2m}\n$$',
      '$$\nJ = \\frac{1}{m}\n$$',
    ) as string;
    const html = renderLikePreview(revised);
    // 颜色不再靠 KaTeX 内联关键字色（#ff0000/#008000）——rehypeReviewMathMarks 会把它
    // 换成带 diff token 类的 <del>/<ins>，与行内公式、普通字词完全同源。
    // 注意：这里包的是公式【内部片段】（\textcolor 产生的最小包裹层），不是 katex 根。
    expect(html).toMatch(/<del class="cindy-md-diff-del[^"]*">[\s\S]*?<\/del>/);
    expect(html).toMatch(/<ins class="cindy-md-diff-ins[^"]*">[\s\S]*?<\/ins>/);
    expect(html).not.toContain('color:red');
    expect(html).not.toContain('color:green');
    expect(html).not.toContain('color:#c0ffee');
    expect(html).not.toContain('color:#facade');
    expect(html).not.toContain('katex-error');
    // 红色公式里分子与分母都在（整条公式一起标），这是预期行为。
    const redStart = html.indexOf('cindy-md-diff-del');
    const redText = html
      .slice(redStart, redStart + 1400)
      .replace(/<[^>]*>/g, '')
      .replace(/[\u200b\s]/g, '');
    expect(redText).toContain('1');
    expect(redText).toContain('2');
  });

  it('keeps the CSS hooks that map the formula marks to theme colors', () => {
    // 颜色全部走 token（hardcoded-color 审计）；属性选择器负责把 KaTeX 写死的内联
    // 关键字颜色换成 --diff-*-fg，并且必须带 !important（内联样式优先级更高）。
    const css = readFileSync(
      resolve(__dirname, '..', '..', '..', '..', '..', '..', 'styles', 'globals.css'),
      'utf8',
    );
    expect(css).toContain("[style*='color:#c0ffee']");
    expect(css).toContain("[style*='color:#facade']");
    expect(css).toContain('var(--diff-del-fg) !important');
    expect(css).toContain('var(--diff-add-fg) !important');
    // 不要再引入 :has() 上溯 —— 它会命中 \frac 外层容器。
    expect(css).not.toContain(':has(.sout)');
  });
});

describe('buildMarkdownMathRevision — 行内代码（原子跨度）', () => {
  it('marks the whole code span instead of falling back to the block', () => {
    // 代码跨度是原子：标记包在整段外面，不往反引号里插（否则标记变字面量、代码格式也丢）。
    const revised = buildMarkdownMathRevision('Run `old` now', 'Run `new` now');
    expect(revised).toBe('Run {--`old`--}{++`new`++} now');
    const html = renderLikePreview(revised as string);
    expect(html).toMatch(/<del class="cindy-md-diff-del[^"]*"><code>old<\/code><\/del>/);
    expect(html).toMatch(/<ins class="cindy-md-diff-ins[^"]*"><code>new<\/code><\/ins>/);
    expect(html).toContain('now');
  });

  it('marks a whole inserted / removed code span', () => {
    expect(buildMarkdownMathRevision('保留 `x`', '保留 `x` 与 `y`')).toContain('{++`y`++}');
    expect(buildMarkdownMathRevision('保留 `x` 与 `y`', '保留 `x`')).toContain('{--`y`--}');
  });

  it('mixes code spans with text-level marks in one paragraph', () => {
    const revised = buildMarkdownMathRevision(
      '旧值见 `old_api` 说明',
      '新值见 `new_api` 说明',
    );
    expect(revised).toContain('{--`old_api`--}{++`new_api`++}');
    expect(revised).toContain('{--旧--}{++新++}');
  });

  it('falls back when the code span itself contains CriticMarkup delimiters', () => {
    // 片段里有 `{--` / `--}` / `{++` / `++}` 时折叠器会错乱，宁可不标。
    expect(buildMarkdownMathRevision('见 `{--x--}` 说明', '见 `{--y--}` 说明')).toBeNull();
  });

  it('never marks task-list checkboxes even when the item has inline code (regression)', () => {
    // 原子路径先于通用路径尝试；缺任务守卫时会把 `- [x]` 标成 `- [{--x--} ]`，
    // remark-gfm 不再认任务项 → 复选框直接消失。
    expect(buildMarkdownMathRevision('- [x] update `config.json`', '- [ ] update `config.json`')).toBeNull();
    expect(buildMarkdownMathRevision('- [x] value $m \\le 30$', '- [ ] value $m \\le 30$')).toBeNull();
    // 大小写写法变化也是勾选标记变化，同样不能词级（taskMarkers 不做归一）。
    expect(buildMarkdownMathRevision('- [x] update `config.json`', '- [X] update `config.json`')).toBeNull();
  });

  it('fails instead of silently dropping deleted text when braces block marking (regression)', () => {
    // 旧实现碰到花括号就返回 after，而校验只比 after 侧签名 —— 删除侧内容会凭空消失、
    // 改动在预览里完全不可见。现在必须失败，让调用方回退整块装饰（改动仍可见）。
    expect(buildMarkdownMathRevision('A {x} B `c`', 'A B `c`')).toBeNull();
    expect(buildMarkdownMathRevision('a {x} b $m$', 'a {y} b $m$')).toBeNull();
    // 原文里字面的 CriticMarkup 定界符也会被折叠器消费（与通用路径同源守卫）。
    expect(buildMarkdownMathRevision('keep {--x--} `c` OLD', 'keep {--x--} `c` NEW')).toBeNull();
  });
});
