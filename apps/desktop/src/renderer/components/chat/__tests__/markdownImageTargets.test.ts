import { describe, expect, it } from 'vitest';
import {
  assignMarkdownGalleryOccurrences,
  extractCachedRenderedMarkdownImageTargets,
  extractMarkdownGalleryImages,
  extractRenderedMarkdownImageTargets,
  type MarkdownImageTargetCache,
} from '../markdownImageTargets';
import { replyImages } from '../replyGalleryImages';

describe('extractRenderedMarkdownImageTargets', () => {
  it('collects rendered images and ignores Markdown literals that render as code or raw HTML', () => {
    const url = 'cindy-media://blobs/abc.png';
    expect(
      extractRenderedMarkdownImageTargets([
        `![result](<${url}>)`,
        `![same result with title](${url} "preview")`,
        '',
        `\`<!--\` ![after inline code](${url}/after-inline-code)`,
        `\`![inline code](${url}/inline)\``,
        '`multiline code',
        `![multiline code](${url}/multiline-inline)`,
        '`',
        `$![inline math](${url}/inline-math)$`,
        `\\(![normalized inline math](${url}/normalized-inline-math)\\)`,
        `\\[![normalized display math](${url}/normalized-display-math)\\]`,
        `\\![escaped](${url}/escaped)`,
        '<!--',
        `![html comment](${url}/comment)`,
        '-->',
        '```md',
        `![fenced code](${url}/fenced)`,
        '```',
        `    ![indented code](${url}/indented)`,
        '',
        '<div>',
        `![block html](${url}/html)`,
        '</div>',
        '',
        '<script>',
        '',
        `![raw html across blank lines](${url}/script)`,
        '',
        '</script>',
        '',
        `<img src="${url}/raw-img" alt="raw">`,
      ].join('\n')),
    ).toEqual([url, `${url}/after-inline-code`, `${url}/raw-img`]);
  });

  it('finds a bare-space local image across emphasis nodes without scanning code or HTML', () => {
    // Media storage rules, §多端与远程: actual chat display and delivery agree.
    // Plain filenames never exercise the emphasis node embedded in this POSIX path.
    const local = '/Users/me/Library/Application Support/Cindy/generated_images/_draft_.png';
    const example = local.replace('_draft_', '_example_');
    expect(
      extractRenderedMarkdownImageTargets([
        `Design: ![Credits mockup](${local})`,
        `\`![inline code](${example})\``,
        '```',
        `![fenced](${example})`,
        '```',
        '',
        '<div>',
        `![raw HTML](${example})`,
        '</div>',
      ].join('\n')),
    ).toEqual([local]);
  });

  it('applies the same source-span rules as IM delivery to bare-space images', () => {
    const local = '/tmp/my shot.png';
    expect(extractRenderedMarkdownImageTargets(`Design &amp; preview: ![pic](${local})`)).toEqual([local]);
    expect(extractRenderedMarkdownImageTargets(`\\![example](${local})`)).toEqual([]);
    expect(extractRenderedMarkdownImageTargets(`*note* then ![pic](${local}) &lt;done&gt;`)).toEqual([local]);
  });

  it('reuses completed-message results and invalidates them when content changes', () => {
    const cache: MarkdownImageTargetCache = new Map();
    const first = extractCachedRenderedMarkdownImageTargets(
      '![one](cindy-media://one.png)',
      cache,
      'assistant-1',
    );
    const same = extractCachedRenderedMarkdownImageTargets(
      '![one](cindy-media://one.png)',
      cache,
      'assistant-1',
    );
    expect(same).toBe(first);

    const changed = extractCachedRenderedMarkdownImageTargets(
      '![two](cindy-media://two.png)',
      cache,
      'assistant-1',
    );
    expect(changed).toEqual(['cindy-media://two.png']);
    expect(changed).not.toBe(first);

    const empty = extractCachedRenderedMarkdownImageTargets('plain text', cache, 'assistant-2');
    expect(empty).toEqual([]);
    expect(extractCachedRenderedMarkdownImageTargets('plain text', cache, 'assistant-2')).toBe(
      empty,
    );
  });

  it('does not count managed video Markdown targets as images', () => {
    expect(
      extractRenderedMarkdownImageTargets(
        '![video](cindy-media://blobs/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.mp4)',
      ),
    ).toEqual([]);
  });

  // Value: carousel slides render real images in MarkdownRenderer and must
  // participate in document gallery order and image target extraction.
  it('extracts images inside carousel fences in document order while skipping nested carousels', () => {
    const md = [
      '![Cover](./cover.png)',
      '',
      '````carousel',
      '![Dark](/tmp/01-dark.png)',
      '<!-- slide -->',
      '![Light](/tmp/01-light.png)',
      '````',
      '',
      '![Footer](./footer.png)',
    ].join('\n');

    expect(extractRenderedMarkdownImageTargets(md)).toEqual([
      './cover.png',
      '/tmp/01-dark.png',
      '/tmp/01-light.png',
      './footer.png',
    ]);
    const gallery = extractMarkdownGalleryImages(md);
    expect(gallery.map((g) => g.target)).toEqual([
      './cover.png',
      '/tmp/01-dark.png',
      '/tmp/01-light.png',
      './footer.png',
    ]);
    expect(gallery[1].sectionSuffix).toContain('carousel:');
    expect(gallery[2].sectionSuffix).toContain('carousel:');
    expect(gallery[1].sectionSuffix).not.toBe(gallery[2].sectionSuffix);
  });

  // Discriminating regression: duplicate images across carousel slides and after
  // a carousel must get per-slide gallerySection + independent occurrence counts
  // in both replyImages (chat gallery) and assignMarkdownGalleryOccurrences.
  it('assigns carousel slide sections and isolated occurrence counts for duplicate images in chat replies', () => {
    const md = [
      '````carousel',
      '![First](/tmp/same.png)',
      '<!-- slide -->',
      '![Second](/tmp/same.png)',
      '````',
      '',
      '![After](/tmp/same.png)',
    ].join('\n');

    const refs = replyImages(md, 'msg-1');
    expect(refs).toHaveLength(3);
    expect(refs[0].section).toContain('\u0000carousel:0:0');
    expect(refs[0].occurrence).toBe(0);
    expect(refs[1].section).toContain('\u0000carousel:0:1');
    expect(refs[1].occurrence).toBe(0);
    // Standalone image after carousel stays in the base section with occurrence 0
    // (matching MarkdownRenderer's markdownImageOccurrence), not shifted to 2.
    expect(refs[2].section).not.toContain('\u0000carousel:');
    expect(refs[2].occurrence).toBe(0);
    expect(assignMarkdownGalleryOccurrences(extractMarkdownGalleryImages(md), 'doc')).toEqual([
      { target: '/tmp/same.png', section: 'doc\u0000carousel:0:0', occurrence: 0 },
      { target: '/tmp/same.png', section: 'doc\u0000carousel:0:1', occurrence: 0 },
      { target: '/tmp/same.png', section: 'doc', occurrence: 0 },
    ]);
  });
});
