/**
 * Regression coverage for local Markdown *links* whose destinations survive
 * mdast-to-hast URL serialization only through the raw-preservation channel
 * (issue #1629).
 *
 * `normalizeUri` percent-encodes Windows backslashes (`\` → `%5C`), so a
 * model-written `[label](C:\Users\...\a.png)` reaches urlTransform as
 * `C:%5CUsers%5C...` — it no longer matches the Windows-absolute whitelist,
 * falls into react-markdown's protocol whitelist (`c:` = unknown scheme), and
 * the href is stripped to "". Without the raw property the link degrades to
 * dead plain text while the identical path renders fine as an image.
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import { describe, expect, it } from 'vitest';

import { classifyMarkdownLinkTarget } from '@/lib/markdownTarget';
import remarkLocalPathLinks from '../components/chat/remarkLocalPathLinks';
import remarkPreserveRawLocalDestinations, {
  RAW_LOCAL_LINK_HREF_PROP,
} from '../components/chat/remarkPreserveRawLocalDestinations';

interface CapturedLink {
  raw?: string;
  href?: string;
}

function renderLink(markdown: string): CapturedLink {
  const captured: CapturedLink = {};
  renderToStaticMarkup(
    createElement(ReactMarkdown, {
      components: {
        a: ({ href, node }) => {
          const raw = node?.properties?.[RAW_LOCAL_LINK_HREF_PROP];
          captured.raw = typeof raw === 'string' ? raw : undefined;
          captured.href = href;
          return null;
        },
      },
      // 与 MarkdownRenderer 的约束一致:preserve 插件必须排在
      // remarkLocalPathLinks 之后,正文裸路径切出的 link 才拿得到原始值。
      remarkPlugins: [remarkLocalPathLinks, remarkPreserveRawLocalDestinations],
      urlTransform: defaultUrlTransform,
      children: markdown,
    }),
  );
  return captured;
}

describe('Markdown local link path encoding', () => {
  it('preserves a Windows backslash absolute link that urlTransform strips to ""', () => {
    const path = 'C:\\Users\\test\\AppData\\Roaming\\Cindy\\dialogues\\random_coordinates.png';
    const { raw, href } = renderLink(`[查看图片 random_coordinates.png](${path})`);

    // 前提锁死:没有 raw 通道时这条链接必死(href 被清空)。这一断言失败说明
    // 上游序列化/transform 行为变了,需要重新评估本修复是否仍必要。
    expect(href).toBe('');
    expect(raw).toBe(path);

    // 原始值走既有分类链路 → 本地图片 candidate(后续 resolve → 可点)。
    const target = classifyMarkdownLinkTarget(raw);
    expect(target.kind).toBe('local-candidate');
    expect(target.kind === 'local-candidate' && target.localKind).toBe('image');
  });

  it('preserves a Windows absolute link with spaces via <> wrapping', () => {
    const path = 'C:\\Users\\test\\My Pictures\\random coordinates.png';
    const { raw } = renderLink(`[查看图片](<${path}>)`);
    expect(raw).toBe(path);
  });

  it('preserves a POSIX absolute link with a real space next to a literal %20', () => {
    const path = '/tmp/report %20final.csv';
    const { raw } = renderLink(`[下载数据](<${path}>)`);
    expect(raw).toBe(path);
  });

  it('preserves a workingDir-relative link destination', () => {
    const { raw } = renderLink('[脚本](./scripts/generate_random_coordinates.py)');
    expect(raw).toBe('./scripts/generate_random_coordinates.py');
  });

  it('stashes bare prose Windows paths cut out by remarkLocalPathLinks', () => {
    // remarkLocalPathLinks 从正文纯文本切出的 link 节点同样经过 hast 序列化,
    // 同样需要 raw 通道 —— preserve 插件排它之后才能覆盖到。
    const { raw } = renderLink('改的是 C:\\proj\\src\\app.ts 这个文件');
    expect(raw).toBe('C:\\proj\\src\\app.ts');
  });

  it('does not stash scheme-bearing destinations', () => {
    for (const md of [
      '[外链](https://example.com/a.png)',
      '[邮件](mailto:a@b.com)',
      '[深链](cindy://session/00000000-0000-0000-0000-000000000000)',
    ]) {
      expect(renderLink(md).raw).toBeUndefined();
    }
  });

  it('still stashes file:// destinations, matching the image channel', () => {
    const url = 'file:///C:/Users/test/My%20Pictures/image.png';
    expect(renderLink(`[图](${url})`).raw).toBe(url);
  });
});
