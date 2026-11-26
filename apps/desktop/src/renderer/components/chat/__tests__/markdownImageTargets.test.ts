import { describe, expect, it } from 'vitest';
import {
  extractCachedRenderedMarkdownImageTargets,
  extractRenderedMarkdownImageTargets,
  type MarkdownImageTargetCache,
} from '../markdownImageTargets';

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
});
