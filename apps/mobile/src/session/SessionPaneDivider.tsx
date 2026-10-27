import { useMemo, useRef, useState } from 'react';
import { PanResponder, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useTheme } from '@/theme';
import { navigationChrome, radius, spacing } from '@/theme/tokens';

/** A dedicated edge target; vertical list scrolling never starts a resize. */
export function SessionPaneDivider({ width, left, top, bottom, bounds, onResize }: {
  width: number;
  left: number;
  top: number;
  bottom: number;
  bounds: { min: number; max: number };
  onResize(width: number): void;
}) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const [dragging, setDragging] = useState(false);
  const latest = useRef({ width, bounds, onResize });
  latest.current = { width, bounds, onResize };
  const responder = useMemo(() => {
    let initial = 0;
    const resize = (next: number) => {
      const current = latest.current;
      current.onResize(Math.round(Math.max(current.bounds.min, Math.min(current.bounds.max, next))));
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
      onPanResponderMove: (_event, gesture) => resize(initial + gesture.dx),
      onPanResponderRelease: (_event, gesture) => { resize(initial + gesture.dx); finish(); },
      onPanResponderTerminate: () => { resize(initial); finish(); },
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
    <View pointerEvents="none" style={[styles.grip, { backgroundColor: dragging ? colors.textSecondary : colors.borderStrong }]} />
  </View>;
}

const styles = StyleSheet.create({
  target: { position: 'absolute', width: navigationChrome.target, alignItems: 'center', justifyContent: 'center', zIndex: 40 },
  grip: { width: 3, height: spacing.xxl, borderRadius: radius.pill },
});
