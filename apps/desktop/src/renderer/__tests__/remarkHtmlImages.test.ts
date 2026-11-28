/**
 * remarkHtmlImages.test.ts
 * ---------------------------------------------------------------------------
 * Regression coverage for model-authored HTML thumbnails like
 * `<img src="..." width="150">` in Markdown tables.
 */

import { describe, expect, it } from 'vitest';
import type { Html, Image, Root } from 'mdast';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import { visit } from 'unist-util-visit';
import remarkHtmlImages from '../components/chat/remarkHtmlImages';

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

  // Value: Markdown READMEs and reports use relative/absolute local <img src>
  // and centered <p align="center"><img .../></p> blocks; unsafe schemes and
  // mixed HTML must remain rejected.
  it('converts safe local img tags and image-only <p> blocks while keeping mixed HTML rejected', () => {
    const localImages = imagesFromMarkdown(
      [
        '<img src="./docs/hero.png" width="600" alt="Hero">',
        '',
        '<p align="center">',
        '  <img src="/abs/a.webp" alt="A" />',
        '  <img src="../shared/b.jpg" alt="B" />',
        '</p>',
      ].join('\n'),
    );
    expect(localImages.map((img) => ({ url: img.url, alt: img.alt }))).toEqual([
      { url: './docs/hero.png', alt: 'Hero' },
      { url: '/abs/a.webp', alt: 'A' },
      { url: '../shared/b.jpg', alt: 'B' },
    ]);

    expect(imagesFromMarkdown('<p>hello <img src="./a.png" /></p>')).toHaveLength(0);
    expect(imagesFromMarkdown('<img src="./secret.txt">')).toHaveLength(0);
    expect(imagesFromMarkdown('<img src="//attacker/share/a.png">')).toHaveLength(0);
  });
});
