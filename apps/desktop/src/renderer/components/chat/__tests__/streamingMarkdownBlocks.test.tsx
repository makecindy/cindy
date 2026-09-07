// @vitest-environment jsdom

import { cleanup, render } from '@testing-library/react';
import ReactMarkdown, { type Components, type UrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSlug from 'rehype-slug';
import type { PluggableList } from 'unified';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { StreamingMarkdownChunk } from '../StreamingMarkdownChunk';
import { createWordFadeState, type WordFadeState } from '../rehypeStreamWordFade';

afterEach(cleanup);

const remarkPlugins: PluggableList = [remarkGfm];
const rehypePlugins: PluggableList = [rehypeSlug];
const defaultComponents: Components = { img: ({ node: _node, src, ...props }) => <img {...props} src={src || undefined} /> };

function Harness({ content, state, components = defaultComponents, urlTransform }: {
  content: string;
  state: WordFadeState;
  components?: Components;
  urlTransform?: UrlTransform;
}) {
  return <StreamingMarkdownChunk
    sourceKey="0"
    content={content}
    remarkPlugins={remarkPlugins}
    rehypePlugins={rehypePlugins}
    components={components}
    urlTransform={urlTransform}
    wordFadeState={state}
    emitSourceLines={false}
    wholeDocument
  />;
}

function withoutFadeMarkup(container: HTMLElement): string {
  const clone = container.cloneNode(true) as HTMLElement;
  for (const element of clone.querySelectorAll('[data-wf-key]')) {
    if (element.tagName === 'SPAN') element.replaceWith(...element.childNodes);
    else {
      element.removeAttribute('data-wf-key');
      element.removeAttribute('data-stream-marker');
      element.removeAttribute('style');
    }
  }
  return clone.innerHTML;
}

describe('streaming Markdown block reuse', () => {
  it('长文追加只渲染变化的块，旧词的 DOM、样式与选择锚点均不变', () => {
    const state = createWordFadeState();
    let now = 0;
    state.timeline.nowFn = () => now;
    const renderParagraph = vi.fn();
    const components: Components = {
      p: ({ children }) => { renderParagraph(); return <p>{children}</p>; },
    };
    const prefix = Array.from({ length: 80 }, (_, i) => `## Heading ${i}\n\nold paragraph ${i}\n\n`).join('');
    const view = render(<Harness content={`${prefix}live`} state={state} components={components} />);
    const paragraph = view.container.querySelector('p')!;
    const word = paragraph.querySelector('[data-wf-key]')!;
    const selection = window.getSelection()!;
    const range = document.createRange();
    range.selectNodeContents(word);
    selection.removeAllRanges();
    selection.addRange(range);
    const anchor = selection.anchorNode;
    const selected = selection.toString();
    const observer = new MutationObserver(() => {});
    observer.observe(paragraph, { subtree: true, attributes: true, childList: true, characterData: true });
    renderParagraph.mockClear();
    now = 500;
    view.rerender(<Harness content={`${prefix}live grows`} state={state} components={components} />);
    expect(renderParagraph).toHaveBeenCalledTimes(1);
    expect(view.container.querySelector('p')).toBe(paragraph);
    expect(paragraph.querySelector('[data-wf-key]')).toBe(word);
    expect(observer.takeRecords()).toEqual([]);
    expect(selection.anchorNode).toBe(anchor);
    expect(selection.toString()).toBe(selected);
    expect(view.container.querySelector('cindy-stream-block')).toBeNull();
    observer.disconnect();
    selection.removeAllRanges();
  });

  it.each([
    '# Same\n\nbody\n\n# Same\n\n[guide]\n\n[guide]: https://example.com',
    '# First\n\ntext[^note]\n\n# Second\n\n[^note]: footnote body',
    '# First\n\n<details>\n<script>hidden()</script>\n\nhidden block\n</details>\n\n# Second',
    '# First\n\n- **bold** and `inline`\n- next\n\n# Second\n\n```ts\nconst a = 1;\n```\n\n| x | y |\n| - | - |\n| a | b |',
    '# First\n\n[safe](https://example.com) [unsafe](javascript:alert) ![bad](javascript:alert)\n\n# Second',
  ])('缓存保留整篇语义及 ReactMarkdown 的安全过滤：%s', (content) => {
    const cached = render(<Harness content={content} state={createWordFadeState()} />);
    const plain = render(<ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={defaultComponents} skipHtml>{content}</ReactMarkdown>);
    expect(withoutFadeMarkup(cached.container)).toBe(plain.container.innerHTML);
  });

  it('晚到的引用定义让旧块失效；重复标题的全局 slug 仍唯一', () => {
    const state = createWordFadeState();
    const prefix = '# Same\n\nSee [guide].\n\n# Same\n\nother';
    const view = render(<Harness content={prefix} state={state} />);
    expect(view.container.querySelector('a')).toBeNull();
    view.rerender(<Harness content={`${prefix}\n\n[guide]: https://example.com`} state={state} />);
    expect(view.container.querySelector('a')?.getAttribute('href')).toBe('https://example.com');
    expect(Array.from(view.container.querySelectorAll('h1'), node => node.id)).toEqual(['same', 'same-1']);
  });

  it('components 或 URL 策略改变时不能复用旧结果', () => {
    const state = createWordFadeState();
    const content = '# Heading\n\n[guide](https://example.com)';
    const view = render(<Harness content={content} state={state} />);
    const components: Components = { p: ({ children }) => <p title="changed context">{children}</p> };
    view.rerender(<Harness content={content} state={state} components={components} />);
    expect(view.container.querySelector('p')?.title).toBe('changed context');
    view.rerender(<Harness content={content} state={state} components={components} urlTransform={() => ''} />);
    expect(view.container.querySelector('a')?.getAttribute('href')).toBe('');
    view.rerender(<Harness content={content} state={state} components={components} />);
    expect(view.container.querySelector('a')?.getAttribute('href')).toBe('https://example.com');
  });

  it('语义块改变但后文相同时，匹配状态与实际 DOM 的 key 保持一致', () => {
    const state = createWordFadeState();
    const view = render(<Harness content={'# First\n\none two\n\n# Second\n\none two'} state={state} />);
    view.rerender(<Harness content={'# First\n\n`one two`\n\n# Second\n\none two'} state={state} />);
    const domKeys = Array.from(view.container.querySelectorAll('span[data-wf-key]'), node => node.getAttribute('data-wf-key'));
    expect(domKeys).toEqual(state.sourceStateByKey.get('0')!.previous.map(segment => segment.key));
    expect(new Set(domKeys).size).toBe(domKeys.length);
  });
});
