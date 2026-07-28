import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { describe, expect, it } from 'vitest';

import { normalizeStrongDelimiterBoundaries } from '@/components/chat/normalizeStrongDelimiterBoundaries';

function renderMarkdown(source: string): string {
  return renderToStaticMarkup(
    createElement(
      ReactMarkdown,
      { remarkPlugins: [remarkGfm], skipHtml: true },
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
      ['`**终点站。', '**从第一轮`'].join('\n'),
      ['    **终点站。**从第一轮'].join('\n'),
    ];

    for (const source of cases) {
      expect(normalizeStrongDelimiterBoundaries(source), source).toBe(source);
    }

    expect(renderMarkdown(cases[2])).toContain('<code>**终点站。**从第一轮</code>');
    expect(renderMarkdown(cases[3])).toContain('**终点站。**从第一轮');
  });
});
