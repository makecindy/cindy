/**
 * remarkTruncateCjkUrls.test.ts
 * ---------------------------------------------------------------------------
 * 回归测试：确保 remarkTruncateCjkUrls 插件能正确把 GFM autolink literal
 * 误吞的 CJK / 全角字符从 href 里切出来，同时不碰显式 markdown link。
 *
 * 插件是 unified plugin，接收 mdast 树并原地修改。测试直接构造 AST 调用
 * 插件函数，避免依赖 `remark` 解析器（项目未显式安装）。
 */

import { describe, it, expect } from 'vitest';

// GitLab MR URL fixture(边界/截断逻辑对 gitlab.com 适用)
const GITLAB_MR_URL = `https://gitlab.com/acme/app/-/merge_requests/42`;
import type { Root, Link, Text, Paragraph } from 'mdast';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkTruncateCjkUrls from '../components/chat/remarkTruncateCjkUrls';

/** 构造一棵最小 mdast 树：一个 paragraph 里放一个 autolink literal 节点 */
function autolinkTree(url: string): Root {
  const text: Text = {
    type: 'text',
    value: url,
    position: {
      start: { line: 1, column: 1, offset: 0 },
      end: { line: 1, column: url.length + 1, offset: url.length },
    },
  };
  const link: Link = {
    type: 'link',
    url,
    children: [text],
    position: text.position,
  };
  const para: Paragraph = { type: 'paragraph', children: [link] };
  return { type: 'root', children: [para] };
}

/** 构造显式 markdown link `[label](url)` 的 AST */
function explicitLinkTree(label: string, url: string): Root {
  const text: Text = {
    type: 'text',
    value: label,
    position: {
      start: { line: 1, column: 2, offset: 1 },
      end: { line: 1, column: label.length + 2, offset: label.length + 1 },
    },
  };
  const markdownLength = label.length + url.length + 4;
  const link: Link = {
    type: 'link',
    url,
    children: [text],
    position: {
      start: { line: 1, column: 1, offset: 0 },
      end: { line: 1, column: markdownLength + 1, offset: markdownLength },
    },
  };
  const para: Paragraph = { type: 'paragraph', children: [link] };
  return { type: 'root', children: [para] };
}

function apostropheWrappedAutolinkTree(url: string): Root {
  const leadingQuote: Text = { type: 'text', value: "'" };
  const text: Text = {
    type: 'text',
    value: url,
    position: {
      start: { line: 1, column: 2, offset: 1 },
      end: { line: 1, column: url.length + 2, offset: url.length + 1 },
    },
  };
  const link: Link = {
    type: 'link',
    url,
    children: [text],
    position: text.position,
  };
  const para: Paragraph = { type: 'paragraph', children: [leadingQuote, link] };
  return { type: 'root', children: [para] };
}

function markdownWrappedAutolinkTree(marker: string, url: string): Root {
  const leadingMarker: Text = { type: 'text', value: marker };
  const text: Text = {
    type: 'text',
    value: url,
    position: {
      start: { line: 1, column: marker.length + 1, offset: marker.length },
      end: { line: 1, column: marker.length + url.length + 1, offset: marker.length + url.length },
    },
  };
  const link: Link = {
    type: 'link',
    url,
    children: [text],
    position: text.position,
  };
  const para: Paragraph = { type: 'paragraph', children: [leadingMarker, link] };
  return { type: 'root', children: [para] };
}

// 拿到插件返回的 transformer 函数
const transform = (remarkTruncateCjkUrls as () => (tree: Root) => void)();

function firstParagraphChildren(markdown: string): Paragraph['children'] {
  const tree = unified().use(remarkParse).use(remarkGfm).parse(markdown) as Root;
  transform(tree);
  return (tree.children[0] as Paragraph).children;
}

function linksFromMarkdown(markdown: string): string[] {
  return firstParagraphChildren(markdown)
    .filter((node): node is Link => node.type === 'link')
    .map((node) => node.url);
}

function valuesFromMarkdown(markdown: string): string[] {
  return firstParagraphChildren(markdown).map((node) => {
    if (node.type === 'link') {
      return `link:${node.url}`;
    }
    if (node.type === 'text') {
      return `text:${node.value}`;
    }
    return node.type;
  });
}

