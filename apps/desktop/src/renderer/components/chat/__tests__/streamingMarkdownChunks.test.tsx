// @vitest-environment jsdom

import { cleanup, render } from '@testing-library/react';
import ReactMarkdown from 'react-markdown';
import rehypeSlug from 'rehype-slug';
import type { Element, Root } from 'hast';
import type { Plugin, PluggableList } from 'unified';
import { afterEach, describe, expect, it } from 'vitest';

import { StreamingMarkdownChunk } from '../StreamingMarkdownChunk';
import { createWordFadeState } from '../rehypeStreamWordFade';
import {
  getStreamingMarkdownThrottleInterval,
  splitStreamingMarkdownChunks,
  STREAMING_MARKDOWN_THROTTLE_BASE_MS,
  STREAMING_MARKDOWN_THROTTLE_MAX_MS,
} from '../streamingMarkdownChunks';

afterEach(cleanup);

describe('splitStreamingMarkdownChunks', () => {
  it('自适应节流只提高复杂长文的间隔并保持有界', () => {
    const short = getStreamingMarkdownThrottleInterval('short prose');
    const longSingleHeading = getStreamingMarkdownThrottleInterval(
      `# Heading\n\n${'paragraph '.repeat(2_000)}`,
    );
    const longMultiHeading = getStreamingMarkdownThrottleInterval(
      Array.from(
        { length: 12 },
        (_, index) => `## Section ${index}\n\n${'paragraph '.repeat(2_000)}`,
      ).join('\n\n'),
    );

    expect(short).toBe(STREAMING_MARKDOWN_THROTTLE_BASE_MS);
    expect(longSingleHeading).toBeGreaterThan(short);
    expect(longMultiHeading).toBeGreaterThanOrEqual(longSingleHeading);
    expect(longMultiHeading).toBeLessThanOrEqual(STREAMING_MARKDOWN_THROTTLE_MAX_MS);
    expect(getStreamingMarkdownThrottleInterval('x'.repeat(320_001))).toBe(
      STREAMING_MARKDOWN_THROTTLE_MAX_MS,
    );
  });

  it('只在已经出现下一段的顶层空行后确认稳定前缀', () => {
    expect(splitStreamingMarkdownChunks('alpha\n\n')).toEqual([
      { start: 0, content: 'alpha\n\n' },
    ]);
    expect(splitStreamingMarkdownChunks('alpha\n\nbeta')).toEqual([
      { start: 0, content: 'alpha\n\n' },
      { start: 7, content: 'beta' },
    ]);
  });

  it('代码围栏和 directive 内的空行不产生边界', () => {
    const markdown = [
      'intro',
      '',
      '````ts',
      'const fence = "```";',
      '',
      'more',
      '````',
      '',
      'after',
      '',
      ':::note',
      'inside',
      '',
      'still inside',
      ':::',
      '',
      'tail',
    ].join('\n');
    const chunks = splitStreamingMarkdownChunks(markdown);

    expect(chunks.map((chunk) => chunk.content)).toEqual([
      'intro\n\n',
      '````ts\nconst fence = "```";\n\nmore\n````\n\n',
      'after\n\n',
      ':::note\ninside\n\nstill inside\n:::\n\n',
      'tail',
    ]);
  });

  it('数学块内部空行不产生边界', () => {
    const markdown = 'before\n\n$$\na + b\n\nc + d\n$$\n\nafter';
    expect(splitStreamingMarkdownChunks(markdown).map((chunk) => chunk.content)).toEqual([
      'before\n\n',
      '$$\na + b\n\nc + d\n$$\n\n',
      'after',
    ]);
  });

  it('列表、引用和缩进续行保持在同一分片', () => {
    const markdown = 'before\n\n- one\n\n- two\n\n> quote\n> next\n\nafter';
    const chunks = splitStreamingMarkdownChunks(markdown);

    expect(chunks).toEqual([
      { start: 0, content: 'before\n\n- one\n\n- two\n\n> quote\n> next\n\n' },
      { start: 38, content: 'after' },
    ]);
  });

  it('括号式有序列表续项保持在同一分片', () => {
    const markdown = 'before\n\n1) one\n\n2) two\n\nafter';

    expect(splitStreamingMarkdownChunks(markdown)).toEqual([
      { start: 0, content: 'before\n\n1) one\n\n2) two\n\n' },
      { start: 24, content: 'after' },
    ]);
  });

  it('单行或多行引用式链接定义出现时保留整篇上下文', () => {
    for (const markdown of [
      'See [guide].\n\nMore text.\n\n[guide]: https://example.com',
      'See [guide].\n\nMore text.\n\n[guide]:\n  https://example.com',
      'See [foo\\]bar].\n\nMore text.\n\n[foo\\]bar]: https://example.com',
    ]) {
      expect(splitStreamingMarkdownChunks(markdown)).toEqual([
        { start: 0, content: markdown },
      ]);
    }
  });

  it('标题源码无法可靠还原显示文本或出现块级 HTML 时保留整篇解析上下文', () => {
    // 链接、下划线强调与 Setext 标题的显示文本不能从源码逐行还原：回退整篇，
    // 保证 rehype-slug 的去重 id 与终版一致。
    for (const headings of [
      '# [Guide](https://example.com)\n\nbody\n\n# Guide',
      '# snake_case\n\nbody\n\n# snake_case',
      'Title\n=====\n\nbody\n\n# Title',
      // 引用、列表里的标题也参与去重计数，但不在顶层标题清单里。
      '> # Same\n\nbody\n\n# Same\n\nbody\n\n# Tail',
      '# A\n\n> ## A\n\n# A',
      '- # Item\n\nbody\n\n# Item',
      '> Quote\n> ---\n\nbody\n\n# Quote',
    ]) {
      expect(splitStreamingMarkdownChunks(headings)).toEqual([
        { start: 0, content: headings },
      ]);
    }

    // 围栏里的 # 注释不是标题，不该让带代码的长回答失去分片。
    const fencedComment = '# A\n\n1. Step\n\n   ```bash\n       # install\n   ```\n\n# A\n\ntail';
    expect(splitStreamingMarkdownChunks(fencedComment).length).toBeGreaterThan(1);

    for (const htmlBlock of [
      '<details>\nsummary\n\nbody\n</details>\n\nafter',
      '<!-- hidden\n\ncontent -->\n\nafter',
      '<?instruction\n\nvalue?>\n\nafter',
      '<![CDATA[hidden\n\ncontent]]>\n\nafter',
      '<!DOCTYPE html>\n\nafter',
    ]) {
      expect(splitStreamingMarkdownChunks(htmlBlock)).toEqual([
        { start: 0, content: htmlBlock },
      ]);
    }
  });
});

