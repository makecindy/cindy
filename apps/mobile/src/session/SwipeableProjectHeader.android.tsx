import { memo, useCallback, useEffect, useRef, type ReactNode } from 'react';
import { Animated, Pressable, StyleSheet, View } from 'react-native';
import { List, Search, SquarePen, type LucideIcon } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { ClassicSwipeable, type ClassicSwipeableMethods } from '@/platform/gestureHandler';
import { iconSize, iconStroke, useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { radius, spacing } from '@/theme/tokens';
import { useWindowWidth } from '@/platform/windowDimension';
import { usePaneEdgeInset } from './SessionPaneDivider';
import type { SwipeRowRegistry } from './swipeRowRegistry';

type Translation = Parameters<NonNullable<React.ComponentProps<typeof ClassicSwipeable>['renderLeftActions']>>[1];
type ReadableTranslation = Translation & { __getValue?(): unknown };
const SIZE = 56;
const GAP = spacing.md;
const LEADING_WIDTH = SIZE * 2 + GAP * 3;
const TRAILING_WIDTH = SIZE + GAP * 2;

/** Android project headers share task/device-row scroll arbitration, not RNGH's
 * ReanimatedSwipeable (which does not expose a vertical failure threshold). */
export const SwipeableProjectHeader = memo(function SwipeableProjectHeader({
  projectKey, registry, onNewTask, onOpenTasks, onSearch, children,
}: {
  projectKey: string;
  registry: SwipeRowRegistry;
  onNewTask(): void;
  onOpenTasks(): void;
  onSearch(): void;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const width = useWindowWidth();
  const edgeInset = usePaneEdgeInset();
  const methods = useRef<ClassicSwipeableMethods | null>(null);
  const translation = useRef<ReadableTranslation | null>(null);
  const rowKey = `project:${projectKey}`;
  const close = useCallback(() => methods.current?.close(), []);
  useEffect(() => {
    methods.current?.reset();
    return () => registry.onRowClose(rowKey);
  }, [registry, rowKey]);
  const run = (action: () => void) => {
    registry.onRowClose(rowKey);
    close();
    action();
  };
  const action = (offset: Translation, Icon: LucideIcon, label: string, onPress: () => void, leading = false, index = 0) => {
    const panelWidth = leading ? LEADING_WIDTH : TRAILING_WIDTH;
    const inputRange = leading ? [0, panelWidth] : [-panelWidth, 0];
    const outputRange = leading ? [0, 1] : [1, 0];
    const progress = offset.interpolate({ inputRange, outputRange, extrapolate: 'clamp' });
    return <Animated.View style={[styles.action,
      { backgroundColor: leading ? colors.swipeActionNeutral : colors.cta },
      leading ? { left: GAP + index * (SIZE + GAP), width: SIZE } : {
        right: GAP,
        width: offset.interpolate({ inputRange: [-TRAILING_WIDTH - 1, -TRAILING_WIDTH], outputRange: [SIZE + 1, SIZE],
          extrapolateLeft: 'extend', extrapolateRight: 'clamp' }),
      },
      { opacity: progress.interpolate({ inputRange: [0.15, 0.7], outputRange: [0, 1], extrapolate: 'clamp' }),
        transform: [{ scale: progress.interpolate({ inputRange: [0.15, 1], outputRange: [0.5, 1], extrapolate: 'clamp' }) }] },
    ]}>
      <Pressable accessibilityLabel={label} accessibilityRole="button" onPress={onPress} style={styles.pressable}>
        <View style={styles.icon}><Icon size={iconSize.swipeAction} strokeWidth={iconStroke.regular}
          color={leading ? colors.swipeActionText : colors.ctaText} /></View>
      </Pressable>
    </Animated.View>;
  };
  return <ClassicSwipeable ref={methods} testID={`home.projectSwipe.${projectKey}`}
    containerStyle={styles.surface} childrenContainerStyle={styles.surface}
    hitSlop={{ left: -spacing.xl, right: -edgeInset }} overshootLeft={false}
    // Stretching the trailing pill animates width, which RN's native driver cannot run.
    useNativeAnimations={false}
    onSwipeableOpenStartDrag={() => registry.onRowOpen(rowKey, close)}
    onSwipeableClose={() => registry.onRowClose(rowKey)}
    onSwipeableWillOpen={direction => {
      // Classic directions name the exposed panel, opposite RNGH3's movement.
      // Read release position, never the maximum distance reached while dragging.
      const value = translation.current?.__getValue?.();
      if (direction === 'right' && typeof value === 'number' && -value >= width * 0.55) run(onNewTask);
    }}
    renderLeftActions={(_progress, offset) => {
      translation.current = offset;
      return <View style={styles.leadingShell}>
        {action(offset, List, t('devices.list.projectActions.allTasks'), () => run(onOpenTasks), true)}
        {action(offset, Search, t('devices.list.projectActions.search'), () => run(onSearch), true, 1)}
      </View>;
    }}
    renderRightActions={(_progress, offset) => {
      translation.current = offset;
      return <View style={styles.trailingShell}>
        {action(offset, SquarePen, t('devices.list.projectActions.newTask'), () => run(onNewTask))}
      </View>;
    }}>
    {children}
  </ClassicSwipeable>;
});

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  surface: { backgroundColor: colors.surface },
  leadingShell: { width: LEADING_WIDTH, overflow: 'visible' },
  trailingShell: { width: TRAILING_WIDTH, overflow: 'visible' },
  action: { borderRadius: radius.pill, height: SIZE, position: 'absolute', top: '50%', marginTop: -SIZE / 2, overflow: 'hidden' },
  pressable: { flex: 1 },
  icon: { position: 'absolute', top: 0, bottom: 0, left: 0, width: SIZE, alignItems: 'center', justifyContent: 'center' },
});
