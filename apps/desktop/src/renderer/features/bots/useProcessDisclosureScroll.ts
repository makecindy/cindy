import { shouldUnpinOnUpIntent, shouldUnpinOnWheel } from '../../components/chat/autoFollowIntent';
import { useCallback, useEffect, useRef, type RefObject, type MutableRefObject, type MouseEvent, type PointerEvent, type WheelEvent, type KeyboardEvent, type UIEvent } from 'react';

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
  const draggingScrollbar = useRef<{ following: boolean; top: number; movedUp: boolean; pointerId: number } | null>(null);
  const resumeFollow = useCallback(() => {
    inspecting.current = false;
    if (contentRef.current) contentRef.current.style.minHeight = '';
    stickToBottom.current = true;
  }, [contentRef, stickToBottom]);
  const finishPointerPause = useCallback((pointerId: number) => {
    const gesture = draggingScrollbar.current;
    if (!gesture || gesture.pointerId !== pointerId) return;
    draggingScrollbar.current = null;
    const element = scrollRef.current;
    // Preserve actual upward browsing, including a queued native scroll event.
    if (!element || !gesture.following || gesture.movedUp || inspecting.current || element.scrollTop < gesture.top) return;
    stickToBottom.current = true;
    element.scrollTop = element.scrollHeight;
  }, [scrollRef, stickToBottom]);
  useEffect(() => {
    // A press may end over the sibling composer. Observe release without
    // capturing/retargeting native scrollbar input or the composer's own events.
    const finish = (event: globalThis.PointerEvent) => finishPointerPause(event.pointerId);
    window.addEventListener('pointerup', finish, true);
    window.addEventListener('pointercancel', finish, true);
    return () => {
      window.removeEventListener('pointerup', finish, true);
      window.removeEventListener('pointercancel', finish, true);
      draggingScrollbar.current = null;
    };
  }, [finishPointerPause]);
  const atBottom = (element: HTMLDivElement) => element.scrollHeight - element.scrollTop - element.clientHeight < bottomThreshold;
  const rememberPosition = (element: HTMLDivElement) => {
    previousTop.current = element.scrollTop;
    previousSize.current = { height: element.scrollHeight, viewport: element.clientHeight };
  };
  const viewportContentHeight = (element: HTMLDivElement, content: HTMLDivElement) => {
    const outsideContent = element.scrollHeight - content.getBoundingClientRect().height;
    return Math.max(0, element.scrollTop + element.clientHeight - outsideContent);
  };
  return {
    inspecting,
    resumeFollow,
    onPointerDown(event: PointerEvent<HTMLDivElement>) {
      // Native scrollbar input targets the scroller itself, unlike its content.
      draggingScrollbar.current = event.target === event.currentTarget
        ? { following: stickToBottom.current, top: event.currentTarget.scrollTop, movedUp: false, pointerId: event.pointerId } : null;
      if (draggingScrollbar.current) {
        rememberPosition(event.currentTarget);
        stickToBottom.current = false;
      }
    },
    onPointerUp(event: PointerEvent<HTMLDivElement>) {
      finishPointerPause(event.pointerId);
    },
    onClickCapture(event: MouseEvent<HTMLDivElement>) {
      if (!(event.target instanceof Element) || !event.target.closest('button[data-scroll-disclosure-header]')) return;
      const content = contentRef.current;
      if (!content || !content.contains(event.target)) return;
      // Auto-follow may already have moved before its queued scroll notice.
      // Inspection starts at this position, so that notice is not reader input.
      rememberPosition(event.currentTarget);
      inspecting.current = true;
      stickToBottom.current = false;
      // A shrinking scroll range clamps scrollTop before any observer can fix
      // the heading. Reserve this viewport, excluding the scroller's padding.
      content.style.minHeight = `${viewportContentHeight(event.currentTarget, content)}px`;
    },
    onWheel(event: WheelEvent<HTMLDivElement>) {
      // Chromium pinch/modified wheel zoom is not list navigation.
      if (event.ctrlKey || event.metaKey) return;
      // Portalled previews retain React ancestry, but own their own wheel input.
      if (event.defaultPrevented || !(event.target instanceof Node) || !event.currentTarget.contains(event.target)) return;
      if (shouldUnpinOnWheel({ deltaX: event.deltaX, deltaY: event.deltaY,
        scrollHeight: event.currentTarget.scrollHeight, clientHeight: event.currentTarget.clientHeight })) stickToBottom.current = false;
      if (inspecting.current && event.deltaY > 0 && Math.abs(event.deltaY) >= Math.abs(event.deltaX) && atBottom(event.currentTarget)) {
        resumeFollow();
        event.currentTarget.scrollTop = event.currentTarget.scrollHeight;
        return true;
      }
    },
    onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
      // Preview portals and consumed input must not navigate the background list.
      if (event.defaultPrevented || !(event.target instanceof Node) || !event.currentTarget.contains(event.target)) return;
      // Tool detail editors keep their own End key behavior.
      if (event.target instanceof Element && event.target.closest('input, textarea, [contenteditable="true"]')) return;
      if ((['ArrowUp', 'PageUp', 'Home'].includes(event.key) || (event.key === ' ' && event.shiftKey))
        && shouldUnpinOnUpIntent({ scrollHeight: event.currentTarget.scrollHeight, clientHeight: event.currentTarget.clientHeight })) stickToBottom.current = false;
      if (event.key === 'End' && inspecting.current) {
        resumeFollow();
        event.currentTarget.scrollTop = event.currentTarget.scrollHeight;
        return true;
      }
    },
    onScroll(event: UIEvent<HTMLDivElement>) {
      const element = scrollRef.current;
      if (!element || element !== event.currentTarget) return false;
      // A queued scroll event can arrive after the next animation/layout frame
      // has grown the content. Being away from the new bottom is not an upward
      // reading gesture. Keep following until the reader actually moves up.
      const movedUp = element.scrollTop < previousTop.current
        && (draggingScrollbar.current !== null || (element.scrollHeight === previousSize.current.height
          && element.clientHeight === previousSize.current.viewport));
      if (draggingScrollbar.current && movedUp) draggingScrollbar.current.movedUp = true;
      const keepFollowing = stickToBottom.current && previousSize.current.height > 0 && !movedUp;
      const content = contentRef.current;
      if (inspecting.current && content?.style.minHeight && element.scrollTop < previousTop.current) {
        content.style.minHeight = `${Math.min(parseFloat(content.style.minHeight), viewportContentHeight(element, content))}px`;
      }
      if (inspecting.current && atBottom(element) && element.scrollTop > previousTop.current) resumeFollow();
      rememberPosition(element);
      return !inspecting.current && (keepFollowing || atBottom(element));
    },
  };
}
