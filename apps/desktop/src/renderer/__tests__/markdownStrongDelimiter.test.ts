import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { describe, expect, it } from 'vitest';

import { normalizeMathDelimiters } from '@cindy/maker-shared/math-markdown';
import { normalizeStrongDelimiterBoundaries } from '@/components/chat/normalizeStrongDelimiterBoundaries';
import remarkStrictInlineMath from '@/components/chat/remarkStrictInlineMath';
import remarkTruncateCjkUrls from '@/components/chat/remarkTruncateCjkUrls';

function renderMarkdown(source: string): string {
  return renderToStaticMarkup(
    createElement(
      ReactMarkdown,
      { remarkPlugins: [remarkGfm, remarkTruncateCjkUrls], skipHtml: true },
      normalizeStrongDelimiterBoundaries(source),
    ),
  );
}

function renderMarkdownWithStrictMath(source: string): string {
  return renderToStaticMarkup(
    createElement(
      ReactMarkdown,
      {
        remarkPlugins: [remarkGfm, remarkMath, remarkStrictInlineMath, remarkTruncateCjkUrls],
        skipHtml: true,
      },
      normalizeStrongDelimiterBoundaries(source),
    ),
  );
}

describe('normalizeStrongDelimiterBoundaries', () => {
  it('repairs punctuation-ended strong spans followed immediately by word text', () => {
    const source = '先看：**"后续不能再卖"——这就是终点站。**从第一轮；**一、设计自由。**即时生效';
    const normalized = normalizeStrongDelimiterBoundaries(source);

    expect(normalized).toContain('这就是终点站。**<!--cindy-strong-boundary-->从第一轮');
    expect(normalized).toContain('一、设计自由。**<!--cindy-strong-boundary-->即时生效');

    const html = renderMarkdown(source);
    expect(html).toContain('<strong>&quot;后续不能再卖&quot;——这就是终点站。</strong>从第一轮');
    expect(html).toContain('<strong>一、设计自由。</strong>即时生效');
    expect(html).not.toContain('**');
  });

  it('treats Unicode symbols as CommonMark punctuation', () => {
    const emojiAfterBoundary = '**结论。**✅继续';
    const asciiSymbolBeforeBoundary = '**总计 $**Next';
    const unicodeSymbolBeforeBoundary = '**总计 €**Next';
    const emojiBeforeBoundary = '**完成 ✅**继续';

    expect(normalizeStrongDelimiterBoundaries(emojiAfterBoundary)).toBe(emojiAfterBoundary);
    expect(normalizeStrongDelimiterBoundaries(asciiSymbolBeforeBoundary)).toBe(
      '**总计 $**<!--cindy-strong-boundary-->Next',
    );
    expect(normalizeStrongDelimiterBoundaries(unicodeSymbolBeforeBoundary)).toBe(
      '**总计 €**<!--cindy-strong-boundary-->Next',
    );
    expect(normalizeStrongDelimiterBoundaries(emojiBeforeBoundary)).toBe(
      '**完成 ✅**<!--cindy-strong-boundary-->继续',
    );
    expect(renderMarkdown(emojiAfterBoundary)).toContain('<strong>结论。</strong>✅继续');
    expect(renderMarkdown(asciiSymbolBeforeBoundary)).toContain('<strong>总计 $</strong>Next');
    expect(renderMarkdown(unicodeSymbolBeforeBoundary)).toContain(
      '<strong>总计 €</strong>Next',
    );
    expect(renderMarkdown(emojiBeforeBoundary)).toContain('<strong>完成 ✅</strong>继续');
  });

  it('does not rewrite boundaries that CommonMark already closes', () => {
    const cases = [
      '**终点站**从第一轮',
      '**终点站。** 从第一轮',
      '**终点站。**，从第一轮',
      '**终点站。**',
      '前文。**重点**从后面继续',
      '前文。**未闭合',
    ];

    for (const source of cases) {
      expect(normalizeStrongDelimiterBoundaries(source), source).toBe(source);
    }
  });

  it('leaves escaped, triple-star, inline-code, and fenced-code content unchanged', () => {
    const cases = [
      '\\*\\*终点站。\\*\\*从第一轮',
      '***终点站。***从第一轮',
      '`**终点站。**从第一轮`',
      ['```md', '**终点站。**从第一轮', '```'].join('\n'),
      ['> ```md', '> **终点站。**从第一轮', '> ```'].join('\n'),
      ['- ```md', '  **终点站。**从第一轮', '  ```'].join('\n'),
      ['`**终点站。', '**从第一轮`'].join('\n'),
      ['    **终点站。**从第一轮'].join('\n'),
      '>     **终点站。**从第一轮',
      '-     **终点站。**从第一轮',
    ];

    for (const source of cases) {
      expect(normalizeStrongDelimiterBoundaries(source), source).toBe(source);
    }

    expect(renderMarkdown(cases[2])).toContain('<code>**终点站。**从第一轮</code>');
    expect(renderMarkdown(cases[3])).toContain('**终点站。**从第一轮');
    expect(renderMarkdown(cases[8])).toContain('<code>**终点站。**从第一轮');
    expect(renderMarkdown(cases[9])).toContain('<code>**终点站。**从第一轮');
  });

  it('leaves link and image destinations, reference definitions, and autolinks unchanged', () => {
    const cases = [
      '[glob](https://example.test/**index.**html)',
      '![glob](https://example.test/**index.**html)',
      ['[glob]: https://example.test/**index.**html', '', '[链接][glob]'].join('\n'),
      ['[glob]:', '  https://example.test/**index.**html', '', '[链接][glob]'].join('\n'),
      '<https://example.test/**index.**html>',
      '**[链接](https://example.test/。**next)',
    ];

    for (const source of cases) {
      expect(normalizeStrongDelimiterBoundaries(source), source).toBe(source);
    }

    expect(renderMarkdown(cases[0])).toContain('href="https://example.test/**index.**html"');
    expect(renderMarkdown(cases[1])).toContain('src="https://example.test/**index.**html"');
    expect(renderMarkdown(cases[2])).toContain('href="https://example.test/**index.**html"');
    expect(renderMarkdown(cases[3])).toContain('href="https://example.test/**index.**html"');
    expect(renderMarkdown(cases[4])).toContain('href="https://example.test/**index.**html"');
    expect(renderMarkdown('**查看 [链接](https://example.test/a)。**正文')).toContain(
      '<strong>查看 <a href="https://example.test/a">链接</a>。</strong>正文',
    );
  });

  it('repairs strong delimiters in visible link labels without rewriting destinations', () => {
    const inlineLink = '[**重点。**正文](https://example.test/**path.**next)';
    const referenceLink = ['[**重点。**正文][target]', '', '[target]: https://example.test'].join(
      '\n',
    );

    expect(normalizeStrongDelimiterBoundaries(inlineLink)).toBe(
      '[**重点。**<!--cindy-strong-boundary-->正文](https://example.test/**path.**next)',
    );
    expect(normalizeStrongDelimiterBoundaries(referenceLink)).toBe(
      [
        '[**重点。**<!--cindy-strong-boundary-->正文][target]',
        '',
        '[target]: https://example.test',
      ].join('\n'),
    );
    expect(renderMarkdown(inlineLink)).toContain(
      '<a href="https://example.test/**path.**next"><strong>重点。</strong>正文</a>',
    );
    expect(renderMarkdown(referenceLink)).toContain(
      '<a href="https://example.test"><strong>重点。</strong>正文</a>',
    );
  });

  it('repairs strong delimiters in visible image descriptions without rewriting destinations', () => {
    const inlineImage = '![**重点。**正文](https://example.test/**path.**next)';
    const referenceImage = [
      '![**重点。**正文][target]',
      '',
      '[target]: https://example.test/**path.**next',
    ].join('\n');

    expect(normalizeStrongDelimiterBoundaries(inlineImage)).toBe(
      '![重点。正文](https://example.test/**path.**next)',
    );
    expect(normalizeStrongDelimiterBoundaries(referenceImage)).toBe(
      [
        '![重点。正文][target]',
        '',
        '[target]: https://example.test/**path.**next',
      ].join('\n'),
    );
    expect(renderMarkdown(inlineImage)).toContain(
      'src="https://example.test/**path.**next" alt="重点。正文"',
    );
    expect(renderMarkdown(referenceImage)).toContain(
      'src="https://example.test/**path.**next" alt="重点。正文"',
    );
  });

  it('isolates image descriptions from unmatched strong delimiters in surrounding prose', () => {
    const source = '**outer ![text.**Next](missing.png)';

    expect(normalizeStrongDelimiterBoundaries(source)).toBe(source);
    const html = renderMarkdown(source);
    expect(html).toContain('alt="text.**Next"');
    expect(html).not.toContain('cindy-strong-boundary');
  });

  it('enters image isolation when protected syntax crosses the description start', () => {
    const source = '**outer ![`code` text.**Next](missing.png)';

    expect(normalizeStrongDelimiterBoundaries(source)).toBe(source);
    const html = renderMarkdown(source);
    expect(html).toContain('alt="code text.**Next"');
    expect(html).not.toContain('cindy-strong-boundary');
  });

  it('restores an outer strong span after scanning an image description', () => {
    const source = '**See ![alt](missing.png).**Next';

    expect(normalizeStrongDelimiterBoundaries(source)).toBe(
      '**See ![alt](missing.png).**<!--cindy-strong-boundary-->Next',
    );
    expect(renderMarkdown(source)).toContain(
      '<strong>See <img src="missing.png" alt="alt"/>.</strong>Next',
    );
  });

  it('preserves protected Markdown syntax inside image descriptions', () => {
    const inlineCode = '![`**终点。**正文`](missing.png)';

    expect(normalizeStrongDelimiterBoundaries(inlineCode)).toBe(inlineCode);
    expect(renderMarkdown(inlineCode)).toContain('src="missing.png" alt="**终点。**正文"');
  });

  it('preserves math syntax inside image descriptions', () => {
    const source = '![$2**3.**x$](missing.png)';

    expect(normalizeStrongDelimiterBoundaries(source)).toBe(source);
    expect(renderMarkdown(source)).toContain('src="missing.png" alt="$2**3.**x$"');
  });

  it('ignores closing brackets inside image-description code spans', () => {
    const source = '![`a]b` **重点。**正文](missing.png)';

    expect(normalizeStrongDelimiterBoundaries(source)).toBe(
      '![`a]b` 重点。正文](missing.png)',
    );
    expect(renderMarkdown(source)).toContain('src="missing.png" alt="a]b 重点。正文"');
  });

  it('scans a long unmatched image-description backtick run once', () => {
    const backticks = '`'.repeat(100_000);
    const source = `**outer ![\`code\`${backticks} text.**Next](missing.png)`;

    expect(normalizeStrongDelimiterBoundaries(source)).toBe(source);
    const html = renderMarkdown(source);
    expect(html).toContain('src="missing.png"');
    expect(html).not.toContain('cindy-strong-boundary');
  });

  it('scans escaped runs linearly in image descriptions', () => {
    const backslashes = '\\'.repeat(100_001);
    const source = `![${backslashes}x **重点。**正文](missing.png)`;

    expect(normalizeStrongDelimiterBoundaries(source)).toBe(
      `![${backslashes}x 重点。正文](missing.png)`,
    );
    const html = renderMarkdown(source);
    expect(html).toContain('src="missing.png"');
    expect(html).not.toContain('cindy-strong-boundary');
  });

  it('ignores closing brackets inside image-description inline HTML', () => {
    const source = '![<span title="]">x</span> **重点。**正文](missing.png)';

    expect(normalizeStrongDelimiterBoundaries(source)).toBe(
      '![<span title="]">x</span> 重点。正文](missing.png)',
    );
    expect(renderMarkdown(source)).toContain(
      'src="missing.png" alt="&lt;span title=&quot;]&quot;&gt;x&lt;/span&gt; 重点。正文"',
    );
  });

  it('ignores closing brackets inside image-description URI autolinks', () => {
    const source = '![<https://example.test/a]b> **重点。**正文](missing.png)';

    expect(normalizeStrongDelimiterBoundaries(source)).toBe(
      '![<https://example.test/a]b> 重点。正文](missing.png)',
    );
    expect(renderMarkdown(source)).not.toContain('**');
  });

  it('ignores closing brackets inside image-description link destinations', () => {
    const source = '![[x](https://example.test/a]b) **重点。**正文](missing.png)';

    expect(normalizeStrongDelimiterBoundaries(source)).toBe(
      '![[x](https://example.test/a]b) 重点。正文](missing.png)',
    );
    expect(renderMarkdown(source)).not.toContain('**');
  });

  it('repairs strong delimiters in CJK prose recovered from a bare URL', () => {
    const source = 'https://example.com/foo（**重点。**正文';

    expect(normalizeStrongDelimiterBoundaries(source)).toBe(
      'https://example.com/foo<!--cindy-strong-boundary-->（**重点。**<!--cindy-strong-boundary-->正文',
    );
    expect(renderMarkdown(source)).toContain(
      '<a href="https://example.com/foo">https://example.com/foo</a>（<strong>重点。</strong>正文',
    );
  });

  it('uses source offsets when a recovered bare URL tail follows a character reference', () => {
    const source = 'https://a.test/x?a=1&amp;b=2（**重点。**正文';

    expect(normalizeStrongDelimiterBoundaries(source)).toBe(
      'https://a.test/x?a=1&amp;b=2<!--cindy-strong-boundary-->（**重点。**<!--cindy-strong-boundary-->正文',
    );
    expect(renderMarkdown(source)).toContain(
      '<a href="https://a.test/x?a=1&amp;amp;b=2">https://a.test/x?a=1&amp;amp;b=2</a>（<strong>重点。</strong>正文',
    );
  });

  it('protects bare URLs regenerated inside recovered CJK tails', () => {
    const source = 'https://a.test/x（https://b.test/**foo.**bar';

    expect(normalizeStrongDelimiterBoundaries(source)).toBe(source);
    expect(renderMarkdown(source)).toContain(
      '<a href="https://b.test/**foo.**bar">https://b.test/**foo.**bar</a>',
    );
  });

  it('classifies image descriptions recovered from CJK-truncated bare URL tails', () => {
    const source = 'https://example.com/foo（![**重点。**正文](missing.png)';

    expect(normalizeStrongDelimiterBoundaries(source)).toBe(
      'https://example.com/foo<!--cindy-strong-boundary-->（![重点。正文](missing.png)',
    );
    const html = renderMarkdown(source);
    expect(html).toContain(
      '<a href="https://example.com/foo">https://example.com/foo</a>（<img src="missing.png" alt="重点。正文"/>',
    );
    expect(html).not.toContain('cindy-strong-boundary');
  });

  it('protects nested bare URLs regenerated inside recovered CJK tails', () => {
    const source = 'https://a.test/x（https://b.test/y（https://c.test/**path.**more）';

    expect(normalizeStrongDelimiterBoundaries(source)).toBe(source);
    expect(renderMarkdown(source)).toContain(
      '<a href="https://c.test/**path.**more">https://c.test/**path.**more</a>）',
    );
  });

  it('protects math syntax recovered from CJK-truncated bare URL tails', () => {
    const source = 'https://example.com/foo（$2**3.**x$';

    expect(normalizeStrongDelimiterBoundaries(source)).toBe(
      'https://example.com/foo<!--cindy-strong-boundary-->（$2**3.**x$',
    );
    const html = renderMarkdownWithStrictMath(source);
    expect(html).toContain('<code class="language-math math-inline">2**3.**x</code>');
    expect(html).not.toContain('cindy-strong-boundary');
  });

  it('escapes loose math delimiters recovered from CJK-truncated bare URL tails', () => {
    const source = 'https://example.com/foo（$5 **重点。**正文 $10';

    expect(normalizeStrongDelimiterBoundaries(source)).toBe(
      'https://example.com/foo<!--cindy-strong-boundary-->（\\$5 **重点。**<!--cindy-strong-boundary-->正文 \\$10',
    );
    const html = renderMarkdownWithStrictMath(source);
    expect(html).toContain(
      '<a href="https://example.com/foo">https://example.com/foo</a>（$5 <strong>重点。</strong>正文 $10',
    );
    expect(html).not.toContain('cindy-strong-boundary');
  });

  it('does not reparse unrelated math in recovered bare URL tails', () => {
    const source = ['https://example.com/foo（$x$', '', '**重点。**正文'].join('\n');

    expect(normalizeStrongDelimiterBoundaries(source)).toBe(
      ['https://example.com/foo（$x$', '', '**重点。**<!--cindy-strong-boundary-->正文'].join('\n'),
    );
  });

  it('bounds recovered-tail reparsing to each bare URL', () => {
    const source = [
      ...Array.from(
        { length: 1_000 },
        (_, index) => `https://example-${index}.com/foo（说明 `,
      ),
      '**重点。**正文',
    ].join('');

    expect(normalizeStrongDelimiterBoundaries(source)).toBe(
      source.replace('**正文', '**<!--cindy-strong-boundary-->正文'),
    );
  });

  it('preserves an open strong span across single-star content', () => {
    expect(renderMarkdown('**This is *very* important.**Next')).toContain(
      '<strong>This is <em>very</em> important.</strong>Next',
    );
    expect(renderMarkdown('**2 * 3.**Next')).toContain('<strong>2 * 3.</strong>Next');
  });

  it('leaves inline and display math bodies unchanged', () => {
    const cases = [
      '$2**3.**x$',
      ['$$', '2**3.**x', '$$'].join('\n'),
      '\\(2**3.**x\\)',
      ['\\[', '2**3.**x', '\\]'].join('\n'),
    ];

    for (const source of cases) {
      const normalizedMath = normalizeMathDelimiters(source);
      expect(normalizeStrongDelimiterBoundaries(normalizedMath), source).toBe(normalizedMath);
    }

    expect(normalizeStrongDelimiterBoundaries('$2**3.**x$ **重点。**正文')).toBe(
      '$2**3.**x$ **重点。**<!--cindy-strong-boundary-->正文',
    );
  });

  it('protects TeX delimiters preserved for source-line anchors', () => {
    const cases = ['\\[2**3.**x\\]', ['\\(', '2**3.**x', '\\)'].join('\n')];

    for (const source of cases) {
      const normalizedMath = normalizeMathDelimiters(source, { preserveLineCount: true });
      expect(normalizedMath, source).toBe(source);
      expect(
        normalizeStrongDelimiterBoundaries(normalizedMath, { preserveTexDelimiters: true }),
        source,
      ).toBe(source);
    }

    const prose = '**重点。**正文';
    expect(normalizeStrongDelimiterBoundaries(prose, { preserveTexDelimiters: true })).toBe(
      '**重点。**<!--cindy-strong-boundary-->正文',
    );
  });

  it('ignores escaped backslashes when pairing preserved TeX delimiters', () => {
    const escapedDisplay = '\\\\[ **重点。**正文 \\\\]';

    expect(
      normalizeStrongDelimiterBoundaries(escapedDisplay, { preserveTexDelimiters: true }),
    ).toBe('\\\\[ **重点。**<!--cindy-strong-boundary-->正文 \\\\]');
  });

  it('ignores preserved TeX delimiters inside protected Markdown syntax', () => {
    const cases = [
      '[x](https://a.test/\\(foo) **重点。**正文 \\)',
      '![x](https://a.test/\\[foo) **重点。**正文 \\]',
      '`\\(foo` **重点。**正文 \\)',
    ];

    for (const source of cases) {
      expect(
        normalizeStrongDelimiterBoundaries(source, { preserveTexDelimiters: true }),
        source,
      ).toBe(source.replace('**正文', '**<!--cindy-strong-boundary-->正文'));
    }
  });

  it('repairs affected markup when loose inline math is downgraded to text', () => {
    const source = '$2**3.**x $';

    expect(normalizeStrongDelimiterBoundaries(source)).toBe(
      '\\$2**3.**<!--cindy-strong-boundary-->x \\$',
    );
    const html = renderMarkdownWithStrictMath(source);
    expect(html).toContain('$2<strong>3.</strong>x $');
    expect(html).not.toContain('cindy-strong-boundary');
  });

  it('repairs strong markup when loose inline math is downgraded to visible text', () => {
    const source = '$5 **重点。**正文 $10';

    expect(normalizeStrongDelimiterBoundaries(source)).toBe(
      '\\$5 **重点。**<!--cindy-strong-boundary-->正文 \\$10',
    );
    const html = renderMarkdownWithStrictMath(source);
    expect(html).toContain('$5 <strong>重点。</strong>正文 $10');
    expect(html).not.toContain('**');
    expect(html).not.toContain('cindy-strong-boundary');
  });

  it('protects nested Markdown syntax when loose inline math is downgraded to visible text', () => {
    const codeOnly = '$foo `**重点。**正文` bar$';
    expect(normalizeStrongDelimiterBoundaries(codeOnly)).toBe(codeOnly);
    expect(renderMarkdownWithStrictMath(codeOnly)).not.toContain('cindy-strong-boundary');

    const source =
      '$foo `**代码。**正文` [链接](https://a.test/**path.**next) <span title="**attr.**next">标签</span> **重点。**正文 bar$';
    expect(normalizeStrongDelimiterBoundaries(source)).toBe(
      '\\$foo `**代码。**正文` [链接](https://a.test/**path.**next) <span title="**attr.**next">标签</span> **重点。**<!--cindy-strong-boundary-->正文 bar\\$',
    );
    const html = renderMarkdownWithStrictMath(source);
    expect(html).toContain(
      '$foo <code>**代码。**正文</code> <a href="https://a.test/**path.**next">链接</a> 标签 <strong>重点。</strong>正文 bar$',
    );
    expect(html).not.toContain('cindy-strong-boundary');
  });

  it('classifies image descriptions inside loose math downgraded to visible text', () => {
    const source = '$foo ![**重点。**正文](missing.png) bar $';

    expect(normalizeStrongDelimiterBoundaries(source)).toBe(
      '\\$foo ![重点。正文](missing.png) bar \\$',
    );
    const html = renderMarkdownWithStrictMath(source);
    expect(html).toContain('$foo <img src="missing.png" alt="重点。正文"/> bar $');
    expect(html).not.toContain('cindy-strong-boundary');
  });

  it('handles many protected spans and ordinary backslashes in source-line mode', () => {
    const protectedSpans = Array.from({ length: 2_000 }, (_, index) => `\`code-${index}\``).join(
      ' ',
    );
    const ordinaryBackslashes = '\\x '.repeat(2_000);
    const source = `${protectedSpans} ${ordinaryBackslashes}**重点。**正文`;

    expect(normalizeStrongDelimiterBoundaries(source, { preserveTexDelimiters: true })).toBe(
      source.replace('**正文', '**<!--cindy-strong-boundary-->正文'),
    );
  });

  it('handles a long escaped-backslash run in source-line mode', () => {
    const source = `${'\\'.repeat(20_000)}x **重点。**正文`;

    expect(normalizeStrongDelimiterBoundaries(source, { preserveTexDelimiters: true })).toBe(
      source.replace('**正文', '**<!--cindy-strong-boundary-->正文'),
    );
  });

  it('handles many paragraphs and preserved TeX ranges in source-line mode', () => {
    const source = Array.from(
      { length: 1_000 },
      (_, index) => `\\[formula_${index}**3.**x\\]\n\n段落 ${index}：**重点。**正文`,
    ).join('\n\n');

    expect(normalizeStrongDelimiterBoundaries(source, { preserveTexDelimiters: true })).toBe(
      source.replaceAll('**正文', '**<!--cindy-strong-boundary-->正文'),
    );
  });

  it('handles many loose math spans and strong-boundary repairs without cross-product scans', () => {
    const source = [
      ...Array.from({ length: 2_000 }, (_, index) => `$value_${index} $`),
      ...Array.from({ length: 2_000 }, (_, index) => `段落 ${index}：**重点。**正文`),
    ].join('\n\n');

    expect(normalizeStrongDelimiterBoundaries(source)).toBe(
      source.replaceAll('**正文', '**<!--cindy-strong-boundary-->正文'),
    );
  });

  it('handles many image descriptions and unrelated repairs without cross-product scans', () => {
    const source = [
      ...Array.from({ length: 2_000 }, (_, index) => `![图片 ${index}](missing-${index}.png)`),
      ...Array.from({ length: 2_000 }, (_, index) => `段落 ${index}：**重点。**正文`),
    ].join('\n\n');

    expect(normalizeStrongDelimiterBoundaries(source)).toBe(
      source.replaceAll('**正文', '**<!--cindy-strong-boundary-->正文'),
    );
  });

  it('applies many boundary repairs without repeatedly rebuilding the document', () => {
    const source = Array.from(
      { length: 5_000 },
      (_, index) => `段落 ${index}：**重点。**正文`,
    ).join('\n\n');

    expect(normalizeStrongDelimiterBoundaries(source)).toBe(
      source.replaceAll('**正文', '**<!--cindy-strong-boundary-->正文'),
    );
  });

  it('leaves historical bare project deep links unchanged', () => {
    const source = '打开 cindy://project/%2Ftmp%2Ffoo**bar.**baz 查看';

    expect(normalizeStrongDelimiterBoundaries(source)).toBe(source);
  });

  it('treats unmatched backticks as prose instead of suppressing later repairs', () => {
    const source = ['`unfinished', '**重点。**下一句'].join('\n');
    const sameLine = '`unfinished **重点。**下一句';
    const invalidBacktickFence = '```foo``` **重点。**下一句';

    expect(normalizeStrongDelimiterBoundaries(source)).toBe(
      ['`unfinished', '**重点。**<!--cindy-strong-boundary-->下一句'].join('\n'),
    );
    expect(normalizeStrongDelimiterBoundaries(sameLine)).toBe(
      '`unfinished **重点。**<!--cindy-strong-boundary-->下一句',
    );
    expect(normalizeStrongDelimiterBoundaries(invalidBacktickFence)).toBe(
      '```foo``` **重点。**<!--cindy-strong-boundary-->下一句',
    );
    expect(renderMarkdown(source)).toContain('<strong>重点。</strong>下一句');
    expect(renderMarkdown(invalidBacktickFence)).toContain('<strong>重点。</strong>下一句');
  });

  it('normalizes indented paragraph continuations but not actual indented code blocks', () => {
    const paragraphContinuation = ['intro', '    **重点。**下一句'].join('\n');
    const indentedCode = ['', '    **重点。**下一句'].join('\n');
    const mixedIndentationCode = ['', ' \t**重点。**下一句'].join('\n');

    expect(normalizeStrongDelimiterBoundaries(paragraphContinuation)).toBe(
      ['intro', '    **重点。**<!--cindy-strong-boundary-->下一句'].join('\n'),
    );
    expect(normalizeStrongDelimiterBoundaries(indentedCode)).toBe(indentedCode);
    expect(normalizeStrongDelimiterBoundaries(mixedIndentationCode)).toBe(mixedIndentationCode);
    expect(renderMarkdown(paragraphContinuation)).toContain('<strong>重点。</strong>下一句');
    expect(renderMarkdown(indentedCode)).toContain('<code>**重点。**下一句');
    expect(renderMarkdown(mixedIndentationCode)).toContain('<code>**重点。**下一句');
  });

  it('leaves raw HTML regions unchanged without suppressing later prose repairs', () => {
    const cases = [
      'prefix <!-- **hidden.**visible --> suffix',
      '<span data-value="**hidden.**visible">正文</span>',
      ['<script>', '**hidden.**visible', '</script>'].join('\n'),
      ['<div>', '**hidden.**visible', '</div>'].join('\n'),
    ];

    for (const source of cases) {
      expect(normalizeStrongDelimiterBoundaries(source), source).toBe(source);
    }

    const followedByProse = ['<!-- **hidden.**visible -->', '', '**重点。**正文'].join('\n');
    expect(normalizeStrongDelimiterBoundaries(followedByProse)).toBe(
      ['<!-- **hidden.**visible -->', '', '**重点。**<!--cindy-strong-boundary-->正文'].join('\n'),
    );
    expect(renderMarkdown(followedByProse)).toContain('<strong>重点。</strong>正文');
  });

  it('resets unmatched strong state at Markdown block boundaries', () => {
    const source = ['**orphan', '# heading', 'x**重点。**正文'].join('\n');

    expect(normalizeStrongDelimiterBoundaries(source)).toBe(
      ['**orphan', '# heading', 'x**重点。**<!--cindy-strong-boundary-->正文'].join('\n'),
    );
    expect(renderMarkdown(source)).toContain('<strong>重点。</strong>正文');
  });
});
