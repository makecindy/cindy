import type {
  AnimationEvent as ReactAnimationEvent,
  ComponentPropsWithoutRef,
} from 'react';
import type { Element } from 'hast';

import { markWordFadeSettled, type WordFadeState } from './rehypeStreamWordFade';

interface StreamFadeSpanProps extends ComponentPropsWithoutRef<'span'> {
  node?: Element;
  wordFadeState: WordFadeState | null;
}

/**
 * ReactMarkdown 给自定义 renderer 的外层 key 是位置型 span-N。这里再用逻辑 key
 * 标识真实 DOM span:位置被复用给别的段时会 remount,旧动画不能污染新段。
 */
export function StreamFadeSpan({
  children,
  node,
  onAnimationEnd,
  wordFadeState,
  ...props
}: StreamFadeSpanProps) {
  const rawWordFadeKey = node?.properties?.dataWfKey;
  const wordFadeKey = typeof rawWordFadeKey === 'string' ? rawWordFadeKey : undefined;
  const handleAnimationEnd = (event: ReactAnimationEvent<HTMLSpanElement>) => {
    onAnimationEnd?.(event);
    if (
      !wordFadeState ||
      !wordFadeKey ||
      event.target !== event.currentTarget ||
      event.animationName !== 'stream-word-in'
    ) {
      return;
    }
    markWordFadeSettled(wordFadeState, wordFadeKey);
  };

  return (
    <span
      key={wordFadeKey}
      {...props}
      data-wf-key={wordFadeKey}
      onAnimationEnd={handleAnimationEnd}
    >
      {children}
    </span>
  );
}
