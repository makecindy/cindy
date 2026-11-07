import { createContext, useCallback, useRef, useState } from 'react';

export const ProcessDisclosureViewport = createContext<((shrinkingBy: number) => void) | null>(null);

/** Manual inspection owns the viewport until a scroll or explicit jump returns to the tail. */
export function useProcessDisclosureViewport(read: () => {
  offsetY: number; contentHeight: number; viewportHeight: number;
}, suspendFollow: () => void, onResume?: () => void) {
  const callbacks = useRef({ read, suspendFollow, onResume });
  callbacks.current = { read, suspendFollow, onResume };
  const inspecting = useRef(false);
  const reserve = useRef(0);
  const [footerHeight, setFooterHeight] = useState(0);
  const setReserve = useCallback((height: number) => {
    reserve.current = height;
    setFooterHeight(height);
  }, []);
  const inspect = useCallback((shrinkingBy: number) => {
    inspecting.current = true;
    callbacks.current.suspendFollow();
    const { offsetY, contentHeight, viewportHeight } = callbacks.current.read();
    // Reserve before the collapse starts: a later scroll correction cannot undo native clamping.
    if (shrinkingBy > 0) setReserve(Math.max(reserve.current, offsetY + viewportHeight - contentHeight + reserve.current + shrinkingBy));
  }, [setReserve]);
  const resume = useCallback(() => {
    inspecting.current = false;
    callbacks.current.onResume?.();
    setReserve(0);
  }, [setReserve]);
  const scroll = useCallback((offsetY: number, previousY: number, userScrolling: boolean, atBottom: boolean) => {
    if (!inspecting.current || !userScrolling) return;
    if (offsetY < previousY) setReserve(Math.max(0, reserve.current - (previousY - offsetY)));
    else if (offsetY > previousY && atBottom) {
      resume();
      return true;
    }
  }, [resume, setReserve]);
  return { inspect, inspecting, footerHeight, resume, scroll };
}
