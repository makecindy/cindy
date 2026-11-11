import { useEffect, useRef, type ReactNode } from 'react';
import { Animated, Easing } from 'react-native';
import { useReduceMotionEnabled } from '@/hooks/useReduceMotion';
import { motionDuration, motionEasing } from '@/theme';

/** Only messages this recent animate: history loads, remounts and recycled cells stay still. */
const FRESH_MS = 15_000;
/** Fresh ids already played, so a remount inside FRESH_MS stays still. Old rows never need an entry. */
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
    if (!run.current) return;
    const timing = Animated.timing(progress, {
      toValue: 1, duration, delay, easing: Easing.bezier(...motionEasing.out), useNativeDriver: true,
    });
    timing.start();
    return () => timing.stop();
  }, [delay, duration, progress]);
  if (!run.current) return <>{children}</>;
  const transform = [
    { translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [distance, 0] }) },
    ...(scaleFrom !== undefined ? [{ scale: progress.interpolate({ inputRange: [0, 1], outputRange: [scaleFrom, 1] }) }] : []),
  ];
  return <Animated.View style={{ opacity: progress, transform }}>{children}</Animated.View>;
}

/**
 * Entering motion for a companion conversation row (M4 / M5). Keyed by message: a row animates at
 * most once and only while it is new (created within FRESH_MS). Your message rises 8pt from 0.96;
 * a teammate's finished reply rises 6pt (replies never stream).
 */
export function CompanionEntering({ id, createdAt, kind, children }: {
  id: string; createdAt: string | number | undefined; kind: 'send' | 'reply'; children: ReactNode;
}) {
  const fresh = useRef<boolean | null>(null);
  if (fresh.current === null) {
    const at = typeof createdAt === 'number' ? createdAt : createdAt ? Date.parse(createdAt) : Number.NaN;
    fresh.current = !animated.has(id) && Number.isFinite(at) && Date.now() - at < FRESH_MS;
    if (fresh.current) {
      animated.add(id);
      // Insertion order: the oldest id is almost always past FRESH_MS; at worst a remount replays it once.
      if (animated.size > MAX_REMEMBERED) animated.delete(animated.values().next().value!);
    }
  }
  return <CompanionFadeIn play={fresh.current} distance={kind === 'send' ? 8 : 6} scaleFrom={kind === 'send' ? 0.96 : undefined}>
    {children}
  </CompanionFadeIn>;
}
