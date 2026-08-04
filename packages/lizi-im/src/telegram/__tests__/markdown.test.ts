import { describe, expect, it } from 'vitest';

import { markdownToTelegramHtml } from '../markdown.js';

describe('markdownToTelegramHtml', () => {
  it('HTML 实体转义(防注入)', () => {
    const { html } = markdownToTelegramHtml('a < b & <script>alert(1)</script>');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&amp;');
  });

  it('粗体/斜体/删除线/行内 code', () => {
    const { html } = markdownToTelegramHtml('**bold** *it* ~~gone~~ `x<y`');
    expect(html).toContain('<b>bold</b>');
    expect(html).toContain('<i>it</i>');
    expect(html).toContain('<s>gone</s>');
    expect(html).toContain('<code>x&lt;y</code>');
  });

  it('code fence → pre/code, 内部不解析行内标记', () => {
    const { html } = markdownToTelegramHtml('```ts\nconst a = "**not bold**";\n```');
    expect(html).toContain('<pre><code class="language-ts">');
    expect(html).toContain('**not bold**');
    expect(html).not.toContain('<b>');
  });

  it('未闭合 fence 不炸', () => {
    const { html } = markdownToTelegramHtml('```\nabc');
    expect(html).toContain('<pre><code>abc</code></pre>');
  });

  it('http(s) 链接转 <a>, 其它 scheme 保留原文', () => {
    const { html } = markdownToTelegramHtml('[x](https://a.b/c) [y](javascript:alert(1))');
    expect(html).toContain('<a href="https://a.b/c">x</a>');
    expect(html).not.toContain('href="javascript');
  });

  it('标题渲染为粗体行, 引用渲染 blockquote', () => {
    const { html } = markdownToTelegramHtml('## Title\n> quoted');
    expect(html).toContain('<b>Title</b>');
    expect(html).toContain('<blockquote>quoted</blockquote>');
  });

  it('受管图片行被抽出且整行移除', () => {
    const { html, imageUrls } = markdownToTelegramHtml(
      'before\n![img](cindy-media://blobs/abc.png)\nafter ![i2](xdt-image://s1/f.png) tail',
    );
    expect(imageUrls).toEqual(['cindy-media://blobs/abc.png', 'xdt-image://s1/f.png']);
    expect(html).toContain('before\nafter tail');
    expect(html).not.toContain('cindy-media://');
  });

  it('普通网络图片语法不进受管抽取, 降级为可点链接', () => {
    const { html, imageUrls } = markdownToTelegramHtml('![x](https://a.b/i.png)');
    expect(imageUrls).toEqual([]);
    expect(html).toBe('<a href="https://a.b/i.png">x</a>');
  });
});
