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

describe('buildSelectableMarkdownHtml 本地路径不出死链', () => {
  // 本模块只服务文件阅读器 WebView,而 MarkdownFileReader 的 interceptNavigation
  // 只放行 http(s)、其余一律拦下 —— 本地路径若渲染成 <a> 就是「蓝色但点不动」的死链。
  // 阅读器里没有 chip / 远端 stat 基础设施,所以按纯文本呈现(与原生侧「未点亮 →
  // 纯文本」同语义)。

  it('markdown 形态的本地路径链接渲染成纯文本,不出 <a>', () => {
    const html = buildSelectableMarkdownHtml('见 [README.md](/Users/me/proj/README.md:17) 补充');
    expect(html).toContain('README.md');
    expect(html).not.toContain('<a href="/Users/me/proj/README.md:17"');
    expect(html).not.toContain('/Users/me/proj/README.md');
  });

  it('正文裸写的本地路径同样是纯文本', () => {
    const html = buildSelectableMarkdownHtml('见 src/App.tsx 第 20 行');
    expect(html).toContain('src/App.tsx');
    expect(html).not.toContain('<a href="src/App.tsx"');
  });

  it('http(s) 链接仍是可点 <a>(阅读器会交给系统浏览器)', () => {
    const html = buildSelectableMarkdownHtml('见 [站点](https://example.com/a.ts)');
    expect(html).toContain('<a href="https://example.com/a.ts">站点</a>');
  });

  it('会话深链渲染成不可点的 chip:保留 chip 观感,但不是 <a>、也不带 href', () => {
    const html = buildSelectableMarkdownHtml('[某会话](cindy://session/abc123)');
    expect(html).toContain('xdt-session-chip');
    expect(html).toContain('某会话');
    // 阅读器无 bridge、interceptNavigation 只放行 http(s) → 会话 chip 点不动,
    // 不该是锚点,更不该把 cindy:// 暴露成 href(PR #1144 review 实捉)。
    expect(html).not.toContain('cindy://session/abc123');
    expect(html).not.toMatch(/<a[^>]*xdt-session-chip/);
  });
});

describe('阅读器里「有下划线 = 可点」不得出现反例(DESIGN.md §14.5 规则 1)', () => {
  // 这个面唯一真的可点的是 http(s):MarkdownFileReader.interceptNavigation 只把
  // http(s) 交给 Linking.openURL,其余导航一律 return false;而且它没有任何
  // postMessage bridge,所以 chip 类元素的点击也无处可去。
  // 于是规则在这里的落地是反过来的:**只有 http(s) 能带下划线**。
  const css = (): string => buildSelectableMarkdownHtml(DOC);
  const ruleBody = (selector: string): string => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const block = new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(css());
    expect(block, `未找到 ${selector} 的样式规则`).not.toBeNull();
    return block![1];
  };

  it('外链 a 带常显下划线(它是这个面唯一真能点的东西)', () => {
    expect(ruleBody('a')).toMatch(/text-decoration:\s*underline/);
  });

  it('外链 a 必须显式 color: inherit —— 留空会掉回 UA 蓝', () => {
    // 本文件是手写 CSS 模板,没有 Tailwind preflight 的 `a { color: inherit }` 复位。
    // 留空时 UA 样式表 `a:link { color: -webkit-link }` 会盖过从 body 继承的颜色,
    // 外链渲染成浏览器默认蓝 —— 既违反「可点态只多一条下划线」,又不随 light/dark
    // 适配(PR #1144 review 实捉)。桌面靠 preflight、RN Text 靠天然继承,唯独这里
    // 需要显式声明。
    const body = ruleBody('a');
    expect(body, 'a 缺少显式 color: inherit').toMatch(/color:\s*inherit/);
    // 也不能写死某个具体色值(那是「除下划线之外还变色」的另一种形式)。
    expect(body, 'a 不得写死具体颜色').not.toMatch(/color:\s*(#|rgb|hsl)/i);
  });

  it('点不动的元素一律不带下划线,也不带 pointer', () => {
    // `img` 是直连图片(![图](https://...)):这个面没有 postMessage bridge、生成的
    // <img> 也不在链接内,点它毫无响应。上一轮只清了两个 chip、漏了这对称的另一半
    // (PR #1144 review 实捉),所以它必须和 chip 同列在这个循环里。
    for (const selector of ['img', '.xdt-image-chip', '.xdt-session-chip']) {
      const body = ruleBody(selector);
      expect(body, `${selector} 点不动却带了下划线 —— 会成为「有下划线 = 可点」的反例`)
        .not.toMatch(/text-decoration:\s*underline/);
      expect(body, `${selector} 点不动却带了 pointer`).not.toMatch(/cursor:\s*pointer/);
    }
  });

  it('本地路径 / mailto 等非 http(s) 目标不出 <a>(不可点就不该是锚点)', () => {
    expect(buildSelectableMarkdownHtml('见 [README.md](/abs/README.md) 补充'))
      .not.toMatch(/<a[^>]*README/);
    expect(buildSelectableMarkdownHtml('[联系](mailto:a@b.com)'))
      .not.toContain('<a href="mailto:');
  });
});
