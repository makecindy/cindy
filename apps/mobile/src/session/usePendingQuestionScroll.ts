import { useCallback, useRef } from 'react';
import type { FocusEvent, ScrollView, TextInput } from 'react-native';

type InputTarget = FocusEvent['target'] & Partial<Pick<TextInput, 'isFocused'>>;

/** Reveal the answer and actions together while the question input is focused. */
export function usePendingQuestionScroll(requestId: string | null) {
  const scrollRef = useRef<ScrollView>(null);
  const focused = useRef<{ requestId: string | null; input: InputTarget } | null>(null);
  const reveal = useCallback(() => {
    const current = focused.current;
    // RN TextInput's host instance owns focus and clears it on unmount. A
    // bubbled blur is not guaranteed when switching questions or presets.
    if (!requestId || current?.requestId !== requestId || !current.input.isFocused?.()) return;
    scrollRef.current?.scrollToEnd({ animated: false });
  }, [requestId]);
  const onFocus = (event: FocusEvent) => {
    focused.current = { requestId, input: event.target as InputTarget };
    reveal();
  };
  const onBlur = (event: FocusEvent) => {
    if (focused.current?.input === event.target) focused.current = null;
  };
  return { scrollRef, onFocus, onBlur, reveal };
}
