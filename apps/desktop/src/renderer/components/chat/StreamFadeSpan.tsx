import type {
  AnimationEvent as ReactAnimationEvent,
  ComponentPropsWithoutRef,
} from 'react';
import { useCallback } from 'react';
import type { Element } from 'hast';

import {
  isWordFadeSettled,
  markWordFadeSettled,
  scheduleWordFadeSegment,
  type WordFadeState,
} from './rehypeStreamWordFade';

interface StreamFadeSpanProps extends ComponentPropsWithoutRef<'span'> {
  node?: Element;
  wordFadeState: WordFadeState | null;
}

interface StreamFadeListItemProps extends ComponentPropsWithoutRef<'li'> {
  node?: Element;
  wordFadeState: WordFadeState | null;
}

function readWordFadeKey(node?: Element): string | undefined {
  const rawWordFadeKey = node?.properties?.dataWfKey;
  return typeof rawWordFadeKey === 'string' ? rawWordFadeKey : undefined;
}

function removeStreamWordClass(className?: string): string | undefined {
  if (!className) return className;
  const next = className
    .split(/\s+/)
    .filter((name) => name && name !== 'stream-word')
    .join(' ');
  return next || undefined;
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
  const wordFadeKey = readWordFadeKey(node);
  const settled = Boolean(
    wordFadeState && wordFadeKey && isWordFadeSettled(wordFadeState, wordFadeKey),
  );
  const attachSpan = useCallback(
    (element: HTMLSpanElement | null) => {
      if (element && wordFadeState && wordFadeKey && !settled) {
        scheduleWordFadeSegment(wordFadeState, wordFadeKey, element);
      }
    },
    [settled, wordFadeKey, wordFadeState],
  );
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
    event.currentTarget.classList.remove('stream-word');
  };

  return (
    <span
      key={wordFadeKey}
      ref={attachSpan}
      {...props}
      className={settled ? removeStreamWordClass(props.className) : props.className}
      data-wf-key={wordFadeKey}
      onAnimationEnd={handleAnimationEnd}
    >
      {children}
    </span>
  );
}

/** 列表圆点与 li 内首段共用 key 和时间线；ref 在 paint 前校正 ::marker delay。 */
export function StreamFadeListItem({
  children,
  node,
  onAnimationEnd,
  wordFadeState,
  ...props
}: StreamFadeListItemProps) {
  const wordFadeKey = readWordFadeKey(node);
  const settled = Boolean(
    wordFadeState && wordFadeKey && isWordFadeSettled(wordFadeState, wordFadeKey),
  );
  const attachListItem = useCallback(
    (element: HTMLLIElement | null) => {
      if (element && wordFadeState && wordFadeKey && !settled) {
        scheduleWordFadeSegment(wordFadeState, wordFadeKey, element);
      }
    },
    [settled, wordFadeKey, wordFadeState],
  );
  const handleAnimationEnd = (event: ReactAnimationEvent<HTMLLIElement>) => {
    onAnimationEnd?.(event);
    if (
      !wordFadeState ||
      !wordFadeKey ||
      event.target !== event.currentTarget ||
      event.animationName !== 'stream-marker-in'
    ) {
      return;
    }
    markWordFadeSettled(wordFadeState, wordFadeKey);
    event.currentTarget.removeAttribute('data-stream-marker');
  };
  const markerProps = props as typeof props & { 'data-stream-marker'?: boolean };

  return (
    <li
      ref={attachListItem}
      {...markerProps}
      data-stream-marker={settled ? undefined : markerProps['data-stream-marker']}
      data-wf-key={wordFadeKey}
      onAnimationEnd={handleAnimationEnd}
    >
      {children}
    </li>
  );
}
