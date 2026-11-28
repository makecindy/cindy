/**
 * Unit tests for Mobile Markdown document image extraction, path/security
 * resolution, bounded progressive fetching, gallery building, and tap parsing.
 * Value: pins relative (`./`, `../`), absolute, `file://`, carousel, HTML
 * `<p><img></p>`, UNC/SSH security boundaries, memory budget caps, and
 * ImageLightbox gallery alignment without requiring RN/WebView runtime mocks.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  appendRemoteMediaMaxBytes,
  buildMarkdownDocumentGallery,
  collectMarkdownDocumentImages,
  fetchMarkdownDocumentImages,
  normalizeAbsPathSegments,
  planMarkdownDocumentImageFetches,
  resolveMarkdownDocumentImageTarget,
} from '@/session/markdownDocumentImages';
import { parseMarkdownImageOpen } from '@/session/markdownFilePager';

describe('normalizeAbsPathSegments', () => {
  it('collapses relative segments for POSIX and Windows paths without losing roots', () => {
    expect(normalizeAbsPathSegments('/repo/docs/../assets/./hero.png')).toBe('/repo/assets/hero.png');
    expect(normalizeAbsPathSegments('C:\\repo\\docs\\..\\assets\\hero.png')).toBe('C:\\repo\\assets\\hero.png');
    expect(normalizeAbsPathSegments('/Users/dash/shot.png')).toBe('/Users/dash/shot.png');
  });
});

describe('resolveMarkdownDocumentImageTarget', () => {
  it('resolves direct http(s), relative, ../, POSIX abs, Windows abs, and file:// targets', () => {
    expect(resolveMarkdownDocumentImageTarget('https://example.com/a.png', '/repo/docs/readme.md')).toMatchObject({
      kind: 'direct',
      fetchUrl: 'https://example.com/a.png',
      fileName: 'a.png',
    });

    expect(resolveMarkdownDocumentImageTarget('./shots/01.png', '/repo/docs/readme.md')).toMatchObject({
      kind: 'remote',
      fetchUrl: `xdt-file://open?path=${encodeURIComponent('/repo/docs/shots/01.png')}`,
      mimeType: 'image/png',
    });

    expect(resolveMarkdownDocumentImageTarget('../assets/banner.webp', '/repo/docs/readme.md')).toMatchObject({
      kind: 'remote',
      fetchUrl: `xdt-file://open?path=${encodeURIComponent('/repo/assets/banner.webp')}`,
      mimeType: 'image/webp',
    });

    expect(resolveMarkdownDocumentImageTarget('/Users/dash/.gemini/01-dark.png', '/repo/readme.md')).toMatchObject({
      kind: 'remote',
      fetchUrl: `xdt-file://open?path=${encodeURIComponent('/Users/dash/.gemini/01-dark.png')}`,
    });

    expect(resolveMarkdownDocumentImageTarget('file:///tmp/my%20shot.jpg', '/repo/readme.md')).toMatchObject({
      kind: 'remote',
      fetchUrl: `xdt-file://open?path=${encodeURIComponent('/tmp/my shot.jpg')}`,
      mimeType: 'image/jpeg',
    });

    expect(resolveMarkdownDocumentImageTarget('imgs\\pic.png', 'C:\\proj\\docs\\guide.md')).toMatchObject({
      kind: 'remote',
      fetchUrl: `xdt-file://open?path=${encodeURIComponent('C:\\proj\\docs\\imgs\\pic.png')}`,
    });
  });

  it('enforces SSH workdir containment, UNC protection, and image extension whitelist', () => {
    const ssh = { sessionId: 's1', remoteHostId: 'host-1', workdir: '/srv/repo' };

    // Inside SSH workdir (even after ../ normalization) → allowed with SSH context.
    const inside = resolveMarkdownDocumentImageTarget('../assets/ok.png', '/srv/repo/docs/a.md', { ssh });
    expect(inside.kind).toBe('remote');
    expect(inside.fetchUrl).toContain('remoteHostId=host-1');
    expect(inside.fetchUrl).toContain(`path=${encodeURIComponent('/srv/repo/assets/ok.png')}`);

    // Outside SSH workdir → fail-closed.
    expect(resolveMarkdownDocumentImageTarget('/etc/secret.png', '/srv/repo/docs/a.md', { ssh }).kind).toBe('unresolvable');
    expect(resolveMarkdownDocumentImageTarget('../../outside.png', '/srv/repo/docs/a.md', { ssh }).kind).toBe('unresolvable');
    expect(resolveMarkdownDocumentImageTarget('xdt-image://local/a.png', '/srv/repo/docs/a.md', { ssh }).kind).toBe('unresolvable');

    // UNC share outside Windows workdir → blocked.
    expect(resolveMarkdownDocumentImageTarget('file://attacker/share/p.png', 'C:\\proj\\readme.md').kind).toBe('unresolvable');

    // Non-image files & unsafe schemes → blocked.
    expect(resolveMarkdownDocumentImageTarget('./secret.env', '/repo/readme.md').kind).toBe('unresolvable');
    expect(resolveMarkdownDocumentImageTarget('javascript:alert(1)', '/repo/readme.md').kind).toBe('unresolvable');
  });
});

describe('collectMarkdownDocumentImages + progressive fetch + gallery', () => {
  const doc = [
    '# Screenshots',
    '',
    '````carousel',
    '![Dark](/tmp/01-dark.png)',
    '<!-- slide -->',
    '![Light](/tmp/01-light.png)',
    '````',
    '',
    '<p align="center"><img src="./diagram.png" alt="Diagram" width="400" /></p>',
    '',
    '![Remote](https://example.com/r.png)',
  ].join('\n');

  it('collects carousel, HTML <p><img></p>, and standard Markdown images in rendered order', () => {
    const entries = collectMarkdownDocumentImages(doc, '/repo/docs/report.md');
    expect(entries.map((e) => ({ index: e.index, alt: e.alt, kind: e.kind }))).toEqual([
      { index: 0, alt: 'Dark', kind: 'remote' },
      { index: 1, alt: 'Light', kind: 'remote' },
      { index: 2, alt: 'Diagram', kind: 'remote' },
      { index: 3, alt: 'Remote', kind: 'direct' },
    ]);
  });

  it('deduplicates, enforces count cap, streams progressive results, and enforces char budget', async () => {
    const entries = collectMarkdownDocumentImages(
      ['![A](/tmp/a.png)', '![A2](/tmp/a.png)', '![B](/tmp/b.png)', '![C](/tmp/c.png)'].join('\n\n'),
      '/repo/doc.md',
    );
    const plan = planMarkdownDocumentImageFetches(entries, 2);
    expect(plan.targets).toHaveLength(2);
    expect(plan.targets[0].refCount).toBe(2);
    expect(plan.overLimitRawUrls).toEqual(['/tmp/c.png']);

    const seen: string[] = [];
    const fetchOne = vi.fn(async (target: { rawUrl: string }) =>
      target.rawUrl === '/tmp/a.png' ? 'data:image/webp;base64,AAAA' : 'data:image/webp;base64,' + 'B'.repeat(200),
    );
    const map = await fetchMarkdownDocumentImages(plan.targets, fetchOne, {
      concurrency: 1,
      totalBudgetChars: 120,
      onResult: (rawUrl) => seen.push(rawUrl),
    });

    expect(seen).toEqual(['/tmp/a.png', '/tmp/b.png']);
    expect(map.get('/tmp/a.png')).toEqual({ status: 'ready', uri: 'data:image/webp;base64,AAAA' });
    // Second image exceeds remaining totalBudgetChars → marked deferred (not error)
    // so the user can still tap it to open full-res ImageLightbox on demand.
    expect(map.get('/tmp/b.png')).toEqual({ status: 'deferred' });
  });

  it('appends or updates host-enforced maxBytes only on xdt-file:// URLs', () => {
    expect(
      appendRemoteMediaMaxBytes('xdt-file://open?path=%2Ftmp%2Fanim.gif&v=123', 2097152),
    ).toBe('xdt-file://open?path=%2Ftmp%2Fanim.gif&v=123&maxBytes=2097152');
    expect(
      appendRemoteMediaMaxBytes('xdt-file://open?path=%2Ftmp%2Fanim.gif&maxBytes=9999&v=1', 1024),
    ).toBe('xdt-file://open?path=%2Ftmp%2Fanim.gif&maxBytes=1024&v=1');
    expect(appendRemoteMediaMaxBytes('cindy-media://blobs/abc.png', 1024)).toBe(
      'cindy-media://blobs/abc.png',
    );
  });

  it('builds ImageLightbox gallery preserving hydrated previewUri and exact tapped index mapping', () => {
    const entries = collectMarkdownDocumentImages(doc, '/repo/docs/report.md');
    const resolved = new Map([
      ['/tmp/01-light.png', { status: 'ready' as const, uri: 'data:image/webp;base64,LIGHT' }],
    ]);
    const gallery = buildMarkdownDocumentGallery(entries, resolved);
    expect(gallery.images).toHaveLength(4);
    expect(gallery.images[1]).toMatchObject({
      key: 'md-doc-img:1',
      title: 'Light',
      previewUri: 'data:image/webp;base64,LIGHT',
    });
    expect(gallery.keyForEntryIndex(1)).toEqual({
      key: 'md-doc-img:1',
      url: `xdt-file://open?path=${encodeURIComponent('/tmp/01-light.png')}`,
    });
    expect(gallery.keyForEntryIndex(99)).toBeNull();
  });
});

describe('parseMarkdownImageOpen', () => {
  it('parses only non-negative integer indices', () => {
    expect(parseMarkdownImageOpen('markdown-image:open:0')).toBe(0);
    expect(parseMarkdownImageOpen('markdown-image:open:14')).toBe(14);
    expect(parseMarkdownImageOpen('markdown-image:open:-1')).toBeNull();
    expect(parseMarkdownImageOpen('markdown-image:open:abc')).toBeNull();
    expect(parseMarkdownImageOpen('markdown-page:next')).toBeNull();
  });
});
