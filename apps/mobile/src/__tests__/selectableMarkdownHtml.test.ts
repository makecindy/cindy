import { describe, expect, it } from 'vitest';

import { buildSelectableMarkdownHtml } from '@/session/selectableMarkdownHtml';

const DOC = [
  '# 标题',        // 0
  '',
  '第一段',        // 2
  '',
  '第二段',        // 4
].join('\n');

describe('buildSelectableMarkdownHtml 渲染态行定位', () => {
  it('带 targetLine 时每个块包 data-src-line 容器(源码起始行)', () => {
    const html = buildSelectableMarkdownHtml(DOC, { targetLine: 3 });
    expect(html).toContain('<div data-src-line="0"><h1>');
    expect(html).toContain('<div data-src-line="2"><p>');
    expect(html).toContain('<div data-src-line="4"><p>');
  });

  it('无 targetLine 时保持原 HTML 结构(不包 data-src-line 容器)', () => {
    expect(buildSelectableMarkdownHtml(DOC)).not.toContain('data-src-line');
  });

  it('targetLine 注入定位脚本(1-based → 0-based),并带闪两下即移除的高亮', () => {
    const html = buildSelectableMarkdownHtml(DOC, { targetLine: 5 });
    expect(html).toContain('n<=4');
    expect(html).toContain('xdt-line-flash');
    // 高亮不驻留:动画两次迭代 + animationend 移除 class。
    expect(html).toContain('ease-in-out 2;');
    expect(html).toContain("addEventListener('animationend'");
    expect(html).toContain('classList.remove');
  });

  it('不传 targetLine 不注入脚本;非法值(0 / 非整数)同样不注入', () => {
    expect(buildSelectableMarkdownHtml(DOC)).not.toContain('<script>');
    expect(buildSelectableMarkdownHtml(DOC, { targetLine: 0 })).not.toContain('<script>');
    expect(buildSelectableMarkdownHtml(DOC, { targetLine: 1.5 })).not.toContain('<script>');
  });
});

/**
 * 代码块语法着色的 WebView 输出。
 *
 * 这里有两条性质必须同时成立,而且它们互相拉扯:着色要求把源码切片后**包上标签**,
 * 而 WebView 要求每一片都**转义**。`highlightCodeHtml` 是逐 token 拼字符串的,漏掉
 * 任何一个分支的 escapeHtml 都会变成 HTML 注入面 —— 而且注入的正是「用户/agent 贴进
 * 聊天或文档里的代码」,这类内容里带 `<script>` 完全正常。
 *
 * 单测 codeHighlight.test.ts 只覆盖分词本身(kind 与无损),不看 HTML;所以这一层的
 * 转义必须在这里钉住,不能靠"实现里写了 escapeHtml"。
 */
describe('buildSelectableMarkdownHtml 代码块语法着色', () => {
  const fence = (code: string, lang = 'ts') => ['```' + lang, code, '```'].join('\n');

  it('围栏代码块产出 syn-* span(着色确实接上了,不是静默退化为纯文本)', () => {
    const html = buildSelectableMarkdownHtml(fence('const a = 1; // c'));
    expect(html).toContain('<span class="syn-keyword">const</span>');
    expect(html).toContain('<span class="syn-number">1</span>');
    expect(html).toContain('<span class="syn-comment">// c</span>');
  });

  it('着色片段与 plain 片段都经过转义,原始尖括号不落地', () => {
    // `<script>` 落在 plain 片段;`"x"` 落在 string 片段 —— 两条分支都要转义。
    const html = buildSelectableMarkdownHtml(fence('const s = "<script>alert(1)</script>";'));
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('</script>');
    expect(html).toContain('&lt;script&gt;');
    // 引号也转义,避免从 span 属性里逃出去。
    expect(html).toContain('&quot;');
  });

  it('& 只转义一次(不出现 &amp;amp; 这类双重转义)', () => {
    const html = buildSelectableMarkdownHtml(fence('const x = a && b;'));
    expect(html).toContain('&amp;&amp;');
    expect(html).not.toContain('&amp;amp;');
  });

  it('超出着色预算的代码块退回纯文本,但仍然转义', () => {
    const long = 'const a = "<b>";\n'.repeat(2000);
    const html = buildSelectableMarkdownHtml(fence(long));
    expect(long.length).toBeGreaterThan(20_000);
    expect(html).not.toContain('<span class="syn-');
    expect(html).not.toContain('<b>');
    expect(html).toContain('&lt;b&gt;');
  });
});

/**
 * 代码块里的 `<code>` 不带行内 code 的装饰 —— 三端同一条判据:**看祖先结构,
 * 不看语言标注**。
 *
 * - 这里(WebView 面):`pre code` 祖先选择器复位,与 GitHub 的
 *   `pre code { background: transparent; padding: 0 }` 同形。
 * - 原生聊天流:解析阶段就分出 code 块 / 行内 code 两个类型(见
 *   messageMarkdown.test.ts 的无语言围栏用例)。
 * - 桌面端:rehypeFencedCodeMarker 给 `pre > code` 打结构标记(见 apps/desktop 的
 *   markdownFencedCodeInline.test.ts)。桌面端曾按「有没有 className」近似判断,
 *   ```(无语言)围栏因此被整块套上行内底色,一行一个灰条。
 *
 * 这条 CSS 规则是纯样式、没有行为面,靠代码 review 容易被当冗余删掉,所以在这里
 * 钉住。
 */
describe('buildSelectableMarkdownHtml 代码块内不套行内 code 装饰', () => {
  const css = (): string => buildSelectableMarkdownHtml('# 标题');

  it('存在 pre code 复位规则,且把底色清成 transparent', () => {
    const rule = css().match(/pre code \{([^}]*)\}/);
    expect(rule, '找不到 pre code 复位规则').toBeTruthy();
    expect(rule![1]).toMatch(/background:\s*transparent/);
  });

  it('行内 code 自己的规则仍在(复位只针对代码块内,不是全局取消)', () => {
    // `code { ... }` 独立规则:行内 code 的压暗色与等宽字体。
    expect(css()).toMatch(/\n\s*code \{[^}]*font-family/);
  });

  it('无语言标注的围栏同样进 pre(复位规则因此对它生效)', () => {
    const html = buildSelectableMarkdownHtml(['```', '任务(Session)', '```'].join('\n'));
    expect(html).toContain('<pre>');
    expect(html).toContain('<code>');
  });
});
