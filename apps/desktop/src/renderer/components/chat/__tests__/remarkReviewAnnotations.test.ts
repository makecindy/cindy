import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import type { Options as MarkdownOptions } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import { describe, expect, it } from 'vitest';
import type { Root } from 'mdast';

import {
  MARKDOWN_REMARK_PLUGINS,
} from '../markdownPluginPipeline';
import {
  collectReviewMarks,
  hasUnconsumedReviewMarks,
  REVIEW_DELETE_CLASS,
  REVIEW_INSERT_CLASS,
  REVIEW_REHYPE_HANDLERS,
  remarkReviewAnnotations,
} from '../remarkReviewAnnotations';

/** 与 MarkdownRenderer 打开 reviewAnnotations 时相同的解析链（镜像管线）。 */
function render(content: string): string {
  return renderToStaticMarkup(
    createElement(ReactMarkdown, {
      remarkPlugins: [remarkGfm, remarkReviewAnnotations],
      remarkRehypeOptions: {
        handlers: REVIEW_REHYPE_HANDLERS,
      } as unknown as NonNullable<MarkdownOptions['remarkRehypeOptions']>,
      children: content,
    }),
  );
}

const parser = unified().use(remarkParse).use(remarkGfm);

/** 渲染链完整版（含 transformer）：用来验证「渲染时才出现的行内节点」也能被折叠包含。 */
function renderWithPipeline(content: string): string {
  return renderToStaticMarkup(
    createElement(ReactMarkdown, {
      remarkPlugins: [...MARKDOWN_REMARK_PLUGINS, remarkReviewAnnotations],
      remarkRehypeOptions: {
        handlers: REVIEW_REHYPE_HANDLERS,
      } as unknown as NonNullable<MarkdownOptions['remarkRehypeOptions']>,
      children: content,
    }),
  );
}

function transform(source: string): Root {
  const tree = parser.parse(source) as Root;
  remarkReviewAnnotations()(tree);
  return tree;
}

describe('collectReviewMarks', () => {
  it('collects insert and delete marks with their ranges', () => {
    const value = 'head {++new++} mid {--old--} tail';
    const marks = collectReviewMarks(value);

    expect(marks).toEqual([
      { kind: 'insert', inner: 'new', start: 5, end: 14 },
      { kind: 'delete', inner: 'old', start: 19, end: 28 },
    ]);
  });

  it('ignores marks whose body contains braces', () => {
    expect(collectReviewMarks('{++a{b++}')).toEqual([]);
    expect(collectReviewMarks('{--a}b--}')).toEqual([]);
  });
});

describe('remarkReviewAnnotations rendering', () => {
  it('renders insert marks as styled <ins>', () => {
    const html = render('前 {++新增的判断++} 后');
    expect(html).toContain(`<ins class="${REVIEW_INSERT_CLASS}">新增的判断</ins>`);
  });

  it('renders delete marks as styled <del>', () => {
    const html = render('前 {--删掉的句子--} 后');
    expect(html).toContain(`<del class="${REVIEW_DELETE_CLASS}">删掉的句子</del>`);
  });

  it('folds a mark that spans inline elements inside one container', () => {
    const html = render('{--Run `old` now--}');
    // 行内代码被整体包进删除线，而不是把标记渲染成字面量。
    expect(html).toContain(`<del class="${REVIEW_DELETE_CLASS}">Run <code>old</code> now</del>`);
    expect(html).not.toContain('{--');
  });

  it('leaves a mark that would wrap block-level siblings unconsumed', () => {
    // 跨两个段落：折叠会把 <p> 塞进 <del>，插件必须放弃，由调用方回退。
    const html = render('{--one\n\ntwo--}');
    expect(html).toContain('{--');
  });

  it('keeps ordinary chat-style text untouched without the plugin', () => {
    const html = renderToStaticMarkup(
      createElement(ReactMarkdown, { remarkPlugins: [remarkGfm], children: '{++not-a-mark++}' }),
    );
    expect(html).toContain('{++not-a-mark++}');
    expect(html).not.toContain('<ins');
  });
});

describe('remarkReviewAnnotations — inline holes', () => {
  // 标记里的链接 / 图片 / 行内代码是「洞」：flat 只拼文本节点，不给洞留位置时
  // 「标记在洞前闭合」与「标记把洞包在内部」完全同形，折叠会把洞静默丢掉。
  it('keeps a link inside the mark when the closing delimiter follows it', () => {
    const html = render('{++部署见 [文档](https://example.com)++}');
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('文档');
    expect(html).toMatch(/<ins[^>]*>部署见 <a[^>]*>文档<\/a><\/ins>/);
  });

  it('keeps consecutive inline nodes inside the mark', () => {
    const html = render('{++[x](u)[y](v) a++}');
    expect(html).toMatch(/<ins[^>]*><a[^>]*href="u"[^>]*>x<\/a><a[^>]*href="v"[^>]*>y<\/a> a<\/ins>/);
  });

  it('keeps an inline image inside the mark', () => {
    const html = render('{++ ![](y.png) ++}');
    expect(html).toMatch(/<ins[^>]*> <img[^>]*y\.png[^>]*> <\/ins>/);
  });

  it('leaves a link after the closing delimiter outside the mark', () => {
    const html = render('{++a++}[x](y)');
    expect(html).toMatch(/<ins[^>]*>a<\/ins><a[^>]*href="y"[^>]*>x<\/a>/);
  });

  it('keeps a link created by the render pipeline inside the mark', () => {
    // 渲染链的 remarkLocalPathLinks 会把裸路径切成 link；校验 / 折叠只看裸
    // remarkParse 时那段文本不在 flat 里，路径链接会被折叠丢掉。
    const html = renderWithPipeline('{--edit docs/readme.md now--}');
    expect(html).toContain('data-bare-path');
    expect(html).toMatch(/<del[^>]*>edit <a[^>]*href="docs\/readme\.md"[^>]*>/);
    expect(html).toMatch(/<del[^>]*>[\s\S]*now<\/del>/);
  });
});

describe('hasUnconsumedReviewMarks', () => {
  it('is false after a clean transform', () => {
    expect(hasUnconsumedReviewMarks(transform('Run {--old--} now'))).toBe(false);
  });

  it('detects residues left inside inline code', () => {
    // 标记落在行内代码里时插件无法折叠，渲染出来就是字面量 —— 必须算残留。
    expect(hasUnconsumedReviewMarks(transform('Run `{--old--}` now'))).toBe(true);
  });

  it('detects residues across block-level siblings', () => {
    expect(hasUnconsumedReviewMarks(transform('{--one\n\ntwo--}'))).toBe(true);
  });
});
