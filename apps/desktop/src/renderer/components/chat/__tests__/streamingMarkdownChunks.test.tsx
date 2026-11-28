// @vitest-environment jsdom

import { act, cleanup, render } from '@testing-library/react';
import type { Element, Root } from 'hast';
import type { Plugin, PluggableList } from 'unified';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'test-owner' } }) }));
vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { MarkdownRenderer, normalizeMarkdownRendererContent } from '../MarkdownRenderer';

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

  it('块级 HTML 出现时保留整篇解析上下文；多个标题照常分片', () => {
    // 标题 id 由渲染后统一分配（见下方「流式标题 id」），多标题长文不必整篇重解析。
    expect(splitStreamingMarkdownChunks('# Same\n\nbody\n\n# same').length).toBeGreaterThan(1);

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

/**
 * 流式标题 id 的回归（DESIGN.md §14.4 Stream pacing；不变量见 streamingHeadingIds.ts）。
 *
 * 测试价值
 * - 生产入口与可观察结果：真实 MarkdownRenderer，流式（分片解析）与终版（整篇解析）
 *   渲染出的标题 id 列表必须完全相同——文内锚点、目录链接在流式期间不指错。
 * - Bug／规则依据：PR #12892 review 两次报出分片后 id 与终版不一致：引用／列表里的
 *   标题、`$$` 公式块里的 `#` 行。根因是从源码猜标题；现在 id 来自真实解析结果。
 * - 现有覆盖缺口：分片切分用例只看切分边界，不看渲染后的 id。
 * - 最小失败输入：`# Same\n\n$$\n# Same\n$$\n\nbody\n\n# Same\n\ntail`，按源码预置
 *   计数时流式 id 多出一个 -1 后缀。
 * - tier：unit（jsdom）。
 */
describe('流式标题 id（MarkdownRenderer）', () => {
  const headingIds = (root: ParentNode) =>
    Array.from(root.querySelectorAll('h1, h2, h3, h4, h5, h6'), (heading) => heading.id);

  function renderedIds(markdown: string, isStreaming: boolean): string[] {
    const view = render(
      <MarkdownRenderer workingDir="/task" content={markdown} isStreaming={isStreaming} streamFadeKey="heading-ids" />,
    );
    const ids = headingIds(view.container);
    view.unmount();
    return ids;
  }

  const CASES = [
    ['# Same', 'body', '## **Bold** `code` heading', 'body', '# same', 'body', '# Same', 'body', '## Bold code heading', 'tail'].join('\n\n'),
    '> # Same\n\nbody\n\n# Same\n\nbody\n\n# Tail',
    '# A\n\n> ## A\n\n# A',
    '- # Item\n\nbody\n\n# Item\n\ntail',
    '# Same\n\n$$\n# Same\n$$\n\nbody\n\n# Same\n\ntail',
    '# [Guide](https://example.com)\n\nbody\n\n# Guide\n\ntail',
    '# snake_case\n\nbody\n\n# snake_case\n\ntail',
    'Title\n=====\n\nbody\n\n# Title\n\ntail',
    '# Energy $E=mc^2$\n\nbody\n\n# Energy $E=mc^2$\n\ntail',
    '# Setup\n\n```bash\n# Setup\n```\n\n# Setup\n\ntail',
  ];

  it('多标题长文分片解析，各种标题写法下 id 都与终版整篇解析一致', () => {
    expect(renderedIds(CASES[0], false)).toEqual(['same', 'bold-code-heading', 'same-1', 'same-2', 'bold-code-heading-1']);
    for (const markdown of CASES) {
      // 确实走了分片（否则一致是平凡的）。
      expect(splitStreamingMarkdownChunks(normalizeMarkdownRendererContent(markdown)).length, markdown).toBeGreaterThan(1);
      const finalIds = renderedIds(markdown, false);
      expect(finalIds.length, markdown).toBeGreaterThan(0);
      expect(renderedIds(markdown, true), markdown).toEqual(finalIds);
    }
  });

  it('流式中途出现的同名标题拿到递增后缀，已显示标题的元素与 id 保持不变', () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance', 'Date'],
    });
    try {
      const reply = (content: string) => (
        <MarkdownRenderer workingDir="/task" content={content} isStreaming streamFadeKey="heading-ids-growth" />
      );
      const view = render(reply('# Same\n\nbody'));
      const first = view.container.querySelector('h1');
      expect(first?.id).toBe('same');
      view.rerender(reply('# Same\n\nbody\n\n> ## Same\n\n# Same\n\ntail'));
      for (let i = 0; i < 120; i++) {
        act(() => {
          vi.advanceTimersByTime(1000 / 60);
        });
      }
      expect(headingIds(view.container)).toEqual(['same', 'same-1', 'same-2']);
      expect(view.container.querySelector('h1')).toBe(first);
    } finally {
      vi.useRealTimers();
    }
  });
});
