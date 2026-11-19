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
import remarkBareSpaceLocalImages from '../components/chat/remarkBareSpaceLocalImages';
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
      remarkPlugins: [remarkBareSpaceLocalImages, remarkPreserveRawLocalDestinations],
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
      'xdt-image://session-id/image%20name.png',
      'xdt-image://generated/image.png',
    ]) {
      expect(normalizeMarkdownImageSrc(url, '/repo', true)).toBe(url);
    }
  });

  it('normalizes legacy path-shaped xdt-file image URLs for the custom protocol', () => {
    const path = 'D:/Users/test/My Pictures/image.png';
    expect(normalizeMarkdownImageSrc(`xdt-file:///${path}`, '/repo', true)).toBe(
      `xdt-file://local/?path=${encodeURIComponent(path)}`,
    );
  });

  // #8951: exercise Markdown serialization as well as the URL bridge. These
  // URI paths have stable '/' separators on every host (unit tier).
  it.each([
    ['xdt-image:///C:/My Pictures/shot (100%).png', 'C:/My Pictures/shot (100%).png'],
    ['xdt-image:///tmp/My Pictures/shot (100%).png', '/tmp/My Pictures/shot (100%).png'],
    ['xdt-image:///C:/My%20Pictures/shot%20(100%25).png', 'C:/My Pictures/shot (100%).png'],
    ['xdt-image:///tmp/report%2520final.png', '/tmp/report%20final.png'],
    ['xdt-file:///tmp/My%20Pictures/100%.png', '/tmp/My%20Pictures/100%.png'],
  ])('loads the original hostless Markdown destination: %s', (url, path) => {
    expect(normalizedImageSrc(`![hostless](<${url}>)`)).toBe(
      `xdt-file://local/?path=${encodeURIComponent(path)}`,
    );
  });

  it('loads the reported bare-space hostless image without angle brackets', () => {
    const path = 'C:/My Pictures/shot (100%).png';
    expect(normalizedImageSrc(`![hostless](xdt-image:///${path})`)).toBe(
      `xdt-file://local/?path=${encodeURIComponent(path)}`,
    );
  });

  // Hostless compatibility must not turn a previously rejected cache URL into
  // an automatic Windows SMB/WebDAV/device access via the local-file protocol.
  it.each([
    'xdt-image:////attacker/share/a.png',
    'xdt-image:///%2Fattacker/share/a.png',
    'xdt-image:///%5C%5Cattacker%5Cshare%5Ca.png',
    'xdt-image:///%3F%3F/UNC/attacker/share/a.png',
    'xdt-image:///%5C%5C%3F%5CC:%5Ca.png',
  ])('rejects hostless network/device destinations before routing: %s', (url) => {
    expect(normalizeMarkdownImageSrc(url, 'C:/repo', true)).toBeUndefined();
  });

  it('keeps legacy POSIX paths and cache-busting revisions intact', () => {
    const path = '/Users/test/My Pictures/image.png';
    expect(
      normalizeMarkdownImageSrc(
        'xdt-file:///Users/test/My%20Pictures/image.png?v=message%202',
        '/repo',
        true,
      ),
    ).toBe('xdt-file://local/?path=' + encodeURIComponent(path) + '&v=message%202');
  });

  it('keeps malformed percent sequences instead of throwing during render', () => {
    const path = '/tmp/100%done.png';
    expect(normalizeMarkdownImageSrc(path, '/repo', true)).toBe(
      `xdt-file://local/?path=${encodeURIComponent(path)}`,
    );
  });

  // file://host used to lose its host and load <task folder>/nas/share/a.png.
  it('maps a file://host image src to its share path, not to a task-folder file', () => {
    expect(normalizedImageSrc('![unc](<file://nas/share/My%20Pictures/a.png>)', 'C:\\repo')).toBe(
      `xdt-file://local/?path=${encodeURIComponent('\\\\nas\\share\\My Pictures\\a.png')}`,
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
      'xdt-image:///tmp/private.png',
    ]) {
      expect(normalizeMarkdownImageSrc(src, '/repo', false)).toBeUndefined();
    }
    expect(normalizeMarkdownImageSrc('https://example.com/public.png', '/repo', false)).toBe(
      'https://example.com/public.png',
    );
  });
});
