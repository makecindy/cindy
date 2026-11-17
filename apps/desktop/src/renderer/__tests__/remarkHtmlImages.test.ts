/**
 * remarkHtmlImages.test.ts
 * ---------------------------------------------------------------------------
 * Regression coverage for model-authored HTML thumbnails like
 * `<img src="..." width="150">` in Markdown tables.
 */

import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import type { Html, Image, Root } from 'mdast';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import { visit } from 'unist-util-visit';
import remarkHtmlImages from '../components/chat/remarkHtmlImages';
import remarkHtmlText from '../components/chat/remarkHtmlText';

const transform = (remarkHtmlImages as () => (tree: Root) => void)();

function parse(markdown: string): Root {
  const tree = unified().use(remarkParse).use(remarkGfm).parse(markdown) as Root;
  transform(tree);
  return tree;
}

function imagesFromMarkdown(markdown: string): Image[] {
  const images: Image[] = [];
  visit(parse(markdown), 'image', (node: Image) => {
    images.push(node);
  });
  return images;
}

function htmlNodesFromMarkdown(markdown: string): Html[] {
  const htmlNodes: Html[] = [];
  visit(parse(markdown), 'html', (node: Html) => {
    htmlNodes.push(node);
  });
  return htmlNodes;
}

describe('remarkHtmlImages', () => {
  it('converts a raw img tag in a GFM table cell into an image node', () => {
    const images = imagesFromMarkdown(
      [
        '| Photo | Name |',
        '|---|---|',
        '| <img src="https://example.com/a.png" width="150" height="90" alt="Villa"> | Bel Lago |',
      ].join('\n'),
    );

    expect(images).toHaveLength(1);
    expect(images[0].url).toBe('https://example.com/a.png');
    expect(images[0].alt).toBe('Villa');
    expect(images[0].data?.hProperties).toEqual({ width: '150', height: '90' });
  });

  it('decodes common HTML entities in src and title attributes', () => {
    const images = imagesFromMarkdown(
      '<img src="https://example.com/a.jpg?x=1&amp;y=2" title="A &quot;view&quot;">',
    );

    expect(images).toHaveLength(1);
    expect(images[0].url).toBe('https://example.com/a.jpg?x=1&y=2');
    expect(images[0].title).toBe('A "view"');
  });

  it('decodes HTML entities only once', () => {
    const images = imagesFromMarkdown(
      '<img src="https://example.com/a.jpg?label=&amp;lt;ok&amp;gt;" title="A &amp;quot;view&amp;quot;">',
    );

    expect(images).toHaveLength(1);
    expect(images[0].url).toBe('https://example.com/a.jpg?label=&lt;ok&gt;');
    expect(images[0].title).toBe('A &quot;view&quot;');
  });

  it('rejects image src schemes that are not safe for raw HTML images', () => {
    expect(imagesFromMarkdown('<img src="javascript:alert(1)" width="150">')).toHaveLength(0);
    expect(imagesFromMarkdown('<img src="data:image/svg+xml;base64,PHN2Zz4=">')).toHaveLength(0);
    expect(imagesFromMarkdown('<img src="xdt-maker://session/abc">')).toHaveLength(0);

    const images = imagesFromMarkdown('<img src="xdt-image://session/a.png" width="150">');
    expect(images).toHaveLength(1);
    expect(images[0].url).toBe('xdt-image://session/a.png');
  });

  it('drops unsafe HTML attributes and keeps only safe image dimensions', () => {
    const images = imagesFromMarkdown(
      '<img src="https://example.com/a.png" width="150" height="90000" style="display:block" onerror="bad()">',
    );

    expect(images).toHaveLength(1);
    expect(images[0].data?.hProperties).toEqual({ width: '150' });
  });

  it('does not convert arbitrary HTML nodes', () => {
    expect(imagesFromMarkdown('<div><img src="https://example.com/a.png"></div>')).toHaveLength(0);
    expect(htmlNodesFromMarkdown('<script>alert(1)</script>')).toHaveLength(1);
  });

  it('does not touch img tags inside fenced code blocks', () => {
    const markdown = ['```html', '<img src="https://example.com/a.png" width="150">', '```'].join(
      '\n',
    );

    expect(imagesFromMarkdown(markdown)).toHaveLength(0);
    expect(htmlNodesFromMarkdown(markdown)).toHaveLength(0);
  });
});

