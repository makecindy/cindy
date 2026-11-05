import { useMemo, useRef, useState } from 'react';
import { PanResponder, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useTheme } from '@/theme';
import { navigationChrome, radius, spacing } from '@/theme/tokens';

/** A dedicated edge target; vertical list scrolling never starts a resize. */
export function SessionPaneDivider({ width, left, top, bottom, bounds, onResize, grip = true, overdrag }: {
  width: number;
  /** The floating drawer's edge is draggable without a visible grip. */
  grip?: boolean;
  left: number;
  top: number;
  bottom: number;
  bounds: { min: number; max: number };
  onResize(width: number): void;
  /** Past bounds.max the edge keeps following the finger up to `limit`, shown
   * through onDrag and never stored. Releasing at `commitAt` or beyond calls
   * onCommit and keeps the width from before the drag. */
  overdrag?: { limit: number; commitAt: number; onDrag(width: number | null): void; onCommit(): void };
}) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const [dragging, setDragging] = useState(false);
  const latest = useRef({ width, bounds, onResize, overdrag });
  latest.current = { width, bounds, onResize, overdrag };
  const responder = useMemo(() => {
    let initial = 0;
    const resize = (next: number) => {
      const current = latest.current;
      current.onResize(Math.round(Math.max(current.bounds.min, Math.min(current.bounds.max, next))));
    };
    const move = (next: number) => {
      const { bounds: { max }, overdrag: over } = latest.current;
      if (over && next > max) {
        resize(max);
        over.onDrag(Math.round(Math.min(over.limit, next)));
        return;
      }
      over?.onDrag(null);
      resize(next);
    };
    const release = (next: number) => {
      const over = latest.current.overdrag;
      if (over && next >= over.commitAt) {
        over.onDrag(over.limit);
        resize(initial);
        over.onCommit();
        return;
      }
      // Short of full screen the edge settles back within its range.
      over?.onDrag(null);
      resize(next);
    };
    const finish = () => {
      setDragging(false);
    };
    return PanResponder.create({
      onMoveShouldSetPanResponder: (_event, gesture) => Math.abs(gesture.dx) > 4 && Math.abs(gesture.dx) > Math.abs(gesture.dy),
      onPanResponderGrant: () => {
        initial = latest.current.width;
        setDragging(true);
      },
      onPanResponderMove: (_event, gesture) => move(initial + gesture.dx),
      onPanResponderRelease: (_event, gesture) => { release(initial + gesture.dx); finish(); },
      onPanResponderTerminate: () => { latest.current.overdrag?.onDrag(null); resize(initial); finish(); },
    });
  }, []);
  return <View {...responder.panHandlers} testID="session.paneDivider"
    accessible accessibilityRole="adjustable"
    accessibilityLabel={t('session.paneResize.label')}
    accessibilityHint={t('session.paneResize.hint')}
    accessibilityValue={{ min: bounds.min, max: bounds.max, now: width, text: String(width) }}
    accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
    onAccessibilityAction={({ nativeEvent }) => {
      const direction = nativeEvent.actionName === 'increment' ? 1 : nativeEvent.actionName === 'decrement' ? -1 : 0;
      if (direction) onResize(Math.max(bounds.min, Math.min(bounds.max, width + direction * spacing.xl)));
    }}
    style={[styles.target, { left: left - navigationChrome.target / 2, top, bottom }]}>
    {grip ? <View pointerEvents="none" style={[styles.grip, { backgroundColor: dragging ? colors.textSecondary : colors.borderStrong }]} /> : null}
  </View>;
}

const styles = StyleSheet.create({
  target: { position: 'absolute', width: navigationChrome.target, alignItems: 'center', justifyContent: 'center', zIndex: 40 },
  grip: { width: 3, height: spacing.xxl, borderRadius: radius.pill },
});