describe('remarkTruncateCjkUrls', () => {
  // ── 应该截断的场景 ──

  it('URL + 全角括号中文：https://x.com/foo（说明）', () => {
    const tree = autolinkTree('https://x.com/foo（说明）');
    transform(tree);
    const para = tree.children[0] as Paragraph;
    const link = para.children[0] as Link;
    const tail = para.children[1] as Text;
    expect(link.url).toBe('https://x.com/foo');
    expect((link.children[0] as Text).value).toBe('https://x.com/foo');
    expect(tail.value).toBe('（说明）');
  });

  it('issue comment fragment + 全角说明：…#issuecomment-1（无 @）', () => {
    const tree = autolinkTree(
      'https://github.com/example/app/issues/3561#issuecomment-5391602790（无 @）',
    );
    transform(tree);
    const para = tree.children[0] as Paragraph;
    const link = para.children[0] as Link;
    const tail = para.children[1] as Text;
    expect(link.url).toBe(
      'https://github.com/example/app/issues/3561#issuecomment-5391602790',
    );
    expect((link.children[0] as Text).value).toBe(
      'https://github.com/example/app/issues/3561#issuecomment-5391602790',
    );
    expect(tail.value).toBe('（无 @）');
  });

  it('authority 里的 IDN 点号保留：https://例子。测试/path', () => {
    const tree = autolinkTree('https://例子。测试/path');
    transform(tree);
    const para = tree.children[0] as Paragraph;
    const link = para.children[0] as Link;
    expect(link.url).toBe('https://例子。测试/path');
    expect(para.children).toHaveLength(1);
  });

  it('URL 路径里的汉字保留：https://example.com/路径', () => {
    const tree = autolinkTree('https://example.com/路径');
    transform(tree);
    const para = tree.children[0] as Paragraph;
    const link = para.children[0] as Link;
    expect(link.url).toBe('https://example.com/路径');
    expect(para.children).toHaveLength(1);
  });

  it('混合 ASCII/CJK 路径保留：https://example.com/2024年报告', () => {
    const tree = autolinkTree('https://example.com/2024年报告');
    transform(tree);
    const para = tree.children[0] as Paragraph;
    const link = para.children[0] as Link;
    expect(link.url).toBe('https://example.com/2024年报告');
    expect(para.children).toHaveLength(1);
  });

  it('无标点的汉字跟在 ASCII 词后也保留（IRI，不按脚本猜测）', () => {
    const tree = autolinkTree('https://example.com/path这是说明');
    transform(tree);
    const para = tree.children[0] as Paragraph;
    const link = para.children[0] as Link;
    expect(link.url).toBe('https://example.com/path这是说明');
    expect(para.children).toHaveLength(1);
  });

  it('URL + 日文假名路径保留：https://example.com/fooこんにちは', () => {
    const tree = autolinkTree('https://example.com/fooこんにちは');
    transform(tree);
    const para = tree.children[0] as Paragraph;
    const link = para.children[0] as Link;
    expect(link.url).toBe('https://example.com/fooこんにちは');
    expect(para.children).toHaveLength(1);
  });

  it('URL + 全角感叹号：https://example.com/path！wow', () => {
    const tree = autolinkTree('https://example.com/path！wow');
    transform(tree);
    const para = tree.children[0] as Paragraph;
    const link = para.children[0] as Link;
    const tail = para.children[1] as Text;
    expect(link.url).toBe('https://example.com/path');
    expect(tail.value).toBe('！wow');
  });

  // ── 截断后还要剥掉残留的尾部 ASCII 标点（GFM trailing punctuation）──

  it('加粗包裹 URL 紧跟括号：…/pull/90**(完整 → 剥掉 **(', () => {
    // 原文 `**https://github.com/x/r/pull/90**(完整 feature 模板)`：闭合 **
    // 因不构成 right-flanking 退化为字面文本，GFM autolink 把 `**(完整` 一并
    // 吞进 URL。CJK 切断后必须把残留的 `**(` 也剥进 tail。
    const tree = autolinkTree('https://github.com/makecindy/cindy/pull/90**(完整');
    transform(tree);
    const para = tree.children[0] as Paragraph;
    const link = para.children[0] as Link;
    const tail = para.children[1] as Text;
    expect(link.url).toBe('https://github.com/makecindy/cindy/pull/90');
    expect((link.children[0] as Text).value).toBe('https://github.com/makecindy/cindy/pull/90');
    expect(tail.value).toBe('**(完整');
  });

  it('无标点的 _~ 加汉字视为路径，不按脚本切断', () => {
    const tree = autolinkTree('https://github.com/makecindy/cindy/pull/90_~说明');
    transform(tree);
    const para = tree.children[0] as Paragraph;
    const link = para.children[0] as Link;
    expect(link.url).toBe('https://github.com/makecindy/cindy/pull/90_~说明');
    expect(para.children).toHaveLength(1);
  });

  it('ASCII prose 截断时保留 URL 尾部合法 markdown 字符', () => {
    const tree = autolinkTree('https://example.com/Foo_(draft');
    transform(tree);
    const para = tree.children[0] as Paragraph;
    const link = para.children[0] as Link;
    const tail = para.children[1] as Text;
    expect(link.url).toBe('https://example.com/Foo_');
    expect((link.children[0] as Text).value).toBe('https://example.com/Foo_');
    expect(tail.value).toBe('(draft');
  });

  it('配对括号内的汉字保留：https://example.com/Foo_(draft说明)', () => {
    const tree = autolinkTree('https://example.com/Foo_(draft说明)');
    transform(tree);
    const para = tree.children[0] as Paragraph;
    const link = para.children[0] as Link;
    expect(link.url).toBe('https://example.com/Foo_(draft说明)');
    expect(para.children).toHaveLength(1);
  });

  it('ASCII prose 截断时保留 URL 尾部合法多字符 markdown 字符', () => {
    const tree = autolinkTree('https://example.com/pkg__(draft');
    transform(tree);
    const para = tree.children[0] as Paragraph;
    const link = para.children[0] as Link;
    const tail = para.children[1] as Text;
    expect(link.url).toBe('https://example.com/pkg__');
    expect((link.children[0] as Text).value).toBe('https://example.com/pkg__');
    expect(tail.value).toBe('(draft');
  });

  it('半角句点后的汉字保留在路径里：https://x.com/foo.说明', () => {
    const tree = autolinkTree('https://x.com/foo.说明');
    transform(tree);
    const para = tree.children[0] as Paragraph;
    const link = para.children[0] as Link;
    expect(link.url).toBe('https://x.com/foo.说明');
    expect(para.children).toHaveLength(1);
  });

  it('半角分号后的汉字保留在路径里：https://x.com/foo;说明', () => {
    const tree = autolinkTree('https://x.com/foo;说明');
    transform(tree);
    const para = tree.children[0] as Paragraph;
    const link = para.children[0] as Link;
    expect(link.url).toBe('https://x.com/foo;说明');
    expect(para.children).toHaveLength(1);
  });

  it('未配对的 ) 被剥掉：https://x.com/foo)（说明）', () => {
    const tree = autolinkTree('https://x.com/foo)（说明）');
    transform(tree);
    const para = tree.children[0] as Paragraph;
    const link = para.children[0] as Link;
    const tail = para.children[1] as Text;
    expect(link.url).toBe('https://x.com/foo');
    expect(tail.value).toBe(')（说明）');
  });

  it('配对的 () 保留：https://en.wikipedia.org/wiki/Foo_(bar)（说明）', () => {
    const tree = autolinkTree('https://en.wikipedia.org/wiki/Foo_(bar)（说明）');
    transform(tree);
    const para = tree.children[0] as Paragraph;
    const link = para.children[0] as Link;
    const tail = para.children[1] as Text;
    expect(link.url).toBe('https://en.wikipedia.org/wiki/Foo_(bar)');
    expect(tail.value).toBe('（说明）');
  });

  it('query 内未配对 ( 保留：https://example.com/search?q=(foo', () => {
    const tree = autolinkTree('https://example.com/search?q=(foo');
    transform(tree);
    const para = tree.children[0] as Paragraph;
    expect(para.children).toHaveLength(1);
    const link = para.children[0] as Link;
    expect(link.url).toBe('https://example.com/search?q=(foo');
    expect((link.children[0] as Text).value).toBe('https://example.com/search?q=(foo');
  });

  it('query / fragment 内未配对 ) 保留', () => {
    for (const url of [
      'https://example.com/search?q=a)b',
      'https://example.com/search?q=a)',
      'https://example.com/search#frag)a',
      'https://example.com/search#frag)',
    ]) {
      const tree = autolinkTree(url);
      transform(tree);
      const para = tree.children[0] as Paragraph;
      expect(para.children).toHaveLength(1);
      const link = para.children[0] as Link;
      expect(link.url).toBe(url);
      expect((link.children[0] as Text).value).toBe(url);
    }
  });

  it('外层 prose 括号包住 query / fragment URL 时只剥 wrapper 右括号', () => {
    for (const [url, expected] of [
      ['https://example.com/search?q=a)', 'https://example.com/search?q=a'],
      ['https://example.com/search?q=a)b)', 'https://example.com/search?q=a)b'],
      ['https://example.com/search#frag)', 'https://example.com/search#frag'],
    ]) {
      const tree = markdownWrappedAutolinkTree('(see ', url);
      transform(tree);
      const para = tree.children[0] as Paragraph;
      const link = para.children[1] as Link;
      const tail = para.children[2] as Text;
      expect(link.url).toBe(expected);
      expect((link.children[0] as Text).value).toBe(expected);
      expect(tail.value).toBe(')');
    }
  });

  it('真实 remark-gfm 解析：跨 inline sibling 仍识别 query URL 外层括号', () => {
    expect(
      linksFromMarkdown('(see **details** https://example.com/search?q=a)'),
    ).toEqual(['https://example.com/search?q=a']);
  });

  it('外层 prose 括号后的相邻文本不进入 query / fragment URL', () => {
    for (const [url, expected, tailValue] of [
      ['https://example.com/search?q=a)then', 'https://example.com/search?q=a', ')then'],
      ['https://example.com/search?q=a)b)then', 'https://example.com/search?q=a)b', ')then'],
      ['https://example.com/search#frag)then', 'https://example.com/search#frag', ')then'],
    ]) {
      const tree = markdownWrappedAutolinkTree('(see ', url);
      transform(tree);
      const para = tree.children[0] as Paragraph;
      const link = para.children[1] as Link;
      const tail = para.children[2] as Text;
      expect(link.url).toBe(expected);
      expect((link.children[0] as Text).value).toBe(expected);
      expect(tail.value).toBe(tailValue);
    }
  });

  it('外层 prose 括号已被切走时保留 query / fragment 自身的尾部右括号', () => {
    for (const [url, expected, tailValue] of [
      ['https://example.com/search?q=a))', 'https://example.com/search?q=a)', ')'],
      ['https://example.com/search?q=a))then', 'https://example.com/search?q=a)', ')then'],
      ['https://example.com/search#frag))', 'https://example.com/search#frag)', ')'],
    ]) {
      const tree = markdownWrappedAutolinkTree('(see ', url);
      transform(tree);
      const para = tree.children[0] as Paragraph;
      const link = para.children[1] as Link;
      const tail = para.children[2] as Text;
      expect(link.url).toBe(expected);
      expect((link.children[0] as Text).value).toBe(expected);
      expect(tail.value).toBe(tailValue);
    }
  });

  it('非 code-host 数字 path 后的配对括号保留：https://example.com/article/123(v2)', () => {
    const tree = autolinkTree('https://example.com/article/123(v2)');
    transform(tree);
    const para = tree.children[0] as Paragraph;
    expect(para.children).toHaveLength(1);
    const link = para.children[0] as Link;
    expect(link.url).toBe('https://example.com/article/123(v2)');
    expect((link.children[0] as Text).value).toBe('https://example.com/article/123(v2)');
  });

  it('非 code-host 的 issues / pull path 后配对括号保留', () => {
    for (const url of ['https://example.com/issues/123(v2)', 'https://example.com/pull/123(foo)']) {
      const tree = autolinkTree(url);
      transform(tree);
      const para = tree.children[0] as Paragraph;
      expect(para.children).toHaveLength(1);
      const link = para.children[0] as Link;
      expect(link.url).toBe(url);
      expect((link.children[0] as Text).value).toBe(url);
    }
  });

  it('数字 path 后紧跟完整 ASCII 括号说明：https://github.com/x/r/pull/283(base,OPEN) → 剥掉括号说明', () => {
    const tree = autolinkTree('https://github.com/makecindy/cindy/pull/283(base,OPEN)');
    transform(tree);
    const para = tree.children[0] as Paragraph;
    const link = para.children[0] as Link;
    const tail = para.children[1] as Text;
    expect(link.url).toBe('https://github.com/makecindy/cindy/pull/283');
    expect((link.children[0] as Text).value).toBe('https://github.com/makecindy/cindy/pull/283');
    expect(tail.value).toBe('(base,OPEN)');
  });

  it('code-host 数字资源带 query / fragment 时仍剥掉尾部状态说明', () => {
    for (const [url, expected] of [
      [
        'https://github.com/makecindy/cindy/pull/283#discussion_r1(base,OPEN)',
        'https://github.com/makecindy/cindy/pull/283#discussion_r1',
      ],
      [
        'https://github.com/makecindy/cindy/pull/283#discussion_r1(base main,OPEN)',
        'https://github.com/makecindy/cindy/pull/283#discussion_r1',
      ],
      [
        'https://github.com/makecindy/cindy/pull/283?diff=split(base,OPEN)',
        'https://github.com/makecindy/cindy/pull/283?diff=split',
      ],
      [
        'https://github.com/makecindy/cindy/pull/283?diff=split(base main,OPEN)',
        'https://github.com/makecindy/cindy/pull/283?diff=split',
      ],
    ]) {
      const tree = autolinkTree(url);
      transform(tree);
      const para = tree.children[0] as Paragraph;
      const link = para.children[0] as Link;
      const tail = para.children[1] as Text;
      expect(link.url).toBe(expected);
      expect((link.children[0] as Text).value).toBe(expected);
      expect(tail.value).toBe(url.slice(expected.length));
    }
  });

  it('code-host query / fragment 值里的状态形括号保留', () => {
    for (const url of [
      'https://github.com/org/repo/pull/283?check=(linux,OK)',
      'https://github.com/org/repo/pull/283#check=(linux,OK)',
      'https://github.com/org/repo/pull/283?check=(base,OPEN)',
      'https://github.com/org/repo/pull/283#check=(base,OPEN)',
      'https://github.com/org/repo/pull/283?check=linux(base,OPEN)',
      'https://github.com/org/repo/pull/283#check=linux(base,OPEN)',
      'https://github.com/org/repo/pull/283?check=(base',
      'https://github.com/org/repo/pull/283?check=linux(base',
    ]) {
      const tree = autolinkTree(url);
      transform(tree);
      const para = tree.children[0] as Paragraph;
      expect(para.children).toHaveLength(1);
      const link = para.children[0] as Link;
      expect(link.url).toBe(url);
      expect((link.children[0] as Text).value).toBe(url);
    }
  });

  it('code-host 数字 path 带 trailing slash 时仍剥掉完整 ASCII 括号说明', () => {
    for (const [url, expected] of [
      [
        'https://github.com/makecindy/cindy/pull/283/(base,OPEN)',
        'https://github.com/makecindy/cindy/pull/283/',
      ],
      [
        `${GITLAB_MR_URL}/(base,OPEN)`,
        `${GITLAB_MR_URL}/`,
      ],
    ]) {
      const tree = autolinkTree(url);
      transform(tree);
      const para = tree.children[0] as Paragraph;
      const link = para.children[0] as Link;
      const tail = para.children[1] as Text;
      expect(link.url).toBe(expected);
      expect((link.children[0] as Text).value).toBe(expected);
      expect(tail.value).toBe('(base,OPEN)');
    }
  });

  it('URL 后紧跟 ASCII 括号说明：https://github.com/x/r/pull/283(base → 剥掉 (base', () => {
    const tree = autolinkTree('https://github.com/makecindy/cindy/pull/283(base');
    transform(tree);
    const para = tree.children[0] as Paragraph;
    const link = para.children[0] as Link;
    const tail = para.children[1] as Text;
    expect(link.url).toBe('https://github.com/makecindy/cindy/pull/283');
    expect((link.children[0] as Text).value).toBe('https://github.com/makecindy/cindy/pull/283');
    expect(tail.value).toBe('(base');
  });

  it('GitLab merge request 后紧跟完整 ASCII 括号说明时剥掉括号说明', () => {
    const tree = autolinkTree(`${GITLAB_MR_URL}(base,OPEN)`);
    transform(tree);
    const para = tree.children[0] as Paragraph;
    const link = para.children[0] as Link;
    const tail = para.children[1] as Text;
    expect(link.url).toBe(GITLAB_MR_URL);
    expect((link.children[0] as Text).value).toBe(GITLAB_MR_URL);
    expect(tail.value).toBe('(base,OPEN)');
  });

  it('加粗 URL 后紧跟 ASCII 括号说明：…/pull/163**(ready → 剥掉 **(ready', () => {
    const tree = autolinkTree('https://github.com/makecindy/cindy/pull/163**(ready');
    transform(tree);
    const para = tree.children[0] as Paragraph;
    const link = para.children[0] as Link;
    const tail = para.children[1] as Text;
    expect(link.url).toBe('https://github.com/makecindy/cindy/pull/163');
    expect((link.children[0] as Text).value).toBe('https://github.com/makecindy/cindy/pull/163');
    expect(tail.value).toBe('**(ready');
  });

  it('path 中 [ ] 说明回到文本：https://example.com/foo[bar]', () => {
    const tree = autolinkTree('https://example.com/foo[bar]');
    transform(tree);
    const para = tree.children[0] as Paragraph;
    const link = para.children[0] as Link;
    const tail = para.children[1] as Text;
    expect(link.url).toBe('https://example.com/foo');
    expect((link.children[0] as Text).value).toBe('https://example.com/foo');
    expect(tail.value).toBe('[bar]');
  });

  it('path 中 { } 说明回到文本：https://example.com/foo{bar}', () => {
    const tree = autolinkTree('https://example.com/foo{bar}');
    transform(tree);
    const para = tree.children[0] as Paragraph;
    const link = para.children[0] as Link;
    const tail = para.children[1] as Text;
    expect(link.url).toBe('https://example.com/foo');
    expect((link.children[0] as Text).value).toBe('https://example.com/foo');
    expect(tail.value).toBe('{bar}');
  });

  it('query / fragment URL 外层 bracket 回到文本', () => {
    for (const [url, expected, tailValue] of [
      ['https://example.com/search?q=a]', 'https://example.com/search?q=a', ']'],
      ['https://example.com/search#frag}', 'https://example.com/search#frag', '}'],
      ['https://example.com/search?q=[a]]', 'https://example.com/search?q=[a]', ']'],
    ]) {
      const tree = autolinkTree(url);
      transform(tree);
      const para = tree.children[0] as Paragraph;
      const link = para.children[0] as Link;
      const tail = para.children[1] as Text;
      expect(link.url).toBe(expected);
      expect((link.children[0] as Text).value).toBe(expected);
      expect(tail.value).toBe(tailValue);
    }
  });

  it('path bracket 截断后的 tail URL 继续变成 link 节点', () => {
    expect(valuesFromMarkdown('看 https://a.test/foo[bar]https://b.test/ok 然后')).toEqual([
      'text:看 ',
      'link:https://a.test/foo',
      'text:[bar]',
      'link:https://b.test/ok',
      'text: 然后',
    ]);
    expect(valuesFromMarkdown('看 https://a.test/foo{bar}https://b.test/ok 然后')).toEqual([
      'text:看 ',
      'link:https://a.test/foo',
      'text:{bar}',
      'link:https://b.test/ok',
      'text: 然后',
    ]);
  });

  it('host-only URL 外层 ] 回到文本：https://example.com]', () => {
    const tree = autolinkTree('https://example.com]');
    transform(tree);
    const para = tree.children[0] as Paragraph;
    const link = para.children[0] as Link;
    const tail = para.children[1] as Text;
    expect(link.url).toBe('https://example.com');
    expect((link.children[0] as Text).value).toBe('https://example.com');
    expect(tail.value).toBe(']');
  });

  it('host-only URL 外层 } 回到文本：https://example.com}', () => {
    const tree = autolinkTree('https://example.com}');
    transform(tree);
    const para = tree.children[0] as Paragraph;
    const link = para.children[0] as Link;
    const tail = para.children[1] as Text;
    expect(link.url).toBe('https://example.com');
    expect((link.children[0] as Text).value).toBe('https://example.com');
    expect(tail.value).toBe('}');
  });

  it('IPv6 host 的 [ ] 保留：https://[::1]', () => {
    const tree = autolinkTree('https://[::1]');
    transform(tree);
    const para = tree.children[0] as Paragraph;
    expect(para.children).toHaveLength(1);
    const link = para.children[0] as Link;
    expect(link.url).toBe('https://[::1]');
    expect((link.children[0] as Text).value).toBe('https://[::1]');
  });

  it('IPv6 host 后的外层 ] 回到文本：https://[::1]]', () => {
    const tree = autolinkTree('https://[::1]]');
    transform(tree);
    const para = tree.children[0] as Paragraph;
    const link = para.children[0] as Link;
    const tail = para.children[1] as Text;
    expect(link.url).toBe('https://[::1]');
    expect((link.children[0] as Text).value).toBe('https://[::1]');
    expect(tail.value).toBe(']');
  });

  it('ASCII 引号结束 URL：https://x.com/foo"说明 → 引号回到纯文本', () => {
    const tree = autolinkTree('https://x.com/foo"说明');
    transform(tree);
    const para = tree.children[0] as Paragraph;
    const link = para.children[0] as Link;
    const tail = para.children[1] as Text;
    expect(link.url).toBe('https://x.com/foo');
    expect(tail.value).toBe('"说明');
  });

  it("保留 URL path 内部 apostrophe：https://.../Guns_N'_Roses", () => {
    const tree = autolinkTree("https://en.wikipedia.org/wiki/Guns_N'_Roses");
    transform(tree);
    const para = tree.children[0] as Paragraph;
    expect(para.children).toHaveLength(1);
    const link = para.children[0] as Link;
    expect(link.url).toBe("https://en.wikipedia.org/wiki/Guns_N'_Roses");
  });

  it("保留 URL 尾部合法 apostrophe：https://example.com/path'", () => {
    const tree = autolinkTree("https://example.com/path'");
    transform(tree);
    const para = tree.children[0] as Paragraph;
    expect(para.children).toHaveLength(1);
    const link = para.children[0] as Link;
    expect(link.url).toBe("https://example.com/path'");
  });

  it("有 opening apostrophe 时剥掉包裹 URL 的尾部 apostrophe", () => {
    const tree = apostropheWrappedAutolinkTree("https://example.com/path'");
    transform(tree);
    const para = tree.children[0] as Paragraph;
    const link = para.children[1] as Link;
    const tail = para.children[2] as Text;
    expect(link.url).toBe('https://example.com/path');
    expect((link.children[0] as Text).value).toBe('https://example.com/path');
    expect(tail.value).toBe("'");
  });

  it("opening apostrophe 后的 path'汉字 视为 IRI，不按脚本切断", () => {
    const tree = apostropheWrappedAutolinkTree("https://example.com/path'说明");
    transform(tree);
    const para = tree.children[0] as Paragraph;
    const link = para.children[1] as Link;
    expect(link.url).toBe("https://example.com/path'说明");
  });

  it('纯 ASCII autolink 也剥掉尾部分号：https://x.com/foo; next', () => {
    const tree = autolinkTree('https://x.com/foo;');
    transform(tree);
    const para = tree.children[0] as Paragraph;
    const link = para.children[0] as Link;
    const tail = para.children[1] as Text;
    expect(link.url).toBe('https://x.com/foo');
    expect(tail.value).toBe(';');
  });

  // ── 不应该截断的场景 ──

  it('纯 ASCII URL 不动：https://example.com/path/to/page', () => {
    const tree = autolinkTree('https://example.com/path/to/page');
    transform(tree);
    const para = tree.children[0] as Paragraph;
    expect(para.children).toHaveLength(1);
    const link = para.children[0] as Link;
    expect(link.url).toBe('https://example.com/path/to/page');
  });

  it('纯 ASCII URL 尾部合法 _ 和 ~ 不动', () => {
    for (const url of ['https://example.com/Foo_', 'https://example.com/Foo~']) {
      const tree = autolinkTree(url);
      transform(tree);
      const para = tree.children[0] as Paragraph;
      expect(para.children).toHaveLength(1);
      const link = para.children[0] as Link;
      expect(link.url).toBe(url);
      expect((link.children[0] as Text).value).toBe(url);
    }
  });

  it('显式 [text](url) 不动：label 和 url 不同', () => {
    const tree = explicitLinkTree('点击这里', 'https://example.com/page');
    transform(tree);
    const para = tree.children[0] as Paragraph;
    expect(para.children).toHaveLength(1);
    const link = para.children[0] as Link;
    expect(link.url).toBe('https://example.com/page');
    expect((link.children[0] as Text).value).toBe('点击这里');
  });

  it('显式 link 文本等于 URL 时也保留尾部合法 _', () => {
    const tree = explicitLinkTree('https://example.com/Foo_', 'https://example.com/Foo_');
    transform(tree);
    const para = tree.children[0] as Paragraph;
    expect(para.children).toHaveLength(1);
    const link = para.children[0] as Link;
    expect(link.url).toBe('https://example.com/Foo_');
    expect((link.children[0] as Text).value).toBe('https://example.com/Foo_');
  });

  it('显式 link 文本等于 URL 时也保留尾部普通标点', () => {
    const tree = explicitLinkTree('https://example.com/foo;', 'https://example.com/foo;');
    transform(tree);
    const para = tree.children[0] as Paragraph;
    expect(para.children).toHaveLength(1);
    const link = para.children[0] as Link;
    expect(link.url).toBe('https://example.com/foo;');
    expect((link.children[0] as Text).value).toBe('https://example.com/foo;');
  });

  it('显式 link 文本等于 URL 且含 CJK boundary 时也不动', () => {
    const tree = explicitLinkTree('https://example.com/路径', 'https://example.com/路径');
    transform(tree);
    const para = tree.children[0] as Paragraph;
    expect(para.children).toHaveLength(1);
    const link = para.children[0] as Link;
    expect(link.url).toBe('https://example.com/路径');
    expect((link.children[0] as Text).value).toBe('https://example.com/路径');
  });

  it('真实 remark-gfm 解析：PR URL 后接有空格的括号说明只链接 PR URL', () => {
    expect(
      linksFromMarkdown('已提交。 PR #283 → https://github.com/makecindy/cindy/pull/283(base main,OPEN)'),
    ).toEqual(['https://github.com/makecindy/cindy/pull/283']);
  });

  it('真实 remark-gfm 解析：PR URL 后接无空格的括号说明只链接 PR URL', () => {
    expect(
      linksFromMarkdown('已提交。 PR #283 → https://github.com/makecindy/cindy/pull/283(base,OPEN)'),
    ).toEqual(['https://github.com/makecindy/cindy/pull/283']);
  });

  it('真实 remark-gfm 解析：带 trailing slash 的 PR URL 后接括号说明只链接 PR URL', () => {
    expect(
      linksFromMarkdown('已提交。 PR #283 → https://github.com/makecindy/cindy/pull/283/(base,OPEN)'),
    ).toEqual(['https://github.com/makecindy/cindy/pull/283/']);
    expect(
      linksFromMarkdown(`已提交。 MR !42 → ${GITLAB_MR_URL}/(base,OPEN)`),
    ).toEqual([`${GITLAB_MR_URL}/`]);
  });

  it('真实 remark-gfm 解析：PR URL 后接括号说明和句末标点只链接 PR URL', () => {
    expect(
      linksFromMarkdown('已提交。 PR #283 → https://github.com/makecindy/cindy/pull/283(base,OPEN).'),
    ).toEqual(['https://github.com/makecindy/cindy/pull/283']);
  });

  it('真实 remark-gfm 解析：PR URL 后接括号说明和全角标点只链接 PR URL', () => {
    expect(
      linksFromMarkdown('已提交。 PR #283 → https://github.com/makecindy/cindy/pull/283(base,OPEN)，状态正常'),
    ).toEqual(['https://github.com/makecindy/cindy/pull/283']);
  });

  it('真实 remark-gfm 解析：被外层括号包住的 PR URL 说明只链接 PR URL', () => {
    expect(
      linksFromMarkdown('(see https://github.com/makecindy/cindy/pull/283(base,OPEN))'),
    ).toEqual(['https://github.com/makecindy/cindy/pull/283']);
  });

  it('真实 remark-gfm 解析：被外层括号包住的 PR URL 说明后接句末标点只链接 PR URL', () => {
    expect(
      linksFromMarkdown('(see https://github.com/makecindy/cindy/pull/283(base,OPEN)).'),
    ).toEqual(['https://github.com/makecindy/cindy/pull/283']);
    expect(
      linksFromMarkdown('(see https://github.com/makecindy/cindy/pull/283(base,OPEN))，状态正常'),
    ).toEqual(['https://github.com/makecindy/cindy/pull/283']);
  });

  it('真实 remark-gfm 解析：Markdown 包裹 URL 后接无空格括号说明只链接 URL', () => {
    expect(
      linksFromMarkdown('**https://github.com/makecindy/cindy/pull/163**(ready)'),
    ).toEqual(['https://github.com/makecindy/cindy/pull/163']);
  });

  it('Markdown 包裹 code-host 括号说明时先用 marker 边界识别 URL 说明', () => {
    const tree = markdownWrappedAutolinkTree(
      '**',
      'https://github.com/makecindy/cindy/pull/283(base,OPEN)**',
    );
    transform(tree);
    const para = tree.children[0] as Paragraph;
    const link = para.children[1] as Link;
    const tail = para.children[2] as Text;
    expect(link.url).toBe('https://github.com/makecindy/cindy/pull/283');
    expect((link.children[0] as Text).value).toBe('https://github.com/makecindy/cindy/pull/283');
    expect(tail.value).toBe('(base,OPEN)**');
  });

  it('Markdown marker 在外层括号后面时仍先识别 code-host 括号说明', () => {
    const tree = markdownWrappedAutolinkTree(
      '**(see ',
      'https://github.com/makecindy/cindy/pull/283(base,OPEN))**',
    );
    transform(tree);
    const para = tree.children[0] as Paragraph;
    const link = para.children[1] as Link;
    const tail = para.children[2] as Text;
    expect(link.url).toBe('https://github.com/makecindy/cindy/pull/283');
    expect((link.children[0] as Text).value).toBe('https://github.com/makecindy/cindy/pull/283');
    expect(tail.value).toBe('(base,OPEN))**');
  });

  it('真实 remark-gfm 解析：query / fragment 中的括号和 bracket 不被误切', () => {
    expect(linksFromMarkdown('https://example.com/search?q=(foo)&tags=[a]#sec')).toEqual([
      'https://example.com/search?q=(foo)&tags=[a]#sec',
    ]);
    expect(linksFromMarkdown('https://example.com/search?q=[a]#frag[b]')).toEqual([
      'https://example.com/search?q=[a]#frag[b]',
    ]);
    expect(linksFromMarkdown('https://example.com/search?q={a}#frag{b}')).toEqual([
      'https://example.com/search?q={a}#frag{b}',
    ]);
    expect(linksFromMarkdown('https://example.com/search?q=a)b')).toEqual([
      'https://example.com/search?q=a)b',
    ]);
    expect(linksFromMarkdown('https://example.com/search#frag)a')).toEqual([
      'https://example.com/search#frag)a',
    ]);
  });

  it('真实 remark-gfm 解析：非 code-host 数字 path 后的配对括号不被误切', () => {
    expect(linksFromMarkdown('https://example.com/article/123(v2)')).toEqual([
      'https://example.com/article/123(v2)',
    ]);
  });

  it('真实 remark-gfm 解析：非 code-host 的 issues / pull path 后配对括号不被误切', () => {
    expect(linksFromMarkdown('https://example.com/issues/123(v2)')).toEqual([
      'https://example.com/issues/123(v2)',
    ]);
    expect(linksFromMarkdown('https://example.com/pull/123(foo)')).toEqual([
      'https://example.com/pull/123(foo)',
    ]);
  });
});
