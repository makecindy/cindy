import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { appendedMessageKeys } from '@cindy/maker-shared/message-presentation';
import { Animated, Easing } from 'react-native';
import { useReduceMotionEnabled } from '@/hooks/useReduceMotion';
import { motionDuration, motionEasing } from '@/theme';
import { AnimatedContentHeight } from './AnimatedContentHeight';

/** Keep removed rows in their old position until their occupied height reaches zero.
 * Work-group sealing replaces several rows at once. Removing them in the data
 * commit lets UIScrollView clamp its range before any row animation can run.
 * This is presentation only: message identities and the final projection stay intact.
 */
export function useRetainedMessageRows<T extends { key: string }>(items: readonly T[], scope: string | undefined, enabled: boolean) {
  const reduced = useReduceMotionEnabled();
  const animate = enabled && reduced === false;
  const [state, setState] = useState(() => ({ items, scope, animate, rows: items, exiting: new Set<string>() }));
  let current = state;
  if (state.items !== items || state.scope !== scope || state.animate !== animate) {
    let exiting = new Set<string>();
    let rows = items;
    const present = new Set(items.map(item => item.key));
    if (animate && state.animate && state.scope === scope && state.rows.some(row => present.has(row.key))) {
      const after = new Map<string | null, T[]>();
      let anchor: string | null = null;
      for (const row of state.rows) {
        if (present.has(row.key)) anchor = row.key;
        else {
          exiting.add(row.key);
          const bucket = after.get(anchor) ?? [];
          bucket.push(row);
          after.set(anchor, bucket);
        }
      }
      if (exiting.size) rows = [...after.get(null) ?? [], ...items.flatMap(item => [item, ...after.get(item.key) ?? []])];
    }
    // Streaming changes item payloads on every chunk, not the exit membership.
    // Keep actions/timers stable so old cells do not repaint or extend retention.
    if (exiting.size === state.exiting.size && [...exiting].every(key => state.exiting.has(key))) exiting = state.exiting;
    current = { items, scope, animate, rows, exiting };
    setState(current);
  }
  const onExited = useCallback((key: string) => {
    setState(previous => {
      if (!previous.exiting.has(key)) return previous;
      const exiting = new Set(previous.exiting);
      exiting.delete(key);
      return { ...previous, exiting, rows: previous.rows.filter(row => row.key !== key) };
    });
  }, []);
  useEffect(() => {
    if (!current.exiting.size) return;
    // Offscreen virtual cells never mount and cannot deliver an animation callback.
    // Bound their retained payload lifetime; visible cells release on completion.
    const keys = [...current.exiting];
    const timer = setTimeout(() => keys.forEach(onExited), 1000);
    return () => clearTimeout(timer);
  }, [current.exiting, onExited]);
  return { rows: current.rows, exiting: current.exiting, onExited };
}

/** Only live tail additions animate; creation time does not tell us when a reply was revealed. */
export function useMessageEntrances(keys: readonly string[], scope: string | undefined, ready = true) {
  const previous = useRef<{ scope: string | undefined; keys: readonly string[]; arrivals: Map<string, number> } | null>(null);
  const arriving = useMemo(() => {
    const prior = ready && previous.current?.scope === scope ? previous.current : null;
    const added = ready ? appendedMessageKeys(prior?.keys, keys) : [];
    const now = Date.now();
    // Virtualized cells may mount after a subsequent message/tool projection.
    // Keep their original arrival time through those commits, rather than
    // forgetting the entrance before the cell has ever reached the screen.
    const present = new Set(keys);
    const arrivals = new Map([...prior?.arrivals ?? []]
      .filter(([key, time]) => present.has(key) && now - time < 1000));
    for (const key of added) arrivals.set(key, now);
    return arrivals;
  }, [keys, scope, ready]);
  useLayoutEffect(() => { previous.current = ready ? { scope, keys, arrivals: arriving } : null; }, [keys, scope, ready, arriving]);
  return arriving;
}

/** A recycled or acknowledged message must not replay its entrance. */
const MAX_REMEMBERED = 200;
const animated = new Set<string>();

/**
 * One-shot entrance: fades in while rising `distance` pt (and growing from `scaleFrom`), ease-out.
 * Transform and opacity only, native driver; renders children as-is when `play` is false or the
 * system asks for reduced motion.
 */
export function CompanionFadeIn({ play, distance, scaleFrom, duration = motionDuration.base, delay = 0, children }: {
  play: boolean; distance: number; scaleFrom?: number; duration?: number; delay?: number; children: ReactNode;
}) {
  const reduceMotion = useReduceMotionEnabled();
  const run = useRef<boolean | null>(null);
  if (run.current === null) run.current = play && reduceMotion === false;
  const progress = useRef(new Animated.Value(run.current ? 0 : 1)).current;
  useEffect(() => {
    if (!run.current || reduceMotion !== false) { progress.setValue(1); return; }
    const timing = Animated.timing(progress, {
      toValue: 1, duration, delay, easing: Easing.bezier(...motionEasing.out), useNativeDriver: true,
    });
    timing.start();
    return () => timing.stop();
  }, [delay, duration, progress, reduceMotion]);
  if (!run.current) return <>{children}</>;
  const transform = [
    { translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [distance, 0] }) },
    ...(scaleFrom !== undefined ? [{ scale: progress.interpolate({ inputRange: [0, 1], outputRange: [scaleFrom, 1] }) }] : []),
  ];
  return <Animated.View style={{ opacity: progress, transform }}>{children}</Animated.View>;
}

/**
 * Entering motion for a companion conversation row (M4 / M5). Keyed by message: a row animates at
 * most once, when it is appended to an already open timeline. History stays still and a slow
 * reply gets the same entrance as a fast one. Grow the occupied space as content
 * arrives; the fade alone cannot keep surrounding rows from jumping.
 */
export function CompanionEntering({ id, arrivedAt, open = true, onExited, children }: {
  id: string; arrivedAt?: number; open?: boolean; onExited?: (id: string) => void; children: ReactNode;
}) {
  // Cells first mounted later by scrolling are history, even if their list projection is unchanged.
  const entering = arrivedAt !== undefined && Date.now() - arrivedAt < 1000;
  const reduceMotion = useReduceMotionEnabled();
  const growOnMount = useRef(entering && !animated.has(id) && reduceMotion === false).current;
  const progress = useRef(new Animated.Value(entering && !animated.has(id) && reduceMotion === false ? 0 : 1)).current;
  const animation = useRef<Animated.CompositeAnimation | null>(null);
  useLayoutEffect(() => {
    if (!entering || animated.has(id)) return;
    animated.add(id);
    if (animated.size > MAX_REMEMBERED) animated.delete(animated.values().next().value!);
    if (reduceMotion !== false) { progress.setValue(1); return; }
    progress.setValue(0);
    animation.current = Animated.timing(progress, { toValue: 1, duration: motionDuration.base,
      easing: Easing.bezier(...motionEasing.out), useNativeDriver: true });
    animation.current.start();
  }, [entering, id, progress, reduceMotion]);
  useLayoutEffect(() => {
    if (reduceMotion !== false) { animation.current?.stop(); progress.setValue(1); }
    return () => { animation.current?.stop(); progress.setValue(1); };
  }, [id, progress, reduceMotion]);
  return <Animated.View style={{ opacity: progress, transform: [
    { translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [6, 0] }) },
  ] }}>
    <AnimatedContentHeight open={open} onCollapsed={onExited ? () => onExited(id) : undefined}
      animateInitial={growOnMount}>{children}</AnimatedContentHeight>
  </Animated.View>;
}
