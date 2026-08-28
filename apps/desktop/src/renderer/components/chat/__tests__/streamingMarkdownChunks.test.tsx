// @vitest-environment jsdom

import { cleanup, render } from '@testing-library/react';
import type { Element, Root } from 'hast';
import type { Plugin, PluggableList } from 'unified';
import { afterEach, describe, expect, it } from 'vitest';

import { StreamingMarkdownChunk } from '../StreamingMarkdownChunk';
import { createWordFadeState } from '../rehypeStreamWordFade';
import { splitStreamingMarkdownChunks } from '../streamingMarkdownChunks';

afterEach(cleanup);

describe('splitStreamingMarkdownChunks', () => {
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

  it('多个标题或块级 HTML 出现时保留整篇解析上下文', () => {
    for (const headings of ['# Same\n\nbody\n\n# same', '# foo\n\nbody\n\n# foo!']) {
      expect(splitStreamingMarkdownChunks(headings)).toEqual([
        { start: 0, content: headings },
      ]);
    }

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

    view.rerender(<Harness markdown={`${initial}\n\n# Second`} />);

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
