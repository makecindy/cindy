import { describe, expect, it } from 'vitest';
import { extractRenderedMarkdownImageTargets } from '../markdownImageTargets';

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
});
