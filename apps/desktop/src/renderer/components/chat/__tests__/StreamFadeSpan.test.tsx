// @vitest-environment jsdom

import { useLayoutEffect, useMemo, type AnimationEvent as ReactAnimationEvent } from 'react';
import { cleanup, fireEvent, render } from '@testing-library/react';
import ReactMarkdown, { type Components } from 'react-markdown';
import type { PluggableList } from 'unified';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { StreamFadeListItem, StreamFadeSpan } from '../StreamFadeSpan';
import {
  commitWordFadeCandidate,
  createWordFadeCandidate,
  createWordFadeState,
  rehypeStreamWordFade,
  type WordFadeState,
} from '../rehypeStreamWordFade';

afterEach(cleanup);

function fireAnimationEnd(element: Element, animationName = 'stream-word-in'): void {
  // jsdom 没有 AnimationEvent,React 会选择 WebKit 前缀事件名。
  const event = new Event('webkitAnimationEnd', { bubbles: true });
  Object.defineProperty(event, 'animationName', { value: animationName });
  fireEvent(element, event);
}

function StreamingMarkdownHarness({
  content,
  state,
}: {
  content: string;
  state: WordFadeState;
}) {
  const candidate = useMemo(() => createWordFadeCandidate(state), [content, state]);
  const rehypePlugins = useMemo(
    () => [[rehypeStreamWordFade, candidate]] as PluggableList,
    [candidate],
  );
  const components = useMemo<Components>(
    () => ({
      span: (props) => <StreamFadeSpan {...props} wordFadeState={state} />,
      li: (props) => <StreamFadeListItem {...props} wordFadeState={state} />,
    }),
    [state],
  );

  useLayoutEffect(() => {
    commitWordFadeCandidate(state, candidate);
  }, [candidate, state]);

  return (
    <ReactMarkdown rehypePlugins={rehypePlugins} components={components}>
      {content}
    </ReactMarkdown>
  );
}

