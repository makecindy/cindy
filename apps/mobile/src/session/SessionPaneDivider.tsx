import { createContext, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { PanResponder, StyleSheet, View } from 'react-native';
import { runOnJS } from 'react-native-reanimated';
import Constants, { ExecutionEnvironment } from 'expo-constants';
import { Gesture } from '@/platform/gestureHandler';
import { useTranslation } from 'react-i18next';
import { spacing } from '@/theme/tokens';

/** Width of the invisible drag band centred on the pane edge (Android's 48dp
 * touch target). Taps inside it still reach the controls underneath. */
export const PANE_DIVIDER_BAND = 48;
/** Horizontal travel that claims the edge; vertical travel first lets lists scroll. */
const ACTIVE_OFFSET = 8;

/** How far the edge's drag band reaches into the task list beside it. Swipeable
 * rows leave that strip to the edge (via hitSlop): when both recognize the same
 * coarse move, the deeper row would otherwise win and a drag there would open
 * row actions instead of resizing. 0 when no resizable edge is next to the list. */
const PaneEdgeInsetContext = createContext(0);
export const PaneEdgeInsetProvider = PaneEdgeInsetContext.Provider;
export function usePaneEdgeInset() {
  return useContext(PaneEdgeInsetContext);
}

type PaneResize = {
  /** Off while the edge is hidden, closing or not resizable. */
  enabled: boolean;
  width: number;
  /** Edge position and vertical extent, in the coordinates of the view the
   * returned gesture is attached to. */
  left: number;
  /** UI-thread coordinate while the containing panel is animating. */
  getLeft?: () => number;
  top: number;
  bottom: number;
  bounds: { min: number; max: number } | null;
  onResize(width: number): void;
  /** Past the bounds the edge reports how far the finger overshoots (signed,
   * 0 inside them) so the host can stretch elastically; onSettle on release. */
  elastic?: { onStretch(overflow: number): void; onSettle(): void };
};

/**
 * A resizable pane edge with no visible grip. The pan gesture belongs on a
 * view that contains both panes, limited by hitSlop to a band around the edge:
 * a tap there reaches the button below and only a horizontal drag resizes.
 * A sibling overlay would swallow those taps, because touches go to the
 * topmost view. `edge` is the invisible adjustable element for assistive
 * technology; render it inside the same container.
 */
export function useSessionPaneDivider({ enabled, width, left, getLeft, top, bottom, bounds, onResize, elastic }: PaneResize) {
  const { t } = useTranslation();
  const [dragging, setDragging] = useState(false);
  const latest = useRef({ width, bounds, onResize, elastic });
  latest.current = { width, bounds, onResize, elastic };
  const active = enabled && !!bounds;
  // The hit band only gates where a drag may begin; keep it fixed while one is
  // running so each width update does not reconfigure the native handler.
  const anchor = useRef({ left, top, bottom });
  if (!dragging) anchor.current = { left, top, bottom };
  const band = anchor.current;
  const drag = useMemo(() => {
    let initial = 0;
    let running = false;
    const resize = (next: number) => {
      const { bounds: range, onResize: report, elastic: spring } = latest.current;
      if (!range) return;
      const clamped = Math.max(range.min, Math.min(range.max, next));
      report(Math.round(clamped));
      spring?.onStretch(next - clamped);
    };
    const finish = () => {
      latest.current.elastic?.onSettle();
      setDragging(false);
    };
    return {
      start() { initial = latest.current.width; running = true; setDragging(true); },
      move(dx: number) { if (running) resize(initial + dx); },
      end(dx: number) { if (!running) return; resize(initial + dx); running = false; finish(); },
      cancel() { if (!running) return; resize(initial); running = false; finish(); },
    };
  }, []);
  const gesture = useMemo(() => Gesture.Pan().enabled(active)
    // A moving edge cannot use a React-rendered hitSlop. Gate it on the UI
    // thread at touch-down; width updates still commit through JS below.
    .hitSlop(getLeft ? { top: -band.top, bottom: -band.bottom }
      : { left: -Math.max(0, band.left - PANE_DIVIDER_BAND / 2), width: PANE_DIVIDER_BAND, top: -band.top, bottom: -band.bottom })
    .onTouchesDown((event, manager) => {
      'worklet';
      const touch = event.allTouches[0];
      if (getLeft && touch && Math.abs(touch.x - getLeft()) > PANE_DIVIDER_BAND / 2) manager.fail();
    })
    // Ahead of row swipes and the drawer's 16pt close/stretch gestures.
    .activeOffsetX([-ACTIVE_OFFSET, ACTIVE_OFFSET]).failOffsetY([-ACTIVE_OFFSET, ACTIVE_OFFSET])
    .onStart(() => { 'worklet'; runOnJS(drag.start)(); })
    .onUpdate(event => { 'worklet'; runOnJS(drag.move)(event.translationX); })
    .onEnd(event => { 'worklet'; runOnJS(drag.end)(event.translationX); })
    .onFinalize((_event, successful) => { 'worklet'; if (!successful) runOnJS(drag.cancel)(); }),
  [active, band.bottom, band.left, band.top, drag, getLeft]);
  // Expo Go has no gesture handler: keep a JS overlay there. It still covers
  // the band, so taps under it only pass through in development builds.
  const fallback = Constants.executionEnvironment === ExecutionEnvironment.StoreClient;
  const responder = useMemo(() => fallback ? PanResponder.create({
    onMoveShouldSetPanResponder: (_event, move) => Math.abs(move.dx) > ACTIVE_OFFSET / 2 && Math.abs(move.dx) > Math.abs(move.dy),
    onPanResponderGrant: drag.start,
    onPanResponderMove: (_event, move) => drag.move(move.dx),
    onPanResponderRelease: (_event, move) => drag.end(move.dx),
    onPanResponderTerminate: drag.cancel,
  }) : null, [drag, fallback]);
  const edge: ReactNode = active && bounds ? <View {...responder?.panHandlers}
    pointerEvents={responder ? 'auto' : 'none'} testID="session.paneDivider"
    accessible accessibilityRole="adjustable"
    accessibilityLabel={t('session.paneResize.label')}
    accessibilityHint={t('session.paneResize.hint')}
    accessibilityValue={{ min: bounds.min, max: bounds.max, now: width, text: String(width) }}
    accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
    onAccessibilityAction={({ nativeEvent }) => {
      const direction = nativeEvent.actionName === 'increment' ? 1 : nativeEvent.actionName === 'decrement' ? -1 : 0;
      if (direction) onResize(Math.max(bounds.min, Math.min(bounds.max, width + direction * spacing.xl)));
    }}
    style={[styles.edge, { left: left - PANE_DIVIDER_BAND / 2, top, bottom }]} /> : null;
  return { gesture, edge, rowInset: active ? PANE_DIVIDER_BAND / 2 : 0 };
}

const styles = StyleSheet.create({
  edge: { position: 'absolute', width: PANE_DIVIDER_BAND, zIndex: 40 },
});
