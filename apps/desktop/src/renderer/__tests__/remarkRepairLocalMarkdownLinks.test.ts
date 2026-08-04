import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import { describe, expect, it } from 'vitest';
import { VFile } from 'vfile';
import { unified } from 'unified';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import type { Image, Link, Root, Text } from 'mdast';

import remarkRepairLocalMarkdownLinks, {
  RAW_LOCAL_LINK_HREF_PROP,
} from '../components/chat/remarkRepairLocalMarkdownLinks';

function parseAndRepair(markdown: string): Root {
  const tree = unified().use(remarkParse).use(remarkGfm).parse(markdown) as Root;
  (remarkRepairLocalMarkdownLinks as () => (tree: Root, file: VFile) => void)()(tree, new VFile(markdown));
  return tree;
}

function firstParagraphChildren(markdown: string) {
  return (parseAndRepair(markdown).children[0] as {
    type: 'paragraph';
    children: Array<Link | Image | Text>;
  }).children;
}

function withoutPositions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutPositions);
  if (!value || typeof value !== 'object') return value;
  const rest = { ...(value as Record<string, unknown>) };
  delete rest.position;
  return Object.fromEntries(Object.entries(rest).map(([key, child]) => [key, withoutPositions(child)]));
}

describe('remarkRepairLocalMarkdownLinks', () => {
  it('repairs an assistant link whose local image path contains spaces', () => {
    const children = firstParagraphChildren(
      '[最终 PNG](/Users/justin/Library/Application Support/Cindy/cindy-media/blobs/a/image.png)',
    );

    expect(children.map(withoutPositions)).toEqual([
      {
        type: 'link',
        url: '/Users/justin/Library/Application Support/Cindy/cindy-media/blobs/a/image.png',
        children: [{ type: 'text', value: '最终 PNG' }],
        data: {
          hProperties: {
            [RAW_LOCAL_LINK_HREF_PROP]:
              '/Users/justin/Library/Application Support/Cindy/cindy-media/blobs/a/image.png',
          },
        },
      },
    ]);
  });

  it('preserves the unencoded href beside the encoded DOM href for remote resolution', () => {
    let renderedHref: string | undefined;
    let rawHref: unknown;
    renderToStaticMarkup(
      createElement(ReactMarkdown, {
        remarkPlugins: [remarkRepairLocalMarkdownLinks],
        components: {
          a: ({ href, ...props }) => {
            renderedHref = href;
            rawHref = (props as Record<string, unknown>)[RAW_LOCAL_LINK_HREF_PROP];
            return null;
          },
        },
        children: '[remote](/remote/My File.png)',
      }),
    );

    expect(renderedHref).toBe('/remote/My%20File.png');
    expect(rawHref).toBe('/remote/My File.png');
  });

  it('turns malformed Markdown image syntax into an image node', () => {
    const children = firstParagraphChildren('![preview](/tmp/My File.png)');

    expect(children.map(withoutPositions)).toEqual([
      { type: 'image', url: '/tmp/My File.png', alt: 'preview' },
    ]);
    expect((children[0] as Image).type).toBe('image');
  });

  it('repairs text-file links too, so generated artifact lists remain usable', () => {
    const children = firstParagraphChildren(
      '[制作 manifest](/Users/justin/Library/Application Support/Cindy/work/manifest.md)',
    );

    expect((children[0] as Link).url).toBe(
      '/Users/justin/Library/Application Support/Cindy/work/manifest.md',
    );
    expect((children[0] as Link).data?.hProperties).toEqual({
      'data-cindy-raw-local-link-href': '/Users/justin/Library/Application Support/Cindy/work/manifest.md',
    });
  });

  it('keeps paired parentheses in the local filename', () => {
    const children = firstParagraphChildren(
      '[最终图](/Users/justin/Library/Application Support/Cindy/work/My File (final).png)',
    );

    expect((children[0] as Link).url).toBe(
      '/Users/justin/Library/Application Support/Cindy/work/My File (final).png',
    );
  });

  it('keeps Windows separators before paired parentheses', () => {
    const children = firstParagraphChildren(
      '[最终图](C:\\\\Users\\\\A B\\\\(final image).png)',
    );

    expect((children[0] as Link).url).toBe('C:\\Users\\A B\\(final image).png');
  });

  it('keeps relative Windows separators before paired parentheses', () => {
    const children = firstParagraphChildren(
      '[图](output\\\\My File \\\\(final image).png)',
    );

    expect((children[0] as Link).url).toBe('output\\My File \\(final image).png');
  });

  it('does not rewrite external links or valid non-link prose', () => {
    expect(firstParagraphChildren('[docs](https://example.com/a%20file.png)')).toEqual([
      expect.objectContaining({ type: 'link', url: 'https://example.com/a%20file.png' }),
    ]);
    expect(firstParagraphChildren('plain text with ]( and /tmp/a file.png').map(withoutPositions)).toEqual([
      { type: 'text', value: 'plain text with ]( and /tmp/a file.png' },
    ]);
  });

  it('does not activate explicitly escaped Markdown link syntax', () => {
    const children = firstParagraphChildren('\\[示例](/tmp/My File.md)');

    expect(children.map(withoutPositions)).toEqual([
      { type: 'text', value: '[示例](/tmp/My File.md)' },
    ]);
  });

  it('preserves explicitly escaped Markdown image syntax', () => {
    const children = firstParagraphChildren('\\![示例](/tmp/My File.png)');

    expect(children.map(withoutPositions)).toEqual([
      { type: 'text', value: '![示例](/tmp/My File.png)' },
    ]);
  });

  it('keeps escaped link syntax inactive after a decoded character reference', () => {
    const children = firstParagraphChildren('&amp; \\[示例](/tmp/My File.md)');

    expect(children.map(withoutPositions)).toEqual([
      { type: 'text', value: '& [示例](/tmp/My File.md)' },
    ]);
  });

  it('keeps escaped link syntax inactive after another Markdown escape', () => {
    const children = firstParagraphChildren('\\* \\[示例](/tmp/My File.md)');

    expect(children.map(withoutPositions)).toEqual([
      { type: 'text', value: '* [示例](/tmp/My File.md)' },
    ]);
  });

  it('keeps a character-reference opening bracket inactive', () => {
    const children = firstParagraphChildren('&#91;示例](/tmp/My File.md)');

    expect(children.map(withoutPositions)).toEqual([
      { type: 'text', value: '[示例](/tmp/My File.md)' },
    ]);
  });

  it('keeps a character-reference image marker inactive', () => {
    const children = firstParagraphChildren('&#33;[示例](/tmp/My File.png)');

    expect(children.map(withoutPositions)).toEqual([
      { type: 'text', value: '![示例](/tmp/My File.png)' },
    ]);
  });

  it('keeps escaped link syntax inactive after a CRLF line ending', () => {
    const children = firstParagraphChildren('line\r\n\\[示例](/tmp/My File.md)');

    expect(children.map(withoutPositions)).toEqual([
      { type: 'text', value: 'line\r\n[示例](/tmp/My File.md)' },
    ]);
  });

  it('still repairs an unescaped link after a CRLF line ending', () => {
    const children = firstParagraphChildren('line\r\n[示例](/tmp/My File.md)');

    expect(children.map(withoutPositions)).toEqual([
      { type: 'text', value: 'line\r\n' },
      {
        type: 'link',
        url: '/tmp/My File.md',
        children: [{ type: 'text', value: '示例' }],
        data: {
          hProperties: {
            [RAW_LOCAL_LINK_HREF_PROP]: '/tmp/My File.md',
          },
        },
      },
    ]);
  });

  it('still repairs an unescaped link after a decoded character reference', () => {
    const children = firstParagraphChildren('&amp; [示例](/tmp/My File.md)');

    expect(children.map(withoutPositions)).toEqual([
      { type: 'text', value: '& ' },
      {
        type: 'link',
        url: '/tmp/My File.md',
        children: [{ type: 'text', value: '示例' }],
        data: {
          hProperties: {
            [RAW_LOCAL_LINK_HREF_PROP]: '/tmp/My File.md',
          },
        },
      },
    ]);
  });

  it('keeps escaped link syntax inactive after named and numeric character references', () => {
    expect(firstParagraphChildren('&copy; \\[示例](/tmp/My File.md)').map(withoutPositions)).toEqual([
      { type: 'text', value: '© [示例](/tmp/My File.md)' },
    ]);
    expect(firstParagraphChildren('&#38; \\[示例](/tmp/My File.md)').map(withoutPositions)).toEqual([
      { type: 'text', value: '& [示例](/tmp/My File.md)' },
    ]);
    expect(firstParagraphChildren('&#x26; \\[示例](/tmp/My File.md)').map(withoutPositions)).toEqual([
      { type: 'text', value: '& [示例](/tmp/My File.md)' },
    ]);
  });

  it('does not rewrite malformed link syntax inside an existing link label', () => {
    const children = firstParagraphChildren('[outer [inner](/tmp/My File.md)](https://example.com)');

    expect(children.map(withoutPositions)).toEqual([
      {
        type: 'link',
        url: 'https://example.com',
        title: null,
        children: [{ type: 'text', value: 'outer [inner](/tmp/My File.md)' }],
      },
    ]);
  });

  it('does not rewrite malformed syntax nested deeper inside an existing link label', () => {
    const children = firstParagraphChildren(
      '[outer *[inner](/tmp/My File.md)*](https://example.com)',
    );

    expect(children.map(withoutPositions)).toEqual([
      {
        type: 'link',
        url: 'https://example.com',
        title: null,
        children: [
          { type: 'text', value: 'outer ' },
          {
            type: 'emphasis',
            children: [{ type: 'text', value: '[inner](/tmp/My File.md)' }],
          },
        ],
      },
    ]);
  });

  it('does not rewrite malformed syntax inside a reference link label', () => {
    const children = firstParagraphChildren(
      '[outer [inner](/tmp/My File.md)][ref]\n\n[ref]: https://example.com',
    );

    expect(children.map(withoutPositions)).toEqual([
      {
        type: 'linkReference',
        identifier: 'ref',
        label: 'ref',
        referenceType: 'full',
        children: [{ type: 'text', value: 'outer [inner](/tmp/My File.md)' }],
      },
    ]);
  });
});
