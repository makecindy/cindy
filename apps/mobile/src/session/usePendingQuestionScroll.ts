import type { TextInputInstance, ScrollViewInstance } from 'react-native';
import { createContext, useCallback, useRef } from 'react';
import type { FocusEvent, LayoutChangeEvent } from 'react-native';

type InputTarget = FocusEvent['target'] & Partial<Pick<TextInputInstance, 'isFocused'>>;

/**
 * Lets a free-text question card report the height between the bottom of its
 * answer box and the bottom of the card. Zero means "reveal to the end".
 */
export const PendingAnswerTrailingInsetContext = createContext<((inset: number) => void) | null>(null);

/**
 * Keep the answer in view while the question input is focused.
 *
 * A card with options reveals the answer and its actions together. A card
 * whose only answer is free text reports how much sits below its answer box
 * (`setTrailingInset`); the reveal then stops at the answer box, so the
 * question above it stays readable while the keyboard is open.
 */
export function usePendingQuestionScroll(requestId: string | null) {
  const scrollRef = useRef<ScrollViewInstance>(null);
  const focused = useRef<{ requestId: string | null; input: InputTarget } | null>(null);
  const metrics = useRef({ content: 0, viewport: 0, trailingInset: 0 });
  const reveal = useCallback(() => {
    const current = focused.current;
    // RN TextInput's host instance owns focus and clears it on unmount. A
    // bubbled blur is not guaranteed when switching questions or presets.
    if (!requestId || current?.requestId !== requestId || !current.input.isFocused?.()) return;
    const { content, viewport, trailingInset } = metrics.current;
    if (trailingInset > 0 && content > 0 && viewport > 0) {
      scrollRef.current?.scrollTo({ y: Math.max(0, content - viewport - trailingInset), animated: false });
      return;
    }
    scrollRef.current?.scrollToEnd({ animated: false });
  }, [requestId]);
  const onFocus = (event: FocusEvent) => {
    focused.current = { requestId, input: event.target as InputTarget };
    reveal();
  };
  const onBlur = (event: FocusEvent) => {
    if (focused.current?.input === event.target) focused.current = null;
  };
  const onLayout = useCallback((event: LayoutChangeEvent) => {
    metrics.current.viewport = event.nativeEvent.layout.height;
    reveal();
  }, [reveal]);
  const onContentSizeChange = useCallback((_width: number, height: number) => {
    metrics.current.content = height;
    reveal();
  }, [reveal]);
  const setTrailingInset = useCallback((inset: number) => {
    if (metrics.current.trailingInset === inset) return;
    metrics.current.trailingInset = inset;
    reveal();
  }, [reveal]);
  return { scrollRef, onFocus, onBlur, onLayout, onContentSizeChange, setTrailingInset, reveal };
}