function treeText(node: Root | Element): string {
  return node.children
    .map((child) => {
      if (child.type === 'text') return child.value;
      if (child.type === 'element') return treeText(child);
      return '';
    })
    .join('');
}

describe('StreamingMarkdownChunk', () => {
  // 回归：多标题长文曾因标题 id 需要全文上下文而整篇重解析，每个 token 都重跑
  // 全文 Markdown，长回答越写越卡（2026-11-25 黑盒基准 long 场景）。现在分片
  // 只重解析尾块，但标题 id（含重复标题的 -1/-2 后缀）必须与整篇解析一致，
  // 否则文内锚点链接在流式期间跳错位置。
  const headingIds = (root: ParentNode) =>
    Array.from(root.querySelectorAll('h1, h2, h3, h4, h5, h6'), (heading) => heading.id);

  function renderChunks(markdown: string) {
    const chunks = splitStreamingMarkdownChunks(markdown);
    return render(
      <div>
        {chunks.map((chunk) => (
          <StreamingMarkdownChunk
            key={chunk.start}
            sourceKey={String(chunk.start)}
            content={chunk.content}
            remarkPlugins={[]}
            rehypePlugins={[rehypeSlug]}
            components={{}}
            wordFadeState={createWordFadeState()}
            emitSourceLines={false}
            headingSeed={chunk.headingSeed}
          />
        ))}
      </div>,
    );
  }

  function wholeDocumentIds(markdown: string): string[] {
    const whole = render(<ReactMarkdown rehypePlugins={[rehypeSlug]}>{markdown}</ReactMarkdown>);
    const ids = headingIds(whole.container);
    whole.unmount();
    return ids;
  }

  it('多标题长文分片解析，标题 id 与整篇解析一致', () => {
    const markdown = [
      '# Same', 'body', '## **Bold** `code` heading', 'body', '# same', 'body',
      '# Same', 'body', '## Bold code heading', 'tail',
    ].join('\n\n');
    expect(splitStreamingMarkdownChunks(markdown).length).toBeGreaterThan(1);

    const expected = wholeDocumentIds(markdown);
    expect(expected).toEqual(['same', 'bold-code-heading', 'same-1', 'same-2', 'bold-code-heading-1']);
    const chunked = renderChunks(markdown);
    expect(headingIds(chunked.container)).toEqual(expected);
    // 占位标题只用于计数，不进入 DOM。
    expect(chunked.container.querySelectorAll('h1, h2')).toHaveLength(expected.length);
  });

  // 回归（PR #12892 review）：引用、列表里的标题同样参与 rehype-slug 去重，曾被
  // headingSeed 漏掉，后面同名顶层标题的 id 少了 -1 后缀，锚点在流式期间指错。
  it('引用或列表里有标题时，标题 id 仍与整篇解析一致', () => {
    for (const markdown of [
      '> # Same\n\nbody\n\n# Same\n\nbody\n\n# Tail',
      '# A\n\n> ## A\n\n# A',
      '- # Item\n\nbody\n\n# Item\n\ntail',
    ]) {
      const expected = wholeDocumentIds(markdown);
      const chunked = renderChunks(markdown);
      expect(headingIds(chunked.container), markdown).toEqual(expected);
      chunked.unmount();
    }
  });

  it('增长尾部重解析时保留稳定前缀的解析结果与 DOM', () => {
    const parsed: string[] = [];
    const countParses: Plugin<[], Root> = () => (tree) => {
      parsed.push(treeText(tree));
    };
    const remarkPlugins: PluggableList = [];
    const rehypePlugins: PluggableList = [countParses];
    const components = {};

    function Harness({ markdown }: { markdown: string }) {
      return (
        <div>
          {splitStreamingMarkdownChunks(markdown).map((chunk) => (
            <StreamingMarkdownChunk
              key={chunk.start}
              sourceKey={String(chunk.start)}
              content={chunk.content}
              remarkPlugins={remarkPlugins}
              rehypePlugins={rehypePlugins}
              components={components}
              wordFadeState={null}
              emitSourceLines={false}
            />
          ))}
        </div>
      );
    }

    const view = render(<Harness markdown={'stable prefix\n\nlive'} />);
    const stableParagraph = view.container.querySelectorAll('p')[0];
    expect(parsed).toEqual(['stable prefix', 'live']);

    view.rerender(<Harness markdown={'stable prefix\n\nlive tail'} />);
    expect(parsed).toEqual(['stable prefix', 'live', 'live tail']);
    expect(view.container.querySelectorAll('p')[0]).toBe(stableParagraph);
  });

  it('多个分片共享一条淡入时间线', () => {
    const state = createWordFadeState();
    state.timeline.nowFn = () => 0;
    const remarkPlugins: PluggableList = [];
    const rehypePlugins: PluggableList = [];
    const markdown = 'one two\n\nthree four';
    const { container } = render(
      <div>
        {splitStreamingMarkdownChunks(markdown).map((chunk) => (
          <StreamingMarkdownChunk
            key={chunk.start}
            sourceKey={String(chunk.start)}
            content={chunk.content}
            remarkPlugins={remarkPlugins}
            rehypePlugins={rehypePlugins}
            components={{}}
            wordFadeState={state}
            emitSourceLines={false}
          />
        ))}
      </div>,
    );

    expect(
      Array.from(container.querySelectorAll<HTMLElement>('[data-wf-key]'), (element) =>
        element.style.getPropertyValue('--wf-delay'),
      ),
    ).toEqual(['0ms', '16ms', '32ms', '48ms']);
  });

  it('全局上下文晚到并回退整篇解析时不重播已完成分片', () => {
    const state = createWordFadeState();
    state.timeline.nowFn = () => 0;
    const remarkPlugins: PluggableList = [];
    const rehypePlugins: PluggableList = [];

    function Harness({ markdown }: { markdown: string }) {
      const chunks = splitStreamingMarkdownChunks(markdown);
      return (
        <div>
          {chunks.map((chunk) => (
            <StreamingMarkdownChunk
              key={chunk.start}
              sourceKey={String(chunk.start)}
              content={chunk.content}
              remarkPlugins={remarkPlugins}
              rehypePlugins={rehypePlugins}
              components={{}}
              wordFadeState={state}
              emitSourceLines={false}
              wholeDocument={chunks.length === 1}
            />
          ))}
        </div>
      );
    }

    const initial = '# First\n\nstable prefix\n\nlive tail';
    const view = render(<Harness markdown={initial} />);
    const firstFrame = Array.from(
      view.container.querySelectorAll<HTMLSpanElement>('[data-wf-key]'),
    );
    const completedKeys = firstFrame.map((span) => span.dataset.wfKey!);
    expect(state.sourceStateByKey.size).toBeGreaterThan(1);
    for (const key of completedKeys) state.timeline.settled.add(key);

    // 引用式链接定义会反向影响前文，晚到时整篇回退解析。
    view.rerender(<Harness markdown={`${initial}\n\n[guide]: https://example.com\n\nSecond`} />);

    const secondFrame = Array.from(
      view.container.querySelectorAll<HTMLSpanElement>('[data-wf-key]'),
    );
    const byKey = new Map(secondFrame.map((span) => [span.dataset.wfKey!, span]));
    expect(completedKeys.every((key) => byKey.has(key))).toBe(true);
    expect(completedKeys.every((key) => !byKey.get(key)!.classList.contains('stream-word'))).toBe(
      true,
    );
    expect(secondFrame.filter((span) => span.classList.contains('stream-word'))).toHaveLength(1);
    expect(secondFrame.at(-1)?.textContent).toBe('Second');
    expect(state.sourceStateByKey.size).toBe(1);
  });
});