/**
 * #10888 — production remark transforms + react-markdown/skipHtml output.
 * Existing thumbnail tests do not cover prose swallowed by one HTML-block node.
 * Minimal failing input: <div>正文</div>. Unit tier; no DOM/network/host needed.
 * The real TextLightbox → MarkdownRenderer path is also covered by the
 * attachment-preview-frame HTML-content UI scenario.
 */
function renderHtmlContent(markdown: string): string {
  return renderToStaticMarkup(createElement(ReactMarkdown, {
    remarkPlugins: [remarkGfm, remarkHtmlImages, remarkHtmlText],
    skipHtml: true,
    children: markdown,
  }));
}

describe('HTML content preservation with raw HTML disabled (#10888)', () => {
  it.each([
    ['single-line div', '<div>正文</div>', '<p>正文</p>'],
    ['multiline div', '<div>\n正文\n</div>', '<p>\n正文\n</p>'],
    ['details and nested content', '<details><summary>标题</summary><div>正文<span>嵌套</span></div></details>', '<p>标题</p>\n<p>正文嵌套</p>'],
    ['adjacent paragraphs and line breaks', '<p>第一段<br>换行</p><p>第二段</p>', '<p>第一段<br/>\n换行</p>\n<p>第二段</p>'],
    ['table cells and rows', '<table><tr><th>名称</th><th>数量</th></tr><tr><td>苹果</td><td>2</td></tr></table>', '<p>名称 | 数量</p>\n<p>苹果 | 2</p>'],
  ])('preserves readable text from %s', (_name, markdown, expected) => {
    expect(renderHtmlContent(markdown)).toBe(expected);
  });

  it('keeps decoded entities as text rather than reinterpreting markup or URLs', () => {
    expect(renderHtmlContent('<div>&lt;script&gt;literal&lt;/script&gt; &amp;lt; &copy; [safe](javascript:bad)</div>'))
      .toBe('<p>&lt;script&gt;literal&lt;/script&gt; &amp;lt; © [safe](javascript:bad)</p>');
  });

  it('discards executable subtrees, attributes and resource URLs but keeps surrounding prose', () => {
    const html = renderHtmlContent([
      '<div id="injected" style="background:url(https://evil.invalid/css)" onclick="alert(1)">Before',
      '<script>script_payload()</script><style>style_payload</style>',
      '<iframe src="https://evil.invalid/frame" srcdoc="<script>bad()</script>">frame_payload</iframe>',
      '<object data="https://evil.invalid/object">object_payload</object>',
      '<svg onload="alert(1)"><text>svg_payload</text></svg>',
      '<math><mtext>math_payload</mtext></math><template>template_payload</template>',
      '<img src="https://evil.invalid/image" onerror="alert(1)">',
      '<a href="javascript:alert(1)">Readable label</a>After</div>',
    ].join(''));
    expect(html).toBe('<p>BeforeReadable labelAfter</p>');
  });

  it('keeps ordinary Markdown, inline HTML text, code fences and existing single-image behavior', () => {
    const markdown = [
      '**Normal** and <span>inline</span>.',
      '',
      '```html',
      '<div><script>literal_code()</script></div>',
      '```',
      '',
      '<img src="https://example.com/a.png" width="150" onerror="bad()">',
      '',
      '| Column |',
      '| --- |',
      '| value |',
    ].join('\n');
    const html = renderHtmlContent(markdown);
    expect(html).toContain('<strong>Normal</strong> and inline.');
    expect(html).toContain('&lt;div&gt;&lt;script&gt;literal_code()&lt;/script&gt;&lt;/div&gt;');
    expect(html).toContain('<img src="https://example.com/a.png" alt="" width="150"/>');
    expect(html).not.toContain('onerror');
    expect(html).toContain('<td>value</td>');
  });
});
