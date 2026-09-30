import {
  createContext,
  Fragment,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { StyleSheet, View, type GestureResponderEvent } from "react-native";

type OutsideTapListener = {
  /** Window coordinates, same space as `measureInWindow` and touch pageX/pageY. */
  contains: (x: number, y: number) => boolean;
  onOutsideTap: () => void;
};

type Subscribe = (listener: OutsideTapListener) => () => void;
type SetOverlay = (id: number, node: ReactNode | null) => void;

const OutsideTapContext = createContext<Subscribe>(() => () => {});
const OverlayContext = createContext<SetOverlay | null>(null);

/** Movement beyond this is a drag or scroll, not a tap. */
export const OUTSIDE_TAP_SLOP = 8;
/** Holding longer than this is a long press (Pressable's default), not a tap. */
export const OUTSIDE_TAP_MAX_MS = 500;

let nextOverlayId = 0;

/**
 * Observes raw touches without claiming the responder, so floating panels can
 * close on an outside tap while everything underneath keeps scrolling normally.
 * It also hosts a window-sized, touch-transparent layer for those panels, so a
 * panel is always inside a hit-testable parent on every platform.
 */
export function OutsideTapProvider({ children }: { children: ReactNode }) {
  const listeners = useRef(new Set<OutsideTapListener>());
  const touch = useRef<{
    x: number;
    y: number;
    at: number;
    moved: boolean;
  } | null>(null);
  const subscribe = useRef<Subscribe>((listener) => {
    listeners.current.add(listener);
    return () => listeners.current.delete(listener);
  }).current;
  const [overlays, setOverlays] = useState(() => new Map<number, ReactNode>());
  const setOverlay = useRef<SetOverlay>((id, node) =>
    setOverlays((previous) => {
      if (node === null && !previous.has(id)) return previous;
      const next = new Map(previous);
      if (node === null) next.delete(id);
      else next.set(id, node);
      return next;
    }),
  ).current;
  const movedFrom = (
    start: { x: number; y: number },
    event: GestureResponderEvent,
  ) =>
    Math.hypot(
      event.nativeEvent.pageX - start.x,
      event.nativeEvent.pageY - start.y,
    ) > OUTSIDE_TAP_SLOP;
  return (
    <OutsideTapContext.Provider value={subscribe}>
      <OverlayContext.Provider value={setOverlay}>
        <View
          style={{ flex: 1 }}
          onTouchStart={(event: GestureResponderEvent) => {
            const { pageX, pageY, touches, timestamp } = event.nativeEvent;
            // A second finger turns the gesture into a pinch; never a tap.
            if (touches.length > 1 && touch.current) touch.current.moved = true;
            else
              touch.current = {
                x: pageX,
                y: pageY,
                at: timestamp,
                moved: touches.length > 1,
              };
          }}
          onTouchMove={(event: GestureResponderEvent) => {
            const start = touch.current;
            if (start && movedFrom(start, event)) start.moved = true;
          }}
          onTouchEnd={(event: GestureResponderEvent) => {
            if (event.nativeEvent.touches.length > 0) return;
            const start = touch.current;
            touch.current = null;
            // Some scroll containers skip move events, so the end point is
            // checked as well.
            if (
              !start ||
              start.moved ||
              movedFrom(start, event) ||
              event.nativeEvent.timestamp - start.at > OUTSIDE_TAP_MAX_MS
            )
              return;
            for (const listener of [...listeners.current]) {
              if (!listener.contains(start.x, start.y)) listener.onOutsideTap();
            }
          }}
          // Native scroll views cancel JS touches when they take over the gesture.
          onTouchCancel={() => {
            touch.current = null;
          }}
        >
          {children}
          <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
            {[...overlays].map(([id, node]) => (
              <Fragment key={id}>{node}</Fragment>
            ))}
          </View>
        </View>
      </OverlayContext.Provider>
    </OutsideTapContext.Provider>
  );
}

/**
 * Renders `children` in the window-sized layer above the app, positioned in
 * window coordinates. Content must not depend on context below the provider.
 */
export function RootOverlay({ children }: { children: ReactNode }) {
  const setOverlay = useContext(OverlayContext);
  const id = useRef(0);
  if (!id.current) id.current = ++nextOverlayId;
  useEffect(() => {
    setOverlay?.(id.current, children);
  }, [setOverlay, children]);
  useEffect(() => () => setOverlay?.(id.current, null), [setOverlay]);
  return null;
}

/** While active, calls `onOutsideTap` for taps that start outside `contains`. */
export function useOutsideTap(
  active: boolean,
  contains: OutsideTapListener["contains"],
  onOutsideTap: () => void,
) {
  const subscribe = useContext(OutsideTapContext);
  const latest = useRef({ contains, onOutsideTap });
  latest.current = { contains, onOutsideTap };
  useEffect(() => {
    if (!active) return;
    return subscribe({
      contains: (x, y) => latest.current.contains(x, y),
      onOutsideTap: () => latest.current.onOutsideTap(),
    });
  }, [active, subscribe]);
}
