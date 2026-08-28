import { describe, expect, it } from 'vitest';

import { parseSnippetMarkup } from '../snippetMarkup';

describe('parseSnippetMarkup', () => {
  it('空串 / null 返回 null，纯空白保留', () => {
    expect(parseSnippetMarkup(null)).toBeNull();
    expect(parseSnippetMarkup('')).toBeNull();
    expect(parseSnippetMarkup('   ')).toEqual([{ text: '   ', marked: false }]);
  });

  it('默认当原文：字面 <mark> 和实体都不解码', () => {
    expect(parseSnippetMarkup('see &lt;tag&gt; here')).toEqual([
      { text: 'see &lt;tag&gt; here', marked: false },
    ]);
    expect(parseSnippetMarkup('<mark>&lt;tag&gt;</mark>')).toEqual([
      { text: '<mark>&lt;tag&gt;</mark>', marked: false },
    ]);
    expect(parseSnippetMarkup('see <mark>here</mark> 登录')).toEqual([
      { text: 'see <mark>here</mark> 登录', marked: false },
    ]);
  });

  it('protocol：不 trim 窗边缘空格', () => {
    expect(parseSnippetMarkup('  <mark>登录</mark>  ', { protocol: true })).toEqual([
      { text: '  ', marked: false },
      { text: '登录', marked: true },
      { text: '  ', marked: false },
    ]);
  });

  it('protocol：原文转义后的 <mark> 还原成字面量，不被当成控制标记', () => {
    expect(
      parseSnippetMarkup('see &lt;mark&gt;here&lt;/mark&gt; <mark>登录</mark>', { protocol: true }),
    ).toEqual([
      { text: 'see <mark>here</mark> ', marked: false },
      { text: '登录', marked: true },
    ]);
  });

  it('protocol：先还原 &amp; 再还原 &lt;，原文 &lt; 显示为字面量 &lt;', () => {
    expect(parseSnippetMarkup('a &amp; b &amp;lt; c <mark>x</mark>', { protocol: true })).toEqual([
      { text: 'a & b &lt; c ', marked: false },
      { text: 'x', marked: true },
    ]);
  });
});
