import { useLayoutEffect, useState, type RefObject } from 'react';

/** Default row height (text-14 × 1.571) when the computed line height is unavailable (jsdom). */
const FALLBACK_LINE_HEIGHT_PX = 22;

function lineHeightOf(el: HTMLTextAreaElement): number {
  const value = Number.parseFloat(window.getComputedStyle(el).lineHeight);
  return Number.isFinite(value) && value > 0 ? value : FALLBACK_LINE_HEIGHT_PX;
}

/**
 * Layout of the free-text answer composers in interaction cards (questions,
 * plan feedback): they start as a single line with the actions beside the
 * text, and switch to a full-width text area with the actions below once the
 * answer wraps or gets a line break.
 *
 * Expansion is sticky until the answer is cleared. Collapsing as soon as the
 * text fits the wider row again would narrow it back and wrap it once more,
 * flipping between the two layouts while the user types.
 *
 * `maxHeight` is the cap the composer already applies when growing; after a
 * layout switch the width changes, so the height is fitted again here.
 */
export function useAnswerComposerExpanded(
  textareaRef: RefObject<HTMLTextAreaElement | null>,
  value: string,
  maxHeight: (el: HTMLTextAreaElement) => number,
): boolean {
  const [expanded, setExpanded] = useState(false);

  // Runs after every render: the field can mount with a restored answer
  // (revisiting a question, reopening the custom answer) without the value
  // changing. Measuring is skipped once expanded or while empty.
  useLayoutEffect(() => {
    if (!value) {
      if (expanded) setExpanded(false);
      return;
    }
    if (expanded) return;
    const el = textareaRef.current;
    if (!el) return;
    if (value.includes('\n') || el.scrollHeight > lineHeightOf(el) * 1.5) setExpanded(true);
  });

  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    const cap = maxHeight(el);
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, cap)}px`;
    el.style.overflowY = el.scrollHeight > cap ? 'auto' : 'hidden';
    // Refit after both width changes and edits, including crossing the scroll cap.
  }, [expanded, value]);

  return expanded;
}

/** Six visible rows at the current UI font size. */
export function sixAnswerRows(el: HTMLTextAreaElement): number {
  return 6 * lineHeightOf(el);
}
