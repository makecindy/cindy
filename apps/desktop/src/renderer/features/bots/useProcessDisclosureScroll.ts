import { useCallback, useRef, type RefObject, type MutableRefObject, type MouseEvent, type WheelEvent, type KeyboardEvent, type UIEvent } from 'react';

/** Main group chats and topic panels render the same process disclosures in
 * separate scrollers. Both must yield automatic following to manual inspection. */
export function useProcessDisclosureScroll(
  scrollRef: RefObject<HTMLDivElement | null>,
  contentRef: RefObject<HTMLDivElement | null>,
  stickToBottom: MutableRefObject<boolean>,
  bottomThreshold: number,
) {
  const inspecting = useRef(false);
  const previousTop = useRef(0);
  const previousSize = useRef({ height: 0, viewport: 0 });
  const resumeFollow = useCallback(() => {
    inspecting.current = false;
    if (contentRef.current) contentRef.current.style.minHeight = '';
    stickToBottom.current = true;
  }, [contentRef, stickToBottom]);
  const atBottom = (element: HTMLDivElement) => element.scrollHeight - element.scrollTop - element.clientHeight < bottomThreshold;
  const viewportContentHeight = (element: HTMLDivElement, content: HTMLDivElement) => {
    const outsideContent = element.scrollHeight - content.getBoundingClientRect().height;
    return Math.max(0, element.scrollTop + element.clientHeight - outsideContent);
  };
  return {
    inspecting,
    resumeFollow,
    onClickCapture(event: MouseEvent<HTMLDivElement>) {
      if (!(event.target instanceof Element) || !event.target.closest('button[data-scroll-disclosure-header]')) return;
      const content = contentRef.current;
      if (!content || !content.contains(event.target)) return;
      inspecting.current = true;
      stickToBottom.current = false;
      // A shrinking scroll range clamps scrollTop before any observer can fix
      // the heading. Reserve this viewport, excluding the scroller's padding.
      content.style.minHeight = `${viewportContentHeight(event.currentTarget, content)}px`;
    },
    onWheel(event: WheelEvent<HTMLDivElement>) {
      if (event.deltaY < 0) stickToBottom.current = false;
      if (inspecting.current && event.deltaY > 0 && atBottom(event.currentTarget)) {
        resumeFollow();
        event.currentTarget.scrollTop = event.currentTarget.scrollHeight;
      }
    },
    onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
      // Tool detail editors keep their own End key behavior.
      if (event.target instanceof Element && event.target.closest('input, textarea, [contenteditable="true"]')) return;
      if (event.key === 'End' && inspecting.current) {
        resumeFollow();
        event.currentTarget.scrollTop = event.currentTarget.scrollHeight;
      }
    },
    onScroll(event: UIEvent<HTMLDivElement>) {
      const element = scrollRef.current;
      if (!element || element !== event.currentTarget) return false;
      // A queued scroll event can arrive after the next animation/layout frame
      // has grown the content. Being away from the new bottom is not an upward
      // reading gesture. Keep following until the reader actually moves up.
      const movedUp = element.scrollTop < previousTop.current
        && element.scrollHeight === previousSize.current.height
        && element.clientHeight === previousSize.current.viewport;
      const keepFollowing = stickToBottom.current && previousSize.current.height > 0 && !movedUp;
      const content = contentRef.current;
      if (inspecting.current && content?.style.minHeight && element.scrollTop < previousTop.current) {
        content.style.minHeight = `${Math.min(parseFloat(content.style.minHeight), viewportContentHeight(element, content))}px`;
      }
      if (inspecting.current && atBottom(element) && element.scrollTop > previousTop.current) resumeFollow();
      previousTop.current = element.scrollTop;
      previousSize.current = { height: element.scrollHeight, viewport: element.clientHeight };
      return !inspecting.current && (keepFollowing || atBottom(element));
    },
  };
}