describe('StreamFadeSpan', () => {
  it('动画结束使用 render 时捕获的 key,不读取后来变化的 dataset', () => {
    const state = createWordFadeState();
    let forwardedTargetMatched = false;
    const forwardedAnimationEnd = vi.fn((event: ReactAnimationEvent<HTMLSpanElement>) => {
      forwardedTargetMatched = event.target === event.currentTarget;
    });
    const { container } = render(
      <StreamFadeSpan
        className="stream-word"
        node={{
          type: 'element',
          tagName: 'span',
          properties: { dataWfKey: 'wf-original' },
          children: [],
        }}
        onAnimationEnd={forwardedAnimationEnd}
        wordFadeState={state}
      >
        word
      </StreamFadeSpan>,
    );
    const span = container.querySelector<HTMLSpanElement>('.stream-word');
    expect(span).not.toBeNull();
    expect(span!.dataset.wfKey).toBe('wf-original');

    span!.dataset.wfKey = 'wf-reused';
    fireAnimationEnd(span!);

    expect(forwardedAnimationEnd).toHaveBeenCalledOnce();
    expect(forwardedAnimationEnd.mock.calls[0][0].animationName).toBe('stream-word-in');
    expect(forwardedTargetMatched).toBe(true);
    expect(state.timeline.settled.has('wf-original')).toBe(true);
    expect(state.timeline.settled.has('wf-reused')).toBe(false);
  });

  it('忽略子节点冒泡和其它动画名', () => {
    const state = createWordFadeState();
    const { container } = render(
      <StreamFadeSpan
        className="stream-word"
        node={{
          type: 'element',
          tagName: 'span',
          properties: { dataWfKey: 'wf-atom' },
          children: [],
        }}
        wordFadeState={state}
      >
        <code>atom</code>
      </StreamFadeSpan>,
    );
    const span = container.querySelector<HTMLSpanElement>('.stream-word')!;

    fireAnimationEnd(span.querySelector('code')!);
    fireAnimationEnd(span, 'spinner-rotate');

    expect(state.timeline.settled.size).toBe(0);
  });

  it('settled 后只摘动画 class，后续增长不替换既有 DOM 节点', () => {
    const state = createWordFadeState();
    state.timeline.nowFn = () => 0;
    const view = render(<StreamingMarkdownHarness content="one two three" state={state} />);
    const firstFrame = Array.from(
      view.container.querySelectorAll<HTMLSpanElement>('[data-wf-key]'),
    );
    const firstKeys = firstFrame.map((span) => span.dataset.wfKey);

    fireAnimationEnd(firstFrame[0]);
    expect(firstFrame[0].isConnected).toBe(true);
    expect(firstFrame[0].classList.contains('stream-word')).toBe(false);
    view.rerender(<StreamingMarkdownHarness content="one two three four" state={state} />);

    const secondFrame = Array.from(
      view.container.querySelectorAll<HTMLSpanElement>('[data-wf-key]'),
    );
    expect(secondFrame.map((span) => span.textContent)).toEqual([
      'one ',
      'two ',
      'three ',
      'four',
    ]);
    expect(secondFrame.slice(0, 3).map((span) => span.dataset.wfKey)).toEqual(firstKeys);
    expect(secondFrame[0]).toBe(firstFrame[0]);
    expect(secondFrame[1]).toBe(firstFrame[1]);
    expect(secondFrame[2]).toBe(firstFrame[2]);
  });

  it('DOM commit 接入 16ms / 96ms 连续时间线', () => {
    const state = createWordFadeState();
    state.timeline.nowFn = () => 0;
    const content = Array.from({ length: 10 }, (_, index) => `w${index}`).join(' ');
    const { container } = render(<StreamingMarkdownHarness content={content} state={state} />);
    const delays = Array.from(
      container.querySelectorAll<HTMLSpanElement>('[data-wf-key]'),
      (span) => span.style.getPropertyValue('--wf-delay'),
    );
    expect(delays).toEqual([
      '0ms',
      '16ms',
      '32ms',
      '48ms',
      '64ms',
      '80ms',
      '96ms',
      '100ms',
      '104ms',
      '108ms',
    ]);
  });

  it('千级突发段把透明等待限制在 160ms 内，同时保留前段节奏', () => {
    const state = createWordFadeState();
    state.timeline.nowFn = () => 0;
    const content = Array.from({ length: 1_000 }, (_, index) => `w${index}`).join(' ');
    const { container } = render(<StreamingMarkdownHarness content={content} state={state} />);
    const delays = Array.from(
      container.querySelectorAll<HTMLSpanElement>('[data-wf-key]'),
      (span) => Number.parseInt(span.style.getPropertyValue('--wf-delay'), 10),
    );

    expect(delays).toHaveLength(1_000);
    expect(delays.slice(0, 10)).toEqual([0, 16, 32, 48, 64, 80, 96, 100, 104, 108]);
    expect(Math.max(...delays)).toBe(160);
    expect(delays.at(-1)).toBe(160);
  });

  it('列表圆点与首段共用 delay，完成后保留 li 节点', () => {
    const state = createWordFadeState();
    state.timeline.nowFn = () => 0;
    const { container } = render(
      <StreamingMarkdownHarness content="- alpha beta" state={state} />,
    );
    const li = container.querySelector<HTMLLIElement>('[data-stream-marker]')!;
    const firstWord = li.querySelector<HTMLSpanElement>('[data-wf-key]')!;
    const key = firstWord.dataset.wfKey!;

    expect(li.dataset.wfKey).toBe(key);
    expect(li.style.getPropertyValue('--wf-delay')).toBe(
      firstWord.style.getPropertyValue('--wf-delay'),
    );
    fireAnimationEnd(li, 'stream-marker-in');
    expect(li.isConnected).toBe(true);
    expect(li.hasAttribute('data-stream-marker')).toBe(false);
    expect(state.timeline.settled.has(key)).toBe(true);
  });
});
