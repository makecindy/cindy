/**
 * Regression coverage for local Markdown images whose paths contain spaces
 * or literal percent characters. The renderer must retain the original mdast
 * destination before react-markdown URL serialization makes those cases
 * ambiguous.
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import { describe, expect, it } from 'vitest';

import { normalizeMarkdownImageSrc } from '@/lib/localPathResolver';
import remarkPreserveRawLocalDestinations, {
  RAW_LOCAL_IMAGE_SRC_PROP,
} from '../components/chat/remarkPreserveRawLocalDestinations';

function normalizedImageSrc(markdown: string, workingDir = '/repo'): string | undefined {
  let normalized: string | undefined;
  renderToStaticMarkup(
    createElement(ReactMarkdown, {
      components: {
        img: ({ src, node }) => {
          const rawLocalSrc = node?.properties?.[RAW_LOCAL_IMAGE_SRC_PROP];
          normalized = normalizeMarkdownImageSrc(
            typeof rawLocalSrc === 'string' ? rawLocalSrc : src,
            workingDir,
            true,
          );
          return null;
        },
      },
      remarkPlugins: [remarkPreserveRawLocalDestinations],
      urlTransform: defaultUrlTransform,
      children: markdown,
    }),
  );
  return normalized;
}

describe('Markdown local image path encoding', () => {
  it('loads a cindy-media blob absolute path containing Application Support', () => {
    const path =
      '/Users/test/Library/Application Support/Cindy/cindy-media/blobs/aa/' +
      `${'a'.repeat(64)}.png`;

    expect(normalizedImageSrc(`![work](<${path}>)`)).toBe(
      `xdt-file://local/?path=${encodeURIComponent(path)}`,
    );
  });

  it('preserves a literal percent character next to a real space', () => {
    const path = '/tmp/100% done.png';

    expect(normalizedImageSrc(`![percent](<${path}>)`)).toBe(
      `xdt-file://local/?path=${encodeURIComponent(path)}`,
    );
  });

  it.each(['/tmp/report%20final.png', '/tmp/report%2Ffinal.png', '/tmp/report%41final.png'])(
    'preserves a valid percent sequence in the literal filename: %s',
    (path) => {
      expect(normalizedImageSrc(`![percent-sequence](<${path}>)`)).toBe(
        `xdt-file://local/?path=${encodeURIComponent(path)}`,
      );
    },
  );

  it('does not alter already-routable media URLs', () => {
    for (const url of [
      `cindy-media://blobs/${'a'.repeat(64)}.png`,
      'xdt-file://local/?path=%2Ftmp%2Falready-routed.png',
      'https://example.com/image%20name.png',
      'data:image/png;base64,AAAA',
    ]) {
      expect(normalizeMarkdownImageSrc(url, '/repo', true)).toBe(url);
    }
  });

  it('keeps malformed percent sequences instead of throwing during render', () => {
    const path = '/tmp/100%done.png';
    expect(normalizeMarkdownImageSrc(path, '/repo', true)).toBe(
      `xdt-file://local/?path=${encodeURIComponent(path)}`,
    );
  });

  it('normalizes an encoded Windows file URL to a native xdt-file path', () => {
    const path = 'C:/Users/test/My Pictures/image.png';
    expect(normalizedImageSrc('![windows](<file:///C:/Users/test/My%20Pictures/image.png>)')).toBe(
      `xdt-file://local/?path=${encodeURIComponent(path)}`,
    );
  });

  it('decodes a file URL once while preserving a literal percent sequence', () => {
    const path = '/tmp/report%20final.png';
    expect(normalizedImageSrc('![file-url](<file:///tmp/report%2520final.png>)')).toBe(
      `xdt-file://local/?path=${encodeURIComponent(path)}`,
    );
  });

  it('blocks privileged local paths in untrusted Markdown previews', () => {
    for (const src of [
      '/tmp/private.png',
      'C:\\Users\\alice\\private.png',
      'relative/private.png',
      'file:///tmp/private.png',
      'xdt-file://local/?path=%2Ftmp%2Fprivate.png',
    ]) {
      expect(normalizeMarkdownImageSrc(src, '/repo', false)).toBeUndefined();
    }
    expect(normalizeMarkdownImageSrc('https://example.com/public.png', '/repo', false)).toBe(
      'https://example.com/public.png',
    );
  });
});
