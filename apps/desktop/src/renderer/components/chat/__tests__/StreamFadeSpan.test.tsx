// @vitest-environment jsdom

import { useLayoutEffect, useMemo, type AnimationEvent as ReactAnimationEvent } from 'react';
import { cleanup, fireEvent, render } from '@testing-library/react';
import ReactMarkdown, { type Components } from 'react-markdown';
import type { PluggableList } from 'unified';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { StreamFadeSpan } from '../StreamFadeSpan';
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
    expect(state.settled.has('wf-original')).toBe(true);
    expect(state.settled.has('wf-reused')).toBe(false);
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

    expect(state.settled.size).toBe(0);
  });

  it('settled 前缀拆除导致位置 key 前移时重建真实 span,旧节点不能结算新段', () => {
    const state = createWordFadeState();
    state.nowFn = () => 0;
    const view = render(<StreamingMarkdownHarness content="one two three" state={state} />);
    const firstFrame = Array.from(
      view.container.querySelectorAll<HTMLSpanElement>('.stream-word'),
    );
    const oldFirst = firstFrame[0];
    const oldSecond = firstFrame[1];
    const secondKey = oldSecond.dataset.wfKey!;

    fireAnimationEnd(oldFirst);
    view.rerender(<StreamingMarkdownHarness content="one two three four" state={state} />);

    const secondFrame = Array.from(
      view.container.querySelectorAll<HTMLSpanElement>('.stream-word'),
    );
    expect(secondFrame.map((span) => span.textContent)).toEqual(['two ', 'three ', 'four']);
    expect(secondFrame[0].dataset.wfKey).toBe(secondKey);
    expect(secondFrame[0]).not.toBe(oldFirst);
    expect(oldSecond.isConnected).toBe(false);

    fireAnimationEnd(oldSecond);
    expect(state.settled.has(secondKey)).toBe(false);

    fireAnimationEnd(secondFrame[0]);
    expect(state.settled.has(secondKey)).toBe(true);
  });
});
